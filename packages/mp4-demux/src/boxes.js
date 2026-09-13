// packages/mp4-demux/src/boxes.js — lecteur bas niveau de boîtes ISO-BMFF.
// Big-endian strict, offsets en Number (buffers bornés), tailles en bigint.
// Convention : toute boîte = { type, off, hdr, start, end } où [off,end) couvre
// l'en-tête + payload, [start,end) le payload. size==0 → jusqu'à parentEnd
// (top-level : jusqu'à EOF). size==1 → largesize u64.

export class BR {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  get eof() { return this.p >= this.b.length; }
  get left() { return this.b.length - this.p; }
  u8() { this.#need(1); return this.b[this.p++]; }
  u16() { this.#need(2); const v = (this.b[this.p] << 8) | this.b[this.p + 1]; this.p += 2; return v; }
  u24() { this.#need(3); const v = (this.b[this.p] << 16) | (this.b[this.p + 1] << 8) | this.b[this.p + 2]; this.p += 3; return v; }
  u32() {
    this.#need(4);
    const v = (this.b[this.p] * 0x1000000) + ((this.b[this.p + 1] << 16) | (this.b[this.p + 2] << 8) | this.b[this.p + 3]);
    this.p += 4;
    return v;
  }
  i32() { const v = this.u32(); return v >= 0x80000000 ? v - 0x100000000 : v; }
  u64() {
    this.#need(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.b[this.p + i]);
    this.p += 8;
    return v;
  }
  bytes(n) {
    const v = Number(n);
    this.#need(v);
    const s = this.b.subarray(this.p, this.p + v);
    this.p += v;
    return s;
  }
  skip(n) { const v = Number(n); this.#need(v); this.p += v; }
  ascii(n) {
    const v = Number(n);
    this.#need(v);
    let s = "";
    for (let i = 0; i < v; i++) s += String.fromCharCode(this.b[this.p + i]);
    this.p += v;
    return s;
  }
  fullbox() { const v = this.u8(); const f = this.u24(); return { version: v, flags: f }; }
  #need(n) { if (this.p + n > this.b.length) throw new RangeError(`boîte tronquée (veut ${n}, reste ${this.left})`); }
}

/** Lit l'en-tête d'une boîte à `pos` dans `buf`. `parentEnd` borne size==0. */
export function readBoxHeader(buf, pos, parentEnd) {
  if (pos + 8 > buf.length) throw new RangeError("en-tête de boîte tronqué");
  const size32 = (buf[pos] * 0x1000000) + ((buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]);
  const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
  let hdr = 8;
  let total;
  if (size32 === 1) {
    if (pos + 16 > buf.length) throw new RangeError("largesize tronqué");
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[pos + 8 + i]);
    hdr = 16;
    total = v;
  } else if (size32 === 0) {
    total = BigInt(parentEnd - pos); // jusqu'à la fin du parent
  } else {
    total = BigInt(size32);
  }
  if (total < BigInt(hdr)) throw new Error(`boîte ${type} trop petite (${total})`);
  const end = pos + Number(total > BigInt(buf.length) ? BigInt(buf.length) : total);
  return { type, off: pos, hdr, start: pos + hdr, end, size: total };
}

/** Itère les boîtes filles dans buf[start,end). */
export function* children(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    const b = readBoxHeader(buf, p, end);
    yield b;
    if (b.end <= p) break; // garde-fou
    p = b.end;
  }
}

/** Cherche le premier enfant `type` (retourne la boîte ou null). */
export function findChild(buf, start, end, type) {
  for (const b of children(buf, start, end)) {
    if (b.type === type) return b;
  }
  return null;
}

/** fixed 16.16 → float. */
export const f1616 = (u) => u / 65536;
/** fixed 8.8 → float. */
export const f88 = (u) => (u >= 0x8000 ? u - 0x10000 : u) / 256;
