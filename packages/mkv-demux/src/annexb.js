// packages/mkv-demux/src/annexb.js — conversions NALU AVCC <-> Annex B.
// Contexte Matroska : quand CodecPrivate contient avcC/hvcC, les frames H264/HEVC
// sont stockées LENGTH-PREFIXED (comme MP4), pas en Annex B. WebCodecs veut de
// l'Annex B (start codes) + description=avcC. VP9/AV1 sont déjà bruts.

/** Découpe un blob Annex B en NALUs (sans start codes). */
export function splitAnnexB(buf) {
  const nals = [];
  const isSC = (p) =>
    buf[p] === 0 && buf[p + 1] === 0 && (buf[p + 2] === 1 || (buf[p + 2] === 0 && buf[p + 3] === 1));
  const scLen = (p) => (buf[p + 2] === 1 ? 3 : 4);
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (isSC(i)) { starts.push(i); i += scLen(i) - 1; }
  }
  // queue émulation 3-byte à la fin
  if (buf.length >= 3 && buf[buf.length - 3] === 0 && buf[buf.length - 2] === 0 && buf[buf.length - 1] === 1) {
    starts.push(buf.length - 3);
  }
  for (let k = 0; k < starts.length; k++) {
    const h = starts[k] + scLen(starts[k]);
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    if (e > h) nals.push(buf.subarray(h, e));
  }
  return nals;
}

/** Annex B → length-prefixed (stockage MKV avec avcC). nalLen = 1|2|4 (avcC[4]&3 + 1). */
export function annexbToAvcc(frameAnnexB, nalLen = 4) {
  const nals = splitAnnexB(frameAnnexB);
  let total = 0;
  for (const n of nals) total += nalLen + n.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer, out.byteOffset);
  let o = 0;
  for (const n of nals) {
    if (nalLen === 4) v.setUint32(o, n.length, false);
    else if (nalLen === 2) v.setUint16(o, n.length, false);
    else out[o] = n.length;
    o += nalLen;
    out.set(n, o);
    o += n.length;
  }
  return out;
}

/** Length-prefixed → Annex B (pour WebCodecs EncodedVideoChunk). */
export function avccToAnnexB(frameAvcc, nalLen = 4) {
  const v = new DataView(frameAvcc.buffer, frameAvcc.byteOffset, frameAvcc.length);
  const parts = [];
  let total = 0, p = 0;
  while (p + nalLen <= frameAvcc.length) {
    const len = nalLen === 4 ? v.getUint32(p, false) : nalLen === 2 ? v.getUint16(p, false) : frameAvcc[p];
    p += nalLen;
    if (p + len > frameAvcc.length) break; // tronqué → stop propre
    parts.push(new Uint8Array([0, 0, 0, 1]));
    parts.push(frameAvcc.subarray(p, p + len));
    total += 4 + len;
    p += len;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const q of parts) { out.set(q, o); o += q.length; }
  return out;
}

/** nalLen depuis avcC/hvcC (octet lengthSizeMinusOne) — défaut 4. */
export function nalLenSize(codecPrivate) {
  if (!codecPrivate || codecPrivate.length < 5) return 4;
  return (codecPrivate[4] & 3) + 1;
}

/** Extrait SPS/PPS (NALs bruts, sans start codes) d'un avcC. */
export function extractSpsPps(avcC) {
  const sps = [], pps = [];
  if (!avcC || avcC.length < 7 || avcC[0] !== 1) return { sps, pps };
  let p = 5;
  const nsps = avcC[p++] & 0x1f;
  for (let i = 0; i < nsps && p + 2 <= avcC.length; i++) {
    const len = (avcC[p] << 8) | avcC[p + 1];
    p += 2;
    if (p + len > avcC.length) break;
    sps.push(avcC.slice(p, p + len));
    p += len;
  }
  if (p >= avcC.length) return { sps, pps };
  const npps = avcC[p++];
  for (let i = 0; i < npps && p + 2 <= avcC.length; i++) {
    const len = (avcC[p] << 8) | avcC[p + 1];
    p += 2;
    if (p + len > avcC.length) break;
    pps.push(avcC.slice(p, p + len));
    p += len;
  }
  return { sps, pps };
}

const SC = new Uint8Array([0, 0, 0, 1]);

/**
 * Garantit SPS/PPS in-band en tête d'un keyframe Annex B (pratique standard
 * hls.js/Shaka : beaucoup de MKV ne les stockent QUE dans l'avcC, et certains
 * décodeurs WebCodecs l'exigent malgré la description).
 * @returns payload inchangé si déjà présent ou si rien à préfixer.
 */
export function ensureInBandSps(annexBFrame, avcC) {
  const nals = splitAnnexB(annexBFrame);
  if (nals.some((n) => (n[0] & 0x1f) === 7)) return annexBFrame; // SPS déjà là
  const { sps, pps } = extractSpsPps(avcC);
  if (!sps.length) return annexBFrame;
  const parts = [];
  let total = 0;
  for (const n of [...sps, ...pps]) {
    parts.push(SC, n);
    total += 4 + n.length;
  }
  parts.push(annexBFrame);
  total += annexBFrame.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const q of parts) { out.set(q, o); o += q.length; }
  return out;
}

/** true si le track stocke en length-prefixed (H264 avec avcC / HEVC avec hvcC). */
export function isAvccStored(codecId, codecPrivate) {
  const fam = String(codecId).split("/")[0];
  if (fam !== "V_MPEG4" && fam !== "V_MPEGH") return false;
  return !!codecPrivate && codecPrivate.length >= 5;
}
