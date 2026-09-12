// app/demux-worker.js — Slice 2 Phase 3 : démux isolé.
// Possède CompatLib + I/O HTTP Range + position de lecture. Parle au decode
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

const BLOCK = 1048576;

async function fetchBlock(blockStart, fetchLen, gen) {
  const key = `${blockStart}:${fetchLen}`;
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
    await lib.ff_block_reader_dev_send(sourceName, blockStart, data);
  })().finally(() => {
    rangePromises.delete(key);
  });
  rangePromises.set(key, promise);
  return promise;
}

function feedTrigger(filename, pos) {
  if (!lib || !String(filename).endsWith(sourceName)) return;
  const size = lib.vfs.get(sourceName)?.size ?? 0n;
  const blockStart = Math.floor(Number(pos) / BLOCK) * BLOCK;
  const fetchLen = Math.min(BLOCK, Number(BigInt(size) - BigInt(blockStart)));
  if (fetchLen <= 0) return;
  const gen = generation;
  fetchBlock(blockStart, fetchLen, gen).catch((e) => {
    if (gen !== generation) return;
    console.error("Range fetch failed:", e);
    lib.ff_block_reader_dev_send(sourceName, pos, null, { errorCode: -1 }).catch(() => {});
  });
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
      if (port) port.onmessage = (ev) => handleRpc(ev.data);
    }
    return;
  }
  handleRpc(d);
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
        abort?.abort?.();
        abort = new AbortController();
        rangePromises = new Map();
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
        // Remplit jusqu'aux quotas (borné) : {video[], audio[], eof}.
        if (!session) throw new Error("not open");
        const vIdx = d.videoIdx, aIdx = d.audioIdx;
        const wantV = Math.min(d.videoN ?? 0, 64), wantA = Math.min(d.audioN ?? 0, 64);
        const video = [], audio = [];
        let eof = false, guard = 0;
        while ((video.length < wantV || audio.length < wantA) && guard++ < 12) {
          const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 524288 });
          if (res === AVERROR_EOF) { eof = true; break; }
          if (res < 0) throw new Error(`demux read ${res}`);
          if (vIdx !== -1 && vIdx !== null && video.length < wantV) {
            for (const p of dict[vIdx] ?? []) {
              if (video.length >= wantV) break;
              video.push(p);
            }
          }
          if (aIdx !== -1 && aIdx !== null && audio.length < wantA) {
            for (const p of dict[aIdx] ?? []) {
              if (audio.length >= wantA) break;
              audio.push(p);
            }
          }
          if (!Object.keys(dict).length) {
            if (session.eof) { eof = true; break; }
            break; // fenêtre sans paquets : rend la main (prochain appel continue)
          }
        }
        reply(true, { gen: d.gen, video, audio, eof }, [...collectTransfer(video), ...collectTransfer(audio)]);
        break;
      }
      case "seek": {
        if (!session) throw new Error("not open");
        const r = await av_seek_frame(session, d.streamIdx ?? -1, BigInt(Math.floor(Number(d.ns))), 0, 1);
        reply(true, { gen: d.gen, res: r });
        break;
      }
      case "close": {
        generation++;
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
