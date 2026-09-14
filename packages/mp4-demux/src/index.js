// packages/mp4-demux/src/index.js — démuxeur ISO-BMFF maison (progressif + fMP4).
// Entrée : source { read(offset:bigint, len:number):Promise<Uint8Array>,
//                   getSize():Promise<bigint|number> } (même contrat que
//                   mkv-demux/probe.js).
// Sortie openMp4(source) : { kind:'mp4', tracks, durationNs, mp4:{tracks,cursors} }
// où tracks est déjà au format demux-compat (family/ffCodecId/ffCodecType,
// codecPrivate+extradata, width/height/channels/sampleRate, index/number).
// Lecture : readMp4(session, lib, name, opts) → { res:0|-11, eof, byIdx }.
// Seek : seekMp4(session, targetNs) (stss/keyframes, binaire sur dts).
// Timestamps : ticks piste → ns (BigInt, troncature <1ns), timebase 1/1e9,
// valeurs brutes (délais d'édition soustraits via elst mono-segment, comme
// ffprobe — premiers pts/dts souvent négatifs, le worker les tolère).

import { BR, children, readBoxHeader } from "./boxes.js";
import {
  parseMvhd, parseTrak, parseEsds, buildProgressiveSamples, applySingleEdit, ESDS_AUDIO,
} from "./moov.js";
import { parseMoof, parseMvex } from "./fmp4.js";

// Types média (miroir demux-compat, pas d'import : cycle).
const T_UNKNOWN = -1, T_VIDEO = 0, T_AUDIO = 1, T_SUBTITLE = 3;

const FOURCC_MAP = {
  avc1: ["h264", 27, T_VIDEO], avc3: ["h264", 27, T_VIDEO],
  hev1: ["hevc", 173, T_VIDEO], hevc: ["hevc", 173, T_VIDEO], hvc1: ["hevc", 173, T_VIDEO],
  mp4v: ["mp4v", 12, T_VIDEO],
  vp08: ["vp9", 167, T_VIDEO], vp09: ["vp9", 167, T_VIDEO],
  av01: ["av1", 32797, T_VIDEO],
  "ac-3": ["ac3", 86019, T_AUDIO], "ec-3": ["eac3", 86055, T_AUDIO],
  Opus: ["opus", 86022, T_AUDIO], opus: ["opus", 86022, T_AUDIO],
  fLaC: ["flac", 86028, T_AUDIO], flaC: ["flac", 86028, T_AUDIO],
  ".mp3": ["mp3", 86017, T_AUDIO], "mp3 ": ["mp3", 86017, T_AUDIO],
};
const SUB_FOURCC = new Set(["text", "tx3g", "sbtl", "stpp", "wvtt"]);

function avcProfileLevel(avcC) {
  if (!avcC || avcC.length < 4 || avcC[0] !== 1) return { profile: -1, level: -1 };
  return { profile: avcC[1] | ((avcC[2] & 0x40) ? 0x100 : 0), level: avcC[3] };
}
// AV1CodecConfigurationRecord → { profile, level } (level = idx×10+20 : 2.0=20…).
function av1ProfileLevel(av1C) {
  if (!av1C || av1C.length < 3 || (av1C[0] & 0x7f) !== 1) return { profile: -1, level: -1 };
  return { profile: (av1C[1] >> 5) & 0x07, level: 20 + (av1C[1] & 0x1f) };
}
// VP9CodecConfigurationRecord v1 → { profile, level }.
function vp9ProfileLevel(vpcC) {
  if (!vpcC || vpcC.length < 5 || vpcC[0] !== 1) return { profile: -1, level: -1 };
  return { profile: vpcC[1], level: vpcC[2] };
}
function aacProfile(asc) {
  if (!asc || !asc.length) return -1;
  const aot = asc[0] >> 3;
  if (aot === 2) return 1;
  if (aot === 5) return 4;
  if (aot === 29) return 28;
  return aot;
}

export function sniffMp4(head) {
  return head && head.length >= 8 &&
    head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70; // 'ftyp'
}

const nsOf = (ticks, timescale) => Number((BigInt(ticks) * 1000000000n) / BigInt(timescale));

async function topLevelBoxes(source, size) {
  const out = [];
  let off = 0n;
  for (let guard = 0; guard < 512 && off + 8n <= size; guard++) {
    const hb = await source.read(off, 16);
    if (hb.length < 8) break;
    const b = readBoxHeader(hb, 0, hb.length);
    const size32 = (hb[0] * 0x1000000) + ((hb[1] << 16) | (hb[2] << 8) | hb[3]);
    let total = b.size;
    if (size32 === 0) total = size - off; // top-level : jusqu'à EOF
    else if (size32 === 1 && hb.length < 16) break; // largesize tronqué
    if (total < BigInt(b.hdr)) throw new Error(`boîte ${b.type} invalide à ${off}`);
    out.push({ type: b.type, off, hdr: b.hdr, payload: off + BigInt(b.hdr), size: total });
    if (total === 0n) break;
    off += total;
  }
  return out;
}

function mapEntryToCodec(entry, kind) {
  const f = entry.fourcc;
  if (SUB_FOURCC.has(f)) return { family: "unknown", id: 0, type: T_SUBTITLE };
  const m = FOURCC_MAP[f];
  if (m) return { family: m[0], id: m[1], type: m[2] };
  if (f === "mp4a") {
    const esds = entry.boxes.get("esds");
    if (esds) {
      const { objectType } = parseEsds(esds);
      const fam = ESDS_AUDIO[objectType];
      if (fam === "aac") return { family: "aac", id: 86018, type: T_AUDIO };
      if (fam === "mp3") return { family: "mp3", id: 86017, type: T_AUDIO };
      if (fam === "ac3") return { family: "ac3", id: 86019, type: T_AUDIO };
      if (fam === "eac3") return { family: "eac3", id: 86055, type: T_AUDIO };
      if (fam === "opus") return { family: "opus", id: 86022, type: T_AUDIO };
    }
    return { family: "unknown", id: 0, type: T_AUDIO };
  }
  if (kind === "video") return { family: "unknown", id: 0, type: T_VIDEO };
  if (kind === "audio") return { family: "unknown", id: 0, type: T_AUDIO };
  return { family: "unknown", id: 0, type: T_UNKNOWN };
}

export async function openMp4(source) {
  const size = BigInt(await source.getSize());
  if (size < 8n) throw new Error("fichier trop petit pour MP4");
  const head = await source.read(0n, 16);
  if (!sniffMp4(head)) throw new Error("pas de ftyp (pas un MP4)");
  const tops = await topLevelBoxes(source, size);
  const moovBox = tops.find((b) => b.type === "moov");
  if (!moovBox) throw new Error("moov introuvable");
  if (moovBox.size > 256n * 1048576n) throw new Error("moov démesuré");
  const moov = await source.read(moovBox.payload, Number(moovBox.size - BigInt(moovBox.hdr)));
  let mvhd = { timescale: 1000, duration: -1n };
  const trakPayloads = [];
  let trex = new Map();
  for (const b of children(moov, 0, moov.length)) {
    const s = b.start, e = b.end;
    if (b.type === "mvhd") mvhd = parseMvhd(moov, s, e);
    else if (b.type === "trak") trakPayloads.push(moov.subarray(s, e));
    else if (b.type === "mvex") trex = parseMvex(moov, s, e);
  }
  if (!trakPayloads.length) throw new Error("moov sans trak");
  // Fragments : lit tous les moofs (payloads seuls, pas les mdat).
  const moofs = [];
  for (const t of tops) {
    if (t.type !== "moof") continue;
    if (t.size > 64n * 1048576n) throw new Error("moof démesuré");
    const buf = await source.read(t.payload, Number(t.size) - t.hdr);
    moofs.push({ buf, off: t.off }); // off = début du moof (base par défaut)
  }
  const tracks = [];
  for (const tp of trakPayloads) {
    const tr = parseTrak(tp, 0, tp.length);
    const kind = tr.hdlr === "vide" ? "video" : tr.hdlr === "soun" ? "audio" : "other";
    if (kind !== "video" && kind !== "audio") continue; // v1 : A/V seuls
    const stbl = tr.stbl;
    if (!stbl || !stbl.stsd.length) continue;
    const entry = stbl.stsd[0];
    const codec = mapEntryToCodec(entry, kind);
    const ts = tr.mdhd.timescale || 1;
    let samples = [];
    if (stbl.stsz && stbl.stsz.count > 0 && stbl.stco) {
      samples = buildProgressiveSamples(stbl, ts);
    }
    const t = {
      index: tracks.length,
      number: BigInt(tr.tkhd.id),
      kind: kind === "video" ? 1 : 2,
      codecId: entry.fourcc,
      family: codec.family,
      ffCodecId: codec.id,
      ffCodecType: codec.type,
      profile: -1, level: -1, audioProfile: -1,
      width: Math.round(entry.width || tr.tkhd.width || 0),
      height: Math.round(entry.height || tr.tkhd.height || 0),
      channels: entry.channels || 0,
      sampleRate: Math.round(entry.sampleRate || 0),
      codecPrivate: new Uint8Array(0),
      extradata: new Uint8Array(0),
      name: "",
      timescale: ts,
      defaultDurationNs: 0n,
      samples,
      cursor: 0,
      _trackId: tr.tkhd.id,
      _elst: tr.elst,
    };
    // Extradata + profils (contrat bridge, comme l'enrichissement MKV).
    const B = entry.boxes;
    if (t.family === "h264" && B.has("avcC")) {
      t.codecPrivate = Uint8Array.from(B.get("avcC"));
      t.extradata = t.codecPrivate;
      const pl = avcProfileLevel(t.codecPrivate);
      t.profile = pl.profile; t.level = pl.level;
    } else if (t.family === "hevc" && B.has("hvcC")) {
      t.codecPrivate = Uint8Array.from(B.get("hvcC"));
      t.extradata = t.codecPrivate;
    } else if (t.family === "av1" && B.has("av1C")) {
      t.codecPrivate = Uint8Array.from(B.get("av1C"));
      t.extradata = t.codecPrivate;
      const pl = av1ProfileLevel(t.codecPrivate);
      t.profile = pl.profile; t.level = pl.level;
    } else if (t.family === "vp9" && B.has("vpcC")) {
      t.codecPrivate = Uint8Array.from(B.get("vpcC"));
      t.extradata = t.codecPrivate;
      const pl = vp9ProfileLevel(t.codecPrivate);
      t.profile = pl.profile; t.level = pl.level;
    } else if (t.family === "aac") {
      const esds = B.get("esds");
      if (esds) {
        const { asc } = parseEsds(esds);
        t.codecPrivate = Uint8Array.from(asc);
        t.extradata = t.codecPrivate;
        t.audioProfile = aacProfile(asc);
      }
    } else if (t.family === "ac3" && B.has("dac3")) {
      t.codecPrivate = Uint8Array.from(B.get("dac3"));
      t.extradata = t.codecPrivate;
    } else if (t.family === "eac3" && B.has("dec3")) {
      t.codecPrivate = Uint8Array.from(B.get("dec3"));
      t.extradata = t.codecPrivate;
    } else if (t.family === "opus" && B.has("dOps")) {
      t.codecPrivate = Uint8Array.from(B.get("dOps"));
      t.extradata = t.codecPrivate;
      // dOps : champs LE comme OpusHead (RFC 7845) → preskip à +2.
      const d = t.codecPrivate;
      t._opusPreskip = d.length >= 4 ? (d[2] | (d[3] << 8)) : 0;
    } else if (t.family === "flac" && B.has("dfLa")) {
      t.codecPrivate = Uint8Array.from(B.get("dfLa"));
      t.extradata = t.codecPrivate;
    }
    tracks.push(t);
  }
  if (!tracks.length) throw new Error("aucune piste A/V dans le moov");
  // Fragments → échantillons (concaténés aux stbl éventuels, triés par dts).
  if (moofs.length) {
    const init = new Map();
    for (const t of tracks) {
      init.set(t._trackId, { trex: trex.get(t._trackId), timescale: t.timescale });
    }
    for (const { buf, off } of moofs) {
      const per = parseMoof(buf, off, off + BigInt(buf.length), init);
      for (const [id, arr] of per) {
        const t = tracks.find((x) => x._trackId === id);
        if (t) t.samples.push(...arr);
      }
    }
    for (const t of tracks) {
      t.samples.sort((a, b) => (a.dts < b.dts ? -1 : a.dts > b.dts ? 1 : a.off < b.off ? -1 : 1));
    }
  }
  // Edit lists mono-segment (parité ffprobe : premiers pts/dts négatifs).
  for (const t of tracks) applySingleEdit(t.samples, t._elst);
  if (!tracks.some((t) => t.samples.length)) {
    throw new Error("ni échantillons progressifs ni fragments");
  }
  // Durée : fin max des pistes, sinon mvhd.
  let durationNs = -1n;
  for (const t of tracks) {
    if (!t.samples.length) continue;
    const last = t.samples[t.samples.length - 1];
    const end = nsOf(last.pts + BigInt(last.dur), t.timescale);
    if (BigInt(end) > durationNs) durationNs = BigInt(end);
  }
  if (durationNs < 0n && mvhd.duration >= 0n && mvhd.timescale) {
    durationNs = (mvhd.duration * 1000000000n) / BigInt(mvhd.timescale);
  }
  let readPos = size;
  for (const t of tracks) {
    if (t.samples.length && t.samples[0].off < readPos) readPos = t.samples[0].off;
  }
  return {
    kind: "mp4",
    tracks,
    durationNs,
    mp4readPos: readPos,
    fileSize: size,
    fragmented: moofs.length > 0,
  };
}

/** Lecture bornée → { res, eof, byIdx } (res: 0 | -11). Triés par offset fichier. */
export async function readMp4(session, lib, name, opts = {}) {
  const limit = BigInt(opts.limit ?? 524288);
  const byIdx = {};
  const tracks = session.mp4.tracks;
  let spent = 0n;
  for (let guard = 0; guard < 400; guard++) {
    let bi = -1, boff = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.cursor >= t.samples.length) continue;
      const s = t.samples[t.cursor];
      if (bi < 0 || s.off < boff) { bi = i; boff = s.off; }
    }
    if (bi < 0) {
      session.readPos = session.size;
      return { res: 0, eof: true, byIdx };
    }
    const t = tracks[bi];
    const s = t.samples[t.cursor];
    let data;
    try {
      data = await lib.read(name, s.off, s.size);
    } catch {
      return { res: -11, eof: false, byIdx };
    }
    if (!data || data.length < s.size) return { res: -11, eof: false, byIdx };
    const tb = t.timescale;
    // Opus : pre-skip conteneur (toujours @48kHz interne) retranché, clampé
    // à 0 (même motif que le delay LAME ; le player compare des horloges).
    // Autres pistes : timestamps bruts (edit lists → négatifs possibles).
    const opsh = t._opusPreskip ? Number((BigInt(t._opusPreskip) * 1000000000n) / 48000n) : 0;
    const pts = opsh ? Math.max(0, nsOf(s.pts, tb) - opsh) : nsOf(s.pts, tb);
    (byIdx[t.index] = byIdx[t.index] ?? []).push({
      pts,
      dts: opsh ? pts : nsOf(s.dts, tb),
      size: data.length,
      data,
      time_base_num: 1,
      time_base_den: 1000000000,
      duration: nsOf(BigInt(s.dur), tb),
      key: !!s.key,
    });
    t.cursor++;
    spent += BigInt(data.length);
    session.readPos = s.off + BigInt(data.length);
    if (spent >= limit) return { res: 0, eof: false, byIdx };
  }
  return { res: 0, eof: false, byIdx };
}

/** Seek : curseurs sur dts<=cible (vidéo : keyframe arrière, sinon 1re clé). */
export function seekMp4(session, targetNs) {
  for (const t of session.mp4.tracks) {
    const n = t.samples.length;
    if (!n) { t.cursor = 0; continue; }
    const tgt = (BigInt(targetNs) * BigInt(t.timescale)) / 1000000000n;
    let lo = 0, hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (t.samples[m].dts <= tgt) lo = m + 1;
      else hi = m;
    }
    let idx = Math.max(0, lo - 1);
    if (t.ffCodecType === T_VIDEO) {
      let k = idx;
      while (k >= 0 && !t.samples[k].key) k--;
      if (k < 0) {
        k = 0;
        while (k < n && !t.samples[k].key) k++;
        if (k >= n) k = 0;
      }
      idx = k;
    }
    t.cursor = idx;
  }
  let rp = session.size;
  for (const t of session.mp4.tracks) {
    if (t.cursor < t.samples.length && t.samples[t.cursor].off < rp) rp = t.samples[t.cursor].off;
  }
  session.readPos = rp;
}
