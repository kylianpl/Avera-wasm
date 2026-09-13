// packages/avi-demux/src/index.js — démuxeur AVI/RIFF maison (v1 : RIFF unique).
// hdrl (avih + strl/strh/strf/strd/strn), movi (descente récursive incl. 'rec '),
// idx1 (offsets vérifiés : base testée movi-payload/movi-liste/fichier).
// Sans idx1 : balayage movi séquentiel (lecture OK, seek dégradé → reprise à 0).
// OpenDML multi-segments (AVIX) : refusé explicitement (v1).
// Vidéo : H264 Annex B → avcc (avcC construit des SPS/PPS in-band ; strd
// avcC accepté), autres fourcc verbatim, pts=dts=ordinal (pas de ctts en AVI
// → pas de B-frames présentables : fixtures encodées -bf 0).
// Audio : MP3 découpé en frames, (E)AC-3 verbatim, PCM verbatim, AAC/ADTS
// découpé ; pts cumulés exacts (compteurs d'échantillons, pas d'estimation).
// Timestamps en ns, timebase 1/1e9 (contrat demux-compat).

import { LR, chunkHeader, chunkEnd } from "./riff.js";
import { parseAvih, parseStrl } from "./hdrl.js";
import {
  T_VIDEO, T_AUDIO, mapVideoCodec, mapAudioTag, AUDIO_IDS,
  detectH264Format, buildAvcC, findParamSets, firstNalType,
  splitMp3Chunk, splitAdtsChunk, parseAdtsHeader, sniffAudioChunk,
} from "./codecs.js";
import { splitAnnexB, annexbToAvcc } from "../../mkv-demux/src/annexb.js";
import { splitAc3Frames, ac3FrameSamples } from "../../sw-decode/src/ac3frames.js";

const MAX_TOP_CHUNKS = 4096;
const MAX_MOVI_CHUNKS = 2000000;
const MAX_PACKETS_PER_READ = 400;

export function sniffAvi(head) {
  return head && head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && // 'RIFF'
    head[8] === 0x41 && head[9] === 0x56 && head[10] === 0x49 && head[11] === 0x20; // 'AVI '
}

const nsTicks = (ticks, num, den) => Number((BigInt(ticks) * 1000000000n * BigInt(num)) / BigInt(den));
// Échantillons (ticks @sr) → ns.
const nsSamp = (samp, sr) => Number((BigInt(samp) * 1000000000n) / BigInt(sr));

function avcProfileLevel(avcC) {
  if (!avcC || avcC.length < 4 || avcC[0] !== 1) return { profile: -1, level: -1 };
  return { profile: avcC[1] | ((avcC[2] & 0x40) ? 0x100 : 0), level: avcC[3] };
}
function aacProfile(asc) {
  if (!asc || !asc.length) return -1;
  const aot = asc[0] >> 3;
  if (aot === 2) return 1;
  if (aot === 5) return 4;
  if (aot === 29) return 28;
  return aot;
}
// ASC LC minimal depuis un header ADTS (profil LC seulement).
function ascFromAdts(data) {
  for (let i = 0; i + 7 <= data.length; i++) {
    if (data[i] !== 0xff || (data[i + 1] & 0xf0) !== 0xf0) continue;
    const profile = ((data[i + 2] >> 6) & 0x03) + 1;
    if (profile !== 2) return null; // LC seul en synthèse
    const freqIdx = (data[i + 2] >> 2) & 0x0f;
    const chCfg = ((data[i + 2] & 0x01) << 2) | ((data[i + 3] >> 6) & 0x03);
    return new Uint8Array([(2 << 3) | (freqIdx >> 1), ((freqIdx & 1) << 7) | (chCfg << 3)]);
  }
  return null;
}

function streamIdxFromId(id, nStreams) {
  const a = id[0], b = id[1];
  let n;
  if (a >= "0" && a <= "9" && b >= "0" && b <= "9") n = (a.charCodeAt(0) - 48) * 10 + (b.charCodeAt(0) - 48);
  else n = parseInt(id.slice(0, 2), 16);
  if (!Number.isFinite(n) || n < 0 || n >= nStreams) return -1;
  return n;
}

export async function openAvi(source) {
  const size = BigInt(await source.getSize());
  if (size < 12n) throw new Error("fichier trop petit pour AVI");
  const head = await source.read(0n, 12);
  if (!sniffAvi(head)) throw new Error("pas un RIFF AVI");
  // Top-level : hdrl, movi, idx1 (+ JUNK/INFO sautés). AVIX → refusé (v1).
  let off = 12n;
  let hdrl = null, movi = null, idx1 = null;
  for (let g = 0; g < MAX_TOP_CHUNKS && off + 8n <= size; g++) {
    const hb = await source.read(off, 16);
    if (hb.length < 12) break;
    const h = chunkHeader(hb, 0);
    if (h.id === "LIST") {
      if (h.listType === "hdrl") {
        if (h.size > 16 * 1048576) throw new Error("hdrl démesuré");
        const payload = await source.read(off + 12n, Number(BigInt(h.size) - 4n));
        hdrl = { payload, off };
      } else if (h.listType === "movi") {
        if (movi) throw new Error("plusieurs LIST movi (OpenDML ? non supporté v1)");
        movi = { listOff: off, payloadOff: off + 12n, size: BigInt(h.size) - 4n };
      }
      // INFO/autres LIST : sautées.
    } else if (h.id === "RIFF") {
      throw new Error("AVI OpenDML multi-segments (AVIX) non supporté (v1 : RIFF unique)");
    } else if (h.id === "idx1") {
      idx1 = { off: off + 8n, size: BigInt(h.size) };
    }
    const nx = chunkEnd(off, { hdr: h.hdr, size: BigInt(h.size) });
    if (nx <= off) break;
    off = nx;
  }
  if (!hdrl) throw new Error("hdrl introuvable");
  if (!movi) throw new Error("movi introuvable");
  // hdrl → avih + streams.
  const { avih, streams: rawStreams } = parseHdrl(hdrl.payload);
  const tracks = [];
  for (let i = 0; i < rawStreams.length; i++) {
    const s = rawStreams[i];
    if (s.fccType !== "vids" && s.fccType !== "auds") continue; // sous-titres AVI : ignorés (v1)
    if (!s.strf) continue;
    tracks.push(buildTrack(s, i));
  }
  if (!tracks.length) throw new Error("aucune piste A/V");
  // Chunks : idx1 vérifié, sinon balayage movi.
  let hasIndex = false;
  if (idx1) {
    hasIndex = await applyIdx1(source, idx1, movi, tracks);
  }
  if (!hasIndex) {
    await walkMovi(source, movi, size, tracks);
  }
  for (const t of tracks) {
    t.chunks.sort((a, b) => (a.off < b.off ? -1 : 1));
    t.cursor = 0;
  }
  if (!tracks.some((t) => t.chunks.length)) throw new Error("aucun chunk A/V");
  // H264 : format + avcC (lecture des clés).
  for (const t of tracks) {
    if (t.family === "h264") await initH264(source, t);
  }
  // Audio sans famille (tag 0xFFFE/inconnu) : sniff du 1er chunk.
  // + repli avih pour le timing vidéo si strh muet.
  for (const t of tracks) {
    if (t.ffCodecType === T_VIDEO && t.frameDurNs <= 0n && avih?.usPerFrame > 0) {
      t.frameDurNs = BigInt(avih.usPerFrame) * 1000n;
    }
    if (t.ffCodecType === T_AUDIO && t.family === "unknown" && t.chunks.length) {
      await sniffAudioTrack(source, t);
    }
  }
  // Durée : vidéo (ordinal exact), sinon -1 (audio-only : strh peu fiable).
  let durationNs = -1n;
  const vt = tracks.find((t) => t.ffCodecType === T_VIDEO);
  if (vt && vt.frameDurNs > 0n) {
    durationNs = BigInt(vt.chunks.length) * vt.frameDurNs;
  }
  let readPos = size;
  for (const t of tracks) {
    if (t.chunks.length && t.chunks[0].off < readPos) readPos = t.chunks[0].off;
  }
  return {
    kind: "avi",
    tracks,
    durationNs,
    avireadPos: readPos,
    fileSize: size,
    avi: { hasIndex },
  };
}

function parseHdrl(payload) {
  let avih = null;
  const streams = [];
  let p = 0;
  while (p + 8 <= payload.length) {
    const h = chunkHeader(payload, p);
    const ds = p + h.hdr, de = Math.min(payload.length, p + h.hdr + h.size);
    if (!h.isList && h.id === "avih") {
      avih = parseAvih(payload, ds, de);
    } else if (h.isList && h.listType === "strl") {
      streams.push(parseStrl(payload, ds, de));
    }
    const nx = Number(chunkEnd(BigInt(p), h));
    if (nx <= p) break;
    p = nx;
  }
  return { avih, streams };
}

function buildTrack(s, index) {
  const t = {
    index,
    number: BigInt(index),
    kind: s.fccType === "vids" ? 1 : 2,
    codecId: "",
    family: "unknown",
    ffCodecId: 0,
    ffCodecType: s.fccType === "vids" ? T_VIDEO : T_AUDIO,
    profile: -1, level: -1, audioProfile: -1,
    width: 0, height: 0, channels: 0, sampleRate: 0,
    codecPrivate: new Uint8Array(0),
    extradata: new Uint8Array(0),
    name: s.name || "",
    timescale: 1,
    defaultDurationNs: 0n,
    chunks: [], // {off,size,key}
    cursor: 0,
    cum: [0n], // audio : échantillon de départ du chunk i (BigInt)
    h264: null,
    bitsPerSample: 0,
    isFloat: false,
    frameDurNs: 0n,
    _strh: s,
  };
  if (s.fccType === "vids") {
    const fourcc = s.strf.compression || s.handler;
    t.codecId = fourcc;
    const m = mapVideoCodec(fourcc);
    t.family = m.family;
    t.ffCodecId = m.id;
    t.width = Math.abs(s.strf.width || 0);
    t.height = Math.abs(s.strf.height || 0);
    // Timing : strh rate/scale, sinon avih (traité par l'appelant si besoin).
    if (s.rate > 0 && s.scale > 0) {
      t.timescale = s.rate / gcd(s.rate, s.scale);
      t._tickScale = s.scale / gcd(s.rate, s.scale);
      t.frameDurNs = (1000000000n * BigInt(s.scale)) / BigInt(s.rate);
    }
    if (t.family === "h264") {
      t.h264 = { format: null, avcC: null };
      const strd = s.strd;
      if (strd && strd.length > 7 && strd[0] === 1) {
        // avcC fourni (rare en AVI) : gardé si les paquets sont length-prefixed
        // (initH264 tranche par détection sur le 1er chunk).
        t.h264.avcC = Uint8Array.from(strd);
      }
    }
  } else {
    const tag = s.strf.tag;
    t.codecId = `tag0x${tag.toString(16).padStart(4, "0")}`;
    const m = mapAudioTag(tag);
    t.family = m.family;
    t.ffCodecId = m.id;
    t.channels = s.strf.channels || 0;
    t.sampleRate = s.strf.sampleRate || 0;
    t.timescale = t.sampleRate || 1;
    t.bitsPerSample = s.strf.bitsPerSample || 0;
    t.isFloat = tag === 0x0003;
    if (s.strf.ext && s.strf.ext.length) {
      t.codecPrivate = Uint8Array.from(s.strf.ext);
      t.extradata = t.codecPrivate;
    }
    if (t.family === "aac" && t.extradata.length) {
      t.audioProfile = aacProfile(t.extradata);
    }
  }
  return t;
}

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const x = a % b; a = b; b = x; }
  return a || 1;
}

/** idx1 → listes de chunks (offsets vérifiés). Retourne true si index utilisable. */
async function applyIdx1(source, idx1, movi, tracks) {
  if (idx1.size > 256n * 1048576n || idx1.size < 16n) return false;
  const buf = await source.read(idx1.off, Number(idx1.size));
  if (buf.length < 16) return false;
  const n = Math.floor(buf.length / 16);
  // Bases d'offsets rencontrées (ffmpeg : position du fourcc 'movi',
  // soit listOff+8 ; variantes : payload, liste, fichier).
  const bases = [movi.listOff + 8n, movi.payloadOff, movi.listOff, 0n];
  const per = tracks.map(() => []);
  let usable = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const id = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    const flags = (buf[o + 4] | (buf[o + 5] << 8) | (buf[o + 6] << 16)) + buf[o + 7] * 0x1000000;
    const off = (buf[o + 8] | (buf[o + 9] << 8) | (buf[o + 10] << 16)) + buf[o + 11] * 0x1000000;
    const sz = (buf[o + 12] | (buf[o + 13] << 8) | (buf[o + 14] << 16)) + buf[o + 15] * 0x1000000;
    if (sz === 0) {
      // Chunk vide (padding d'encodeur, ex. ffmpeg) : gardé pour l'ordinal
      // (il consomme un tick de présentation, cf. ffprobe : pts 0,80,120…),
      // mais n'émettra aucun paquet.
    }
    const si = streamIdxFromId(id, tracks.length);
    if (si < 0) continue;
    // Vérifie la base : l'en-tête sur place doit correspondre (id + taille).
    let abs = null;
    for (const b of bases) {
      const cand = b + BigInt(off);
      const hb = await source.read(cand, 8).catch(() => null);
      if (hb && hb.length >= 8 &&
          hb[0] === buf[o] && hb[1] === buf[o + 1] && hb[2] === buf[o + 2] && hb[3] === buf[o + 3]) {
        const s2 = (hb[4] | (hb[5] << 8) | (hb[6] << 16)) + hb[7] * 0x1000000;
        if (s2 === sz) { abs = cand; break; }
      }
    }
    if (abs === null) continue;
    per[si].push({ off: abs + 8n, size: sz, key: !!(flags & 0x10), id });
    usable++;
  }
  if (!usable) return false;
  for (let i = 0; i < tracks.length; i++) tracks[i].chunks = per[i];
  return true;
}

/** Balayage movi séquentiel (sans idx1) : descente récursive ('rec ' inclus). */
async function walkMovi(source, movi, fileSize, tracks) {
  const end = movi.payloadOff + movi.size;
  const stack = [{ off: movi.payloadOff, end: end > fileSize ? fileSize : end }];
  let guard = 0;
  const push = (off, size, id) => {
    const si = streamIdxFromId(id, tracks.length);
    if (si < 0) return;
    const suf = id.slice(2);
    if (suf !== "dc" && suf !== "db" && suf !== "wb") return; // 'tx'/autres : sautés (v1)
    tracks[si].chunks.push({ off: off + 8n, size, key: false, id }); // vides inclus (ordinal)
  };
  while (stack.length && guard++ < MAX_MOVI_CHUNKS) {
    const { off, end: e } = stack.pop();
    if (off + 8n >= e) continue;
    const hb = await source.read(off, 12).catch(() => null);
    if (!hb || hb.length < 8) continue;
    const h = chunkHeader(hb, 0);
    if (h.isList) {
      // Descend (quel que soit le type : 'rec ' ou autre).
      const inner = off + 12n, iend = off + 12n + BigInt(h.size) - 4n;
      // On traite séquentiellement : empile la suite, descend d'abord.
      stack.push({ off: off + 12n + BigInt(h.size) - 4n + BigInt((h.size - 4) & 1), end: e });
      stack.push({ off: inner, end: iend > e ? e : iend });
      void inner;
      continue;
    }
    const full = chunkEnd(off, { hdr: 8, size: BigInt(h.size) });
    push(off, h.size, h.id);
    const nx = full > e ? e : full;
    if (nx > off) stack.push({ off: nx, end: e });
  }
}

/** H264 : détecte le format + construit avcC (SPS/PPS in-band). */
async function initH264(source, t) {
  const strdAvcC = t.h264.avcC; // éventuel avcC fourni (rare en AVI)
  const keyChunks = t.chunks.filter((c) => c.key);
  const cands = (keyChunks.length ? keyChunks : t.chunks).slice(0, 10);
  for (const c of cands) {
    let data;
    try {
      data = await source.read(c.off, Math.min(c.size, 1048576));
    } catch {
      continue;
    }
    if (!data.length) continue;
    const det = detectH264Format(data) ?? "annexb";
    t.h264.format = det;
    if (det === "annexb") {
      t.h264.avcC = null; // un strd-avcC serait incohérent avec des paquets Annex B
      const { sps, pps } = findParamSets(splitAnnexB(data));
      if (sps && pps) {
        t.h264.avcC = buildAvcC(sps, pps);
        break;
      }
    } else {
      t.h264.avcC = strdAvcC; // avcc : seul un strd peut fournir l'avcC
      break;
    }
  }
  if (!t.h264.format) t.h264.format = "annexb";
  if (t.h264.avcC) {
    t.codecPrivate = Uint8Array.from(t.h264.avcC);
    t.extradata = t.codecPrivate;
    const pl = avcProfileLevel(t.codecPrivate);
    t.profile = pl.profile;
    t.level = pl.level;
  }
}

/** Sniff du 1er chunk audio (tags 0xFFFE/inconnus) + ASC AAC de repli. */
async function sniffAudioTrack(source, t) {
  const c = t.chunks[0];
  let data;
  try {
    data = await source.read(c.off, Math.min(c.size, 8192));
  } catch {
    return;
  }
  if (!data.length) return;
  const fam = sniffAudioChunk(data);
  if (!fam) return;
  t.family = fam;
  t.ffCodecId = AUDIO_IDS[fam] ?? 0;
  t.codecId = fam;
  if (fam === "aac" && !t.extradata.length) {
    const asc = ascFromAdts(data);
    if (asc) {
      t.codecPrivate = asc;
      t.extradata = asc;
      t.audioProfile = aacProfile(asc);
    }
  }
}

/** Échantillons d'un chunk audio décodé (sans émission). */
function countChunkSamples(t, data) {
  switch (t.family) {
    case "mp3": {
      let n = 0;
      for (const f of splitMp3Chunk(data)) n += f.spf;
      return n;
    }
    case "ac3":
    case "eac3": {
      let n = 0;
      for (const f of splitAc3Frames(data)) n += ac3FrameSamples(f);
      return n;
    }
    case "pcm": {
      const align = t._strh.sampleSize > 0 ? t._strh.sampleSize
        : t.channels * (t.bitsPerSample || 16) / 8;
      if (!(align > 0)) return 0;
      return Math.floor(data.length / align);
    }
    case "aac": {
      let n = 0;
      for (const f of splitAdtsChunk(data)) n += f.samples;
      return n;
    }
    default:
      return 0;
  }
}

/** Étend cum[] (échantillons cumulés par chunk) jusqu'à couvrir `unit`. */
async function extendCum(lib, name, t, unit) {
  while (t.cum.length <= t.chunks.length) {
    const i = t.cum.length - 1; // chunk à mesurer
    if (i >= t.chunks.length) break;
    if (t.cum[i] >= unit && i > 0) break;
    const c = t.chunks[i];
    let data;
    try {
      data = await lib.read(name, c.off, c.size);
    } catch {
      break;
    }
    if (!data || data.length < c.size) break;
    t.cum.push(t.cum[i] + BigInt(countChunkSamples(t, data)));
    if (t.cum[t.cum.length - 1] >= unit) break;
  }
}

/** Lecture bornée → { res:0|-11, eof, byIdx }. Fusion par offset fichier. */
export async function readAvi(session, lib, name, opts = {}) {
  const limit = BigInt(opts.limit ?? 524288);
  const byIdx = {};
  const tracks = session.avi.tracks;
  let spent = 0n;
  for (let guard = 0; guard < MAX_PACKETS_PER_READ; guard++) {
    let bi = -1, boff = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.cursor >= t.chunks.length) continue;
      const o = t.chunks[t.cursor].off;
      if (bi < 0 || o < boff) { bi = i; boff = o; }
    }
    if (bi < 0) {
      session.readPos = session.size;
      return { res: 0, eof: true, byIdx };
    }
    const t = tracks[bi];
    const c = t.chunks[t.cursor];
    if (c.size === 0) {
      // Chunk vide (padding) : consomme l'ordinal, n'émet rien.
      t.cursor++;
      session.readPos = c.off;
      continue;
    }
    let data;
    try {
      data = await lib.read(name, c.off, c.size);
    } catch {
      return { res: -11, eof: false, byIdx };
    }
    if (!data || data.length < c.size) {
      t.cursor++; // chunk illisible : saute (pas de boucle infinie)
      continue;
    }
    const pkts = packetsForChunk(t, c, data, session.avi.hasIndex);
    for (const p of pkts) {
      (byIdx[t.index] = byIdx[t.index] ?? []).push(p);
    }
    t.cursor++;
    spent += BigInt(data.length);
    session.readPos = c.off + BigInt(data.length);
    if (spent >= limit) return { res: 0, eof: false, byIdx };
  }
  return { res: 0, eof: false, byIdx };
}

function packetsForChunk(t, c, data, hasIndex) {
  if (t.ffCodecType === T_VIDEO) {
    const ord = t.cursor; // ordinal fichier (vides inclus : parité ffprobe)
    const pts = t.frameDurNs > 0n ? Number(BigInt(ord) * t.frameDurNs) : 0;
    let payload = data;
    let key = c.key;
    if (t.family === "h264" && t.h264) {
      if ((t.h264.format ?? "annexb") === "annexb") {
        const nals = splitAnnexB(data);
        payload = annexbToAvcc(data);
        if (!hasIndex) key = firstNalType(nals) === 5;
      } else if (!hasIndex) {
        key = keyIsIdrAvcc(data);
      }
    }
    const dur = t.frameDurNs > 0n ? Number(t.frameDurNs) : 0;
    return [{
      pts, dts: pts, size: payload.length, data: payload,
      time_base_num: 1, time_base_den: 1000000000, duration: dur, key: !!key,
    }];
  }
  // Audio : découpe + pts cumulés.
  const sr = t.timescale || t.sampleRate || 1;
  const base = t.cum[t.cursor] ?? 0n;
  const out = [];
  const pushPcm = (samples, bytes) => {
    out.push({
      pts: nsSamp(base + BigInt(out._s ?? 0), sr),
      dts: nsSamp(base + BigInt(out._s ?? 0), sr),
      size: bytes.length, data: bytes,
      time_base_num: 1, time_base_den: 1000000000,
      duration: nsSamp(BigInt(samples), sr), key: true,
    });
    out._s = (out._s ?? 0) + samples;
  };
  if (t.family === "mp3") {
    for (const f of splitMp3Chunk(data)) {
      pushPcm(f.spf, data.slice(f.off, f.off + f.len));
    }
  } else if (t.family === "ac3" || t.family === "eac3") {
    const frames = splitAc3Frames(data);
    if (!frames.length) {
      // Chunk sans sync (padding) : 0 échantillon, cum inchangé.
    }
    for (const f of frames) {
      const n = ac3FrameSamples(f) || (t.family === "ac3" ? 1536 : 0);
      if (!n) continue;
      pushPcm(n, f);
    }
  } else if (t.family === "pcm") {
    const align = t._strh.sampleSize > 0 ? t._strh.sampleSize
      : t.channels * (t.bitsPerSample || 16) / 8;
    const n = align > 0 ? Math.floor(data.length / align) : 0;
    if (n > 0) pushPcm(n, data);
  } else if (t.family === "aac") {
    for (const f of splitAdtsChunk(data)) {
      pushPcm(f.samples, data.slice(f.off, f.off + f.len));
    }
  } else {
    // Audio inconnu : paquet brut (le décodeur échouera proprement).
    pushPcm(0, data);
  }
  const total = out._s ?? 0;
  delete out._s;
  // cum[i+1] : borne de fin du chunk i (cohérent avec extendCum).
  t.cum[t.cursor + 1] = base + BigInt(total);
  return out;
}

/** Première NAL == IDR dans un chunk avcc (repli sans idx1). */
function keyIsIdrAvcc(data) {
  try {
    return firstNalType(avccNals(data)) === 5;
  } catch {
    return false;
  }
}

function avccNals(data) {
  const out = [];
  let p = 0;
  const v = new DataView(data.buffer, data.byteOffset, data.length);
  while (p + 4 <= data.length) {
    const len = v.getUint32(p, false);
    p += 4;
    if (len <= 0 || p + len > data.length) break;
    out.push(data.subarray(p, p + len));
    p += len;
  }
  return out;
}

/** Seek : vidéo par ordinal+clé, audio par cumul exact (extension paresseuse). */
export async function seekAvi(session, lib, name, targetNs) {
  const tracks = session.avi.tracks;
  const hasIndex = session.avi.hasIndex;
  if (!hasIndex) {
    for (const t of tracks) t.cursor = 0;
    const rp = session.size;
    session.readPos = rp;
    session.eof = false;
    return;
  }
  for (const t of tracks) {
    if (!t.chunks.length) { t.cursor = 0; continue; }
    if (t.ffCodecType === T_VIDEO) {
      const dur = t.frameDurNs > 0n ? t.frameDurNs : 40000000n;
      let ord = Number(BigInt(targetNs < 0n ? 0n : targetNs) / dur);
      if (ord < 0) ord = 0;
      if (ord >= t.chunks.length) ord = t.chunks.length - 1;
      // Recul keyframe en sautant les vides, puis avance past les vides
      // (atterrir sur un vide casserait l'amorçage du décodeur).
      let k = ord;
      while (k > 0 && (!t.chunks[k].key || t.chunks[k].size === 0)) k--;
      if (!t.chunks[k].key || t.chunks[k].size === 0) {
        k = 0;
        while (k < t.chunks.length && (!t.chunks[k].key || t.chunks[k].size === 0)) k++;
        if (k >= t.chunks.length) k = Math.min(ord, t.chunks.length - 1);
      }
      while (k < t.chunks.length && t.chunks[k].size === 0) k++;
      t.cursor = Math.min(Math.max(0, k), t.chunks.length);
    } else {
      // Audio : unité = échantillons @sr.
      const sr = t.timescale || t.sampleRate || 1;
      const unit = (BigInt(targetNs < 0n ? 0n : targetNs) * BigInt(sr)) / 1000000000n;
      await extendCum(lib, name, t, unit).catch(() => {});
      // Dernier chunk avec cumStart <= unit.
      let lo = 0, hi = t.cum.length - 1;
      if (hi < 0) { t.cursor = 0; continue; }
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (t.cum[m] <= unit) lo = m;
        else hi = m - 1;
      }
      t.cursor = Math.min(lo, t.chunks.length);
      // Tronque cum au curseur : cum[cursor] reste défini, la suite se
      // reconstruira à la lecture (pas de trou dans l'index).
      t.cum.length = Math.min(t.cum.length, t.cursor + 1);
    }
  }
  let rp = session.size;
  for (const t of tracks) {
    if (t.cursor < t.chunks.length && t.chunks[t.cursor].off < rp) rp = t.chunks[t.cursor].off;
  }
  session.readPos = rp;
  session.eof = false;
}
