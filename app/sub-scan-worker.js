// app/sub-scan-worker.js — scan des sous-titres dans un worker DÉDIÉ.
// Pourquoi : le scan parcourt tout le fichier. Le faire dans le demux-worker
// (mutex RPC sérialisé) affamait la lecture A/V pendant des secondes
// (ring audio vidé → dérive/stall, vu sur un épisode 24 min). Ici : session
// et I/O HTTP indépendantes → la lecture continue, le scan se termine quand
// il peut, puis le worker est terminé.
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const BLOCK = 1048576;
const PREFETCH = 8; // blocs en vol (pipeline : le scan est séquentiel)
let url = null;
let lib = null;
let name = null;
let abort = null;
let size = 0;
const inflight = new Map(); // blockStart -> Promise

/** Prépare/expédie un bloc (dédupliqué). Le scan lit séquentiellement :
 * sans pipeline, une requête à la fois ≈ 25-30 ms/bloc → ~40 s sur 1,5 Go. */
function cached(blockStart) {
  return !!lib?.vfs?.get(name)?.blocks?.has(BigInt(blockStart));
}

function ensureBlock(blockStart, gen) {
  // NB : ne PAS mémoriser « déjà envoyé » : le cache CompatLib (48 blocs)
  // évince, et un retour arrière du démux (Cues/Attachments) doit pouvoir
  // re-télécharger. On se fie au cache réel.
  if (blockStart < 0 || blockStart >= size || cached(blockStart)) return;
  if (inflight.has(blockStart)) return;
  const fetchLen = Math.min(BLOCK, size - blockStart);
  const p = fetchBlock(blockStart, fetchLen, gen)
    .catch((err) => {
      if (gen === self.__gen) console.error("[sub-scan] block:", err?.message ?? err);
    })
    .finally(() => inflight.delete(blockStart));
  inflight.set(blockStart, p);
}

async function fetchBlock(blockStart, fetchLen, gen) {
  const end = blockStart + fetchLen - 1;
  const res = await fetch(url, {
    headers: { Range: `bytes=${blockStart}-${end}` },
    signal: abort.signal,
  });
  if (gen !== self.__gen) return;
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} for range ${blockStart}-${end}`);
  }
  let data = new Uint8Array(await res.arrayBuffer());
  if (res.status === 200) data = data.subarray(blockStart, blockStart + fetchLen);
  await lib.ff_block_reader_dev_send(name, blockStart, data);
}

self.__gen = 0;

self.onmessage = async (e) => {
  const d = e.data;
  if (!d || d.type !== "start") return;
  self.__gen++;
  const gen = self.__gen;
  abort = new AbortController();
  const t0 = performance.now();
  try {
    url = new URL(d.url, self.location.href).href;
    const head = await fetch(url, { method: "HEAD", signal: abort.signal });
    if (!head.ok) throw new Error(`HEAD ${head.status}`);
    size = Number(head.headers.get("content-length"));
    if (!Number.isFinite(size) || size <= 0) throw new Error("Content-Length absent");
    lib = new CompatLib();
    name = `subscan-${gen}`;
    lib.onblockread = async (file, pos) => {
      if (file !== name) return;
      const blockStart = Math.floor(Number(pos) / BLOCK) * BLOCK;
      // Pipeline : demande le bloc courant + les suivants.
      for (let k = 0; k < PREFETCH; k++) ensureBlock(blockStart + k * BLOCK, gen);
    };
    await lib.mkblockreaderdev(name, size);
    const [session] = await ff_init_demuxer_file(lib, name);
    if (gen !== self.__gen) return;
    const packets = [];
    for (let guard = 0; guard < 20000; guard++) {
      if (gen !== self.__gen) return;
      const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 8388608, onlyIdx: d.trackIdx });
      if (res === AVERROR_EOF) break;
      if (res < 0) throw new Error(`lecture ${res}`);
      packets.push(...(dict[d.trackIdx] ?? []));
    }
    if (gen !== self.__gen) return;
    // Copie : chaque paquet doit posséder son buffer (le worker est terminé
    // juste après l'envoi ; mais on évite aussi les vues partagées).
    const owned = packets.map((p) => ({
      pts: p.pts, duration: p.duration, size: p.data.length, data: Uint8Array.from(p.data),
    }));
    self.postMessage(
      { type: "cues", packets: owned, ms: Math.round(performance.now() - t0) },
      owned.map((p) => p.data.buffer),
    );
  } catch (err) {
    if (gen === self.__gen) {
      self.postMessage({ type: "error", error: String(err?.message ?? err) });
    }
  } finally {
    try { abort?.abort(); } catch {}
    try { await lib?.unlink(name); } catch {}
  }
};
