// packages/ts-demux/src/ts.js — paquets de transport (188o, 192o m2ts).
// Sync 0x47 (triple contrôle), stride 188/192, adaptation (PCR, flags),
// compteurs de continuité (trous tolérés, resync).

export const TS_LEN = 188;
export const M2TS_LEN = 192;

/** Détecte le stride (188/192) + offset payload. Retourne { stride, skip }
 * (skip = 4 pour m2ts : TP_extra_header) ou null.
 * m2ts : la sync est à +4 (extra-header devant chaque paquet). */
export function detectStride(head) {
  if (!head || head.length < 4) return null;
  const g = (i) => head[i] === 0x47;
  if (g(0) && head.length > 376 && g(188) && g(376)) return { stride: 188, skip: 0 };
  if (g(4) && head.length > 392 && g(196) && g(388)) return { stride: 192, skip: 4 };
  if (g(0) && head.length > 384 && g(192) && g(384)) return { stride: 192, skip: 4 };
  // Fichier court : 2 syncs suffisent.
  if (g(0) && head.length > 188 && g(188)) return { stride: 188, skip: 0 };
  if (g(4) && head.length > 196 && g(196)) return { stride: 192, skip: 4 };
  if (g(0) && head.length > 192 && g(192)) return { stride: 192, skip: 4 };
  return null;
}

export function sniffTs(head) {
  if (!head || head.length < 5) return false;
  if (head[0] !== 0x47 && head[4] !== 0x47) return false; // 0x47 ou m2ts (+4)
  return detectStride(head) !== null;
}

/** Parse l'en-tête TS à `off` (buf ≥ 4o + skip). Retourne null si sync KO.
 * { pid, pusi, adaptLen, payloadOff, cc, scrambled, tei, hasPcr, pcr27, rai }. */
export function parseTsHeader(buf, off, skip) {
  const o = off + skip;
  if (buf[o] !== 0x47) return null;
  const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
  const scr = (buf[o + 3] >> 6) & 0x03;
  const adapt = (buf[o + 3] >> 4) & 0x03;
  const pusi = !!(buf[o + 1] & 0x40);
  const tei = !!(buf[o + 1] & 0x80);
  const cc = buf[o + 3] & 0x0f;
  let payloadOff = o + 4, hasPcr = false, pcr27 = 0n, rai = false;
  if (adapt === 2 || adapt === 3) {
    const alen = buf[o + 4];
    if (alen > 0 && o + 5 + alen <= buf.length + 1024) {
      const flags = alen >= 1 ? buf[o + 5] : 0;
      rai = !!(flags & 0x40);
      if ((flags & 0x10) && alen >= 7 && o + 11 <= buf.length) {
        const b0 = buf[o + 5 + 1], b1 = buf[o + 6 + 1], b2 = buf[o + 7 + 1];
        const b3 = buf[o + 8 + 1], b4 = buf[o + 9 + 1], b5 = buf[o + 10 + 1];
        const base = (BigInt(b0) << 25n) | (BigInt(b1) << 17n) | (BigInt(b2) << 9n) |
          (BigInt(b3) << 1n) | BigInt(b4 >> 7);
        const ext = BigInt(((b4 & 0x01) << 8) | b5);
        pcr27 = base * 300n + ext;
        hasPcr = true;
      }
    }
    payloadOff = o + 5 + alen;
  }
  if (adapt === 2) payloadOff = -1; // adaptation seule : pas de charge
  return { pid, pusi, adaptLen: 0, payloadOff, cc, scrambled: scr !== 0, tei, hasPcr, pcr27, rai };
}

/** Resync sur grille stride : cherche 0x47 en `pos`, `pos+stride`,
 * `pos+2*stride` (fenêtre bornée). Retourne l'offset ou -1n. */
export async function resyncTs(source, from, end, stride, skip) {
  let off = BigInt(from);
  const stop = BigInt(end);
  const maxScan = 1048576;
  let scanned = 0;
  const win = stride * 3 + 8;
  while (off + BigInt(win) <= stop && scanned < maxScan) {
    let buf;
    try {
      buf = await source.read(off, win);
    } catch {
      return -1n;
    }
    if (!buf || buf.length < win) return -1n;
    for (let i = 0; i + stride * 2 < buf.length; i++) {
      if (buf[i + skip] === 0x47 && buf[i + skip + stride] === 0x47 &&
          buf[i + skip + stride * 2] === 0x47) {
        return off + BigInt(i);
      }
    }
    const adv = BigInt(buf.length) - BigInt(stride * 2);
    if (adv <= 0n) return -1n;
    off += adv;
    scanned += Number(adv);
  }
  return -1n;
}

/** CRC32 IEEE (tables MPEG-TS/PSI). */
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_T[(c >>> 24) ^ buf[i]] ^ (c << 8)) >>> 0;
  return c >>> 0;
}
