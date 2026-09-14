// packages/sw-decode/src/mpeg2.js — décodage logiciel MPEG-1/2 vidéo
// via le build FFmpeg decode-only vendor/mpeg2 (LGPL-2.1+, voir
// vendor/mpeg2/BUILD.md). Utilisé quand WebCodecs n'expose pas le codec
// (MPEG-2 : jamais supporté navigateurs).
//
// Contrat (même forme que MP4VSession, format 0 = I420) :
//   - createMPEG2Session(codecpar, codecName) -> session
//     (codecpar = piste enrichie : { family, width, height, ... },
//     codecName = 'mpeg2video'|'mpeg1video')
//   - session.decode(packetBytes, ptsUs) -> frames[] (0 ou 1 frame)
//     frame = { format:0, width, height, data (I420 dense), layout, pts (µs),
//       time_base_num:1, time_base_den:1000000 } — consommé tel quel par
//     libavI420FrameToVideoFrame dans app/worker.js.
//   - session.reset()   -> flush post-seek
//   - session.destroy() -> libération slot + tampons
//
// Pas de réordonnancement (fixtures `-bf 0`, même limite que mp4v/AVI).
import createMpeg2Module from "../vendor/mpeg2/mpeg2.mjs";

let modulePromise = null;
async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = await createMpeg2Module();
      return {
        mod,
        create: mod.cwrap("mpeg2_create", "number", ["string", "number", "number"]),
        decode: mod.cwrap("mpeg2_decode", "number",
          ["number", "number", "number", "number", "number", "number", "number", "number", "number"]),
        flush: mod.cwrap("mpeg2_flush", null, ["number"]),
        free: mod.cwrap("mpeg2_free", null, ["number"]),
      };
    })();
  }
  return modulePromise;
}

const MPEG2_ERRORS = {
  "-1": "slot invalide", "-2": "tampon invalide", "-3": "paquet rejeté",
  "-4": "erreur interne du décodeur", "-5": "format de sortie inattendu (pas du YUV planaire 8 bits)",
  "-6": "résolution inattendue ou tampon trop petit",
};

export class MPEG2Session {
  constructor(api, slot, { codec, width, height }) {
    this.api = api;
    this.slot = slot;
    this.codec = codec;
    this.width = width;
    this.height = height;
    const { mod } = api;
    this._mod = mod;
    const ySize = width * height;
    const uvSize = ((width + 1) >> 1) * ((height + 1) >> 1);
    this._ySize = ySize;
    this._uvSize = uvSize;
    this._outPtr = mod._malloc(ySize + 2 * uvSize);
    this._inPtr = mod._malloc(4 * 1048576); // paquets vidéo ≤ 4MiB (I-frame 1080p large)
    this._inCap = 4 * 1048576;
    this._pW = mod._malloc(4);
    this._pH = mod._malloc(4);
  }

  decode(packetBytes, ptsUs) {
    const { api } = this;
    if (!packetBytes?.length) return [];
    if (packetBytes.length > this._inCap) {
      throw new Error(`[sw-dec] paquet ${this.codec} trop gros (${packetBytes.length} o)`);
    }
    api.mod.HEAPU8.set(packetBytes, this._inPtr);
    const r = api.decode(this.slot, this._inPtr, packetBytes.length,
      this._outPtr, this._ySize + 2 * this._uvSize,
      this.width, this.height, this._pW, this._pH);
    if (r < 0) {
      throw new Error(`[sw-dec] ${this.codec}: ${MPEG2_ERRORS[String(r)] ?? `erreur ${r}`}`);
    }
    if (r === 0) return [];
    const w = this.width, h = this.height;
    const uvW = (w + 1) >> 1;
    const data = new Uint8Array(
      api.mod.HEAPU8.buffer, this._outPtr, this._ySize + 2 * this._uvSize).slice();
    return [{
      format: 0,
      width: w,
      height: h,
      data,
      layout: [
        { offset: 0, stride: w },
        { offset: this._ySize, stride: uvW },
        { offset: this._ySize + this._uvSize, stride: uvW },
      ],
      pts: ptsUs,
      time_base_num: 1,
      time_base_den: 1000000000,
    }];
  }

  /** Drainage de fin : pousse un paquet vide (frames retardées éventuelles). */
  drain() {
    const { api } = this;
    const r = api.decode(this.slot, 0, 0,
      this._outPtr, this._ySize + 2 * this._uvSize,
      this.width, this.height, this._pW, this._pH);
    if (r !== 1) return [];
    const w = this.width;
    const uvW = (w + 1) >> 1;
    const data = new Uint8Array(
      api.mod.HEAPU8.buffer, this._outPtr, this._ySize + 2 * this._uvSize).slice();
    return [{
      format: 0, width: w, height: this.height, data,
      layout: [
        { offset: 0, stride: w },
        { offset: this._ySize, stride: uvW },
        { offset: this._ySize + this._uvSize, stride: uvW },
      ],
      pts: -1, time_base_num: 1, time_base_den: 1000000000,
    }];
  }

  reset() {
    try {
      this.api.flush(this.slot);
    } catch (e) {
      console.warn("[sw-dec] mpeg2 flush:", e);
    }
  }

  destroy() {
    try {
      this.api.free(this.slot);
    } catch {}
    const m = this._mod;
    try {
      m._free(this._inPtr);
      m._free(this._outPtr);
      m._free(this._pW);
      m._free(this._pH);
    } catch {}
    this.slot = -1;
  }
}

/** Crée une session MPEG-1/2 vidéo. */
export async function createMPEG2Session(codecpar, codecName) {
  const width = Number(codecpar?.width ?? 0);
  const height = Number(codecpar?.height ?? 0);
  if (!width || !height || width > 4096 || height > 2304) {
    throw new Error(`[sw-dec] ${codecName}: dimensions invalides (${width}x${height})`);
  }
  const api = await loadModule();
  const slot = api.create(codecName, width, height);
  if (slot < 0) throw new Error(`[sw-dec] mpeg2_create(${codecName}) a échoué (${slot})`);
  console.log(`[sw-dec] décodeur logiciel ${codecName} activé (WASM FFmpeg) : ${width}x${height}`);
  return new MPEG2Session(api, slot, { codec: codecName, width, height });
}
