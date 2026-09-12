// packages/mkv-demux/src/lacing.js — Xiph / Fixed / EBML lacing des Blocks MKV.
import { EbmlError, NeedMoreData } from "./vint.js";

function laceWidth(first) {
  if (first & 0x80) return 1;
  if (first & 0x40) return 2;
  if (first & 0x20) return 3;
  if (first & 0x10) return 4;
  if (first & 0x08) return 5;
  if (first & 0x04) return 6;
  if (first & 0x02) return 7;
  if (first & 0x01) return 8;
  throw new EbmlError("bad ebml lace byte");
}

/**
 * Découpe les frames d'un Block.
 * @param {Uint8Array} payload payload complet du SimpleBlock/Block (inclut track+ts+flags)
 * @param {number} laceType 0=none 1=xiph 2=fixed 3=ebml
 * @param {number} frameCount (laceCount+1)
 * @param {number} headerLen offset du premier octet de frame dans payload
 * @returns {{off:number,len:number}[]} offsets relatifs au payload
 */
export function splitLacing(payload, laceType, frameCount, headerLen) {
  if (frameCount <= 0) throw new EbmlError("frameCount must be > 0");
  if (headerLen > payload.length) throw new NeedMoreData("trunc lace header");
  if (laceType === 0) {
    if (frameCount !== 1) throw new EbmlError("no-lace must have 1 frame");
    return [{ off: headerLen, len: payload.length - headerLen }];
  }
  if (laceType === 2) {
    const total = payload.length - headerLen;
    if (total % frameCount !== 0) throw new EbmlError("fixed lace size mismatch");
    const s = total / frameCount;
    return Array.from({ length: frameCount }, (_, i) => ({ off: headerLen + i * s, len: s }));
  }
  if (laceType === 1) {
    // Xiph : n-1 tailles en série d'octets 255-chaînés
    const sizes = [];
    let p = headerLen;
    // headerLen pointe déjà APRÈS le laceCount ; les tailles commencent à p
    // (l'appelant a avancé). Ici payload = tout le block, on relit à partir de p0.
    for (let i = 0; i < frameCount - 1; i++) {
      let v = 0;
      for (;;) {
        if (p >= payload.length) throw new NeedMoreData("trunc xiph lace");
        const b = payload[p++];
        v += b;
        if (b !== 255) break;
      }
      sizes.push(v);
    }
    const frames = [];
    let off = p;
    for (let i = 0; i < frameCount; i++) {
      const len = i + 1 < frameCount ? sizes[i] : payload.length - off;
      if (off + len > payload.length) throw new EbmlError("xiph lace overflow");
      frames.push({ off, len });
      off += len;
    }
    return frames;
  }
  // EBML : 1ère taille unsigned, suivantes signées avec biais
  const sizes = [];
  let p = headerLen;
  {
    if (p >= payload.length) throw new NeedMoreData("trunc ebml lace");
    const w = laceWidth(payload[p]);
    if (p + w > payload.length) throw new NeedMoreData("trunc ebml lace size");
    const mask = w === 8 ? 0 : ((1 << (8 - w)) - 1);
    let v = BigInt(payload[p] & mask);
    for (let i = 1; i < w; i++) v = (v << 8n) | BigInt(payload[p + i]);
    p += w;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new EbmlError("ebml lace size too big");
    sizes.push(Number(v));
    let acc = Number(v);
    for (let i = 1; i < frameCount - 1; i++) {
      if (p >= payload.length) throw new NeedMoreData("trunc ebml lace");
      const w2 = laceWidth(payload[p]);
      if (p + w2 > payload.length) throw new NeedMoreData("trunc ebml lace size");
      const mask2 = w2 === 8 ? 0 : ((1 << (8 - w2)) - 1);
      let uv = BigInt(payload[p] & mask2);
      for (let k = 1; k < w2; k++) uv = (uv << 8n) | BigInt(payload[p + k]);
      p += w2;
      const bias = Number((1n << BigInt(7 * w2 - 1)) - 1n);
      acc += Number(uv) - bias;
      if (acc < 0) throw new EbmlError("ebml lace negative size");
      sizes.push(acc);
    }
  }
  const frames = [];
  let off = p;
  for (let i = 0; i < frameCount; i++) {
    const len = i + 1 < frameCount ? sizes[i] : payload.length - off;
    if (off + len > payload.length) throw new EbmlError("ebml lace overflow");
    frames.push({ off, len });
    off += len;
  }
  return frames;
}
