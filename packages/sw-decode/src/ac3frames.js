// packages/sw-decode/src/ac3frames.js — découpage et mesure de frames (E)AC-3.
// Tailles AC-3 : ATSC A/52 table 5.18 (mots de 16 bits).
// Tailles E-AC-3 (A/52B) : frmsiz 11 bits → (frmsiz+1) mots.
// Échantillons : AC-3 toujours 6 blocs × 256 ; E-AC-3 numblkscod (octet 4,
// bits 5-4, table eac3_blocks=[1,2,3,6] de l'analyseur FFmpeg ac3_parser.c,
// 256 éch./bloc ; fscod==3 → 6 blocs).

const AC3_WORDS = [
  [64,64,80,80,96,96,112,112,128,128,160,160,192,192,224,224,256,256,320,320,384,384,448,448,512,512,640,640,768,768,896,896,1024,1024,1152,1152,1280,1280],
  [69,70,87,88,104,105,121,122,139,140,174,175,208,209,243,244,278,279,348,349,417,418,487,488,557,558,696,697,835,836,975,976,1114,1115,1253,1254,1393,1394],
  [96,96,120,120,144,144,168,168,192,192,240,240,288,288,336,336,384,384,480,480,576,576,672,672,768,768,960,960,1152,1152,1344,1344,1536,1536],
];

const EAC3_BLOCKS = [1, 2, 3, 6];

/** bsid d'une frame (octet 5, bits 7-3). 16 = E-AC-3, ≤10 = AC-3. */
export function ac3Bsid(frame) {
  if (!frame || frame.length < 6) return -1;
  if (frame[0] !== 0x0b || frame[1] !== 0x77) return -1;
  return frame[5] >> 3;
}

/** Taille en octets d'une frame à `pos` (0 si sync invalide). */
export function ac3FrameSize(buf, pos) {
  if (pos + 6 > buf.length) return 0;
  if (buf[pos] !== 0x0b || buf[pos + 1] !== 0x77) return 0;
  const bsid = buf[pos + 5] >> 3;
  if (bsid === 16) {
    const frmsiz = ((buf[pos + 2] & 0x07) << 8) | buf[pos + 3];
    return (frmsiz + 1) * 2;
  }
  if (bsid > 16) return 0;
  const fscod = buf[pos + 4] >> 6;
  const frmsizecod = buf[pos + 4] & 0x3f;
  if (fscod > 2 || frmsizecod > 37) return 0;
  return AC3_WORDS[fscod][frmsizecod] * 2;
}

/** Échantillons/voie d'une frame complète (0 si invalide). */
export function ac3FrameSamples(frame) {
  if (!frame || frame.length < 6) return 0;
  const bsid = ac3Bsid(frame);
  if (bsid < 0 || bsid > 16) return 0;
  if (bsid < 16) return 1536;
  const fscod = (frame[4] >> 6) & 0x03;
  const nblk = fscod === 3 ? 6 : EAC3_BLOCKS[(frame[4] >> 4) & 0x03];
  return nblk * 256;
}

/** Découpe un flux élémentaire (E)AC-3 en frames (sync 0x0B77). */
export function splitAc3Frames(buf) {
  const out = [];
  let i = 0;
  while (i + 6 < buf.length) {
    if (buf[i] !== 0x0b || buf[i + 1] !== 0x77) { i++; continue; }
    const size = ac3FrameSize(buf, i);
    if (size < 8 || i + size > buf.length) {
      if (size === 0) { i++; continue; } // sync invalide : avance
      break; // queue tronquée : on s'arrête
    }
    out.push(buf.subarray(i, i + size));
    i += size;
  }
  return out;
}
