// packages/ts-demux/src/pes.js — paquets PES (re-assemblage + horodatage).
// Préfixe 0x000001, stream_id, longueur (0 = non bornée : vidéo), PTS/DTS
// 33 bits @90kHz. Un PES = une unité d'accès en pratique (ffmpeg aligne).

/** Lit PTS/DTS (5o à `o`, préfixe 4 bits déjà masqué). Retourne BigInt ticks. */
function ts33(b, o) {
  return (BigInt(b[o] & 0x0e) << 29n) | (BigInt(b[o + 1]) << 22n) |
    (BigInt((b[o + 2] & 0xfe) >> 1) << 15n) | (BigInt(b[o + 3]) << 7n) |
    BigInt(b[o + 4] >> 1);
}

/** Parse l'en-tête PES (payload démarré par PUSI).
 * Retourne { hdrLen, pts (BigInt|null), dts (BigInt|null), streamId }
 * ou null (bourrage/stream privé non-PES). */
export function parsePesHeader(payload) {
  if (payload.length < 9) return null;
  if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return null;
  const streamId = payload[3];
  // stream_id sys (BC, BE, BF, F0, F1, F2, FF, F8) : pas de PES std.
  if (streamId === 0xbc || streamId === 0xbe || streamId === 0xbf ||
      streamId === 0xf0 || streamId === 0xf1 || streamId === 0xf2 ||
      streamId === 0xff || streamId === 0xf8) return null;
  if ((payload[6] & 0xc0) !== 0x80) return null; // '10' attendu
  const ptsDts = (payload[7] >> 6) & 0x03;
  const hlen = payload[8];
  if (9 + hlen > payload.length) return null;
  let pts = null, dts = null;
  if (ptsDts === 0x02 && hlen >= 5) {
    pts = ts33(payload, 9);
    dts = pts;
  } else if (ptsDts === 0x03 && hlen >= 10) {
    pts = ts33(payload, 9);
    dts = ts33(payload, 14);
  }
  return { hdrLen: 9 + hlen, pts, dts, streamId };
}

export const ns90k = (ticks) => Number((ticks * 1000000000n) / 90000n);
