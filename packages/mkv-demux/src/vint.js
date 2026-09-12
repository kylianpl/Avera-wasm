// packages/mkv-demux/src/vint.js — EBML varint ID + vint length.
// Miroir JS du Rust crates/mkv-demux-rs. BigInt pour les valeurs > 2^53.
export class NeedMoreData extends Error {}
export class EbmlError extends Error {}

function widthOf(first) {
  if (first & 0x80) return 1;
  if (first & 0x40) return 2;
  if (first & 0x20) return 3;
  if (first & 0x10) return 4;
  if (first & 0x08) return 5;
  if (first & 0x04) return 6;
  if (first & 0x02) return 7;
  if (first & 0x01) return 8;
  throw new EbmlError("bad vint leading byte 0x00");
}

/** Lit un ID EBML (valeur brute, marker bit conservé). Retourne {id:number,width}. */
export function readId(buf, off) {
  if (off >= buf.length) throw new NeedMoreData("eof id");
  const w = widthOf(buf[off]);
  if (off + w > buf.length) throw new NeedMoreData("trunc id");
  let v = 0;
  for (let i = 0; i < w; i++) v = v * 256 + buf[off + i];
  return { id: v, width: w };
}

/**
 * Lit une taille vint. Retourne {size:bigint|null,width} — null = unknown-size
 * (tous les bits data à 1). Jamais de Number pour la taille.
 */
export function readVint(buf, off) {
  if (off >= buf.length) throw new NeedMoreData("eof vint");
  const w = widthOf(buf[off]);
  if (off + w > buf.length) throw new NeedMoreData("trunc vint");
  const mask = w === 8 ? 0 : ((1 << (8 - w)) - 1);
  let v = BigInt(buf[off] & mask);
  for (let i = 1; i < w; i++) v = (v << 8n) | BigInt(buf[off + i]);
  const max = (1n << BigInt(7 * w)) - 1n;
  if (v === max) return { size: null, width: w }; // unknown-size
  return { size: v, width: w };
}

/** Lit un uint big-endian n octets en bigint (n ≤ 8). */
export function readUint(buf, off, n) {
  if (off + n > buf.length) throw new NeedMoreData("trunc uint");
  let v = 0n;
  for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(buf[off + i]);
  return v;
}

/** Encode une taille vint (pour tests/bench). size=null → unknown-size. Throw si > capacité. */
export function encodeVint(size, width) {
  if (size === null) {
    const w = width ?? 8;
    // unknown-size = tous les bits DATA à 1, marker préservé :
    // width 1 → 0xFF, width 2 → 0x7F 0xFF, ..., width 8 → 0x01 0xFF×7.
    const out = new Uint8Array(w).fill(0xff);
    out[0] = (1 << (8 - w)) | ((1 << (8 - w)) - 1);
    return out;
  }
  const v = BigInt(size);
  const w = width ?? minVintWidth(v);
  const max = (1n << BigInt(7 * w)) - 1n;
  if (v >= max) throw new RangeError(`vint ${v} too big for width ${w} (max ${max - 1n})`);
  const out = new Uint8Array(w);
  let tmp = v;
  for (let i = w - 1; i >= 0; i--) { out[i] = Number(tmp & 0xffn); tmp >>= 8n; }
  out[0] |= 1 << (8 - w); // marker bit
  return out;
}

export function minVintWidth(v) {
  const x = BigInt(v);
  for (let w = 1; w <= 8; w++) if (x < (1n << BigInt(7 * w)) - 1n) return w;
  return 8;
}
