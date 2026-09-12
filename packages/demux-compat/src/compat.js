// packages/demux-compat/src/compat.js — interface "libav" pour app/worker.js,
// adossée à packages/mkv-demux (JS prouvé) au lieu de libav.js.
// Couvre D1–D10 (voir PLAN.md) : le worker ne change que ses imports.
// SW fallback (ff_init_decoder/ff_decode_multi/…) : stubs Phase 4.
//
// Conventions : timebase paquets = nanosecondes (num=1, den=1e9) — les maths
// du worker (pts*num/den, streamTimestamp) tombent juste ; seek en ns.
import { Reader, ID, parseTracks, parseChapters, parseCues, pickCue } from "../../mkv-demux/src/ebml.js";
import { parseBlock } from "../../mkv-demux/src/blocks.js";
import { probeSource } from "../../mkv-demux/src/probe.js";

// ---- Constantes FFmpeg (valeurs réelles, comparées par worker.js) ----
export const AV_TIME_BASE = 1000000;
export const AVSEEK_FLAG_BACKWARD = 1;
export const AVERROR_EOF = -541478725;
export const EAGAIN = 11;
export const AVMEDIA_TYPE_UNKNOWN = -1;
export const AVMEDIA_TYPE_VIDEO = 0;
export const AVMEDIA_TYPE_AUDIO = 1;
export const AVMEDIA_TYPE_DATA = 2;
export const AVMEDIA_TYPE_SUBTITLE = 3;
export const AVMEDIA_TYPE_ATTACHMENT = 4;

// Famille (interne) + codec_id FFmpeg + nom affichage, depuis CodecID MKV.
function mapCodec(codecId, kind) {
  const c = codecId || "";
  const V = (family, id) => ({ family, type: AVMEDIA_TYPE_VIDEO, id });
  const A = (family, id) => ({ family, type: AVMEDIA_TYPE_AUDIO, id });
  const S = (family, id) => ({ family, type: AVMEDIA_TYPE_SUBTITLE, id });
  if (c.startsWith("V_MPEG4/ISO/AVC")) return V("h264", 27);
  if (c.startsWith("V_MPEGH/ISO/HEVC")) return V("hevc", 173);
  if (c.startsWith("V_VP8")) return V("vp8", 139);
  if (c.startsWith("V_VP9")) return V("vp9", 167);
  if (c.startsWith("V_AV1")) return V("av1", 32797);
  if (c.startsWith("V_MPEG4/ISO/ASP") || c.startsWith("V_MS/VFW/FOURCC")) return V("mp4v", 12);
  if (c.startsWith("V_THEORA")) return V("theora", 30);
  if (c.startsWith("A_MPEG/L3")) return A("mp3", 86017);
  if (c.startsWith("A_AAC")) return A("aac", 86018);
  if (c.startsWith("A_AC3")) return A("ac3", 86019);
  if (c.startsWith("A_EAC3")) return A("eac3", 86055);
  if (c.startsWith("A_OPUS")) return A("opus", 86022);
  if (c.startsWith("A_VORBIS")) return A("vorbis", 86021);
  if (c.startsWith("A_FLAC")) return A("flac", 86028);
  if (c.startsWith("A_PCM")) return A("pcm", 65536);
  if (c.startsWith("S_TEXT/UTF8")) return S("srt", 94225);
  if (c.startsWith("S_TEXT/ASS")) return S("ass", 94226);
  if (c.startsWith("S_HDMV/PGS")) return S("pgs", 94227);
  if (c.startsWith("S_VOBSUB")) return S("vobsub", 94228);
  if (kind === 1) return V("unknown", 0);
  if (kind === 2) return A("unknown", 0);
  if (kind === 17) return S("unknown", 0);
  return { family: "unknown", type: AVMEDIA_TYPE_UNKNOWN, id: 0 };
}

const CODEC_NAMES = {
  27: "h264", 173: "hevc", 139: "vp8", 167: "vp9", 32797: "av1", 12: "mp4v",
  30: "theora", 86017: "mp3", 86018: "aac", 86019: "ac3", 86055: "eac3",
  86022: "opus", 86021: "vorbis", 86028: "flac", 94225: "subrip", 94226: "ass",
};
export function avcodec_get_name(id) { return CODEC_NAMES[id] ?? `codec_${id}`; }
export function ff_error(ret) {
  if (ret === AVERROR_EOF) return "End of file";
  if (ret === -EAGAIN) return "Try again";
  return `LibAV error ${ret}`;
}

// Profil/niveau H264 depuis avcC (pour le bridge) : idc + bit constrained.
function avcProfileLevel(priv) {
  if (!priv || priv.length < 4 || priv[0] !== 1) return { profile: -1, level: -1 };
  return {
    profile: priv[1] | ((priv[2] & 0x40) ? 0x100 : 0),
    level: priv[3],
  };
}
// Profil audio FFmpeg depuis ASC (AAC) : AOT→profil (LC→LOW…).
function aacProfile(priv) {
  if (!priv || !priv.length) return -1;
  const aot = priv[0] >> 3;
  if (aot === 2) return 1;
  if (aot === 5) return 4;
  if (aot === 29) return 28;
  return aot;
}

// ---- Lecteur Range avec cache blocs 1MiB, servi par onblockread (worker) ----
const BLOCK = 1048576;
const CACHE_MAX = 48;

export class CompatLib {
  constructor() {
    this.vfs = new Map(); // name -> { size, blocks: Map<start, Uint8Array> }
    this.waiters = new Map(); // `${name}:${start}` -> [{resolve, reject}]
    this.onblockread = null; // posé par worker.js
    // Constantes (lues comme this.libav.X par worker.js).
    this.AV_TIME_BASE = AV_TIME_BASE;
    this.AVSEEK_FLAG_BACKWARD = AVSEEK_FLAG_BACKWARD;
    this.AVERROR_EOF = AVERROR_EOF;
    this.EAGAIN = EAGAIN;
    this.AVMEDIA_TYPE_UNKNOWN = AVMEDIA_TYPE_UNKNOWN;
    this.AVMEDIA_TYPE_VIDEO = AVMEDIA_TYPE_VIDEO;
    this.AVMEDIA_TYPE_AUDIO = AVMEDIA_TYPE_AUDIO;
    this.AVMEDIA_TYPE_DATA = AVMEDIA_TYPE_DATA;
    this.AVMEDIA_TYPE_SUBTITLE = AVMEDIA_TYPE_SUBTITLE;
    this.AVMEDIA_TYPE_ATTACHMENT = AVMEDIA_TYPE_ATTACHMENT;
    this.libavjsMode = "demux-compat (sans libav)";
  }
  // Espace de noms statique (remplace `LibAV.AVMEDIA_TYPE_*` du worker).
  // (voir export LibAV plus bas)
  // -- D1 : FS virtuel --
  async mkblockreaderdev(name, size) {
    this.vfs.set(name, { size: BigInt(size), blocks: new Map() });
    return 0;
  }
  async unlink(name) {
    this.vfs.delete(name);
    return 0;
  }
  async ff_block_reader_dev_send(name, pos, data, _opts) {
    const v = this.vfs.get(name);
    const key = `${name}:${BigInt(pos)}`;
    const ws = this.waiters.get(key);
    this.waiters.delete(key);
    if (!v) {
      for (const w of ws ?? []) w.reject(new Error("fichier inconnu"));
      return -1;
    }
    if (!data) {
      v.blocks.delete(BigInt(pos));
      for (const w of ws ?? []) w.reject(new Error("lecture bloc rejetée"));
      return -1;
    }
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    v.blocks.set(BigInt(pos), u8);
    while (v.blocks.size > CACHE_MAX) {
      v.blocks.delete(v.blocks.keys().next().value);
    }
    for (const w of ws ?? []) w.resolve(u8);
    return 0;
  }
  #requestBlock(name, start) {
    const v = this.vfs.get(name);
    if (!v) throw new Error("fichier inconnu");
    const hit = v.blocks.get(start);
    if (hit) return Promise.resolve(hit);
    const key = `${name}:${start}`;
    return new Promise((resolve, reject) => {
      if (!this.waiters.has(key)) this.waiters.set(key, []);
      this.waiters.get(key).push({ resolve, reject });
      setTimeout(() => {
        const ws = this.waiters.get(key);
        if (!ws) return;
        const i = ws.findIndex((w) => w.resolve === resolve);
        if (i >= 0) {
          ws.splice(i, 1);
          reject(new Error("timeout bloc"));
        }
      }, 30000).unref?.();
      try {
        this.onblockread?.(name, Number(start), BLOCK);
      } catch (e) {
        reject(e);
      }
    });
  }
  /** Lecture [off, off+len) — assemble depuis les blocs (erreurs si trou). */
  async read(name, off, len) {
    off = BigInt(off); len = BigInt(len);
    if (len <= 0n) return new Uint8Array(0);
    const v = this.vfs.get(name);
    if (!v) throw new Error("fichier inconnu");
    const end = off + len > v.size ? v.size : off + len;
    if (end <= off) return new Uint8Array(0);
    const out = new Uint8Array(Number(end - off));
    let p = 0;
    for (let b = (off / BigInt(BLOCK)) * BigInt(BLOCK); b < end; b += BigInt(BLOCK)) {
      const blk = await this.#requestBlock(name, b);
      const from = off > b ? off - b : 0n;
      const to = end - b < BigInt(blk.length) ? end - b : BigInt(blk.length);
      if (to <= from) continue;
      out.set(blk.subarray(Number(from), Number(to)), p);
      p += Number(to - from);
    }
    return out.subarray(0, p);
  }
}

// ---- Session démux (opaque, passée telle quelle au worker) ----
export async function ff_init_demuxer_file(lib, name) {
  const v = lib.vfs.get(name);
  if (!v) throw new Error("fichier inconnu");
  const source = {
    read: (off, len) => lib.read(name, off, len),
    getSize: async () => v.size,
  };
  const idx = await probeSource(source);
  const tracksRaw = await source.read(idx.tracks.off, Number(idx.tracks.size)).then(parseTracks);
  const tracks = tracksRaw.map((t, i) => ({ ...t, index: i }));
  // Enrichissement (bridge + codecpar) : famille, profil/niveau H264, profil AAC.
  for (const t of tracks) {
    const m = mapCodec(t.codecId, t.kind);
    t.family = m.family;
    t.ffCodecId = m.id;
    t.ffCodecType = m.type;
    t.profile = -1; t.level = -1; t.audioProfile = -1;
    const priv = t.codecPrivate ?? new Uint8Array(0);
    t.extradata = priv; // alias : le bridge lit `extradata` (codecPrivate MKV)
    if (m.family === "h264") {
      const pl = avcProfileLevel(priv);
      t.profile = pl.profile; t.level = pl.level;
    }
    if (m.family === "aac") t.audioProfile = aacProfile(priv);
  }
  const segEnd = await findSegmentEnd(lib, name, idx, v.size);
  let chapters = [];
  try {
    if (idx.chapters?.size) {
      const cp = await source.read(idx.chapters.off, Number(idx.chapters.size));
      chapters = parseChapters(cp);
    }
  } catch {}
  const session = {
    lib, name, size: v.size, segOff: idx.segOff, segEnd,
    timecodeScale: idx.timecodeScale, durationNs: idx.durationNs,
    tracks, chapters, cues: null, cuesScanned: false,
    readPos: idx.firstClusterOff ?? idx.segOff,
    firstClusterOff: idx.firstClusterOff ?? idx.segOff,
    eof: false,
  };
  const streams = tracks.map((t) => {
    return {
      index: t.index,
      number: t.number,
      codec_type: t.ffCodecType,
      codec_id: t.ffCodecId,
      codecpar: t, // objet piste interne (ff_copyout_codecpar + bridge l'exploitent)
      time_base_num: 1,
      time_base_den: 1000000000,
      metadata: t.name ? { title: t.name } : {},
    };
  });
  return [session, streams];
}

async function findSegmentEnd(lib, name, idx, fileSize) {
  try {
    const head = await lib.read(name, idx.segOff - 12n < 0n ? 0n : idx.segOff - 12n, 12);
    const r = new Reader(head);
    const e = r.elem();
    if (e.id === ID.Segment && e.size !== null) return idx.segOff + BigInt(e.size);
  } catch {}
  return fileSize;
}

// ---- D3 : codecpar ----
export async function ff_copyout_codecpar(track) {
  const priv = track.codecPrivate ?? new Uint8Array(0);
  return {
    family: track.family ?? mapCodec(track.codecId, track.kind).family,
    width: Number(track.width || 0),
    height: Number(track.height || 0),
    channels: Number(track.channels || 0),
    channelCount: Number(track.channels || 0),
    sample_rate: Number(track.sampleRate || 0),
    sampleRate: Number(track.sampleRate || 0),
    profile: track.profile ?? -1,
    level: track.level ?? -1,
    audioProfile: track.audioProfile ?? -1,
    extradata: priv,
  };
}

// ---- D5 : durée/métadonnées/chapitres ----
export async function AVFormatContext_duration(session) {
  if (session.durationNs < 0n) return -1;
  return Number(session.durationNs / 1000n); // ticks AV_TIME_BASE (µs)
}
export async function AVFormatContext_metadata(_session) { return 0; }
export async function ff_copyout_dict(_ptr) { return {}; }
export async function ff_get_demuxer_chapters(session) {
  return (session.chapters ?? []).map((c, i) => ({
    id: i,
    time_base: { num: 1, den: 1000000 },
    start: Number(c.startNs / 1000n),
    end: Number(c.endNs / 1000n),
    metadata: c.title ? { title: c.title } : {},
  }));
}

// Espace de noms pour `import { LibAV }` (remplace les statiques libav).
export const LibAV = {
  AVMEDIA_TYPE_UNKNOWN, AVMEDIA_TYPE_VIDEO, AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_DATA, AVMEDIA_TYPE_SUBTITLE, AVMEDIA_TYPE_ATTACHMENT,
};

// Méthodes d'instance (worker.js appelle this.libav.*) — délégation fine.
const _m = CompatLib.prototype;
_m.ff_init_demuxer_file = function (name) { return ff_init_demuxer_file(this, name); };
_m.ff_read_frame_multi = function (s, p, o) { return ff_read_frame_multi(s, p, o); };
_m.av_seek_frame = function (s, i, t, a, f) { return av_seek_frame(s, i, t, a, f); };
_m.avformat_seek_file_max = function (s, i, t, a, f) { return avformat_seek_file_max(s, i, t, a, f); };
_m.ff_copyout_codecpar = function (t) { return ff_copyout_codecpar(t); };
_m.avcodec_get_name = function (id) { return avcodec_get_name(id); };
_m.ff_get_demuxer_chapters = function (s) { return ff_get_demuxer_chapters(s); };
_m.ff_copyout_dict = function (p) { return ff_copyout_dict(p); };
_m.AVFormatContext_duration = function (s) { return AVFormatContext_duration(s); };
_m.AVFormatContext_metadata = function (s) { return AVFormatContext_metadata(s); };
_m.av_packet_alloc = function () { return av_packet_alloc(); };
_m.ff_error = function (r) { return ff_error(r); };
_m.ff_init_decoder = function () { return ff_init_decoder(); };
_m.ff_decode_multi = function () { return ff_decode_multi(); };
_m.ff_free_decoder = function () { return ff_free_decoder(); };
_m.avcodec_flush_buffers = function () { return avcodec_flush_buffers(); };

// ---- D6 : curseur paquet (opaque, compat gère son curseur) ----
export async function av_packet_alloc() { return {}; }

// ---- Lecture clusters → paquets ----
function parseClusterPayload(session, buf, baseOff) {
  // buf = payload Cluster complet ; baseOff = offset absolu du payload.
  const out = [];
  const cr = new Reader(buf);
  let clusterTicks = null;
  while (!cr.eof) {
    const start = cr.p;
    let e;
    try { e = cr.elem(); }
    catch { break; }
    const end = e.size === null ? buf.length : Math.min(buf.length, cr.p + Number(e.size));
    if (e.id === ID.Timecode) {
      clusterTicks = Number(cr.uint(e.size === null ? BigInt(buf.length - cr.p) : e.size));
    } else if ((e.id === ID.SimpleBlock || e.id === ID.BlockGroup) && clusterTicks !== null) {
      const payload = buf.subarray(cr.p, end);
      if (e.id === ID.SimpleBlock) {
        const b = parseBlock(payload, BigInt(clusterTicks), session.timecodeScale);
        out.push({ block: b, payload, durTicks: 0n, group: false });
      } else {
        const grp = parseBlockGroup(session, payload, BigInt(clusterTicks));
        if (grp) out.push(grp);
      }
    }
    cr.p = end <= start ? start + 1 : end;
  }
  return { clusterTicks, blocks: out };
}

function parseBlockGroup(session, payload, clusterTicks) {
  // BlockGroup : Block + BlockDuration? + ReferenceBlock* (clé = absence).
  const gr = new Reader(payload);
  let blockPayload = null, durTicks = 0n, hasRef = false;
  while (!gr.eof) {
    const start = gr.p;
    let e;
    try { e = gr.elem(); }
    catch { break; }
    const end = e.size === null ? payload.length : Math.min(payload.length, gr.p + Number(e.size));
    if (e.id === ID.Block && blockPayload === null) {
      blockPayload = payload.subarray(gr.p, end);
    } else if (e.id === ID.BlockDuration) {
      try { durTicks = BigInt(Number(gr.uint(e.size))) ; } catch {}
    } else if (e.id === ID.ReferenceBlock) {
      hasRef = true;
    }
    gr.p = end <= start ? start + 1 : end;
  }
  if (!blockPayload) return null;
  const b = parseBlock(blockPayload, clusterTicks, session.timecodeScale);
  b.key = !hasRef; // pas de référence = keyframe (les flags Block n'ont pas de bit clé)
  return { block: b, payload: blockPayload, durTicks, group: true };
}

async function ensureCues(session) {
  if (session.cuesScanned) return session.cues ?? [];
  session.cuesScanned = true;
  try {
    // Retrouve l'élément Cues : balayage borné depuis la fin (Cues en queue).
    const tail = 2 * 1048576;
    const start = session.segEnd > BigInt(tail) ? session.segEnd - BigInt(tail) : 0n;
    const buf = await session.lib.read(session.name, start, Number(session.segEnd - start));
    const r = new Reader(buf);
    while (!r.eof) {
      const s0 = r.p;
      let e;
      try { e = r.elem(); }
      catch { break; }
      const end = e.size === null ? buf.length : Math.min(buf.length, r.p + Number(e.size));
      if (e.id === ID.Cues) {
        session.cues = parseCues(buf.subarray(r.p, end), session.timecodeScale);
        break;
      }
      r.p = end <= s0 ? s0 + 1 : end;
    }
  } catch {}
  return session.cues ?? [];
}

// ---- D7 : lecture bornée → paquets par index de stream ----
export async function ff_read_frame_multi(session, _packet, opts = {}) {
  const limit = BigInt(opts.limit ?? 524288);
  const byIdx = {};
  if (session.eof) return [-541478725, byIdx];
  const { lib, name } = session;
  let spent = 0n;
  for (;;) {
    if (session.readPos >= session.segEnd) {
      session.eof = true;
      return Object.keys(byIdx).length ? [0, byIdx] : [-541478725, byIdx];
    }
    const winStart = session.readPos;
    const want = session.segEnd - winStart > 1048576n ? 1048576n : session.segEnd - winStart;
    let win;
    try {
      win = await lib.read(name, winStart, Number(want));
    } catch {
      return [-11, byIdx];
    }
    if (!win.length) {
      session.eof = true;
      return Object.keys(byIdx).length ? [0, byIdx] : [-541478725, byIdx];
    }
    const r = new Reader(win);
    while (!r.eof) {
      const s0 = r.p;
      let e;
      try { e = r.elem(); }
      catch { break; } // header tronqué : on avance de ce qui est consommé (ci-dessous)
      const end = e.size === null ? null : r.p + Number(e.size);
      if (e.id === ID.Cluster && (end === null || winStart + BigInt(end) > winStart + BigInt(win.length))) {
        if (end !== null) {
          // À cheval : complète (borné par la taille annoncée).
          const need = Number(winStart + BigInt(end) - (winStart + BigInt(win.length)));
          if (need > 64 * 1048576) break; // garde-fou cluster absurde
          try {
            const tail = await lib.read(name, winStart + BigInt(win.length), need);
            if (tail.length < need) break;
            const full = new Uint8Array(win.length - s0 + tail.length);
            full.set(win.subarray(s0));
            full.set(tail, win.length - s0);
            const { blocks } = parseClusterPayload(session, full.subarray(r.p - s0), winStart + BigInt(r.p));
            routeBlocks(session, blocks, byIdx);
            spent += BigInt(end - s0);
            session.readPos = winStart + BigInt(end);
            continue;
          } catch {
            break;
          }
        }
        // Unknown-size : parse jusqu'au bout de la fenêtre (shortWindow).
        const { blocks } = parseClusterPayload(session, win.subarray(r.p), winStart + BigInt(r.p));
        routeBlocks(session, blocks, byIdx);
        spent += BigInt(win.length - s0);
        session.readPos = winStart + BigInt(win.length);
        r.p = win.length;
        if (spent >= limit) return [0, byIdx];
        continue;
      }
      if (e.id === ID.Cluster && end !== null && end <= win.length) {
        const { blocks } = parseClusterPayload(session, win.subarray(r.p, end), winStart + BigInt(r.p));
        routeBlocks(session, blocks, byIdx);
        spent += BigInt(end - s0);
        session.readPos = winStart + BigInt(end);
        r.p = end;
        if (spent >= limit) return [0, byIdx];
        continue;
      }
      // Métadonnée : avance de ce qui est consommé et rend la main.
      r.p = end === null || end <= s0 ? (end === null ? win.length : s0 + 1) : Math.min(end, win.length);
      break;
    }
    // Positionnement absolu (les clusters avancent eux-mêmes + continue ;
    // ici on consomme le reste de la fenêtre). Jamais de sur-place.
    session.readPos = winStart + BigInt(r.p > 0 ? r.p : 1);
    if (Object.keys(byIdx).length || spent >= limit) return [0, byIdx];
  }
}

function routeBlocks(session, blocks, byIdx) {
  for (const { block: b, payload, durTicks } of blocks) {
    const track = session.tracks.find((t) => t.number === b.track);
    if (!track) continue;
    const idx = track.index;
    byIdx[idx] = byIdx[idx] ?? [];
    const durNs = durTicks > 0n ? durTicks * session.timecodeScale
      : (track.defaultDurationNs > 0n ? track.defaultDurationNs : 0n);
    for (const f of b.frames) {
      const data = payload.slice(f.off, f.off + f.len);
      byIdx[idx].push({
        pts: Number(b.ptsNs), // ticks ns (timebase 1/1e9)
        dts: Number(b.ptsNs),
        size: data.length,
        data,
        time_base_num: 1,
        time_base_den: 1000000000,
        duration: Number(durNs),
        key: !!b.key,
      });
    }
  }
}

// ---- D8 : seek (temps s, ns internes) ----
export async function av_seek_frame(session, streamIdx, ts, _a, _flags) {
  return seekNs(session, BigInt(ts));
}
export async function avformat_seek_file_max(session, streamIdx, ts, _a, _flags) {
  return seekNs(session, BigInt(ts));
}
async function seekNs(session, targetNs) {
  try {
    const cues = await ensureCues(session);
    if (!cues.length) {
      // Sans index : repart du premier cluster (dégradé, pas fatal).
      session.readPos = session.firstClusterOff;
    } else {
      const cue = pickCue(cues, targetNs);
      session.readPos = cue ? session.segOff + BigInt(cue.clusterPos) : session.firstClusterOff;
    }
    session.eof = false;
    return 0;
  } catch {
    return -1;
  }
}

// ---- D9/D10 déjà couverts (unlink, consts) ----

// ---- SW fallback : stubs Phase 4 ----
export async function ff_init_decoder() {
  throw new Error("SW fallback libav : Phase 4 — non migré (WebCodecs uniquement pour l'instant)");
}
export async function ff_decode_multi() {
  throw new Error("SW fallback libav : Phase 4 — non migré (WebCodecs uniquement pour l'instant)");
}
export async function ff_free_decoder() {}
export async function avcodec_flush_buffers() {}
export async function laFrameToVideoFrame() {
  throw new Error("SW fallback libav : Phase 4 — non migré (WebCodecs uniquement pour l'instant)");
}
