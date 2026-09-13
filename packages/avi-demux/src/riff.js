// packages/avi-demux/src/riff.js — primitives RIFF/AVI little-endian.
// Les tailles sont des u32 ; un chunk = id(4) + size(4) + données + pad si impair.
// Une LIST = id 'LIST' + size(4) + type(4) + contenu (hdr 12o).

export class LR {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  get eof() { return this.p >= this.b.length; }
  u8() { this.#need(1); return this.b[this.p++]; }
  u16() { this.#need(2); const v = this.b[this.p] | (this.b[this.p + 1] << 8); this.p += 2; return v; }
  i16() { const v = this.u16(); return v >= 0x8000 ? v - 0x10000 : v; }
  u32() {
    this.#need(4);
    const v = (this.b[this.p] | (this.b[this.p + 1] << 8) | (this.b[this.p + 2] << 16)) + this.b[this.p + 3] * 0x1000000;
    this.p += 4;
    return v;
  }
  i32() { const v = this.u32(); return v >= 0x80000000 ? v - 0x100000000 : v; }
  fcc() {
    this.#need(4);
    const s = String.fromCharCode(this.b[this.p], this.b[this.p + 1], this.b[this.p + 2], this.b[this.p + 3]);
    this.p += 4;
    return s;
  }
  bytes(n) {
    const v = Number(n);
    this.#need(v);
    const s = this.b.subarray(this.p, this.p + v);
    this.p += v;
    return s;
  }
  skip(n) { const v = Number(n); this.#need(v); this.p += v; }
  #need(n) { if (this.p + n > this.b.length) throw new RangeError(`RIFF tronqué (veut ${n}, reste ${this.b.length - this.p})`); }
}

/** En-tête de chunk à `pos` : { id, size, hdr } (hdr=12 si LIST, 8 sinon). */
export function chunkHeader(buf, pos) {
  if (pos + 8 > buf.length) throw new RangeError("en-tête RIFF tronqué");
  const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
  const size = (buf[pos + 4] | (buf[pos + 5] << 8) | (buf[pos + 6] << 16)) + buf[pos + 7] * 0x1000000;
  if (id === "LIST") {
    if (pos + 12 > buf.length) throw new RangeError("en-tête LIST tronqué");
    const type = String.fromCharCode(buf[pos + 8], buf[pos + 9], buf[pos + 10], buf[pos + 11]);
    return { id, size, hdr: 12, isList: true, listType: type };
  }
  return { id, size, hdr: 8, isList: false, listType: null };
}

/** Fin d'un chunk : off + 8 + size + pad. (Pour LIST, size inclut déjà les
 *  4 octets de type : h.hdr ne sert qu'à trouver le payload, pas la fin.) */
export const chunkEnd = (off, h) => {
  const sz = BigInt(h.size);
  return BigInt(off) + 8n + sz + (sz & 1n);
};
