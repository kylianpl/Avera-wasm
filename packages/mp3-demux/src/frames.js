// packages/mp3-demux/src/frames.js — en-têtes MPEG audio + Xing/Info.
// Supporte Layer I/II/III, MPEG 1/2/2.5 (cadres, durées, offsets Xing).
// Free-format (bitrate idx 0) refusé (tailles indétectables sans scan total).

// [mpeg1L1, mpeg1L2, mpeg1L3, mpeg2L1, mpeg2L2, mpeg2L3] (kbps, idx 1..14).
const BITRATES = [
  [32,64,96,128,160,192,224,256,288,320,352,384,416,448],
  [32,48,56,64,80,96,112,128,160,192,224,256,320,384],
  [32,40,48,56,64,80,96,112,128,160,192,224,256,320],
  [32,48,56,64,80,96,112,128,144,160,176,192,224,256],
  [8,16,24,32,40,48,56,64,80,96,112,128,144,160],
  [8,16,24,32,40,48,56,64,80,96,112,128,144,160],
];
const SAMPLERATES = [
  [44100, 48000, 32000], // MPEG1
  [22050, 24000, 16000], // MPEG2
  [11025, 12000, 8000],  // MPEG2.5
];

/**
 * Parse 4 octets d'en-tête à `pos`. Retourne null si invalide.
 * { version:0|1|2 (2.5|réservé→null|2|1…), layer:1|2|3, bitrate, sampleRate,
 *   padding, channels, samplesPerFrame, frameLen, sideLen, mpeg1 }.
 * version : 0=MPEG2.5, 2=MPEG2, 3=MPEG1 (1=réservé → null).
 */
export function parseFrameHeader(buf, pos) {
  if (pos + 4 > buf.length) return null;
  const b0 = buf[pos], b1 = buf[pos + 1], b2 = buf[pos + 2], b3 = buf[pos + 3];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const verBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  if (verBits === 1 || layerBits === 0) return null;
  const protection = b1 & 0x01;
  const brIdx = (b2 >> 4) & 0x0f;
  const srIdx = (b2 >> 2) & 0x03;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const padding = (b2 >> 1) & 0x01;
  const mode = (b3 >> 6) & 0x03;
  const mpeg1 = verBits === 3;
  const layer = 4 - layerBits; // 1, 2 ou 3
  const table = (mpeg1 ? 0 : 3) + (layer - 1);
  const bitrate = BITRATES[table][brIdx - 1] * 1000;
  const sampleRate = SAMPLERATES[mpeg1 ? 0 : verBits === 2 ? 1 : 2][srIdx];
  const channels = mode === 3 ? 1 : 2;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : mpeg1 ? 1152 : 576;
  // len = spf/8 * bitrate/samplerate (+ slot de padding ; L1 : slots de 4o).
  const slot = layer === 1 ? 4 : 1;
  const frameLen = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding * slot;
  if (frameLen < 21 || frameLen > 2881) return null; // garde-fou (max L1 384k/32k)
  const sideLen = (mpeg1 ? (mode === 3 ? 17 : 32) : mode === 3 ? 9 : 17) + (protection ? 0 : 2);
  return {
    version: verBits, layer, mpeg1, bitrate, sampleRate, padding,
    channels, samplesPerFrame, frameLen, sideLen,
  };
}

/** Même famille (version/layer/sr) — lookahead anti faux-sync. */
export function sameStream(a, b) {
  return a && b && a.version === b.version && a.layer === b.layer &&
    a.sampleRate === b.sampleRate;
}

/**
 * Parse le Xing/Info dans une frame complète (0-offset relatif).
 * Retourne { numFrames, numBytes, toc:Uint8Array(100)|null } ou null.
 */
export function parseXing(frame) {
  if (!frame || frame.length < 4) return null;
  const h = parseFrameHeader(frame, 0);
  if (!h) return null;
  const base = 4 + h.sideLen; // en-tête (+CRC) + side info
  if (base + 8 > frame.length) return null;
  const magic = String.fromCharCode(frame[base], frame[base + 1], frame[base + 2], frame[base + 3]);
  if (magic !== "Xing" && magic !== "Info") return null;
  let p = base + 4;
  const u32 = () => (frame[p] * 0x1000000) + ((frame[p + 1] << 16) | (frame[p + 2] << 8) | frame[p + 3]);
  const flags = u32(); p += 4;
  const out = { numFrames: 0, numBytes: 0, toc: null };
  if (flags & 0x01) { out.numFrames = u32(); p += 4; }
  if (flags & 0x02) { out.numBytes = u32(); p += 4; }
  if (flags & 0x04) {
    if (p + 100 > frame.length) return null;
    out.toc = Uint8Array.from(frame.subarray(p, p + 100));
    p += 100;
  }
  return out;
}

/** Taille du tag ID3v2 à partir de 10 octets d'en-tête (synchsafe). -1 si pas ID3. */
export function id3v2Size(head10) {
  if (head10.length < 10 || head10[0] !== 0x49 || head10[1] !== 0x44 || head10[2] !== 0x33) return -1;
  if (head10[3] > 4) return -1; // v2.2/2.3/2.4 connus (major ≤ 4)
  let size = 0;
  for (let i = 6; i < 10; i++) {
    if (head10[i] & 0x80) return -1;
    size = (size << 7) | head10[i];
  }
  return { size: 10 + size, flags: head10[5], version: head10[3] };
}
