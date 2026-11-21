// packages/color-meta/src/index.js — métadonnées de couleur/HDR, sans I/O.
// Sources, par ordre de priorité : conteneur (MKV Colour, MP4 colr/mdcv/
// clli), puis VUI du bitstream (SPS H.264/HEVC — le seul endroit où certains
// muxers écrivent les primaires/transfert). Sortie normalisée pour
// VideoDecoderConfig.colorSpace (chaînes WebCodecs) + tone mapping.
//
// Codes CICP (H.273) → chaînes WebCodecs.

const PRIMARIES = {
  1: "bt709", 4: "bt470m", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m",
  8: "film", 9: "bt2020", 10: "smpte428", 11: "smpte431", 12: "smpte432",
  22: "ebu3213",
};
const TRANSFER = {
  1: "bt709", 4: "bt709", 5: "bt709", 6: "smpte170m", 7: "smpte240m",
  8: "linear", 9: "log", 10: "log-sqrt", 11: "iec61966-2-4", 12: "bt1361",
  13: "iec61966-2-1", 14: "bt709", 15: "bt709", 16: "pq", 17: "smpte428",
  18: "hlg",
};
const MATRIX = {
  0: "rgb", 1: "bt709", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m",
  9: "bt2020-ncl", 10: "bt2020-cl", 11: "smpte2085", 12: "chroma-derived-ncl",
  13: "chroma-derived-cl", 14: "ictcp",
};

/** Normalise {primaries, transfer, matrix, fullRange, maxCLL, maxFALL,
 *  mastering} (codes CICP en entrée) → chaînes WebCodecs + booléens.
 *  Retourne null si rien d'exploitable. */
export function normalizeColor(src) {
  if (!src) return null;
  const out = {};
  const p = PRIMARIES[src.primaries];
  const t = TRANSFER[src.transfer];
  const m = MATRIX[src.matrix];
  if (p) out.primaries = p;
  if (t) out.transfer = t;
  if (m) out.matrix = m;
  if (typeof src.fullRange === "boolean") out.fullRange = src.fullRange;
  if (src.maxCLL > 0) out.maxCLL = src.maxCLL;
  if (src.maxFALL > 0) out.maxFALL = src.maxFALL;
  if (src.mastering) out.mastering = src.mastering;
  return Object.keys(out).length ? out : null;
}

/** HDR = transfert PQ ou HLG (ou primaires BT.2020 + PQ/HLG). */
export function isHdr(color) {
  const t = color?.transfer;
  return t === "pq" || t === "hlg";
}

/** HDR10 (PQ statique) vs HLG. */
export function hdrMode(color) {
  if (!color) return "sdr";
  if (color.transfer === "pq") return "pq";
  if (color.transfer === "hlg") return "hlg";
  return "sdr";
}

/** colorSpace pour VideoDecoderConfig (sans clés inconnues). */
export function toWebCodecsColorSpace(color) {
  if (!color) return null;
  const cs = {};
  if (color.primaries) cs.primaries = color.primaries;
  if (color.transfer) cs.transfer = color.transfer;
  if (color.matrix) cs.matrix = color.matrix;
  if (typeof color.fullRange === "boolean") cs.fullRange = color.fullRange;
  return Object.keys(cs).length >= 2 ? cs : null;
}

/** Fusionne conteneur (prioritaire) et VUI (repli), champ par champ.
 *  Les codes CICP 0 (non spécifié) sont ignorés ; les booléens comptent. */
export function mergeColor(container, vui) {
  if (!container && !vui) return null;
  // CICP 2 = "unspecified" (et 0 pour primaires/transfert) : ne doit pas
  // écraser une valeur exploitable venue de l'autre source.
  const unspecified = (k, v) => v === 2 || (v === 0 && k !== "matrix");
  const out = {};
  for (const src of [vui ?? {}, container ?? {}]) {
    for (const [k, v] of Object.entries(src)) {
      if (v == null) continue;
      if (typeof v === "number" && unspecified(k, v)) continue;
      if (k === "mastering" && typeof v === "object") out.mastering = { ...(out.mastering ?? {}), ...v };
      else out[k] = v;
    }
  }
  return normalizeColor(out);
}

// ---- Lecteur de bits MSB-first (RBSP) ----
export function MSBR(buf, off = 0) {
  let byte = off, bits = 0, nbits = 0;
  return {
    u(n) {
      let v = 0;
      while (n > 0) {
        if (nbits === 0) {
          if (byte >= buf.length) throw new RangeError("bits épuisés");
          bits = buf[byte++];
          nbits = 8;
        }
        const take = Math.min(n, nbits);
        v = (v << take) | ((bits >> (nbits - take)) & ((1 << take) - 1));
        nbits -= take;
        n -= take;
      }
      return v >>> 0;
    },
    ue() {
      let z = 0;
      while (this.u(1) === 0) {
        z++;
        if (z > 31) throw new RangeError("ue démesuré");
      }
      return ((1 << z) - 1) + (z ? this.u(z) : 0);
    },
    se() {
      const v = this.ue();
      return v & 1 ? (v + 1) >> 1 : -(v >> 1);
    },
    skip(n) { for (let i = 0; i < n; i++) this.u(1); },
  };
}

/** Retire les octets d'anti-émulation 0x000003 → RBSP. */
export function ebspToRbsp(nal) {
  const out = new Uint8Array(nal.length);
  let o = 0;
  for (let i = 0; i < nal.length; i++) {
    if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
      out[o++] = 0; out[o++] = 0;
      i += 2;
    } else out[o++] = nal[i];
  }
  return out.subarray(0, o);
}

/** VUI H.265 : video_signal_type → { fullRange, primaries, transfer, matrix }. */
function hevcVui(r) {
  if (!r.u(1)) return null; // aspect_ratio_info_present
  const ar = r.u(8);
  if (ar === 255) { r.u(16); r.u(16); }
  if (r.u(1)) r.u(1); // overscan
  if (!r.u(1)) return null; // video_signal_type_present
  r.u(3); // video_format
  const fullRange = r.u(1) === 1;
  const out = { fullRange };
  if (r.u(1)) { // colour_description_present
    out.primaries = r.u(8);
    out.transfer = r.u(8);
    out.matrix = r.u(8);
  }
  return out;
}

/** VUI H.264 : idem. */
function avcVui(r) {
  if (!r.u(1)) return null;
  const ar = r.u(8);
  if (ar === 255) { r.u(16); r.u(16); }
  if (r.u(1)) r.u(1);
  if (!r.u(1)) return null;
  r.u(3);
  const fullRange = r.u(1) === 1;
  const out = { fullRange };
  if (r.u(1)) {
    out.primaries = r.u(8);
    out.transfer = r.u(8);
    out.matrix = r.u(8);
  }
  return out;
}

function hevcScalingList(r) {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    const n = sizeId === 3 ? 2 : 6;
    for (let matrixId = 0; matrixId < n; matrixId++) {
      if (!r.u(1)) { r.ue(); continue; }
      if (sizeId > 1) r.se();
      const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
      for (let i = 0; i < coefNum; i++) r.se();
    }
  }
}

function hevcStRps(r, idx, numSets, deltaPocs) {
  let interPred = 0;
  if (idx !== 0) interPred = r.u(1);
  if (interPred) {
    if (idx === numSets) r.ue(); // delta_idx_minus1
    r.u(1); // delta_rps_sign
    r.ue(); // abs_delta_rps_minus1
    const ref = deltaPocs[idx - 1] ?? 0;
    let count = 0;
    for (let j = 0; j <= ref; j++) {
      if (!r.u(1)) r.u(1);
      else count++;
    }
    deltaPocs[idx] = count;
    return;
  }
  const neg = r.ue(), pos = r.ue();
  for (let i = 0; i < neg; i++) { r.ue(); r.u(1); }
  for (let i = 0; i < pos; i++) { r.ue(); r.u(1); }
  deltaPocs[idx] = neg + pos;
}

/** VUI d'un SPS HEVC (NAL brute avec header 2o) → couleur ou null. */
export function parseHevcSpsColor(nal) {
  try {
    const r = MSBR(ebspToRbsp(nal), 2);
    r.u(4); // vps_id
    const maxSub = r.u(3);
    r.u(1); // temporal_nesting
    // profile_tier_level
    r.u(2); r.u(1);
    r.u(5); // profile
    r.u(32); r.u(32); r.u(16);
    const level = r.u(8);
    void level;
    if (maxSub > 0) {
      let flags = 0, levels = 0;
      for (let i = 0; i < maxSub; i++) {
        if (r.u(1)) flags |= 1 << i;
        if (r.u(1)) levels |= 1 << i;
      }
      for (let i = 0; i < maxSub; i++) {
        if (flags & (1 << i)) { r.u(2); r.u(1); r.u(5); r.u(32); r.u(32); r.u(16); }
        if (levels & (1 << i)) r.u(8);
      }
    }
    r.ue(); // sps_id
    const chroma = r.ue();
    if (chroma === 3) r.u(1);
    r.ue(); r.ue(); // width, height
    if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); } // conformance window
    r.ue(); r.ue(); // bit depths
    const log2poc = r.ue() + 4;
    const ordering = r.u(1);
    for (let i = ordering ? 0 : maxSub; i <= maxSub; i++) { r.ue(); r.ue(); r.ue(); }
    r.ue(); r.ue(); r.ue(); r.ue(); // luma/tx block sizes
    r.ue(); r.ue(); // hierarchy depths
    if (r.u(1)) { // scaling_list_enabled
      if (r.u(1)) hevcScalingList(r);
    }
    r.u(1); // amp
    r.u(1); // sao
    if (r.u(1)) { // pcm
      r.u(4); r.u(4); r.ue(); r.ue(); r.u(1);
    }
    const numSt = r.ue();
    const deltaPocs = [];
    for (let i = 0; i < numSt; i++) hevcStRps(r, i, numSt, deltaPocs);
    if (r.u(1)) { // long_term_ref_pics
      const n = r.ue();
      for (let i = 0; i < n; i++) { r.u(log2poc); r.u(1); }
    }
    r.u(1); // temporal_mvp
    r.u(1); // strong_intra_smoothing
    if (!r.u(1)) return null; // vui_parameters_present
    return hevcVui(r);
  } catch {
    return null;
  }
}

function avcSkipScalingList(r, size) {
  let last = 8, next = 8;
  for (let j = 0; j < size; j++) {
    if (next) {
      const d = r.se();
      next = (last + d + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

/** VUI d'un SPS H.264 (NAL brute avec header 1o) → couleur ou null. */
export function parseAvcSpsColor(nal) {
  try {
    const r = MSBR(ebspToRbsp(nal), 1);
    const profile = r.u(8);
    r.u(8); r.u(8); // constraints + level
    r.ue(); // sps_id
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = r.ue();
      if (chroma === 3) r.u(1);
      r.ue(); r.ue(); // bit depths
      r.u(1); // qpprime
      if (r.u(1)) {
        const n = chroma === 3 ? 12 : 8;
        for (let i = 0; i < n; i++) if (r.u(1)) avcSkipScalingList(r, i < 6 ? 16 : 64);
      }
    }
    r.ue(); // log2_max_frame_num
    const poc = r.ue();
    if (poc === 0) r.ue();
    else if (poc === 1) {
      r.u(1);
      r.se(); r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue(); r.u(1); // ref frames + gaps
    r.ue(); r.ue(); // width, height
    const frameOnly = r.u(1);
    if (!frameOnly) r.u(1);
    r.u(1); // direct_8x8
    if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); } // crop
    if (!r.u(1)) return null; // vui_parameters_present
    return avcVui(r);
  } catch {
    return null;
  }
}

/** Extrait SPS d'un hvcC (record nu) → Uint8Array ou null. */
export function spsFromHvcC(priv) {
  if (!priv || priv.length < 24) return null;
  let r = priv;
  if (r[0] === 0x68 && r[1] === 0x76 && r[2] === 0x63 && r[3] === 0x43) r = r.subarray(4);
  if (r[0] !== 1 || r.length < 23) return null;
  let o = 23;
  for (let a = 0; a < r[22] && o + 3 <= r.length; a++) {
    const type = r[o] & 0x3f;
    o += 1;
    const n = (r[o] << 8) | r[o + 1];
    o += 2;
    for (let i = 0; i < n && o + 2 <= r.length; i++) {
      const len = (r[o] << 8) | r[o + 1];
      o += 2;
      if (o + len > r.length) return null;
      if (type === 33) return r.subarray(o, o + len);
      o += len;
    }
  }
  return null;
}

/** Extrait SPS d'un avcC. */
export function spsFromAvcC(priv) {
  if (!priv || priv.length < 8 || priv[0] !== 1) return null;
  const n = priv[5] & 0x1f;
  if (!n) return null;
  let o = 6;
  for (let i = 0; i < n; i++) {
    if (o + 2 > priv.length) return null;
    const len = (priv[o] << 8) | priv[o + 1];
    o += 2;
    if (o + len > priv.length) return null;
    if (i === 0) return priv.subarray(o, o + len);
    o += len;
  }
  return null;
}

/** Couleur depuis extradata de piste (hvcC/avcC) — repli VUI. */
export function colorFromExtradata(family, priv) {
  if (!priv || !priv.length) return null;
  if (family === "hevc") {
    const sps = spsFromHvcC(priv);
    return sps ? parseHevcSpsColor(sps) : null;
  }
  if (family === "h264") {
    const sps = spsFromAvcC(priv);
    return sps ? parseAvcSpsColor(sps) : null;
  }
  return null;
}

/** colr 'nclx' MP4 (contenu 4+ octets après le type) → couleur.
 * b = bytes après "colr" : type(4) + primaries(2) + transfer(2) +
 * matrix(2) + full_range(1, bit 7). */
export function parseColrBox(b) {
  if (!b || b.length < 11) return null;
  const type = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (type !== "nclx" && type !== "nclc") return null;
  const primaries = (b[4] << 8) | b[5];
  const transfer = (b[6] << 8) | b[7];
  const matrix = (b[8] << 8) | b[9];
  const out = { primaries, transfer, matrix };
  if (type === "nclx") out.fullRange = (b[10] & 0x80) !== 0;
  return out;
}

/** mdcv MP4 : display primaries (u16 ×8), lum max/min (u32 ×2). */
export function parseMdcvBox(b) {
  if (!b || b.length < 24) return null;
  const u16 = (o) => (b[o] << 8) | b[o + 1];
  const u32 = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  return {
    rx: u16(0) / 50000, ry: u16(2) / 50000,
    gx: u16(4) / 50000, gy: u16(6) / 50000,
    bx: u16(8) / 50000, by: u16(10) / 50000,
    wx: u16(12) / 50000, wy: u16(14) / 50000,
    lumMax: u32(16) / 10000, lumMin: u32(20) / 10000,
  };
}

/** clli MP4 : maxCLL, maxFALL (u16). */
export function parseClliBox(b) {
  if (!b || b.length < 4) return null;
  return { maxCLL: (b[0] << 8) | b[1], maxFALL: (b[2] << 8) | b[3] };
}
