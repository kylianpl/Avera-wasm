// packages/mkv-demux/src/blocks.js — parse SimpleBlock/Block + timestamps i64 ns.
import { splitLacing } from "./lacing.js";
import { EbmlError, NeedMoreData } from "./vint.js";

function vintVal(buf, pos) {
  const b0 = buf[pos];
  let w = 1;
  if (b0 & 0x80) w = 1; else if (b0 & 0x40) w = 2; else if (b0 & 0x20) w = 3;
  else if (b0 & 0x10) w = 4; else if (b0 & 0x08) w = 5; else if (b0 & 0x04) w = 6;
  else if (b0 & 0x02) w = 7; else if (b0 & 0x01) w = 8; else throw new EbmlError("bad vint");
  if (pos + w > buf.length) throw new NeedMoreData("trunc trackno");
  const mask = w === 8 ? 0 : ((1 << (8 - w)) - 1);
  let v = BigInt(buf[pos] & mask);
  for (let i = 1; i < w; i++) v = (v << 8n) | BigInt(buf[pos + i]);
  return { value: v, width: w };
}

/**
 * @param {Uint8Array} payload payload du SimpleBlock (0xA3) ou Block (0xA1), SANS id/size
 * @param {bigint} clusterTimeNs timestamp du Cluster en ns
 * @param {bigint} timecodeScale ns par tick (ex 1000000n)
 * @returns {{track:bigint, ptsNs:bigint, key:boolean, invisible:boolean, lace:number, frames:{off:number,len:number}[]}}
 */
export function parseBlock(payload, clusterTimeTicks, timecodeScale) {
  let p = 0;
  const { value: track, width: w0 } = vintVal(payload, p); p += w0;
  if (p + 3 > payload.length) throw new NeedMoreData("short block");
  const ts = new DataView(payload.buffer, payload.byteOffset + p, 2).getInt16(0, false); p += 2;
  const flags = payload[p++];
  const key = (flags & 0x80) !== 0;
  const invisible = (flags & 0x08) !== 0;
  const lace = (flags >> 1) & 0x03;
  let frameCount = 1;
  let headerLen = p;
  if (lace !== 0) {
    if (p >= payload.length) throw new NeedMoreData("trunc lace count");
    frameCount = payload[p++] + 1;
    headerLen = p;
    // Pour xiph/ebml les tailles suivent ; splitLacing les lit à partir de headerLen.
    // On doit lui passer le payload ENTIER avec headerLen = position des tailles.
    const frames = splitLacing(payload, lace, frameCount, headerLen);
    const ptsNs = (BigInt(clusterTimeTicks) + BigInt(ts)) * BigInt(timecodeScale);
    return { track, ptsNs, key, invisible, lace, frames };
  }
  const ptsNs = (BigInt(clusterTimeTicks) + BigInt(ts)) * BigInt(timecodeScale);
  return { track, ptsNs, key, invisible, lace, frames: [{ off: headerLen, len: payload.length - headerLen }] };
}

/** ptsNs (bigint) → microsecondes bigint pour WebCodecs. */
export function nsToUs(ns) { return BigInt(ns) / 1000n; }
/** ns (bigint) → secondes float UNIQUEMENT pour UI/horloge. */
export function nsToSec(ns) { return Number(ns) / 1e9; }
