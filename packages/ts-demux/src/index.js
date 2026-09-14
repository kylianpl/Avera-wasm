// packages/ts-demux/src/index.js — démuxeur MPEG-TS maison (188/192o).
// PAT/PMT (CRC32) → streams ; PES réassemblés par PID ; PTS/DTS 90kHz.
// Vidéo H264/HEVC Annex B → avcc + avcC/hvcC in-band (SPS parsés : dims,
// profil/niveau), clés IDR/IRAP ; MPEG-2 (séquence→clé) et DTS (frames)
// en passthrough (SW decode : étape 6). Audio AAC-ADTS→RAW, AC3/EAC3/MP3
// découpés, pts cumulés intra-PES. Durée par PCR (repli -1). Seek : estimé
// bitrate + resync + avance à la clé (approximatif documenté, sans index).
// Limites v1 : LATM, LPCM-BD, VC-1, télétexte/sous-titres, multi-programmes
// (1er avec A/V), brouillé (paquets sautés), sections longues >64Ko.

import { sniffTs, detectStride, parseTsHeader, resyncTs, TS_LEN, M2TS_LEN } from "./ts.js";
import { feedSection, parsePat, parsePmt } from "./psi.js";
import { parsePesHeader, ns90k } from "./pes.js";
import { splitAnnexB, annexbToAvcc } from "../../mkv-demux/src/annexb.js";
import {
  detectH264Format, buildAvcC, findParamSets, nalsHaveIdr,
  splitMp3Chunk, parseAdtsHeader, splitAdtsChunk, sniffAudioChunk, AUDIO_IDS,
} from "../../avi-demux/src/codecs.js";
import { parseFrameHeader } from "../../mp3-demux/src/frames.js";
import { splitAc3Frames, ac3FrameSamples } from "../../sw-decode/src/ac3frames.js";
import { packetNals } from "../../sw-decode/src/index.js";

export { sniffTs };

const MAX_PACKETS_PER_READ = 400;
const WINDOW = 1048576;
const MAX_PSI_SCAN = 4 * 1048576;

/** Lecteur de bits MSB-first (SPS/HVC/MPEG2/DTS). */
function MSBR(buf, off = 0) {
  let byte = off, bits = 0, nbits = 0;
  return {
    u(n) {
      let v = 0;
      while (n > 0) {
        if (nbits === 0) {
          if (byte >= buf.length) throw new RangeError("bits épuisés");
          bits = buf[byte++];
          nbits = 8;
        }
        const take = Math.min(n, nbits);
        v = (v << take) | ((bits >> (nbits - take)) & ((1 << take) - 1));
        nbits -= take;
        n -= take;
      }
      return v >>> 0;
    },
    ue() {
      let z = 0;
      while (this.u(1) === 0) {
        z++;
        if (z > 31) throw new RangeError("ue démesuré");
      }
      return ((1 << z) - 1) + (z ? this.u(z) : 0);
    },
    se() {
      const v = this.ue();
      return v & 1 ? (v + 1) >> 1 : -(v >> 1);
    },
  };
}

/** Retire l'emulation prevention (0x000003) → RBSP. */
function ebspToRbsp(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
      out.push(0, 0);
      i += 2;
    } else out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

function skipScalingList(r, size) {
  let last = 8, next = 8;
  for (let j = 0; j < size; j++) {
    if (next) {
      const d = r.se();
      next = (last + d + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

/** SPS H264 (NAL brute sans header) → { width, height } ou null. */
function parseSpsAvc(nal) {
  try {
    if (!nal || nal.length < 2) return null;
    const r = MSBR(ebspToRbsp(nal), 1); // saute le header NAL (0x67)
    const profile = r.u(8);
    r.u(8); r.u(8); // constraints + level
    r.ue(); // sps_id
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = r.ue();
      if (chroma === 3) r.u(1);
      r.ue(); r.ue(); // bit depths
      r.u(1); // qpprime
      if (r.u(1)) {
        const n = chroma === 3 ? 12 : 8;
        for (let i = 0; i < n; i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
    r.ue(); // log2_max_frame_num-4
    const poc = r.ue();
    if (poc === 0) r.ue();
    else if (poc === 1) {
      r.u(1); r.se(); r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue(); r.u(1); // max_num_ref_frames + gaps
    const w = (r.ue() + 1) * 16, h = (r.ue() + 1) * 16;
    const frameOnly = r.u(1);
    if (!frameOnly) r.u(1);
    r.u(1); // direct_8x8
    let cropl = 0, cropr = 0, cropt = 0, cropb = 0;
    if (r.u(1)) {
      cropl = r.ue(); cropr = r.ue(); cropt = r.ue(); cropb = r.ue();
    }
    const subW = chroma === 1 || chroma === 2 ? 2 : 1;
    const subH = chroma === 1 ? 2 : 1;
    // Fixtures progressives (frame_mbs_only=1) : crop direct.
    const hh = frameOnly ? h : h * 2;
    return {
      width: w - subW * (cropl + cropr),
      height: hh - subH * (cropt + cropb),
    };
  } catch {
    return null;
  }
}

/** SPS HEVC (NAL brute avec header 2o) → { width, height, profile, level }. */
function parseSpsHevc(nal) {
  try {
    if (!nal || nal.length < 3) return null;
    const r = MSBR(ebspToRbsp(nal), 2); // saute le header NAL 2o
    r.u(4); // vps_id
    const maxSub = r.u(3);
    r.u(1); // temporal_nesting
    // profile_tier_level(1, maxSub)
    r.u(2); r.u(1);
    const profile = r.u(5);
    r.u(32); r.u(32); r.u(16); // compat + constraints
    const level = r.u(8);
    if (maxSub > 0) {
      let flags = 0;
      for (let i = 0; i < maxSub; i++) {
        if (r.u(1)) flags |= 1 << i; // sub_profile_present
        r.u(1); // sub_level_present
      }
      for (let i = 0; i < maxSub; i++) {
        if (flags & (1 << i)) {
          r.u(2); r.u(1); r.u(5); r.u(32); r.u(32); r.u(16); r.u(8);
        }
      }
    }
    r.ue(); // sps_id
    const chroma = r.ue();
    if (chroma === 3) r.u(1);
    const w = r.ue(), h = r.ue();
    let cropl = 0, cropr = 0, cropt = 0, cropb = 0;
    if (r.u(1)) {
      cropl = r.ue(); cropr = r.ue(); cropt = r.ue(); cropb = r.ue();
    }
    const subW = chroma === 1 || chroma === 2 ? 2 : 1;
    const subH = chroma === 1 ? 2 : 1;
    return {
      width: w - subW * (cropl + cropr),
      height: h - subH * (cropt + cropb),
      profile, level,
    };
  } catch {
    return null;
  }
}

/** hvcC minimal depuis VPS/SPS/PPS (pour HEVCSession + bridge). */
function buildHvcC(vps, sps, pps, profile, level) {
  const arrays = [];
  const push = (tag, nals) => {
    if (!nals.length) return;
    const h = [tag | 0x80, 0, nals.length];
    const body = [];
    for (const n of nals) {
      body.push((n.length >> 8) & 0xff, n.length & 0xff, ...n);
    }
    arrays.push([...h, ...body]);
  };
  push(0xa0, vps); push(0xa1, sps); push(0xa2, pps);
  const prof = profile || 1;
  const rec = [
    1, // version
    prof & 0x1f, // profile_space(0)+tier(0)+profile_idc
    prof <= 3 ? 0x60 : 0x00, // compatibilité (Main/Main10/MainSP)
    0, 0, 0, // compatibilité (suite)
    0, 0, 0, 0, 0, 0, // contraintes
    level || 120, // level_idc (défaut 4.0)
    0xf0, 0x00, // min_spatial_segmentation + reserved
    0xfc, // parallelismType
    0xfc, // chroma 4:2:0, 8 bits (défauts ; le SW lit les NALs)
    0xf8, 0x00, 0x00, 0x00, // bitrate/volume pic (inconnus)
    arrays.length,
  ];
  return Uint8Array.from([...rec, ...arrays.flat()]);
}

const MPEG2_FPS = [0, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

/** Séquence MPEG-2 (après 0x000001B3) → { width, height, fps } ou null. */
function parseMpeg2SeqHead(b) {
  if (b.length < 7) return null;
  const w = (b[0] << 4) | (b[1] >> 4);
  const h = ((b[1] & 0x0f) << 8) | b[2];
  const fr = (b[3] >> 0) & 0x0f;
  if (!w || !h) return null;
  return { width: w, height: h, fps: MPEG2_FPS[fr] || 25 };
}

/** Header AC-3 (sync 0x0B77) → { rate, channels } ou null.
 * Parse bit-exact jusqu'à lfeon (cmix/surmix/dsurmod conditionnels). */
function parseAc3Head(b) {
  if (b.length < 7 || b[0] !== 0x0b || b[1] !== 0x77) return null;
  try {
    let byte = 4, bit = 0;
    const u = (n) => {
      let v = 0;
      while (n > 0) {
        if (byte >= b.length) throw new RangeError("ac3 court");
        const avail = 8 - bit;
        const take = Math.min(n, avail);
        v = (v << take) | ((b[byte] >> (avail - take)) & ((1 << take) - 1));
        bit += take;
        n -= take;
        if (bit >= 8) { byte++; bit = 0; }
      }
      return v;
    };
    const fscod = u(2), frmsizecod = u(6);
    if (fscod === 3 || frmsizecod >= 38) return null;
    u(5); u(3); // bsid + bsmod
    const acmod = u(3);
    if ((acmod & 0x01) && acmod !== 0x01) u(2); // cmixlev
    if (acmod & 0x04) u(2); // surmixlev
    if (acmod === 0x02) u(2); // dsurmod
    const lfe = u(1);
    const rate = [48000, 44100, 32000][fscod];
    const chmap = [2, 1, 2, 3, 3, 4, 4, 5];
    return { rate, channels: chmap[acmod] + lfe };
  } catch {
    return null;
  }
}

/** Header E-AC-3 (≥5o) → { rate, channels } ou null (chanmap exotique : défaut). */
function parseEac3Head(b) {
  if (b.length < 5 || b[0] !== 0x0b || b[1] !== 0x77) return null;
  const strmtyp = (b[2] >> 6) & 0x03;
  if (strmtyp === 3) return null;
  const fscod = (b[4] >> 6) & 0x03;
  if (fscod === 3) {
    if (b.length < 6) return null;
    const fscod2 = (b[5] >> 6) & 0x03;
    if (fscod2 === 3) return null;
    return { rate: [24000, 22050, 16000][fscod2], channels: 2 };
  }
  return { rate: [48000, 44100, 32000][fscod], channels: 2 };
}

/** ASC 2o depuis un header ADTS (profil LC forcé comme avi-demux). */
function ascFromAdtsHeader(b) {
  if (b.length < 4) return null;
  const freqIdx = (b[2] >> 2) & 0x0f;
  const chCfg = ((b[2] & 0x01) << 2) | ((b[3] >> 6) & 0x03);
  if (freqIdx >= 13) return null;
  return Uint8Array.from([(2 << 3) | (freqIdx >> 1), ((freqIdx & 1) << 7) | (chCfg << 3)]);
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Frame DTS core (sync BE) → { len, samples, rate, channels } ou null. */
function parseDtsCore(b) {
  if (b.length < 10) return null;
  const be = b[0] === 0x7f && b[1] === 0xfe && b[2] === 0x80 && b[3] === 0x01;
  const le14 = b[0] === 0xff && b[1] === 0x1f && b[2] === 0x00 && b[3] === 0xe8;
  const le16 = b[0] === 0xfe && b[1] === 0x7f && b[2] === 0x01 && b[3] === 0x80;
  if (!be && !le14 && !le16) return null;
  if (!be) return null; // LE/14 bits : refusé v1 (documenté)
  const nblks = ((b[4] & 0x01) << 6) | ((b[5] >> 2) & 0x3f);
  const fsize = (((b[5] & 0x03) << 12) | (b[6] << 4) | (b[7] >> 4)) + 1;
  const amode = ((b[7] & 0x0f) << 2) | ((b[8] >> 6) & 0x03);
  const sfreq = (b[8] >> 2) & 0x0f;
  const rates = [0, 8000, 16000, 32000, 0, 0, 11025, 22050, 44100, 0, 0, 12000, 24000, 48000, 96000, 192000];
  const rate = rates[sfreq] || 48000;
  const chmap = [1, 2, 2, 2, 2, 3, 3, 4, 2, 3, 4, 5, 6, 6, 6, 7];
  const channels = (amode < 16 ? chmap[amode] : 2);
  if (fsize < 96 || fsize > 16384) return null;
  return { len: fsize, samples: (nblks + 1) * 32, rate, channels };
}

/** Découpe DTS (sync BE) en frames [{off,len,samples}]. */
function splitDtsFrames(data) {
  const out = [];
  let i = 0;
  while (i + 10 <= data.length) {
    if (!(data[i] === 0x7f && data[i + 1] === 0xfe && data[i + 2] === 0x80 && data[i + 3] === 0x01)) {
      i++;
      continue;
    }
    const f = parseDtsCore(data.subarray(i, Math.min(i + 16, data.length)));
    if (!f || i + f.len > data.length) break;
    out.push({ off: i, len: f.len, samples: f.samples });
    i += f.len;
  }
  return out;
}

/** Scan borné (début) : collecte PAT puis PMT. Retourne les streams mappés.
 * source = adaptée (baseOff appliquée par l'appelant). */
async function scanPsi(source, size, stride, skip) {
  const patState = { buf: null };
  let pat = [];
  const pmtStates = new Map();
  const pmts = new Map(); // pmtPid -> streams
  const want = size < BigInt(MAX_PSI_SCAN) ? size : BigInt(MAX_PSI_SCAN);
  let win = null;
  try {
    win = await source.read(0n, Number(want));
  } catch {
    throw new Error("TS illisible (PSI)");
  }
  const pktLen = stride;
  let resyncs = 0;
  for (let o = 0; o + pktLen <= win.length; o += pktLen) {
    let h = parseTsHeader(win, o, skip);
    if (!h) {
      // Désync : resync borné (max 8), puis reprend sur la grille.
      if (++resyncs > 8) break;
      let found = -1;
      for (let k = o + 1; k + pktLen <= win.length && k < o + 2048; k++) {
        if (win[k + skip] === 0x47 && win[k + skip + pktLen] === 0x47) { found = k; break; }
      }
      if (found < 0) break;
      o = found - pktLen; // le o += pktLen de boucle atterrit sur found
      continue;
    }
    const end = Math.min(win.length, o + pktLen);
    if (h.tei || h.scrambled || h.payloadOff < 0 || h.payloadOff > end) continue;
    const payload = win.subarray(h.payloadOff, end);
    if (h.pid === 0) {
      const sec = feedSection(patState, payload, h.pusi);
      if (sec) pat = parsePat(sec);
    } else {
      const pm = [...pat].find((p) => p.pmtPid === h.pid);
      if (pm && !pmts.has(h.pid)) {
        if (!pmtStates.has(h.pid)) pmtStates.set(h.pid, { buf: null });
        const sec = feedSection(pmtStates.get(h.pid), payload, h.pusi);
        if (sec) {
          const streams = parsePmt(sec);
          if (streams.length) pmts.set(h.pid, streams);
        }
      }
    }
    if (pat.length && [...pmts.values()].some((s) => s.length)) break;
  }
  return { pat, pmts };
}

/** Sniff des PIDs privés 0x06 nus : 1er PES (borné 1Mo/6000 paquets).
 * Retourne Map pid -> famille audio ("aac"/"mp3"/"ac3"/"eac3") ou null. */
async function sniffPrivatePids(source, baseOff, size, stride, skip, pids) {
  const out = new Map();
  const asm = new Map(); // pid -> { parts }
  const end = baseOff + (size - baseOff < 1048576n ? size - baseOff : 1048576n);
  await walkTs(source, baseOff, end, stride, skip, 6000, (h, payload) => {
    if (!pids.includes(h.pid) || out.has(h.pid)) return;
    let cur = asm.get(h.pid);
    if (h.pusi) {
      const ph = parsePesHeader(payload);
      if (!ph) return;
      cur = { parts: [payload.subarray(ph.hdrLen)] };
      asm.set(h.pid, cur);
    } else if (cur) {
      cur.parts.push(payload);
    } else return;
    let len = 0;
    for (const c of cur.parts) len += c.length;
    if (len < 16) return;
    const b = new Uint8Array(Math.min(len, 64));
    let o = 0;
    for (const c of cur.parts) {
      const n = Math.min(c.length, b.length - o);
      b.set(c.subarray(0, n), o);
      o += n;
      if (o >= b.length) break;
    }
    const fam = sniffAudioChunk(b);
    if (fam && (AUDIO_IDS[fam] ?? 0)) {
      out.set(h.pid, fam);
      asm.delete(h.pid);
    } else if (len >= 4096) {
      out.set(h.pid, null); // assez vu : non-audio
      asm.delete(h.pid);
    }
  });
  for (const pid of pids) if (!out.has(pid)) out.set(pid, null);
  return out;
}

function buildTrack(m, index) {  const isVideo = m.family === "h264" || m.family === "hevc" || m.family === "mpeg2video";
  return {
    index,
    number: BigInt(index + 1),
    kind: isVideo ? 1 : 2,
    codecId: m.family,
    family: m.family,
    ffCodecId: m.id,
    ffCodecType: isVideo ? 0 : 1,
    profile: -1, level: -1, audioProfile: -1,
    width: 0, height: 0, channels: 0, sampleRate: 0,
    codecPrivate: new Uint8Array(0),
    extradata: new Uint8Array(0),
    name: "",
    timescale: 90000,
    defaultDurationNs: 0n,
    _pid: m.pid,
    _streamType: m.streamType,
    _pes: null, // assembleur PES courant { buf[], pts, dts, gotHeader }
    _lastEnd: 0n, // fin (ticks) du dernier paquet émis (repli sans PTS)
    _prevV: null, // paquet vidéo précédent (backfill durée)
    _fps: 0, // mpeg2video
  };
}

/** Lit des paquets TS séquentiels depuis `pos` (stride), appelle `cb(h, payload).
 * Retourne la nouvelle pos. S'arrête à `end` ou après `maxPkts`. */
async function walkTs(source, pos, end, stride, skip, maxPkts, cb) {
  let p = BigInt(pos);
  const stop = BigInt(end);
  let n = 0;
  let buf = null, boff = 0n;
  const need = Math.min(Number(stop - p), WINDOW);
  try {
    buf = await source.read(p, need > 0 ? need : 0);
  } catch {
    return p;
  }
  boff = p;
  while (p + BigInt(stride) <= stop && n < maxPkts) {
    if (p < boff || p + BigInt(stride) > boff + BigInt(buf.length)) {
      const nn = Math.min(Number(stop - p), WINDOW);
      try {
        buf = await source.read(p, nn > 0 ? nn : 0);
      } catch {
        return p;
      }
      boff = p;
      if (!buf.length) return p;
    }
    const rel = Number(p - boff);
    const h = parseTsHeader(buf, rel, skip);
    if (!h) { p += 1n; continue; } // désync : avance à l'octet (resync externe si besoin)
    if (!h.tei && !h.scrambled && h.payloadOff >= 0) {
      const pend = boff + BigInt(buf.length);
      const pktEnd = p + BigInt(stride);
      const from = h.payloadOff - rel >= 0 ? h.payloadOff : rel;
      const to = Number((pktEnd <= pend ? pktEnd : pend) - boff);
      if (to > from) cb(h, buf.subarray(from, to), p);
    }
    p += BigInt(stride);
    n++;
  }
  return p;
}

export async function openTs(source) {
  const size = BigInt(await source.getSize());
  if (size < 188n) throw new Error("fichier trop petit pour TS");
  const head = await source.read(0n, 512);
  let det = detectStride(head);
  let pos = 0n;
  if (!det) {
    // Resync au premier alignement plausible (grille 188 puis m2ts 192+4).
    let at = await resyncTs(source, 0n, size < 1048576n ? size : 1048576n, TS_LEN, 0);
    if (at < 0n) at = await resyncTs(source, 0n, size < 1048576n ? size : 1048576n, M2TS_LEN, 4);
    if (at < 0n) throw new Error("sync TS introuvable");
    pos = at;
    const h2 = await source.read(pos, 512);
    det = detectStride(h2) ?? { stride: 188, skip: 0 };
  }
  const { stride, skip } = det;
  const { pat, pmts } = await scanPsi({ read: (o, l) => source.read(BigInt(pos) + BigInt(o), l) }, size - pos, stride, skip);
  if (!pat.length) throw new Error("PAT introuvable");
  // 1er programme avec au moins une vidéo ou un audio décodable.
  let mapped = [];
  for (const [, streams] of pmts) {
    if (streams.some((s) => s.family === "h264" || s.family === "hevc" || s.family === "mpeg2video") ||
        streams.some((s) => s.family === "aac" || s.family === "ac3" || s.family === "eac3" ||
          s.family === "mp3" || s.family === "mp2" || s.family === "dts")) {
      mapped = streams;
      break;
    }
  }
  if (!mapped.length) {
    // Repli : tous les streams mappés du 1er PMT (même sans vidéo connue).
    const first = [...pmts.values()][0];
    if (!first?.length) throw new Error("aucun stream A/V décodable (PMT vide/inconnue)");
    mapped = first;
  }
  // Privés 0x06 nus (sans descripteurs, ex. AAC en m2ts ffmpeg) : sniff
  // du 1er PES (borné 1Mo). Non-audio → piste écartée (sous-titres…).
  if (mapped.some((m) => m.family === "unknown")) {
    const sniffed = await sniffPrivatePids(source, pos, size, stride, skip,
      mapped.filter((m) => m.family === "unknown").map((m) => m.pid));
    mapped = mapped.filter((m) => {
      if (m.family !== "unknown") return true;
      const fam = sniffed.get(m.pid);
      if (!fam || !(AUDIO_IDS[fam] ?? 0)) return false;
      m.family = fam;
      m.id = AUDIO_IDS[fam];
      return true;
    });
    if (!mapped.length) throw new Error("aucun stream A/V décodable (privés non-audio)");
  }
  const tracks = mapped.map((m, i) => buildTrack(m, i));
  const session = {
    kind: "ts",
    tracks,
    durationNs: -1n,
    tsreadPos: pos,
    fileSize: size,
    ts: { stride, skip, baseOff: pos, t0: 0n, pcrRate: 0 },
  };
  // Init codecs (SPS/ASC/headers sur les 1ers PES) + PCR/durée.
  await initCodecs(source, session);
  await initDuration(source, session);
  return session;
}

/** Assemble un PES complet pour `track` à partir des paquets (état t._pes).
 * Retourne le PES { payload, pts, dts, rai } ou null (en cours). Le flag
 * random_access_indicator est accumulé sur tous les paquets du PES. */
function feedPes(t, h, payload) {
  if (h.pusi) {
    // Nouveau PES : termine le précédent s'il a du contenu.
    const prev = t._pes && t._pes.parts.length ? finishPes(t) : null;
    const ph = parsePesHeader(payload);
    if (!ph) {
      t._pes = null;
      return prev;
    }
    t._pes = { parts: [payload.subarray(ph.hdrLen)], pts: ph.pts, dts: ph.dts, rai: h.rai };
    return prev;
  }
  if (!t._pes) return null; // suite sans début : ignore
  t._pes.parts.push(payload);
  t._pes.rai = t._pes.rai || h.rai;
  return null;
}

function finishPes(t) {
  const p = t._pes;
  t._pes = null;
  if (!p || !p.parts.length) return null;
  let len = 0;
  for (const c of p.parts) len += c.length;
  const payload = new Uint8Array(len);
  let o = 0;
  for (const c of p.parts) { payload.set(c, o); o += c.length; }
  return { payload, pts: p.pts, dts: p.dts, rai: !!p.rai };
}

/** Init codecs : scanne les 1ers PES (≤2Mo) pour SPS/ASC/headers. */
async function initCodecs(source, session) {
  const { stride, skip, baseOff } = session.ts;
  const size = session.fileSize;
  const acc = new Map(); // pid -> { parts, pts, dts, started }
  const end = baseOff + (size - baseOff < 2n * 1048576n ? size - baseOff : 2n * 1048576n);
  await walkTs({ read: (o, l) => source.read(o, l) }, baseOff, end, stride, skip, 20000, (h, payload) => {
    const t = session.tracks.find((x) => x._pid === h.pid);
    if (!t) return;
    const prev = feedPes(t, h, payload);
    const cands = [];
    if (prev) cands.push(prev);
    // (le PES en cours sera finalisé au prochain PUSI ; pour l'init on
    // force la finalisation à la fin du scan — voir ci-dessous)
    for (const pes of cands) initFromPes(session, t, pes);
  });
  // Finalise les PES en cours (1er PES vidéo/audio suffit).
  for (const t of session.tracks) {
    const pes = finishPes(t);
    if (pes) initFromPes(session, t, pes);
    t._pes = null;
  }
  // t0 = min des 1ers PTS (normalisation, parité "démarre à 0").
  let t0 = null;
  for (const t of session.tracks) {
    if (t._firstPts != null && (t0 == null || t._firstPts < t0)) t0 = t._firstPts;
  }
  session.ts.t0 = t0 ?? 0n;
  // readPos = 1er paquet média (re-scan rapide : on repart du début).
  session.tsreadPos = baseOff;
  session.readPos = baseOff;
}

function initFromPes(session, t, pes) {
  if (t._firstPts == null && pes.pts != null) t._firstPts = pes.pts;
  const p = pes.payload;
  if (!p.length) return;
  if (t.family === "h264" && !t.extradata.length) {
    const nals = splitAnnexB(p);
    const { sps, pps } = findParamSets(nals);
    if (sps && pps) {
      t.codecPrivate = buildAvcC(sps, pps);
      t.extradata = t.codecPrivate;
      const pl = avcPl(t.codecPrivate);
      t.profile = pl.profile; t.level = pl.level;
      const dims = parseSpsAvc(sps);
      if (dims) { t.width = dims.width; t.height = dims.height; }
    }
  } else if (t.family === "hevc" && !t.extradata.length) {
    const nals = packetNals(p);
    const vps = nals.filter((n) => n.length && ((n[0] >> 1) & 0x3f) === 32);
    const sps = nals.filter((n) => n.length && ((n[0] >> 1) & 0x3f) === 33);
    const pps = nals.filter((n) => n.length && ((n[0] >> 1) & 0x3f) === 34);
    if (sps.length && pps.length) {
      let prof = 1, lev = 120, dims = null;
      const ps = parseSpsHevc(sps[0]);
      if (ps) {
        prof = ps.profile; lev = ps.level;
        dims = { width: ps.width, height: ps.height };
      }
      t.codecPrivate = buildHvcC(vps.slice(0, 1), sps.slice(0, 1), pps.slice(0, 1), prof, lev);
      t.extradata = t.codecPrivate;
      t.profile = prof; t.level = lev;
      if (dims) { t.width = dims.width; t.height = dims.height; }
    }
  } else if (t.family === "aac" && !t.extradata.length) {
    for (const f of splitAdtsChunk(p)) {
      const asc = ascFromAdtsHeader(p.subarray(f.off, f.off + f.len));
      if (asc) {
        t.codecPrivate = asc;
        t.extradata = asc;
        t.audioProfile = 1;
        t.channels = aacChannels(p, f.off);
        t.sampleRate = aacRate(p, f.off);
        break;
      }
    }
  } else if ((t.family === "ac3" || t.family === "eac3") && !t.sampleRate) {
    const frames = splitAc3Frames(p);
    if (frames.length) {
      const info = t.family === "ac3" ? parseAc3Head(frames[0]) : parseEac3Head(frames[0]);
      if (info) { t.sampleRate = info.rate; t.channels = info.channels; }
    }
  } else if ((t.family === "mp3" || t.family === "mp2") && !t.sampleRate) {
    const h0 = parseFrameHeader(p, 0);
    if (h0) {
      t.sampleRate = h0.sampleRate; t.channels = h0.channels;
      // ffmpeg signale MP1/MP2 en stream_type 0x03 : tranche sur le layer réel.
      const fam = h0.layer === 3 ? "mp3" : "mp2";
      t.family = fam; t.codecId = fam;
      t.ffCodecId = fam === "mp3" ? 86017 : 86016;
    }
  } else if (t.family === "mpeg2video" && !t.width) {
    const sq = findStartCode(p, 0xb3);
    if (sq >= 0) {
      const info = parseMpeg2SeqHead(p.subarray(sq + 4, sq + 11));
      if (info) {
        t.width = info.width; t.height = info.height;
        t._fps = info.fps;
      }
    }
  } else if (t.family === "dts" && !t.sampleRate) {
    const frames = splitDtsFrames(p);
    if (frames.length) {
      const info = parseDtsCore(p.subarray(frames[0].off, frames[0].off + 16));
      if (info) { t.sampleRate = info.rate; t.channels = info.channels; }
    }
  }
  if (t.ffCodecType === 1 && !t.timescale) t.timescale = 90000;
  if (t.sampleRate) t.timescale = t.sampleRate;
}

function avcPl(avcC) {
  if (!avcC || avcC.length < 4 || avcC[0] !== 1) return { profile: -1, level: -1 };
  return { profile: avcC[1] | ((avcC[2] & 0x40) ? 0x100 : 0), level: avcC[3] };
}

function aacChannels(p, off) {
  return ((p[off + 2] & 0x01) << 2) | ((p[off + 3] >> 6) & 0x03);
}

function aacRate(p, off) {
  return ADTS_RATES[(p[off + 2] >> 2) & 0x0f] ?? 0;
}

/** Cherche un start code MPEG (0x000001 + id). */
function findStartCode(b, id) {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && b[i + 3] === id) return i;
  }
  return -1;
}

/** Durée par PCR (tête + queue, borné). Repli -1 (inconnue). */
async function initDuration(source, session) {
  const { stride, skip, baseOff } = session.ts;
  const size = session.fileSize;
  const first = await findPcr(source, baseOff, baseOff + 2n * 1048576n, stride, skip);
  const tailStart = size > 4n * 1048576n ? size - 4n * 1048576n : baseOff;
  const last = await findLastPcr(source, tailStart, size, baseOff, stride, skip);
  if (first != null && last != null && last >= first) {
    session.durationNs = ((last - first) * 1000000000n) / 27000000n;
  } else {
    session.durationNs = -1n;
  }
}

async function findPcr(source, from, end, stride, skip) {
  let found = null;
  await walkTs(source, from, end, stride, skip, 20000, (h) => {
    if (found == null && h.hasPcr) found = h.pcr27;
  });
  return found;
}
/** Dernier PCR dans [from, end) (grille exacte baseOff + k*stride). */
async function findLastPcr(source, from, end, baseOff, stride, skip) {
  const stop = BigInt(from);
  let off = BigInt(end);
  while (off > stop) {
    const fromW = off - 65536n > stop ? off - 65536n : stop;
    let win = null;
    try {
      win = await source.read(fromW, Number(off - fromW));
    } catch {
      return null;
    }
    if (!win.length) return null;
    // Premier offset aligné dans la fenêtre.
    let rel = Number((fromW - BigInt(baseOff)) % BigInt(stride));
    if (rel < 0) rel += stride;
    if (rel !== 0) rel = stride - rel;
    let last = null;
    for (; rel + stride <= win.length; rel += stride) {
      const h = parseTsHeader(win, rel, skip);
      if (h && !h.tei && !h.scrambled && h.hasPcr) last = h.pcr27;
    }
    if (last != null) return last; // le plus proche de `end`
    if (fromW === stop) return null;
    off = fromW + BigInt(stride);
  }
  return null;
}

/** Découpe un payload vidéo Annex B en AUs (sur AUD si ≥2, sinon entier).
 * family sépare les types AUD (H264: type 9 sur 1o ; HEVC: type 35 sur 2o) :
 * un test croisé coupe les SEI H264 (0x46>>1&0x3f==35) en deux. */
function splitAus(payload, family) {
  const cuts = [0];
  for (let i = 0; i + 3 < payload.length; i++) {
    const sc4 = payload[i] === 0 && payload[i + 1] === 0 &&
      payload[i + 2] === 0 && payload[i + 3] === 1;
    const sc3 = !sc4 && payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1;
    if (!sc4 && !sc3) continue;
    if (i === 0) { if (sc4) i++; continue; }
    const o = sc4 ? i + 4 : i + 3;
    if (family === "hevc") {
      if (o + 1 < payload.length && (((payload[o] << 8) | payload[o + 1]) >> 1 & 0x3f) === 35) {
        cuts.push(i);
      }
    } else {
      if ((payload[o] & 0x1f) === 9) cuts.push(i);
    }
    if (sc4) i++; // chevauchement : le motif 3o en i+1 n'est pas un vrai code
  }
  if (cuts.length < 2) return [payload];
  const out = [];
  for (let k = 0; k < cuts.length; k++) {
    out.push(payload.subarray(cuts[k], k + 1 < cuts.length ? cuts[k + 1] : payload.length));
  }
  return out;
}

/** Émet les paquets d'un PES terminé. Retourne le nombre émis. */
function emitPes(t, pes, t0, byIdx) {
  const p = pes.payload;
  if (!p.length) return 0;
  const base = pes.pts != null ? pes.pts : pes.dts;
  const start90 = base != null ? base - t0 : t._lastEnd;
  let n = 0;
  const push = (pts90, dts90, dur90, bytes, key) => {
    const pts = Math.max(0, ns90k(pts90));
    const dts = Math.max(0, ns90k(dts90));
    const pkt = {
      pts, dts, size: bytes.length, data: bytes,
      time_base_num: 1, time_base_den: 1000000000,
      duration: Math.max(0, ns90k(dur90)), key: !!key,
    };
    (byIdx[t.index] = byIdx[t.index] ?? []).push(pkt);
    if (t.ffCodecType === 0) {
      // Backfill durée vidéo (dts monotones en ordre de décodage).
      if (t._prevV) t._prevV.pkt.duration = Math.max(0, dts - t._prevV.dts);
      t._prevV = { pkt, dts };
    } else {
      t._lastEnd = dts90 + dur90;
    }
    n++;
  };
  if (t.family === "h264") {
    const aus = splitAus(p, "h264");
    aus.forEach((au, i) => {
      const avcc = annexbToAvcc(au);
      push(start90, pes.dts != null ? pes.dts - t0 : start90, 0n, avcc,
        nalsHaveIdr(splitAnnexB(au)) || (i === 0 && pes.rai));
    });
  } else if (t.family === "hevc") {
    const aus = splitAus(p, "hevc");
    aus.forEach((au, i) => {
      const nals = packetNals(au);
      let key = i === 0 && !!pes.rai;
      for (const nn of nals) {
        if (nn.length) {
          const ty = (nn[0] >> 1) & 0x3f;
          if (ty >= 16 && ty <= 23) { key = true; break; } // IRAP (BLA/WLP/CRA)
        }
      }
      push(start90, pes.dts != null ? pes.dts - t0 : start90, 0n, Uint8Array.from(au), key);
    });
  } else if (t.family === "mpeg2video") {
    // 1 paquet/image (start codes 0x00000100), clé = séquence présente.
    let pics = [];
    for (let i = 0; i + 3 < p.length; i++) {
      if (p[i] === 0 && p[i + 1] === 0 && p[i + 2] === 1 && p[i + 3] === 0x00) pics.push(i);
    }
    if (!pics.length) pics = [0];
    const dur90 = t._fps > 0 ? BigInt(Math.round(90000 / t._fps)) : 3600n;
    pics.forEach((st0, i) => {
      const end = i + 1 < pics.length ? pics[i + 1] : p.length;
      const pic = p.subarray(st0, end);
      let key = i === 0 && !!pes.rai;
      for (let k = 0; k + 3 < pic.length; k++) {
        if (pic[k] === 0 && pic[k + 1] === 0 && pic[k + 2] === 1 && pic[k + 3] === 0xb3) {
          key = true;
          break;
        }
      }
      push(start90, pes.dts != null ? pes.dts - t0 : start90, dur90, Uint8Array.from(pic), key);
    });
  } else if (t.family === "aac") {
    let acc = 0n;
    for (const f of splitAdtsChunk(p)) {
      const raw = Uint8Array.from(p.subarray(f.off + f.hdr, f.off + f.len));
      const d = (BigInt(f.samples) * 90000n) / BigInt(t.sampleRate || 48000);
      push(start90 + acc, start90 + acc, d, raw, true);
      acc += d;
    }
    if (!acc) t._lastEnd = start90;
    else t._lastEnd = start90 + acc;
  } else if (t.family === "ac3" || t.family === "eac3") {
    let acc = 0n;
    for (const f of splitAc3Frames(p)) {
      const n = ac3FrameSamples(f) || (t.family === "ac3" ? 1536 : 0);
      if (!n) continue;
      const d = (BigInt(n) * 90000n) / BigInt(t.sampleRate || 48000);
      // Copie : chaque paquet doit POSSEDER son buffer (transfert
      // inter-workers : un buffer partagé duplique la transfer list et
      // postMessage jette le batch — même bug qu'en AVI, cf. tests).
      push(start90 + acc, start90 + acc, d, Uint8Array.from(f), true);
      acc += d;
    }
    if (acc) t._lastEnd = start90 + acc;
  } else if (t.family === "mp3" || t.family === "mp2") {
    let acc = 0n;
    for (const f of splitMp3Chunk(p)) {
      const raw = Uint8Array.from(p.subarray(f.off, f.off + f.len));
      const d = (BigInt(f.spf) * 90000n) / BigInt(t.sampleRate || 48000);
      push(start90 + acc, start90 + acc, d, raw, true);
      acc += d;
    }
    if (acc) t._lastEnd = start90 + acc;
  } else if (t.family === "dts") {
    let acc = 0n;
    for (const f of splitDtsFrames(p)) {
      const raw = Uint8Array.from(p.subarray(f.off, f.off + f.len));
      const info = parseDtsCore(p.subarray(f.off, Math.min(f.off + 16, p.length)));
      const sr = t.sampleRate || info?.rate || 48000;
      const d = (BigInt(f.samples) * 90000n) / BigInt(sr);
      push(start90 + acc, start90 + acc, d, raw, true);
      acc += d;
    }
    if (acc) t._lastEnd = start90 + acc;
  }
  return n;
}

/** Lecture bornée → { res:0|-11, eof, byIdx }. */
export async function readTs(session, lib, name, opts = {}) {
  const source = { read: (o, l) => lib.read(name, o, l) };
  const limit = BigInt(opts.limit ?? 524288);
  const byIdx = {};
  const { stride, skip, t0 } = session.ts;
  const size = session.fileSize ?? session.size;
  const setPos = (p) => { session.tsreadPos = p; session.readPos = p; };
  const pidMap = new Map(session.tracks.map((t) => [t._pid, t]));
  let spent = 0n;
  let pos = session.tsreadPos ?? session.readPos;
  for (let guard = 0; guard < MAX_PACKETS_PER_READ; guard++) {
    if (pos + BigInt(stride) > size) break;
    const want = size - pos > BigInt(WINDOW) ? WINDOW : Number(size - pos);
    let win = null;
    try {
      win = await source.read(pos, want);
    } catch {
      return { res: -11, eof: false, byIdx };
    }
    if (!win.length) break;
    let rel = 0;
    while (rel + stride <= win.length) {
      const h = parseTsHeader(win, rel, skip);
      if (!h) {
        // Désync locale : resync borné puis reprend.
        const at = await resyncTs(source, pos + BigInt(rel), size, stride, skip).catch(() => -1n);
        if (at < 0n) { pos = size; break; }
        pos = at;
        break;
      }
      pos += BigInt(stride);
      if (h.tei || h.scrambled || h.payloadOff < 0) { rel += stride; continue; }
      const from = h.payloadOff;
      const to = Math.min(win.length, rel + stride);
      if (to > from) {
        const t = pidMap.get(h.pid);
        if (t) {
          const done = feedPes(t, h, win.subarray(from, to));
          if (done) emitPes(t, done, t0, byIdx);
        }
      }
      rel += stride;
      spent += BigInt(stride);
      if (spent >= limit) {
        setPos(pos);
        return { res: 0, eof: false, byIdx };
      }
    }
    // Fenêtre épuisée : pos déjà avancée par la boucle.
    setPos(pos);
    if (pos + BigInt(stride) > size || win.length < want) break;
  }
  // Fin de fichier : vide les PES en cours puis EOF.
  for (const t of session.tracks) {
    const done = finishPes(t);
    if (done) emitPes(t, done, session.ts.t0, byIdx);
    t._prevV = null;
  }
  setPos(size);
  return { res: 0, eof: true, byIdx };
}

/** Seek : fraction → resync → avance à la clé vidéo (approximatif, sans index).
 * Durée inconnue → reprise à 0 (documenté). */
export async function seekTs(session, lib, name, targetNs) {
  const source = { read: (o, l) => lib.read(name, o, l) };
  const { stride, skip, baseOff, t0 } = session.ts;
  const size = session.fileSize ?? session.size;
  const dur = session.durationNs;
  const setPos = (p) => { session.tsreadPos = p; session.readPos = p; };
  for (const t of session.tracks) {
    t._pes = null;
    t._prevV = null;
  }
  if (!(dur > 0n)) {
    setPos(baseOff);
    session.eof = false;
    return;
  }
  let frac = Number((BigInt(targetNs < 0n ? 0n : targetNs) * 1000n) / dur) / 1000;
  if (!Number.isFinite(frac) || frac < 0) frac = 0;
  if (frac > 1) frac = 1;
  const est = baseOff + BigInt(Math.floor(Number(size - baseOff) * frac));
  // Backtrack 2Mo : l'estimation peut tomber DANS le PES clé cible (le
  // walk ne teste un PES qu'à l'arrivée du PUSI suivant — un départ
  // intra-PES le raterait, jusqu'à EOF si c'était la dernière clé).
  const BACKTRACK = 2n * 1048576n;
  const estFrom = est - BACKTRACK > baseOff ? est - BACKTRACK : baseOff;
  const at = await resyncTs(source, estFrom, size, stride, skip).catch(() => -1n);
  let pos = at >= 0n ? at : baseOff;
  // Avance (≤8Mo) à la 1re clé vidéo avec PTS ≥ cible (audio suit).
  const tgt90 = (BigInt(targetNs < 0n ? 0n : targetNs) * 90000n) / 1000000000n + t0;
  const vt = session.tracks.find((t) => t.ffCodecType === 0);
  const pidMap = new Map(session.tracks.map((t) => [t._pid, t]));
  const asm = new Map(); // pid -> { parts, pts, dts, rai }
  let foundAt = -1n;
  let firstAudioAt = -1n;
  const maxWalk = 8 * 1048576;
  let walked = 0n;
  const end = size;
  while (pos + BigInt(stride) <= end && walked < BigInt(maxWalk)) {
    const want = end - pos > BigInt(WINDOW) ? WINDOW : Number(end - pos);
    let win = null;
    try {
      win = await source.read(pos, want);
    } catch {
      break;
    }
    if (!win.length) break;
    let rel = 0;
    while (rel + stride <= win.length) {
      const h = parseTsHeader(win, rel, skip);
      if (!h) {
        // Paquet illisible : resync borné (anti boucle infinie : rel=0
        // ne ferait pas avancer pos).
        const rat = await resyncTs(source, pos + BigInt(rel) + 1n, end, stride, skip).catch(() => -1n);
        if (rat < 0n) break;
        rel = Number(rat - pos);
        if (rel + stride > win.length) { pos = rat; break; }
        continue;
      }
      const absP = pos + BigInt(rel);
      rel += stride;
      walked += BigInt(stride);
      if (h.tei || h.scrambled || h.payloadOff < 0) continue;
      const t = pidMap.get(h.pid);
      if (!t) continue;
      const to = Math.min(win.length, rel);
      const from = h.payloadOff;
      if (to <= from) continue;
      const payload = win.subarray(from, to);
      let cur = asm.get(h.pid);
      if (h.pusi) {
        // Termine le précédent.
        if (cur && cur.parts.length && t.ffCodecType === 0 && vt && t === vt) {
          const pes = assemble(cur);
          if (pes && pes.pts != null && pes.pts >= tgt90 && pesHasKey(t, pes)) {
            foundAt = cur.startPos;
            break;
          }
        }
        const ph = parsePesHeader(payload);
        cur = { parts: ph ? [payload.subarray(ph.hdrLen)] : [], pts: ph?.pts ?? null, dts: ph?.dts ?? null, startPos: absP, rai: h.rai };
        asm.set(h.pid, cur);
      } else if (cur) {
        cur.parts.push(payload);
      }
      if (t.ffCodecType === 1 && firstAudioAt < 0n && cur?.pts != null && cur.pts >= tgt90) {
        firstAudioAt = cur.startPos;
      }
      if (foundAt >= 0n) break;
    }
    pos += BigInt(rel);
    if (foundAt >= 0n) break;
    if (rel === 0) break; // aucun paquet consommé : anti boucle infinie
  }
  // Positionne : vidéo à la clé (ou estimation), audio au 1er PES ≥ clé.
  setPos(foundAt >= 0n ? foundAt : pos);
  void firstAudioAt;
  for (const t of session.tracks) {
    t._pes = null;
    t._prevV = null;
  }
  session.eof = false;
}

function assemble(cur) {
  if (!cur.parts.length) return null;
  let len = 0;
  for (const c of cur.parts) len += c.length;
  const payload = new Uint8Array(len);
  let o = 0;
  for (const c of cur.parts) { payload.set(c, o); o += c.length; }
  return { payload, pts: cur.pts, dts: cur.dts, rai: cur.rai };
}

/** Le PES vidéo contient-il une clé (IDR/IRAP/séquence) ? */
function pesHasKey(t, pes) {
  const p = pes.payload;
  if (!p.length) return false;
  if (t.family === "h264") return nalsHaveIdr(splitAnnexB(p)) || !!pes.rai;
  if (t.family === "hevc") {
    for (const n of packetNals(p)) {
      if (n.length) {
        const ty = (n[0] >> 1) & 0x3f;
        if (ty >= 16 && ty <= 23) return true;
      }
    }
    return !!pes.rai;
  }
  if (t.family === "mpeg2video") {
    if (pes.rai) return true;
    for (let i = 0; i + 3 < p.length; i++) {
      if (p[i] === 0 && p[i + 1] === 0 && p[i + 2] === 1 && p[i + 3] === 0xb3) return true;
    }
  }
  return false;
}
