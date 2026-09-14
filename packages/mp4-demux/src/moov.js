// packages/mp4-demux/src/moov.js — parse moov → pistes + tables d'échantillons.
// Entre : payload moov (Uint8Array). Sortie : { tracks, mvhd, trex }.
// Chaque piste progressive expose buildSamples() → [{off,size,dts,pts,dur,key}]
// en ticks d'horloge piste (bigint, pts/dts signés pour les délais d'édition).
// Les tables suivent ISO-BMFF : stts/ctts/stsc/stsz|stz2/stco|co64/stss.

import { BR, children, findChild, f1616 } from "./boxes.js";

const MAX_SAMPLES = 50_000_000;

// objectTypeIndication ESDS → famille (audio seulement ici ; 0x20 = mp4v vidéo).
export const ESDS_AUDIO = {
  0x40: "aac", 0x66: "aac", 0x67: "aac",
  0x69: "mp3", 0x6b: "mp3",
  0xa5: "ac3", 0xa6: "eac3",
  0xa9: "dts", 0xac: "opus",
};

export function parseMvhd(buf, start, end) {
  const r = new BR(buf, start);
  const { version } = r.fullbox();
  let timescale, duration;
  if (version === 0) {
    r.skip(8);
    timescale = r.u32();
    duration = BigInt(r.u32());
    if (duration === 0xffffffffn) duration = -1n;
  } else {
    r.skip(16);
    timescale = r.u32();
    duration = r.u64();
    if (duration === 0xffffffffffffffffn) duration = -1n;
  }
  return { timescale, duration };
}

export function parseMdhd(buf, start, end) {
  const r = new BR(buf, start);
  const { version } = r.fullbox();
  let timescale, duration;
  if (version === 0) {
    r.skip(8);
    timescale = r.u32();
    duration = BigInt(r.u32());
    if (duration === 0xffffffffn) duration = -1n;
  } else {
    r.skip(16);
    timescale = r.u32();
    duration = r.u64();
    if (duration === 0xffffffffffffffffn) duration = -1n;
  }
  return { timescale, duration };
}

function parseTkhd(buf, start, end) {
  const r = new BR(buf, start);
  const { version } = r.fullbox();
  let id, duration, width, height;
  if (version === 0) {
    r.skip(8);
    id = r.u32();
    r.skip(4);
    duration = r.u32();
    r.skip(8 + 2 + 2 + 2 + 2 + 36);
    width = f1616(r.u32());
    height = f1616(r.u32());
  } else {
    r.skip(16);
    id = r.u32();
    r.skip(4);
    r.skip(8);
    r.skip(8 + 2 + 2 + 2 + 2 + 36);
    width = f1616(r.u32());
    height = f1616(r.u32());
    duration = 0;
  }
  return { id, duration, width, height };
}

function parseHdlr(buf, start, end) {
  const r = new BR(buf, start);
  r.fullbox();
  r.skip(4);
  return r.ascii(4);
}

function parseElst(buf, start, end) {
  const r = new BR(buf, start);
  const { version } = r.fullbox();
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n && r.p + (version === 0 ? 12 : 20) <= end; i++) {
    if (version === 0) {
      out.push({ segDur: BigInt(r.u32()), mediaTime: BigInt(r.i32()), rate: r.i32() });
    } else {
      out.push({ segDur: BigInt(r.u64()), mediaTime: r.u64() >= 0x8000000000000000n ? -1n : r.u64(), rate: r.i32() });
    }
  }
  return out;
}

// ---- stsd ----

function tagSearch(payload, tags) {
  // Repli : cherche un motif 4-octets suivi d'une taille(payload) plausible.
  // Retourne Map(tag → bytes du payload de la boîte).
  const out = new Map();
  for (let i = 0; i + 8 <= payload.length; i++) {
    const tag = String.fromCharCode(payload[i + 4], payload[i + 5], payload[i + 6], payload[i + 7]);
    if (!tags.includes(tag) || out.has(tag)) continue;
    const size = (payload[i] * 0x1000000) + ((payload[i + 1] << 16) | (payload[i + 2] << 8) | payload[i + 3]);
    if (size < 8 || i + size > payload.length + 8) continue;
    out.set(tag, payload.subarray(i + 8, i + size));
  }
  return out;
}

/** Parse la charge utile esds → { objectType, asc }. Tolérant (saute l'inconnu). */
export function parseEsds(payload) {
  const r = new BR(payload, 0);
  r.fullbox();
  let objectType = 0;
  let asc = new Uint8Array(0);
  const descLen = () => {
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = r.u8();
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return len;
  };
  try {
    // Les descripteurs sont IMBRIQUÉS (03 ⊃ 04 ⊃ 05) : pile de limites,
    // on ne saute que les feuilles inconnues.
    const limits = [payload.length];
    while (!r.eof) {
      while (limits.length && r.p >= limits[limits.length - 1]) limits.pop();
      if (!limits.length) break;
      const tag = r.u8();
      const len = descLen();
      const end = Math.min(limits[limits.length - 1], r.p + len);
      if (tag === 0x03) {
        r.skip(2); // ES_ID
        const flags = r.u8();
        if (flags & 0x80) r.skip(2);
        if (flags & 0x40) { const n = r.u8(); r.skip(n); }
        if (flags & 0x02) r.skip(2);
        limits.push(end);
      } else if (tag === 0x04) {
        objectType = r.u8();
        r.skip(1 + 3 + 4 + 4);
        limits.push(end);
      } else if (tag === 0x05) {
        asc = Uint8Array.from(r.bytes(Math.max(0, end - r.p)));
        r.p = end;
      } else {
        r.p = end;
      }
    }
  } catch {}
  return { objectType, asc };
}

function parseStsdEntry(payload, kind) {
  // payload = entrée complète (size+fourcc inclus). Retourne
  // { fourcc, width, height, channels, sampleRate, boxes: Map }.
  const fourcc = String.fromCharCode(payload[4], payload[5], payload[6], payload[7]);
  const e = { fourcc, width: 0, height: 0, channels: 0, sampleRate: 0, boxes: new Map() };
  try {
    if (kind === "video") {
      const r = new BR(payload, 16);
      r.skip(16);
      e.width = r.u16();
      e.height = r.u16();
      for (const b of children(payload, 8 + 78, payload.length)) {
        e.boxes.set(b.type, payload.subarray(b.start, b.end));
      }
    } else if (kind === "audio") {
      const r = new BR(payload, 16);
      const version = r.u16();
      r.skip(2 + 4);
      e.channels = r.u16();
      r.skip(2 + 2 + 2);
      e.sampleRate = f1616(r.u32());
      // v0: 8+8+20=36 ; v1: +16=52 ; v2: +36=72 (approx, repli tag-search).
      const base = version === 1 ? 52 : version >= 2 ? 72 : 36;
      if (base < payload.length) {
        for (const b of children(payload, base, payload.length)) {
          e.boxes.set(b.type, payload.subarray(b.start, b.end));
        }
      }
    }
  } catch {}
  // Repli tag-search (mises en page exotiques) pour les configs codec.
  for (const t of ["avcC", "hvcC", "av1C", "vpcC", "esds", "dac3", "dec3", "dOps", "dfLa"]) {
    if (!e.boxes.has(t)) {
      const found = tagSearch(payload, [t]).get(t);
      if (found) e.boxes.set(t, found);
    }
  }
  return e;
}

function parseStsd(buf, start, end, kind) {
  const r = new BR(buf, start);
  r.fullbox();
  const count = r.u32();
  const out = [];
  let p = r.p;
  for (let i = 0; i < count && p + 8 <= end; i++) {
    const size = (buf[p] * 0x1000000) + ((buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]);
    if (size < 8 || p + size > end) break;
    out.push(parseStsdEntry(buf.subarray(p, p + size), kind));
    p += size;
  }
  return out;
}

// ---- tables d'échantillons ----

function u32array(buf, start, end) {
  const r = new BR(buf, start);
  r.fullbox();
  const n = r.u32();
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (r.p + 4 > end) throw new Error("table tronquée");
    out[i] = r.u32();
  }
  return out;
}

function parseStts(buf, start, end) {
  const r = new BR(buf, start);
  r.fullbox();
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) out.push([r.u32(), r.u32()]);
  return out; // [count, delta][]
}

function parseCtts(buf, start, end) {
  const r = new BR(buf, start);
  const { version } = r.fullbox();
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    const count = r.u32();
    const off = version === 0 ? r.u32() : r.i32();
    out.push([count, off]);
  }
  return out;
}

function parseStsc(buf, start, end) {
  const r = new BR(buf, start);
  r.fullbox();
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) out.push([r.u32(), r.u32(), r.u32()]);
  return out; // [first_chunk(1-based), spc, desc_idx][]
}

function parseStsz(buf, start, end) {
  const r = new BR(buf, start);
  r.fullbox();
  const uniform = r.u32();
  const n = r.u32();
  if (uniform !== 0) return { uniform, sizes: null, count: n };
  const sizes = new Array(n);
  for (let i = 0; i < n; i++) sizes[i] = r.u32();
  return { uniform: 0, sizes, count: n };
}

function parseStz2(buf, start, end) {
  const r = new BR(buf, start);
  r.fullbox();
  r.skip(3);
  const field = r.u8();
  const n = r.u32();
  const sizes = new Array(n);
  if (field === 16) {
    for (let i = 0; i < n; i++) sizes[i] = r.u16();
  } else if (field === 8) {
    for (let i = 0; i < n; i++) sizes[i] = r.u8();
  } else if (field === 4) {
    for (let i = 0; i < n; i += 2) {
      const b = r.u8();
      sizes[i] = b >> 4;
      if (i + 1 < n) sizes[i + 1] = b & 0x0f;
    }
  } else {
    throw new Error(`stz2 field_size=${field} inconnu`);
  }
  return { uniform: 0, sizes, count: n };
}

/** Construit la table d'échantillons progressive d'une piste. */
export function buildProgressiveSamples(stbl, timescale) {
  const n = stbl.stsz.count;
  if (n <= 0 || n > MAX_SAMPLES) return [];
  const chunks = stbl.stco; // offsets (bigint)
  // samples_per_chunk par chunk (1-based → index).
  const spcOf = (c1) => {
    let spc = stbl.stsc[stbl.stsc.length - 1][1];
    for (const [first, spc2] of stbl.stsc) {
      if (first <= c1) spc = spc2;
      else break;
    }
    return spc;
  };
  const sizes = stbl.stsz.uniform !== 0
    ? null
    : stbl.stsz.sizes;
  // Offsets : parcours des chunks.
  const offs = new Array(n);
  let si = 0;
  for (let c = 0; c < chunks.length && si < n; c++) {
    const spc = spcOf(c + 1);
    let off = chunks[c];
    for (let k = 0; k < spc && si < n; k++, si++) {
      const sz = sizes ? sizes[si] : stbl.stsz.uniform;
      offs[si] = off;
      off += BigInt(sz);
    }
  }
  if (si < n) throw new Error(`stsc/stco incohérents (${si}/${n} échantillons placés)`);
  // dts via stts.
  const dts = new Array(n);
  let t = 0n, di = 0;
  for (const [count, delta] of stbl.stts) {
    for (let k = 0; k < count && di < n; k++, di++) {
      dts[di] = t;
      t += BigInt(delta);
    }
  }
  while (di < n) { dts[di] = t; di++; }
  // pts via ctts (défaut : = dts).
  const pts = dts.slice();
  if (stbl.ctts) {
    let pi = 0;
    for (const [count, cts] of stbl.ctts) {
      for (let k = 0; k < count && pi < n; k++, pi++) {
        pts[pi] = dts[pi] + BigInt(cts);
      }
    }
  }
  // durées : delta stts par échantillon (dernier = delta courant).
  const durs = new Array(n);
  {
    let di2 = 0, last = 0;
    for (const [count, delta] of stbl.stts) {
      for (let k = 0; k < count && di2 < n; k++, di2++) { durs[di2] = delta; last = delta; }
    }
    while (di2 < n) { durs[di2] = last; di2++; }
  }
  // keyframes via stss (absent = tout clé, cas audio).
  let isKey = null;
  if (stbl.stss) {
    const set = new Set(stbl.stss);
    isKey = (i1) => set.has(i1);
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      off: offs[i],
      size: sizes ? sizes[i] : stbl.stsz.uniform,
      dts: dts[i],
      pts: pts[i],
      dur: durs[i],
      key: isKey ? isKey(i + 1) : true,
    };
  }
  return out;
}

function parseStbl(buf, start, end, kind) {
  const stbl = { stsd: [], stts: [], ctts: null, stsc: [], stsz: null, stco: null, stss: null };
  for (const b of children(buf, start, end)) {
    switch (b.type) {
      case "stsd": stbl.stsd = parseStsd(buf, b.start, b.end, kind); break;
      case "stts": stbl.stts = parseStts(buf, b.start, b.end); break;
      case "ctts": stbl.ctts = parseCtts(buf, b.start, b.end); break;
      case "stsc": stbl.stsc = parseStsc(buf, b.start, b.end); break;
      case "stsz": stbl.stsz = parseStsz(buf, b.start, b.end); break;
      case "stz2": stbl.stsz = parseStz2(buf, b.start, b.end); break;
      case "stco": {
        const arr = u32array(buf, b.start, b.end);
        stbl.stco = arr.map((v) => BigInt(v));
        break;
      }
      case "co64": {
        const r = new BR(buf, b.start);
        r.fullbox();
        const n = r.u32();
        const arr = new Array(n);
        for (let i = 0; i < n; i++) arr[i] = r.u64();
        stbl.stco = arr;
        break;
      }
      case "stss": stbl.stss = u32array(buf, b.start, b.end); break;
      default: break;
    }
  }
  return stbl;
}

/** Parse un trak → descripteur de piste (sans les échantillons). */
export function parseTrak(buf, start, end) {
  let tkhd = null, mdhd = null, hdlr = "....", elst = null, stbl = null;
  for (const b of children(buf, start, end)) {
    if (b.type === "tkhd") tkhd = parseTkhd(buf, b.start, b.end);
    else if (b.type === "edts") {
      const e = findChild(buf, b.start, b.end, "elst");
      if (e) elst = parseElst(buf, e.start, e.end);
    } else if (b.type === "mdia") {
      for (const m of children(buf, b.start, b.end)) {
        if (m.type === "mdhd") mdhd = parseMdhd(buf, m.start, m.end);
        else if (m.type === "hdlr") hdlr = parseHdlr(buf, m.start, m.end);
        else if (m.type === "minf") {
          const s = findChild(buf, m.start, m.end, "stbl");
          if (s) {
            const kind = hdlr === "vide" ? "video" : hdlr === "soun" ? "audio" : "other";
            stbl = parseStbl(buf, s.start, s.end, kind);
          }
        }
      }
    }
  }
  if (!tkhd || !mdhd) throw new Error("trak incomplet (tkhd/mdhd manquant)");
  return { tkhd, mdhd, hdlr, elst, stbl };
}

/**
 * Applique une edit list mono-segment (cas courant caméra/ffmpeg) : décale
 * les pts pour que la présentation commence à 0. Multi-segments : ignoré
 * (timestamps média bruts, comme ffprobe).
 */
export function applySingleEdit(samples, elst) {
  if (!elst || elst.length !== 1 || samples.length === 0) return samples;
  const [e] = elst;
  if (e.rate !== 0x00010000) return samples; // dwell/empty complexe : brut
  if (e.mediaTime === -1n) {
    // Édition vide en tête : retarde tout de segDur (unités movie timescale
    // — inconnue ici ; on ignore, le worker tolère).
    return samples;
  }
  if (e.mediaTime === 0n) return samples;
  // media_time en unités MEDIA timescale : soustrait (clamp ≥ premier).
  for (const s of samples) {
    s.pts = s.pts - e.mediaTime;
    s.dts = s.dts - e.mediaTime;
  }
  return samples;
}
