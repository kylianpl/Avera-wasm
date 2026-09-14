// packages/sw-decode/src/dca.js — décodage logiciel DTS core (fallback audio).
// Backend : vendor/dca/dca.mjs (build decode-only FFmpeg dca, LGPL-2.1+,
// voir vendor/dca/BUILD.md). Les navigateurs n'exposent DTS ni en
// WebCodecs ni en MSE géré : quand isConfigSupported échoue, worker.js
// bascule sur setupFallbackAudioDecoder → ff_init_decoder(dts).
//
// Contrat (même que le chemin libav historique) :
//   - createDCASession(codecpar) -> session
//     (codecpar = piste enrichie : { family:'dts', channels,
//     sampleRate|sample_rate, extradata? } — le DTS core n'a pas
//     d'extradata, les frames sont auto-délimitées)
//   - session.decode(packetBytes, ptsUs) -> frames[] (0 ou 1 frame)
//     frame = { format:3 (FLT), sample_rate, channels, nb_samples,
//       data:Float32Array ENTRELACÉ, pts (µs, Number), time_base_num:1,
//       time_base_den:1000000 } — consommé tel quel par bufferAudioSamples
//     (branche "LibAV frame / interleaved data").
//   - session.reset()   -> flush post-seek (état overlap-add réinitialisé)
//   - session.destroy() -> libération slot + tampons
//
// Le contexte natif accumule l'état inter-frames : décoder les paquets en
// continu donne un PCM exact (vérifié bit-à-bit ±1e-6 contre le même
// FFmpeg natif, cf. vendor/dca/BUILD.md).
import createDcaModule from "../vendor/dca/dca.mjs";

const FRAME_SAMPLES = 2048; // max échantillons/voie par frame DTS (nblks ≤ 63)
const MAX_FRAMES_PER_PACKET = 8; // borne tampon (paquets TS ≈ 1 frame)
const MAX_CHANNELS = 8;
const IN_CAP = 65536; // une frame DTS core fait au plus 16 Ko

let modulePromise = null;
async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = await createDcaModule();
      return {
        mod,
        create: mod.cwrap("dca_create", "number", ["number"]),
        decode: mod.cwrap("dca_decode", "number",
          ["number", "number", "number", "number", "number", "number", "number", "number"]),
        flush: mod.cwrap("dca_flush", null, ["number"]),
        free: mod.cwrap("dca_free", null, ["number"]),
      };
    })();
  }
  return modulePromise;
}

const DCA_ERRORS = {
  "-1": "slot invalide", "-2": "tampon invalide", "-3": "paquet rejeté",
  "-4": "erreur interne du décodeur", "-5": "format de sortie inattendu",
  "-6": "paquet trop gros / layout changeant",
};

export class DCASession {
  constructor(api, slot, { codec, channels, sampleRate }) {
    this.api = api;
    this.slot = slot;
    this.codec = codec; // "ac3" | "eac3"
    this.channels = channels;
    this.sampleRate = sampleRate;
    const { mod } = api;
    this._mod = mod;
    this._inPtr = mod._malloc(IN_CAP);
    this._outCap = MAX_FRAMES_PER_PACKET * FRAME_SAMPLES;
    this._outPtr = mod._malloc(this._outCap * MAX_CHANNELS * 4);
    this._pSr = mod._malloc(4);
    this._pCh = mod._malloc(4);
    this._pNb = mod._malloc(4);
    this._warnedLayout = false;
  }

  decode(packetBytes, ptsUs) {
    const { api } = this;
    if (!packetBytes?.length) return [];
    if (packetBytes.length > IN_CAP) {
      throw new Error(`[sw-dec] paquet ${this.codec} trop gros (${packetBytes.length} o)`);
    }
    api.mod.HEAPU8.set(packetBytes, this._inPtr);
    const n = api.decode(this.slot, this._inPtr, packetBytes.length,
      this._outPtr, this._outCap, this._pSr, this._pCh, this._pNb);
    if (n < 0) {
      throw new Error(`[sw-dec] ${this.codec}: ${DCA_ERRORS[String(n)] ?? `erreur ${n}`}`);
    }
    if (n === 0) return [];
    const H32 = api.mod.HEAP32;
    const sr = H32[this._pSr / 4];
    let ch = H32[this._pCh / 4];
    if (sr !== this.sampleRate) {
      throw new Error(`[sw-dec] ${this.codec}: sr négocié ${sr} ≠ déclaré ${this.sampleRate}`);
    }
    // Le ringbuffer audio est dimensionné sur les voies déclarées (codecpar).
    // En pratique elles correspondent ; sinon on remappe sans casser le flux.
    let data;
    if (ch === this.channels) {
      data = new Float32Array(api.mod.HEAPF32.buffer, this._outPtr, n * ch).slice();
    } else {
      if (!this._warnedLayout) {
        console.warn(`[sw-dec] ${this.codec}: ${ch} voies décodées ≠ ${this.channels} déclarées (remappage)`);
        this._warnedLayout = true;
      }
      const src = new Float32Array(api.mod.HEAPF32.buffer, this._outPtr, n * ch);
      data = new Float32Array(n * this.channels);
      const keep = Math.min(ch, this.channels);
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < keep; c++) data[i * this.channels + c] = src[i * ch + c];
      }
      ch = this.channels;
    }
    return [{
      format: 3, // FLT (cf. fmtNames dans worker.js)
      sample_rate: this.sampleRate,
      channels: ch,
      ch_layout_nb_channels: ch,
      nb_samples: n,
      data,
      pts: ptsUs,
      time_base_num: 1,
      time_base_den: 1000000,
    }];
  }

  reset() {
    try {
      this.api.flush(this.slot);
    } catch (e) {
      console.warn("[sw-dec] dca flush:", e);
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
      m._free(this._pSr);
      m._free(this._pCh);
      m._free(this._pNb);
    } catch {}
    this.slot = -1;
  }
}

/** Crée une session DTS depuis le codecpar (famille + voies + taux). */
export async function createDCASession(codecpar) {
  const family = codecpar?.family;
  const codecId = 86056;
  const channels = Number(codecpar?.channels ?? codecpar?.channelCount ?? 0);
  const sampleRate = Number(codecpar?.sample_rate ?? codecpar?.sampleRate ?? 0);
  if (!channels || !sampleRate) {
    throw new Error(`[sw-dec] ${family ?? "dts?"}: codecpar incomplet (ch=${channels} sr=${sampleRate})`);
  }
  const api = await loadModule();
  const slot = api.create(codecId);
  if (slot < 0) throw new Error(`[sw-dec] dca_create a échoué (${slot})`);
  console.log(`[sw-dec] décodeur logiciel ${family} activé (WASM FFmpeg) : ${channels}ch ${sampleRate}Hz`);
  return new DCASession(api, slot, { codec: family, channels, sampleRate });
}
