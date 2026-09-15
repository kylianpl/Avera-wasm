// packages/sw-decode/src/pcm.js — PCM brut → flottant (fallback audio logiciel).
// Pour les conteneurs qui stockent du PCM sans codec (AVI/WAVE : tag 0x0001
// entier signé LE, 0x0003 flottant LE ; MKV A_PCM/INT/LIT|BIG et
// A_PCM/FLOAT/IEEE = flottant LE) : WebCodecs ne décode pas le PCM brut,
// cette session triviale (sans état, sans WASM) le convertit en frames FLT
// consommables par bufferAudioSamples. 8/16/24/32 bits + float32/64,
// little- et big-endian (isBigEndian : pont seul, jamais WebCodecs).

/** Crée une session PCM. bits : 8|16|24|32 (entier) ou 32|64 (flottant). */
export function createPCMSession({ channels, sampleRate, bits, isFloat, isBigEndian }) {
  channels = Number(channels);
  sampleRate = Number(sampleRate);
  bits = Number(bits);
  const be = !!isBigEndian;
  if (!channels || channels > 8) throw new Error(`[sw-dec] pcm: voies invalides (${channels})`);
  if (!sampleRate || sampleRate > 192000) throw new Error(`[sw-dec] pcm: taux invalide (${sampleRate})`);
  if (isFloat && bits !== 32 && bits !== 64) {
    throw new Error(`[sw-dec] pcm: flottant ${bits} bits non supporté`);
  }
  if (!isFloat && ![8, 16, 24, 32].includes(bits)) {
    throw new Error(`[sw-dec] pcm: profondeur inconnue (${bits} — conteneur sans strf ?)`);
  }
  const bps = bits / 8;
  const le = !be; // DataView : littleEndian flag
  console.log(`[sw-dec] pont PCM logiciel : ${channels}ch ${sampleRate}Hz ${isFloat ? "f" : "s"}${bits}${be ? "be" : "le"}`);
  return {
    decode(packetBytes, ptsUs) {
      if (!packetBytes?.length) return [];
      const n = Math.floor(packetBytes.length / (channels * bps));
      if (n <= 0) return [];
      const data = new Float32Array(n * channels);
      if (isFloat && bits === 32 && le) {
        const src = new Float32Array(packetBytes.buffer, packetBytes.byteOffset, n * channels);
        data.set(src);
      } else if (isFloat && bits === 32) {
        const dv = new DataView(packetBytes.buffer, packetBytes.byteOffset);
        for (let i = 0; i < n * channels; i++) data[i] = dv.getFloat32(i * 4, false);
      } else if (isFloat) {
        const dv = new DataView(packetBytes.buffer, packetBytes.byteOffset);
        for (let i = 0; i < n * channels; i++) data[i] = dv.getFloat64(i * 8, le);
      } else if (bits === 16 && le) {
        const src = new Int16Array(packetBytes.buffer, packetBytes.byteOffset, Math.floor(packetBytes.length / 2));
        const m = Math.min(src.length, data.length);
        for (let i = 0; i < m; i++) data[i] = src[i] / 32768;
      } else if (bits === 16) {
        const dv = new DataView(packetBytes.buffer, packetBytes.byteOffset);
        for (let i = 0; i < n * channels; i++) data[i] = dv.getInt16(i * 2, false) / 32768;
      } else if (bits === 8) {
        for (let i = 0; i < data.length; i++) data[i] = (packetBytes[i] - 128) / 128;
      } else if (bits === 32 && le) {
        const src = new Int32Array(packetBytes.buffer, packetBytes.byteOffset, Math.floor(packetBytes.length / 4));
        const m = Math.min(src.length, data.length);
        for (let i = 0; i < m; i++) data[i] = src[i] / 2147483648;
      } else if (bits === 32) {
        const dv = new DataView(packetBytes.buffer, packetBytes.byteOffset);
        for (let i = 0; i < n * channels; i++) data[i] = dv.getInt32(i * 4, false) / 2147483648;
      } else {
        // 24 bits : DataView (pas d'Int24 natif).
        const dv = new DataView(packetBytes.buffer, packetBytes.byteOffset);
        let o = 0;
        for (let i = 0; i < n * channels; i++, o += 3) {
          let v;
          if (le) {
            v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
          } else {
            v = (dv.getUint8(o) << 16) | (dv.getUint8(o + 1) << 8) | dv.getUint8(o + 2);
          }
          if (v & 0x800000) v -= 0x1000000;
          data[i] = v / 8388608;
        }
      }
      return [{
        format: 3, // FLT (cf. fmtNames dans worker.js)
        sample_rate: sampleRate,
        channels,
        ch_layout_nb_channels: channels,
        nb_samples: n,
        data,
        pts: ptsUs,
        time_base_num: 1,
        time_base_den: 1000000,
      }];
    },
    reset() {}, // sans état
    destroy() {}, // sans ressource native
  };
}
