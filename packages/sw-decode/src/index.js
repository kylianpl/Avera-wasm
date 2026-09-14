// packages/sw-decode/src/index.js — décodage logiciel WASM de secours (Phase 4).
// HEVC/H.265 via libde265 (vendor/libde265, LGPL-3.0, MIT pour le build WASM).
//
// Contexte : quand le navigateur ne supporte PAS le codec en WebCodecs
// (ex. HEVC hors Chrome/Edge matériel, ou `?sw=` forcé), worker.js bascule sur
// le chemin "libav" (setupFallbackVideoDecoder). Cette façade fournit le même
// contrat que les stubs Phase 4 qu'elle remplace :
//   - ff_init_decoder(codec_id, codecpar)  -> [_, ctx, pkt, frame]
//   - ff_decode_multi(ctx, pkt, frame, packets) -> frames[] au format libav
//     (format 0 = I420) que libavI420FrameToVideoFrame sait convertir.
//   - avcodec_flush_buffers(ctx)           -> reset() (seek)
//   - ff_free_decoder(ctx)                 -> destroy()
//
// Frames produites : { format:0, width, height, data (I420 dense),
//   layout:[{offset,stride}], pts (µs, Number), time_base_num:1,
//   time_base_den:1000000 } — cohérent avec frameTimestampUs() du worker.

import initialize from "../vendor/libde265/libde265.mjs";
import { splitAnnexB, avccToAnnexB } from "../../mkv-demux/src/annexb.js";

export { EAC3Session, createEAC3Session } from "./eac3.js";
export { createPCMSession } from "./pcm.js";
export { MP4VSession, createMP4VSession } from "./mp4v.js";
export { MPEG2Session, createMPEG2Session } from "./mpeg2.js";
export { DCASession, createDCASession } from "./dca.js";
export { splitAc3Frames, ac3FrameSize, ac3FrameSamples, ac3Bsid } from "./ac3frames.js";

const WASM_URL = new URL("../vendor/libde265/libde265.wasm", import.meta.url);

let modulePromise = null;

async function loadWasmBytes() {
  if (WASM_URL.protocol === "file:") {
    // Repli Node (tests unitaires sous node --test) : lecture directe.
    const { readFile } = await import("node:fs/promises");
    return (await readFile(WASM_URL)).buffer;
  }
  const res = await fetch(WASM_URL, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`libde265 wasm: HTTP ${res.status} (${WASM_URL.href})`);
  return await res.arrayBuffer();
}

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const wasmBytes = await loadWasmBytes();
      return initialize({
        instantiateWasm(info, receive) {
          WebAssembly.instantiate(wasmBytes, info).then((r) => receive(r.instance, r.module));
          return {};
        },
      });
    })();
  }
  return modulePromise;
}

function isStartCode(b, p) {
  return (
    b[p] === 0 &&
    b[p + 1] === 0 &&
    (b[p + 2] === 1 || (b[p + 2] === 0 && b[p + 3] === 1))
  );
}

/** Découpe un paquet vidéo MKV en NALs bruts.
 *  Les tracks HEVC (V_MPEGH) sont stockés LENGTH-PREFIXED (4 octets), comme
 *  MP4 — sauf flux déjà en Annex B (start codes). On normalise vers Annex B
 *  puis on découpe. */
export function packetNals(data) {
  if (!data || !data.length) return [];
  if (isStartCode(data, 0)) return splitAnnexB(data);
  return splitAnnexB(avccToAnnexB(data, 4));
}

/** Extrait VPS/SPS/PPS (NALs bruts) d'un HEVCDecoderConfigurationRecord
 *  (hvcC). Accepte le préfixe 'hvcC' ou le record nu (norme Matroska). */
export function extractHvcCParameterSets(codecPrivate) {
  const ps = { vps: [], sps: [], pps: [] };
  if (!codecPrivate || codecPrivate.length < 24) return ps;
  let r = codecPrivate;
  if (r[0] === 0x68 && r[1] === 0x76 && r[2] === 0x63 && r[3] === 0x43) r = r.subarray(4);
  if (r[0] !== 1 || r.length < 23) return ps;
  const numArrays = r[22];
  if (numArrays === 0) return ps;
  let o = 23;
  for (let a = 0; a < numArrays && o + 3 <= r.length; a++) {
    o += 1; // arrayCompleteness + réservé
    if (o + 2 > r.length) break;
    const numNalus = (r[o] << 8) | r[o + 1];
    o += 2;
    for (let n = 0; n < numNalus && o + 2 <= r.length; n++) {
      const len = (r[o] << 8) | r[o + 1];
      o += 2;
      if (o + len > r.length) break;
      const nal = r.subarray(o, o + len);
      o += len;
      if (!nal.length) continue;
      const type = (nal[0] >> 1) & 0x3f;
      if (type === 32) ps.vps.push(nal);
      else if (type === 33) ps.sps.push(nal);
      else if (type === 34) ps.pps.push(nal);
    }
  }
  return ps;
}

function copyPlane(dst, dstOff, dstStride, src, srcOff, srcStride, width, rows) {
  if (srcStride === dstStride || width === srcStride) {
    dst.set(src.subarray(srcOff, srcOff + dstStride * rows), dstOff);
  } else {
    for (let y = 0; y < rows; y++) {
      const s = srcOff + y * srcStride;
      const d = dstOff + y * dstStride;
      for (let x = 0; x < width; x++) dst[d + x] = src[s + x];
    }
  }
}

function copyPlane16To8(dst, dstOff, dstStride, src, srcOff, srcStride, width, rows) {
  const u16 = new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
  for (let y = 0; y < rows; y++) {
    const s = (srcOff + y * srcStride) >> 1;
    const d = dstOff + y * dstStride;
    for (let x = 0; x < width; x++) dst[d + x] = (u16[x] & 0xffff) >> 2;
  }
}

/** Image libde265 → frame libav I420 (format 0), 8 bits (10→8 via >>2). */
function imageToI420Frame(img, ptsUs) {
  const w = img.getWidth(0);
  const h = img.getHeight(0);
  const bpp = img.getBitsPerPixel(0);
  const p0 = img.getImagePlane(0);
  const p1 = img.getImagePlane(1);
  const p2 = img.getImagePlane(2);
  const uvW = p1.width;
  const uvH = p1.height;
  const ySize = w * h;
  const uvSize = uvW * uvH;
  const data = new Uint8Array(ySize + uvSize * 2);
  if (bpp <= 8) {
    copyPlane(data, 0, w, p0.bytes, 0, p0.stride, w, h);
    copyPlane(data, ySize, uvW, p1.bytes, 0, p1.stride, uvW, uvH);
    copyPlane(data, ySize + uvSize, uvW, p2.bytes, 0, p2.stride, uvW, uvH);
  } else {
    copyPlane16To8(data, 0, w, p0.bytes, 0, p0.stride, w, h);
    copyPlane16To8(data, ySize, uvW, p1.bytes, 0, p1.stride, uvW, uvH);
    copyPlane16To8(data, ySize + uvSize, uvW, p2.bytes, 0, p2.stride, uvW, uvH);
  }
  return {
    format: 0,
    width: w,
    height: h,
    data,
    layout: [
      { offset: 0, stride: w },
      { offset: ySize, stride: uvW },
      { offset: ySize + uvSize, stride: uvW },
    ],
    pts: ptsUs,
    time_base_num: 1,
    time_base_den: 1000000,
  };
}

/** Session de décodage HEVC (une par flux vidéo). */
export class HEVCSession {
  constructor(Module, codecpar) {
    this.m = Module;
    this.dec = new Module.Decoder();
    this._warned = new Set();
    this._pending = []; // frames sorties par libde265, retenues jusqu'à finalisation
    // VPS/SPS/PPS hors-bande (CodecPrivate MKV = hvcC) : certains muxers
    // (ffmpeg) regroupent les paramètres dans le premier bloc en UN seul
    // "NAL" faux que libde265 ne sait pas découper. On les fournit donc
    // explicitement avant tout paquet.
    const ps = extractHvcCParameterSets(codecpar?.extradata ?? codecpar?.codecPrivate);
    this._paramNals = [...ps.vps, ...ps.sps, ...ps.pps];
    for (const nal of this._paramNals) this.dec.pushNal(nal, 0n);
    if (this._paramNals.length) {
      console.log(`[sw-dec] paramètres hvcC fournis : VPS=${ps.vps.length} SPS=${ps.sps.length} PPS=${ps.pps.length}`);
    }
  }

  /** Décode UN access unit (paquet démuxé, length-prefixed ou Annex B).
   *  libde265 sort les B-frames en ordre de décodage → on retient ses sorties
   *  puis on finalise (émet) toute frame dont le pts est < pts de l'AU courant
   *  : elle ne peut plus être devancée par une frame future. Le flux rendu est
   *  donc trié par pts (ordre de présentation), cohérent avec WebCodecs. */
  decode(data, ptsUs) {
    const nals = packetNals(data);
    const pts = Math.max(0, Math.round(ptsUs | 0));
    for (const nal of nals) this.dec.pushNal(nal, BigInt(pts));
    this.dec.pushEndOfFrame();
    this._drain();
    return this._finalize(pts);
  }

  _drain() {
    let guard = 0;
    while (guard++ < 8192) {
      const r = this.dec.decode();
      if (r.error !== this.m.Error.OK) {
        if (r.error === this.m.Error.ERROR_WAITING_FOR_INPUT_DATA) break;
        if (!this._warned.has(r.error)) {
          this._warned.add(r.error);
          console.warn(`[sw-dec] libde265 ${this.m.getErrorText(r.error)} (${r.error})`);
        }
        break;
      }
      const img = this.dec.getNextPicture();
      if (!img) {
        if (!r.more) break;
        continue;
      }
      const fpts = img.pts == null ? 0 : Number(img.pts);
      const f = imageToI420Frame(img, fpts);
      img.delete();
      // insertion triée par pts (stable : même pts → append)
      let k = this._pending.length;
      while (k > 0 && this._pending[k - 1].p > fpts) k--;
      this._pending.splice(k, 0, { p: fpts, f });
    }
  }

  _finalize(upToPts) {
    const out = [];
    while (this._pending.length && this._pending[0].p < upToPts) out.push(this._pending.shift().f);
    return out;
  }

  reset() {
    this._pending = [];
    try {
      this.dec.reset();
    } catch (e) {
      console.warn("[sw-dec] libde265 reset:", e);
    }
    // reset() vide les SPS/PPS internes ; or ffmpeg regroupe les paramètres
    // du premier bloc dans un faux "NAL" VPS que libde265 ne sait pas découper.
    // On re-fournit donc le hvcC hors-bande (idempotent, indispensable après
    // seek : sans ça le flux ne redémarre jamais).
    if (this._paramNals.length) {
      for (const nal of this._paramNals) this.dec.pushNal(nal, 0n);
    }
  }

  flush() {
    try {
      this.dec.flushData();
    } catch {}
    this._drain();
    return this._pending.map((x) => x.f);
  }

  destroy() {
    this._pending = [];
    try {
      this.dec.delete();
    } catch {}
  }
}

/** Crée une session HEVC. codecpar fournit le hvcC (VPS/SPS/PPS hors-bande).
 *  Sinon libde265 décode les paramètres in-band. */
export async function createHEVCSession(codecpar) {
  const Module = await loadModule();
  return new HEVCSession(Module, codecpar);
}