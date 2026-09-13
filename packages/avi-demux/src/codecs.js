// packages/avi-demux/src/codecs.js — codecs AVI : mapping fourcc/tags,
// H264 Annex B ↔ avcc + construction avcC, découpage MP3/ADTS, sniff audio.
import { parseFrameHeader } from "../../mp3-demux/src/frames.js";
import { splitAnnexB, annexbToAvcc } from "../../mkv-demux/src/annexb.js";

export const T_VIDEO = 0, T_AUDIO = 1;

const VIDEO_FOURCC = {
  H264: "h264", h264: "h264", X264: "h264", x264: "h264",
  AVC1: "h264", avc1: "h264", DAVC: "h264", VSSH: "h264",
  XVID: "mp4v", xvid: "mp4v", DIVX: "mp4v", divx: "mp4v",
  DX50: "mp4v", dx50: "mp4v", MP4V: "mp4v", mp4v: "mp4v", FMP4: "mp4v",
  VP80: "vp8", VP8: "vp8",
  MJPG: "mjpeg", mjpg: "mjpeg",
  DVSD: "dvvideo", dvsd: "dvvideo",
  THEO: "theora", theo: "theora",
};
export const VIDEO_IDS = {
  h264: 27, mp4v: 12, vp8: 139, mjpeg: 7, dvvideo: 24, theora: 30,
};

// Tags WAVE (wFormatTag) → famille. 0xFFFE/0xFFFF : sniffé sur les données.
export const AUDIO_TAGS = {
  0x0001: "pcm", 0x0003: "pcm", 0x0055: "mp3", 0x0050: "mp2",
  0x2000: "ac3", 0x00ff: "aac", 0x1600: "aac", 0x1610: "aac",
};
export const AUDIO_IDS = { pcm: 65536, mp3: 86017, mp2: 86016, ac3: 86019, eac3: 86055, aac: 86018 };

export function mapVideoCodec(fourcc) {
  const family = VIDEO_FOURCC[fourcc];
  if (!family) return { family: "unknown", id: 0 };
  return { family, id: VIDEO_IDS[family] ?? 0 };
}

export function mapAudioTag(tag) {
  const family = AUDIO_TAGS[tag];
  if (!family) return { family: "unknown", id: 0 };
  return { family, id: AUDIO_IDS[family] ?? 0 };
}

/** 'annexb' | 'avcc' | null (indéterminé). */
export function detectH264Format(chunk) {
  if (chunk.length >= 4) {
    if (chunk[0] === 0 && chunk[1] === 0 &&
        (chunk[2] === 1 || (chunk[2] === 0 && chunk[3] === 1))) {
      return "annexb";
    }
    const len = (chunk[0] * 0x1000000) + ((chunk[1] << 16) | (chunk[2] << 8) | chunk[3]);
    if (len > 0 && len <= chunk.length - 4) {
      // Vérifie que ça marche en chaîne sur au moins 2 NALs (ou 1 NAL exacte).
      let p = 0, n = 0;
      while (p + 4 <= chunk.length && n < 3) {
        const l = (chunk[p] * 0x1000000) + ((chunk[p + 1] << 16) | (chunk[p + 2] << 8) | chunk[p + 3]);
        if (l <= 0 || p + 4 + l > chunk.length) break;
        p += 4 + l;
        n++;
      }
      if (n > 0 && (p === chunk.length || n === 3)) return "avcc";
      if (n === 1 && p === chunk.length) return "avcc";
    }
  }
  return null;
}

/** Construit un record avcC depuis SPS/PPS bruts (sans start codes). */
export function buildAvcC(sps, pps) {
  if (!sps || sps.length < 4 || !pps || !pps.length) return null;
  const out = new Uint8Array(11 + sps.length + pps.length);
  out[0] = 1;
  out[1] = sps[1];
  out[2] = sps[2];
  out[3] = sps[3];
  out[4] = 0xff; // lengthSizeMinusOne = 3 (4 octets)
  out[5] = 0xe1; // 1 SPS
  out[6] = (sps.length >> 8) & 0xff;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  out[8 + sps.length] = 1; // 1 PPS
  out[9 + sps.length] = (pps.length >> 8) & 0xff;
  out[10 + sps.length] = pps.length & 0xff;
  out.set(pps, 11 + sps.length);
  return out;
}

/** Extrait SPS/PPS (premiers trouvés) de NALs brutes. */
export function findParamSets(nals) {
  let sps = null, pps = null;
  for (const n of nals) {
    if (!n.length) continue;
    const t = n[0] & 0x1f;
    if (t === 7 && !sps && n.length >= 4) sps = n;
    else if (t === 8 && !pps) pps = n;
    if (sps && pps) break;
  }
  return { sps, pps };
}

/** Type de la première NAL (pour keyframe de repli). -1 si vide. */
export function firstNalType(nals) {
  for (const n of nals) {
    if (n.length) return n[0] & 0x1f;
  }
  return -1;
}

/** Découpe un chunk audio MP3 en frames [{off,len,spf}]. */
export function splitMp3Chunk(data) {
  const out = [];
  let i = 0;
  while (i + 4 <= data.length) {
    const h = parseFrameHeader(data, i);
    if (!h) { i++; continue; }
    if (i + h.frameLen > data.length) break;
    out.push({ off: i, len: h.frameLen, spf: h.samplesPerFrame });
    i += h.frameLen;
  }
  return out;
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** En-tête ADTS à `pos` → { frameLen, samples } ou null. */
export function parseAdtsHeader(buf, pos) {
  if (pos + 7 > buf.length) return null;
  if (buf[pos] !== 0xff || (buf[pos + 1] & 0xf0) !== 0xf0) return null;
  if ((buf[pos + 1] & 0x06) !== 0) return null; // layer doit être 0
  const freqIdx = (buf[pos + 2] >> 2) & 0x0f;
  if (freqIdx === 15 || ADTS_RATES[freqIdx] === undefined) return null;
  const protection = buf[pos + 1] & 0x01;
  const hdrLen = protection ? 7 : 9;
  const frameLen = ((buf[pos + 3] & 0x03) << 11) | (buf[pos + 4] << 3) | ((buf[pos + 5] >> 5) & 0x07);
  if (frameLen < hdrLen || frameLen > 8192) return null;
  const blocks = buf[pos + 6] & 0x03;
  return { frameLen, samples: (blocks + 1) * 1024 };
}

/** Découpe un chunk AAC/ADTS en frames [{off,len,samples}]. */
export function splitAdtsChunk(data) {
  const out = [];
  let i = 0;
  while (i + 7 <= data.length) {
    const h = parseAdtsHeader(data, i);
    if (!h) { i++; continue; }
    if (i + h.frameLen > data.length) break;
    out.push({ off: i, len: h.frameLen, samples: h.samples });
    i += h.frameLen;
  }
  return out;
}

/** Sniff du 1er chunk audio (tags 0xFFFE ou inconnus) → famille ou null. */
export function sniffAudioChunk(data) {
  if (!data || data.length < 4) return null;
  if (parseFrameHeader(data, 0)) return "mp3";
  if (data[0] === 0x0b && data[1] === 0x77 && data.length >= 6) {
    const bsid = data[5] >> 3;
    if (bsid === 16) return "eac3";
    if (bsid <= 10) return "ac3";
    return null;
  }
  if (parseAdtsHeader(data, 0)) return "aac";
  return null;
}
