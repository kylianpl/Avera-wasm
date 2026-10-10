// app/demux-worker.js — Slice 2 Phase 3 : démux isolé.
// Possède CompatLib + I/O HTTP (Range par bloc + prélecture séquentielle en
// stream) + position de lecture. Parle au decode
// worker en RPC (open/read/seek/close) sur MessagePort, paquets transférables.
// Aucune décision de présentation/décodage ici : producteur bête et méchant.
import { CompatLib } from "../packages/demux-compat/src/compat.js";
import {
  ff_init_demuxer_file,
  ff_read_frame_multi,
  av_seek_frame,
  AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

let lib = null;
let session = null;
let streams = [];
let url = null;
let sourceName = null;
let generation = 0;
let abort = null;
let rangePromises = new Map();
let port = null;

// Prélecture séquentielle (Streams API, opportuniste) : pendant la lecture
// le démuxeur avance de façon monotone, donc un GET ouvert (Range `N-`)
// débite les blocs suivants en un seul aller-retour au lieu d'un RTT par
// bloc Range. Le Range reste la source de vérité (probe, seeks, relectures,
// repli si le stream échoue) : le stream ne fait que nourrir le même cache
// de blocs en avance, borné par READAHEAD_BLOCKS.
// Discipline : pause dès que l'avance suffit (backpressure naturelle — on ne
// pull plus le reader), cancel à tout saut non séquentiel / open / close.
const READAHEAD_BLOCKS = 8;
let seqGen = -1;        // génération du pump actif (ou -1 : aucun)
let seqEpoch = 0;       // incrémenté à chaque (re)démarrage/annulation
let seqPumping = false; // un pump tourne (peut être en pause capée)
let seqReader = null;   // reader actif (pour cancel)
let seqNext = 0n;       // prochain offset absolu à nourrir
let seqBaseBlock = 0;   // premier bloc couvert par le pump courant
let demandBlock = -1;   // dernier bloc explicitement demandé (feedTrigger)
let seqFails = 0;       // échecs stream consécutifs (repli Range pur au-delà)
const SEQ_MAX_FAILS = 3;

function seqCancel() {
  seqEpoch++;
  seqPumping = false;
  try { seqReader?.cancel(); } catch {}
  seqReader = null;
}

async function seqPump(fromOff, gen, epoch) {
  seqPumping = true;
  seqReader = null;
  try {
    const size = lib.vfs.get(sourceName)?.size ?? 0n;
    if (fromOff >= size) return;
    const resp = await fetch(url, {
      headers: { Range: `bytes=${fromOff}-` },
      signal: abort?.signal,
    });
    if (gen !== generation || epoch !== seqEpoch) return;
    if ((!resp.ok && resp.status !== 206) || !resp.body) {
      if (resp.status !== 206) throw new Error(`HTTP ${resp.status} for stream ${fromOff}-`);
      return;
    }
    let base = fromOff;
    if (resp.status === 200) {
      if (fromOff !== 0n) return; // Range ignoré : le Range par bloc couvre
      base = 0n;
    }
    const reader = resp.body.getReader();
    seqReader = reader;
    seqNext = base;
    seqBaseBlock = Math.floor(Number(base) / BLOCK);
    let carry = new Uint8Array(0);
    const push = (a, b) => {
      const nv = new Uint8Array(a.length + b.length);
      nv.set(a); nv.set(b, a.length);
      return nv;
    };
    for (;;) {
      if (gen !== generation || epoch !== seqEpoch) return;
      const sizeNow = lib.vfs.get(sourceName)?.size ?? 0n;
      // Assez d'avance : pause (le prochain trigger séquentiel reprendra).
      if (seqNext >= BigInt(demandBlock + 1 + READAHEAD_BLOCKS) * BigInt(BLOCK) ||
          seqNext >= sizeNow) return;
      let rd;
      try {
        rd = await reader.read();
      } catch (e) {
        if (e?.name === "AbortError") return;
        throw e;
      }
      if (gen !== generation || epoch !== seqEpoch) return;
      if (rd.done) return;
      if (!rd.value?.length) continue;
      carry = push(carry, rd.value);
      // Découpe les blocs alignés couverts par [seqNext, seqNext+carry).
      for (;;) {
        const blockStart = Math.floor(Number(seqNext) / BLOCK) * BLOCK;
        const blockEnd = Math.min(blockStart + BLOCK, Number(sizeNow));
        const haveTo = Number(seqNext) + carry.length;
        if (haveTo < blockEnd) break; // bloc incomplet : attend la suite
        const take = blockEnd - Number(seqNext);
        const piece = carry.subarray(0, take);
        carry = carry.subarray(take);
        seqNext += BigInt(take);
        try {
          await lib.ff_block_reader_dev_send(sourceName, blockStart, piece);
        } catch {}
        if (gen !== generation || epoch !== seqEpoch) return;
      }
      // Garde-fou mémoire : carry ne retient qu'un reste de bloc (< 1 Mio).
      if (carry.length > BLOCK) {
        const blockStart = Math.floor(Number(seqNext) / BLOCK) * BLOCK;
        const sizeNow2 = lib.vfs.get(sourceName)?.size ?? 0n;
        const blockEnd = Math.min(blockStart + BLOCK, Number(sizeNow2));
        const take = Math.min(carry.length, blockEnd - Number(seqNext));
        if (take > 0) {
          try {
            await lib.ff_block_reader_dev_send(sourceName, blockStart, carry.subarray(0, take));
          } catch {}
          carry = carry.subarray(take);
          seqNext += BigInt(take);
        } else {
          carry = new Uint8Array(0);
        }
      }
    }
  } catch (e) {
    if (e?.name !== "AbortError" && gen === generation && epoch === seqEpoch) {
      console.debug("[demux] seq stream failed:", String(e?.message ?? e));
      seqFails++;
    }
  } finally {
    if (epoch === seqEpoch) seqPumping = false;
    if (seqReader) { try { seqReader.cancel(); } catch {} seqReader = null; }
  }
}

function seqKick(blockStartBytes, gen) {
  if (seqFails >= SEQ_MAX_FAILS) return; // repli Range pur pour la génération
  // blockStartBytes est un offset octets → on raisonne en index de bloc.
  const blockIdx = Math.floor(blockStartBytes / BLOCK);
  demandBlock = Math.max(demandBlock, blockIdx);
  const nextBlock = Number(seqNext / BigInt(BLOCK));
  if (seqGen === gen && seqBaseBlock <= blockIdx && blockIdx <= nextBlock + READAHEAD_BLOCKS + 2) {
    // Toujours dans la foulée du stream : reprend s'il était en pause capée.
    if (!seqPumping) {
      seqEpoch++;
      void seqPump(seqNext, gen, seqEpoch);
    }
    return;
  }
  // Saut (seek, ouverture, grand bond) : on repart juste après le bloc demandé.
  seqCancel();
  seqGen = gen;
  demandBlock = blockIdx;
  seqEpoch++;
  console.log(`[demux] seq stream @${blockStartBytes + BLOCK} (read-ahead)`);
  void seqPump(BigInt(blockStartBytes) + BigInt(BLOCK), gen, seqEpoch);
}

// Sérialisation des opérations (mutex à chaîne de promesses) : sans ça, un
// read en vol (await fetch) s'entrelace avec un seek et avance readPos au
// milieu de la nouvelle position (paquets mélangés, keyframes manqués).
// mpv fait pareil avec son verrou demux (demux_seek). Coût : un seek attend
// la fin du read en cours (quelques ms).
let opTail = Promise.resolve();
function serialized(fn) {
  const run = opTail.then(fn);
  opTail = run.catch(() => {});
  return run;
}

const BLOCK = 1048576;

async function fetchBlock(deviceName, blockStart, fetchLen, gen) {
  const key = `${deviceName}:${blockStart}:${fetchLen}`;
  if (rangePromises.has(key)) return rangePromises.get(key);
  const promise = (async () => {
    const end = blockStart + fetchLen - 1;
    const response = await fetch(url, {
      headers: { Range: `bytes=${blockStart}-${end}` },
      signal: abort?.signal,
    });
    if (gen !== generation) return;
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} for range ${blockStart}-${end}`);
    }
    let data = new Uint8Array(await response.arrayBuffer());
    if (response.status === 200) data = data.subarray(blockStart, blockStart + fetchLen);
    await lib.ff_block_reader_dev_send(deviceName, blockStart, data);
  })().finally(() => {
    rangePromises.delete(key);
  });
  rangePromises.set(key, promise);
  return promise;
}

function feedTrigger(filename, pos) {
  if (!lib) return;
  // Devices connus : session A/V + session sous-titres (suffixe "-sub").
  // (endsWith inversé interdit : "source-1-sub" ne finit PAS par "source-1"
  // — bug vu au premier test du RPC subtitles : aucun fetch, timeout bloc.)
  if (filename !== sourceName && filename !== `${sourceName}-sub`) return;
  const size = lib.vfs.get(sourceName)?.size ?? 0n;
  const blockStart = Math.floor(Number(pos) / BLOCK) * BLOCK;
  const fetchLen = Math.min(BLOCK, Number(BigInt(size) - BigInt(blockStart)));
  if (fetchLen <= 0) return;
  const gen = generation;
  fetchBlock(filename, blockStart, fetchLen, gen).catch((e) => {
    if (gen !== generation) return;
    console.error("Range fetch failed:", e);
    lib.ff_block_reader_dev_send(filename, pos, null, { errorCode: -1 }).catch(() => {});
  });
  // Read-ahead séquentiel : nourrit les blocs suivants via un stream unique.
  // Ne change rien à la correction (le Range ci-dessus reste la source de
  // vérité du bloc demandé) — en cas de saut, seqKick annule et repart.
  seqKick(blockStart, gen);
}

function collectTransfer(packets) {
  const xfer = [];
  const walk = (o) => {
    if (o instanceof Uint8Array) {
      if (o.byteLength) xfer.push(o.buffer);
    } else if (Array.isArray(o)) {
      for (const v of o) walk(v);
    } else if (o && typeof o === "object") {
      for (const v of Object.values(o)) walk(v);
    }
  };
  for (const p of packets) walk(p);
  return xfer;
}

self.onmessage = async (e) => {
  const d = e.data;
  // Init (port du canal decode↔demux). Les RPC arrivent SUR LE PORT, pas sur
  // self : sans onmessage le port file sans être lu et tout pend (vu en beta).
  if (!d || d.id === undefined) {
    if (d && d.type === "init") {
      port = d.port ?? null;
      if (port) port.onmessage = (ev) => serialized(() => handleRpc(ev.data));
    }
    return;
  }
  serialized(() => handleRpc(d));
};

async function handleRpc(d) {
  const reply = (ok, payload, transfer) => {
    try {
      port.postMessage({ id: d.id, ok, ...payload }, transfer ?? []);
    } catch (err) {
      try { port.postMessage({ id: d.id, ok: false, error: String(err?.message ?? err) }); } catch {}
    }
  };
  try {
    switch (d.op) {
      case "open": {
        generation++;
        // (même ordre que close : reader d'abord, abort ensuite — voir close)
        try { await seqReader?.cancel(); } catch {}
        seqCancel();
        abort?.abort?.();
        abort = new AbortController();
        rangePromises = new Map();
        seqCancel();
        seqGen = -1; seqNext = 0n; demandBlock = -1; seqFails = 0;
        url = new URL(d.url, self.location.href).href;
        const head = await fetch(url, { method: "HEAD", signal: abort.signal });
        if (!head.ok) throw new Error(`Failed to probe media: ${head.statusText}`);
        const size = Number(head.headers.get("content-length"));
        if (!Number.isFinite(size) || size <= 0) {
          throw new Error("Media server did not provide Content-Length");
        }
        lib = new CompatLib();
        try {
          await lib.init({ wasm: d.wasm ?? true });
        } catch {}
        sourceName = `source-${generation}`;
        lib.onblockread = (filename, pos) => feedTrigger(filename, pos);
        await lib.mkblockreaderdev(sourceName, size);
        const [sess, sts] = await ff_init_demuxer_file(lib, sourceName);
        session = sess;
        streams = sts;
        reply(true, { streams, durationNs: String(sess.durationNs), chapters: sess.chapters ?? [] });
        break;
      }
      case "read": {
        // Remplit SANS quotas par type : tout ce qui est parsé est retourné.
        // (Les quotas tronquaient : readPos avançait quand même → contenu perdu
        // = sauts périodiques audio/vidéo en beta.) Le staging côté decode
        // (60 paquets/16Mo) borne déjà l'avance ; ici on borne le travail/RPC.
        if (!session) throw new Error("not open");
        const vIdx = d.videoIdx, aIdx = d.audioIdx;
        const video = [], audio = [];
        let bytes = 0, eof = false, guard = 0;
        const take = (arr, out) => {
          for (const p of arr) { out.push(p); bytes += p.size ?? 0; }
        };
        while (guard++ < 12 && bytes < 2 * 1048576) {
          const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 524288 });
          if (res === AVERROR_EOF) { eof = true; break; }
          if (res < 0) throw new Error(`demux read ${res}`);
          if (vIdx !== -1 && vIdx !== null) take(dict[vIdx] ?? [], video);
          if (aIdx !== -1 && aIdx !== null) take(dict[aIdx] ?? [], audio);
          if (!Object.keys(dict).length) break; // fenêtre sans paquets : rend la main
        }
        reply(true, { gen: d.gen, video, audio, eof, pos: session ? String(session.readPos) : null }, [...collectTransfer(video), ...collectTransfer(audio)]);
        break;
      }
      case "seek": {
        if (!session) throw new Error("not open");
        const r = await av_seek_frame(session, d.streamIdx ?? -1, BigInt(Math.floor(Number(d.ns))), 0, 1);
        reply(true, { gen: d.gen, res: r });
        break;
      }
      case "subtitles": {
        // Scan complet d'une piste sous-titres sur la session PRINCIPALE,
        // positions sauvegardées/restaurées (MKV : readPos ; MP4 : curseurs
        // par piste — seuls démuxeurs à émettre du texte v1). Pas de 2e
        // session : un seul open, pas de cache dupliqué, pas de device-bis.
        if (!session) throw new Error("not open");
        const trackIdx = d.trackIdx;
        if (session.kind !== "mkv" && session.kind !== "mp4") {
          throw new Error(`sous-titres non supportés en ${session.kind} (v1 : mkv/mp4)`);
        }
        const saved = {
          readPos: session.readPos,
          eof: session.eof,
          cursors: session.tracks.map((t) => t.cursor ?? 0),
        };
        try {
          session.readPos = session.firstClusterOff ?? session.readPos;
          session.eof = false;
          if (session.kind === "mp4") {
            for (const t of session.tracks) t.cursor = 0;
          }
          const packets = [];
          for (let guard = 0; guard < 5000; guard++) {
            const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
            if (res === AVERROR_EOF) break;
            if (res < 0) throw new Error(`demux subtitles ${res}`);
            packets.push(...(dict[trackIdx] ?? []));
          }
          // Copie : les paquets partagent les buffers du cache de blocs —
          // les transférer tels quels détacherait le cache, et un même
          // buffer 2× dans la transfer list jette le batch (vu en ASS).
          // (même règle que l'émission audio/vidéo, cf. collectTransfer.)
          const owned = packets.map((p) => ({ ...p, data: Uint8Array.from(p.data), size: p.data.length }));
          console.log(`[sub] piste ${trackIdx} : ${owned.length} paquets`);
          reply(true, { gen: d.gen, packets: owned }, collectTransfer(owned));
        } finally {
          session.readPos = saved.readPos;
          session.eof = saved.eof;
          if (session.kind === "mp4") {
            session.tracks.forEach((t, i) => { t.cursor = saved.cursors[i] ?? 0; });
          }
        }
        break;
      }
      case "close": {
        generation++;
        // Ordre : d'abord le reader du stream (fin gracieuse de la réponse
        // en vol), puis l'abort des Range (sinon l'abort mid-stream laisse
        // un rejet non catché côté fetch).
        try { await seqReader?.cancel(); } catch {}
        seqCancel();
        abort?.abort?.();
        try { await lib?.unlink(sourceName); } catch {}
        lib = null; session = null; streams = [];
        rangePromises = new Map();
        reply(true, { gen: d.gen });
        break;
      }
      default:
        reply(false, { error: "unknown op" });
    }
  } catch (err) {
    reply(false, { error: String(err?.message ?? err) });
  }
};
