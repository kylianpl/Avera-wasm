// packages/avi-demux/src/hdrl.js — parse hdrl : avih + strl (strh/strf/strd/strn).
// Sortie : { avih, streams: [{ fccType, handler, scale, rate, start, length,
//   bufSize, sampleSize, strf, strd, name }] } avec strf décodé (video/audio).

import { LR, chunkHeader, chunkEnd } from "./riff.js";

export function parseAvih(buf, start, end) {
  const r = new LR(buf, start);
  return {
    usPerFrame: r.u32(),
    maxBytesPerSec: r.u32(),
    padding: r.u32(),
    flags: r.u32(),
    totalFrames: r.u32(),
    initFrames: r.u32(),
    nStreams: r.u32(),
    suggestedBufSize: r.u32(),
    width: r.u32(),
    height: r.u32(),
  };
}

function parseStrh(buf, start, end) {
  const r = new LR(buf, start);
  return {
    fccType: r.fcc(),
    handler: r.fcc(),
    flags: r.u32(),
    priority: r.u16(),
    language: r.u16(),
    initFrames: r.u32(),
    scale: r.u32(),
    rate: r.u32(),
    start: r.u32(),
    length: r.u32(),
    suggestedBufSize: r.u32(),
    quality: r.u32(),
    sampleSize: r.u32(),
  };
}

function parseVideoStrf(raw) {
  const r = new LR(raw, 0);
  const size = r.u32();
  const o = {
    kind: "video",
    bmiSize: size,
    width: r.i32(),
    height: r.i32(),
    planes: r.u16(),
    bitCount: r.u16(),
    compression: r.fcc(),
    imageSize: r.u32(),
    xPelsPerMeter: r.i32(),
    yPelsPerMeter: r.i32(),
    clrUsed: r.u32(),
    clrImportant: r.u32(),
    extra: raw.length > 40 ? raw.subarray(40) : new Uint8Array(0),
  };
  return o;
}

function parseAudioStrf(raw) {
  const r = new LR(raw, 0);
  const o = {
    kind: "audio",
    tag: r.u16(),
    channels: r.u16(),
    sampleRate: r.u32(),
    avgBytesPerSec: r.u32(),
    blockAlign: r.u16(),
    bitsPerSample: r.u16(),
    cbSize: 0,
    ext: new Uint8Array(0),
  };
  if (raw.length >= 18) {
    o.cbSize = r.u16();
    if (o.cbSize > 0 && raw.length >= 18 + o.cbSize) {
      o.ext = raw.subarray(18, 18 + o.cbSize);
    }
  }
  return o;
}

/** Parse un strl (payload). Retourne le descripteur de stream. */
export function parseStrl(buf, start, end) {
  const s = {
    fccType: "", handler: "", scale: 0, rate: 0, start: 0, length: 0,
    bufSize: 0, sampleSize: 0, strf: null, strd: new Uint8Array(0), name: "",
  };
  let p = start;
  while (p + 8 <= end) {
    const h = chunkHeader(buf, p);
    const ds = p + h.hdr, de = Math.min(end, p + h.hdr + h.size);
    if (h.isList) { p = Number(chunkEnd(BigInt(p), h)); continue; }
    try {
      if (h.id === "strh") {
        const sh = parseStrh(buf, ds, de);
        Object.assign(s, {
          fccType: sh.fccType, handler: sh.handler, scale: sh.scale, rate: sh.rate,
          start: sh.start, length: sh.length, bufSize: sh.suggestedBufSize,
          sampleSize: sh.sampleSize,
        });
      } else if (h.id === "strf") {
        const raw = buf.subarray(ds, de);
        s.strf = s.fccType === "auds" ? parseAudioStrf(raw)
          : s.fccType === "vids" ? parseVideoStrf(raw)
          : { kind: "other", raw };
      } else if (h.id === "strd") {
        s.strd = Uint8Array.from(buf.subarray(ds, de));
      } else if (h.id === "strn") {
        s.name = new TextDecoder().decode(buf.subarray(ds, de)).replace(/\0+$/, "");
      }
    } catch {}
    p = Number(chunkEnd(BigInt(p), h));
    if (p <= ds) break;
  }
  return s;
}
