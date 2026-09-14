// packages/ogg-demux/src/codecs.js — identification BOS + durées exactes.
// Vorbis : convention 2 modes libvorbis (0=short, 1=long, 1 bit LSB —
// validée byte-exact : Σ intra-page == Δ granulepos sur fixtures mono +
// stéréo) + fenêtres (prev+cur)/4, pos_init=-D0 (pré-roll, cf. ffprobe
// pts=-128) ; granulepos exclut le padding final (snap avant uniquement,
// rogne via total). Setups exotiques ≠2 modes : page-exact, intra-page
// approché (documenté).
// Opus : TOC (RFC 6716 §3.1). FLAC : STREAMINFO + blocksize de frame.
// Theora : passthrough (clé = bit FTYPE), pas de SW decode (v1).

/** ilog(x) Vorbis : bits pour représenter x (0 si x ≤ 0). */
export function ilog(x) {
  if (x <= 0) return 0;
  let n = 0;
  while (x > 0) { n++; x >>= 1; }
  return n;
}

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000) >>> 0;
const u16be = (b, o) => (b[o] << 8) | b[o + 1];

/** Identifie un paquet BOS → descripteur de stream ou null (non géré). */
export function identifyBos(pkt) {
  if (!pkt || pkt.length < 8) return null;
  // Vorbis : 0x01 + "vorbis" (30o min).
  if (pkt[0] === 0x01 && pkt.length >= 30 &&
      pkt[1] === 0x76 && pkt[2] === 0x6f && pkt[3] === 0x72 &&
      pkt[4] === 0x62 && pkt[5] === 0x69 && pkt[6] === 0x73) {
    const channels = pkt[11];
    const rate = u32le(pkt, 12);
    const bs = pkt[28];
    const bs0 = 1 << (bs & 0x0f), bs1 = 1 << ((bs >> 4) & 0x0f);
    if (!channels || !rate || bs0 < 64 || bs1 < 64 || bs1 < bs0) return null;
    if (!(pkt[29] & 0x01)) return null; // framing
    return { codec: "vorbis", family: "vorbis", id: 86021, type: 1, channels, rate, bs0, bs1 };
  }
  // Opus : "OpusHead" (19o min).
  if (pkt.length >= 19 && pkt[0] === 0x4f && pkt[1] === 0x70 && pkt[2] === 0x75 &&
      pkt[3] === 0x73 && pkt[4] === 0x48 && pkt[5] === 0x65 && pkt[6] === 0x61 && pkt[7] === 0x64) {
    const channels = pkt[9];
    const preskip = u16le(pkt, 10);
    if (!channels || channels > 8) return null;
    return { codec: "opus", family: "opus", id: 86022, type: 1, channels, rate: 48000, preskip };
  }
  // FLAC : "fLaC" + STREAMINFO (42o). En Ogg : préfixe de mapping
  // (9o : 0x7F + "FLAC" + version + nb headers) devant.
  let foff = -1;
  if (pkt[0] === 0x66 && pkt[1] === 0x4c && pkt[2] === 0x61 && pkt[3] === 0x43) foff = 0;
  else if (pkt.length >= 51 && pkt[0] === 0x7f && pkt[1] === 0x46 && pkt[2] === 0x4c &&
      pkt[3] === 0x41 && pkt[4] === 0x43 && pkt[9] === 0x66) foff = 9;
  if (foff >= 0 && pkt.length >= foff + 42) {
    const si = parseStreamInfo(pkt.subarray(foff + 4, foff + 42));
    if (!si) return null;
    return { codec: "flac", family: "flac", id: 86028, type: 1, headOff: foff, ...si };
  }
  // Theora : 0x80 + "theora" (42o) — passthrough (pas de SW decode v1).
  // Dimensions = PICW/PICH 24 bits (FMBW/FMBH = macroblocs) ; KFGSHIFT :
  // position variable selon versions, défaut 6 sain (1..16).
  if (pkt[0] === 0x80 && pkt.length >= 42 &&
      pkt[1] === 0x74 && pkt[2] === 0x68 && pkt[3] === 0x65 &&
      pkt[4] === 0x6f && pkt[5] === 0x72 && pkt[6] === 0x61) {
    const picw = (pkt[14] << 16) | (pkt[15] << 8) | pkt[16];
    const pich = (pkt[17] << 16) | (pkt[18] << 8) | pkt[19];
    const width = picw || (u16be(pkt, 10) * 16);
    const height = pich || (u16be(pkt, 12) * 16);
    const fpsNum = (pkt[22] * 0x1000000) + ((pkt[23] << 16) | (pkt[24] << 8) | pkt[25]);
    const fpsDen = (pkt[26] * 0x1000000) + ((pkt[27] << 16) | (pkt[28] << 8) | pkt[29]);
    const kg = pkt.length > 40 ? pkt[40] : 6;
    return {
      codec: "theora", family: "theora", id: 30, type: 0,
      width, height, fpsNum, fpsDen, kgShift: kg >= 1 && kg <= 16 ? kg : 6,
    };
  }
  return null;
}

/** STREAMINFO FLAC (bloc 38o : header 4o + contenu 34o) →
 * { channels, rate, bps, total, minBlock, maxBlock, minFrame, maxFrame }. */
export function parseStreamInfo(si) {
  if (!si || si.length < 22) return null;
  if ((si[0] & 0x7f) !== 0) return null; // type bloc 0 exigé (last indifférent)
  const minBlock = u16be(si, 4), maxBlock = u16be(si, 6);
  const minFrame = (si[8] << 16) | (si[9] << 8) | si[10];
  const maxFrame = (si[11] << 16) | (si[12] << 8) | si[13];
  const rate = (si[14] << 12) | (si[15] << 4) | (si[16] >> 4);
  const channels = ((si[16] >> 1) & 0x07) + 1;
  const bps = (((si[16] & 0x01) << 4) | (si[17] >> 4)) + 1;
  // total = bas 4 bits de si[17] + si[18..21] (36 bits).
  const total = (BigInt(si[17] & 0x0f) << 32n) | (BigInt(si[18]) << 24n) |
    (BigInt(si[19]) << 16n) | (BigInt(si[20]) << 8n) | BigInt(si[21]);
  if (!rate || !channels) return null;
  return { channels, rate, bps, total, minBlock, maxBlock, minFrame, maxFrame };
}

/** Échantillons d'un paquet audio Vorbis (type 0 exigé).
 * st = { modes:[0,1] (convention libvorbis validée), bs0, bs1, prevW }.
 * Met à jour prevW. */
export function vorbisPacketSamples(pkt, st) {
  if (!pkt || !pkt.length || (pkt[0] & 0x01) !== 0) return 0;
  const m = st.modes.length;
  let mode = 0;
  if (m > 1) {
    // Lecture LSB-first de ilog(m-1) bits après le bit de type.
    const nb = ilog(m - 1);
    let v = 0;
    for (let i = 0; i < nb; i++) {
      const bit = (pkt[(1 + i) >> 3] >> ((1 + i) & 7)) & 1;
      v |= bit << i;
    }
    mode = v < m ? v : 0;
  }
  const w = st.modes[mode] ? st.bs1 : st.bs0;
  const prev = st.prevW || w;
  st.prevW = w;
  return Math.floor((prev + w) / 4);
}

/** Échantillons d'un paquet Opus (TOC RFC 6716 §3.1). 0 si illisible. */
export function opusPacketSamples(pkt) {
  if (!pkt || pkt.length < 1) return 0;
  const toc = pkt[0];
  const cfg = toc >> 3, code = toc & 0x03;
  // Durées (ms) par config.
  const DUR = [
    10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60,
    10, 20, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20,
    2.5, 5, 10, 20, 2.5, 5, 10, 20,
  ];
  const per = Math.round(DUR[cfg] * 48); // @48kHz
  if (code === 0) return per;
  if (code === 1 || code === 2) return per * 2;
  // Code 3 : compte arbitraire ; CBR (division exacte) seul supporté.
  if (pkt.length < 2) return 0;
  const count = pkt[1] & 0x3f;
  if (count < 1 || count > 48) return 0;
  const payload = pkt.length - 2;
  if (payload % count !== 0) return 0; // VBR : resync granulepos (index.js)
  return per * count;
}

/** Blocksize d'une frame FLAC (paquet Ogg = 1 frame).
 * st = { minBlock, maxBlock }. 0 si illisible. */
export function flacFrameSamples(pkt, st) {
  if (!pkt || pkt.length < 6) return 0;
  if (pkt[0] !== 0xff || (pkt[1] & 0xfc) !== 0xf8) return 0;
  const bsCode = (pkt[2] >> 4) & 0x0f;
  // N° de sample/frame (codage UTF-8, 1..7o à partir de l'octet 4).
  const u = pkt[4];
  let nb = 1;
  if (u & 0x80) {
    nb = 0;
    let b = u;
    while (b & 0x80) { nb++; b = (b << 1) & 0xff; }
    if (nb < 2 || nb > 7) return 0;
  }
  const p = 4 + nb;
  if (p > pkt.length) return 0;
  switch (bsCode) {
    case 0x00: return st.minBlock || 0; // réservé → min (borne)
    case 0x01: return 192;
    case 0x02: return 576;
    case 0x03: return 1152;
    case 0x04: return 2304;
    case 0x05: return 4608;
    case 0x06: return p < pkt.length ? pkt[p] + 1 : 0;
    case 0x07: return p + 1 < pkt.length ? ((pkt[p] << 8) | pkt[p + 1]) + 1 : 0;
    default: return 256 << (bsCode - 8); // 0x08..0x0F
  }
}

/** Privé Vorbis au format Matroska (Xiph lacing) depuis les 3 headers.
 * Bridge-compatible verbatim (même octets que CodecPrivate MKV). */
export function buildVorbisPrivate(h1, h2, h3) {
  const lace = (len) => {
    const out = [];
    while (len >= 255) { out.push(255); len -= 255; }
    out.push(len);
    return out;
  };
  const l1 = lace(h1.length), l2 = lace(h2.length);
  const out = new Uint8Array(1 + l1.length + l2.length + h1.length + h2.length + h3.length);
  let o = 0;
  out[o++] = 2; // 3 paquets - 1
  for (const b of l1) out[o++] = b;
  for (const b of l2) out[o++] = b;
  out.set(h1, o); o += h1.length;
  out.set(h2, o); o += h2.length;
  out.set(h3, o);
  return out;
}

/** Clé Theora : 2e bit à 0 (intra). Validé byte-exact : 75/75 paquets
 * vs clés ffprobe (0,12,…,72) sur fixture libtheora (le MSB, toujours 0,
 * n'est PAS le FTYPE contrairement à une lecture naïve du spec). */
export function theoraIsKey(pkt) {
  return !!pkt && pkt.length > 0 && (pkt[0] & 0x40) === 0;
}
