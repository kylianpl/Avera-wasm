// packages/flac-demux/src/frames.js — STREAMINFO + en-têtes de frames FLAC.
// Sync 0xFFF8-0xFB, blocksize (codes 000-111 + 110/111 explicites),
// continuité des n° (frame ou sample selon stratégie), CRC8 vérifié.

/** CRC8 (poly 0x07) sur [start, end). */
export function crc8(buf, start, end) {
  let c = 0;
  for (let i = start; i < end; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

/** STREAMINFO (contenu 34o) → { minBlock, maxBlock, minFrame, maxFrame,
 *  rate, channels, bps, total }. */
export function parseStreamInfoContent(si) {
  if (!si || si.length < 34) return null;
  const u16be = (o) => (si[o] << 8) | si[o + 1];
  const minBlock = u16be(0), maxBlock = u16be(2);
  const minFrame = (si[4] << 16) | (si[5] << 8) | si[6];
  const maxFrame = (si[7] << 16) | (si[8] << 8) | si[9];
  const rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const channels = ((si[12] >> 1) & 0x07) + 1;
  const bps = (((si[12] & 0x01) << 4) | (si[13] >> 4)) + 1;
  const total = (BigInt(si[13] & 0x0f) << 32n) | (BigInt(si[14]) << 24n) |
    (BigInt(si[15]) << 16n) | (BigInt(si[16]) << 8n) | BigInt(si[17]);
  if (!rate || !channels || rate > 655350) return null;
  return { minBlock, maxBlock, minFrame, maxFrame, rate, channels, bps, total };
}

const SR_EXTRA = { 12: 1000, 13: 1, 14: 10 }; // code → multiplicateur (fin d'en-tête)

/** En-tête de frame à `pos` → { samples, num, variable, headerLen } ou null.
 * si = STREAMINFO (bornes + taux). CRC8 exigé (anti faux-sync). */
export function parseFrameHeader(buf, pos, si) {
  if (pos + 6 > buf.length) return null;
  if (buf[pos] !== 0xff || (buf[pos + 1] & 0xfc) !== 0xf8) return null;
  if (buf[pos + 1] & 0x02) return null; // bit réservé
  const variable = !!(buf[pos + 1] & 0x01); // 0 = n° frame, 1 = n° sample
  const bsCode = (buf[pos + 2] >> 4) & 0x0f;
  const srCode = buf[pos + 2] & 0x0f;
  if (srCode === 0x0f) return null;
  const chAssign = (buf[pos + 3] >> 4) & 0x0f;
  if (chAssign > 10) return null;
  const bpsCode = (buf[pos + 3] >> 1) & 0x07;
  if (bpsCode === 0x03 || bpsCode === 0x07) return null;
  // N° encodé UTF-8 (1..7o depuis l'octet 4).
  const u0 = buf[pos + 4];
  let nb = 1;
  if (u0 & 0x80) {
    nb = 0;
    let b = u0;
    while (b & 0x80) { nb++; b = (b << 1) & 0xff; }
    if (nb < 2 || nb > 7 || pos + 4 + nb > buf.length) return null;
  }
  // (valeur du n° : continuité vérifiée par l'appelant si besoin)
  let num = 0n;
  if (nb === 1) {
    num = BigInt(u0);
  } else {
    const firstBits = 8 - nb - 1;
    num = BigInt(u0 & ((1 << firstBits) - 1));
    for (let i = 1; i < nb; i++) {
      if ((buf[pos + 4 + i] & 0xc0) !== 0x80) return null;
      num = (num << 6n) | BigInt(buf[pos + 4 + i] & 0x3f);
    }
  }
  let p = pos + 4 + nb;
  let samples = 0;
  if (bsCode === 0x06) {
    if (p + 1 > buf.length) return null;
    samples = buf[p] + 1;
    p += 1;
  } else if (bsCode === 0x07) {
    if (p + 2 > buf.length) return null;
    samples = ((buf[p] << 8) | buf[p + 1]) + 1;
    p += 2;
  } else if (bsCode === 0x00) {
    samples = si?.minBlock || 0; // réservé : borne STREAMINFO
    if (!samples) return null;
  } else if (bsCode <= 0x05) {
    samples = [192, 576, 1152, 2304, 4608][bsCode - 1];
  } else {
    samples = 256 << (bsCode - 8);
  }
  if (SR_EXTRA[srCode] !== undefined) {
    p += srCode === 12 ? 1 : 2;
    if (p > buf.length) return null;
  }
  if (p + 1 > buf.length) return null; // CRC8
  if (crc8(buf, pos, p) !== buf[p]) return null;
  return { samples, num, variable, headerLen: p + 1 - pos };
}

/** Taille du tag ID3v2 (synchsafe). -1 si pas ID3 (certains .flac taggés). */
export function id3v2Size(head10) {
  if (head10.length < 10 || head10[0] !== 0x49 || head10[1] !== 0x44 || head10[2] !== 0x33) return -1;
  if (head10[3] > 4) return -1;
  let size = 0;
  for (let i = 6; i < 10; i++) {
    if (head10[i] & 0x80) return -1;
    size = (size << 7) | head10[i];
  }
  return 10 + size;
}
