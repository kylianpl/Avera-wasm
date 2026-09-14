// packages/ogg-demux/src/index.js — démuxeur Ogg maison (streaming-friendly).
// Pages OggS + réassemblage inter-pages, BOS (Vorbis/Opus/FLAC/Theora),
// timestamps granulepos EXACTS (snap par page + durées intra-page :
// fenêtres Vorbis (prev+cur)/4 via setup, TOC Opus, blocksize FLAC).
// Opus : pre-skip retranché (clamp 0) + fin rognée au dernier granulepos.
// Seek : bissection sur granulepos (Borné ~40 itérations) + reprise sur
// page fraîche (bit continued clair). Durée : dernier granulepos audio
// (sinon vidéo), exacte. Pas de vérif CRC (structure validée).
// Theora : passthrough (clé FTYPE), pas de SW decode (v1, échec propre).

import { sniffOgg, findPage, readPage, splitPagePackets } from "./pages.js";
import {
  identifyBos, vorbisPacketSamples, opusPacketSamples,
  flacFrameSamples, parseStreamInfo, buildVorbisPrivate, theoraIsKey, ilog,
} from "./codecs.js";

export { sniffOgg };

const MAX_PACKETS_PER_READ = 400;
const WINDOW = 1048576;

const nsSamp = (samp, sr) => Number((BigInt(samp) * 1000000000n) / BigInt(sr));

/** Ouvre : scan BOS + headers, tail-scan des totaux. */
export async function openOgg(source) {
  const size = BigInt(await source.getSize());
  if (size < 27n) throw new Error("fichier trop petit pour Ogg");
  const head = await source.read(0n, 4);
  if (!sniffOgg(head)) throw new Error("pas un Ogg ('OggS' absent)");
  const streams = new Map(); // serial -> état
  let off = 0n;
  let order = 0;
  // Phase headers : nourrit chaque page à son stream (BOS comme suites :
  // les headers longs — setup Vorbis — chevauchent des pages non-BOS).
  // Stop quand tous les streams connus ont leurs headers (cap 64 pages).
  for (let g = 0; g < 64; g++) {
    const at = await findPage(source, off, size);
    if (at < 0n) break;
    const pg = await readPage(source, at);
    if (!pg) { off = at + 27n; continue; }
    const { head: h, body } = pg;
    off = at + BigInt(h.totalLen);
    if (h.bos && !streams.has(h.serial)) {
      streams.set(h.serial, newStream(h.serial, order++));
    }
    const st = streams.get(h.serial);
    if (st) feedPage(st, h, body);
    if (streams.size > 0 && [...streams.values()].every((s) => s.headerDone)) break;
  }
  if (!streams.size) throw new Error("aucun stream Ogg BOS");
  // Les streams sans header complet (tronqué) sont écartés.
  for (const [ser, st] of [...streams]) {
    if (!st.desc) streams.delete(ser);
  }
  if (!streams.size) throw new Error("aucun stream Ogg identifié");
  // Snapshot d'open (frag + pending de queue headers) : un seek en tête
  // restaure cet état au lieu de réinitialiser (les buffers sont
  // immuables, le drain remplace le tableau sans le muter).
  for (const st of streams.values()) {
    st.openSnap = { frag: st.frag ?? null, pending: [...(st.pending ?? [])] };
  }
  // Totaux : tail-scan du dernier granulepos valide par stream.
  await scanTotals(source, size, streams);
  // Pistes (ordre BOS) + durée (audio d'abord, sinon vidéo).
  const tracks = [];
  for (const st of streams.values()) {
    tracks.push(buildTrack(st, tracks.length));
  }
  let durationNs = -1n;
  const au = tracks.find((t) => t.ffCodecType === 1);
  const any = au ?? tracks[0];
  if (any) {
    const st = [...streams.values()].find((s) => s.track === any);
    if (st && st.total != null) {
      const sr = any.timescale || 1;
      if (any.ffCodecType === 0) {
        // Theora-only : granulepos = (iframe << shift) | offset (approx).
        const sh = BigInt(st.desc.kgShift ?? 6);
        const frames = (st.total >> sh) + (st.total & ((1n << sh) - 1n));
        durationNs = (frames * BigInt(st.desc.fpsDen || 1) * 1000000000n) / BigInt(st.desc.fpsNum || 25);
      } else {
        const aud = st.desc.codec === "opus" ? st.total - BigInt(st.desc.preskip || 0) : st.total;
        durationNs = (aud * 1000000000n) / BigInt(sr);
      }
    }
  }
  return {
    kind: "ogg",
    tracks,
    durationNs,
    oggreadPos: off,
    fileSize: size,
    ogg: { streams, audioStart: off },
  };
}

function newStream(serial, order) {
  return {
    serial, order, desc: null, track: null,
    headers: [], headerDone: false,
    frag: null, pos: 0n, total: null, started: false,
    modes: [0, 1], // convention 2 modes libvorbis (0=short, 1=long)
    bs0: 256, bs1: 2048, prevW: 0,
    frames: 0, eos: false,
  };
}

/** Piste compat depuis un stream identifié. */
function buildTrack(st, idx) {
  const d = st.desc;
  const isAudio = d.type === 1;
  const t = {
    index: idx,
    number: BigInt(idx + 1),
    kind: isAudio ? 2 : 1,
    codecId: d.codec,
    family: d.family,
    ffCodecId: d.id,
    ffCodecType: isAudio ? 1 : 0,
    profile: -1, level: -1, audioProfile: -1,
    width: d.width || 0, height: d.height || 0,
    channels: d.channels || 0, sampleRate: d.rate || 0,
    codecPrivate: new Uint8Array(0),
    extradata: new Uint8Array(0),
    name: "",
    timescale: isAudio ? d.rate || 48000 : 1,
    defaultDurationNs: 0n,
    _skipHead: 0, // Opus pre-skip (échantillons @48k)
    _serial: st.serial,
  };
  if (d.codec === "vorbis" && st.vorbisPrivate) {
    t.codecPrivate = st.vorbisPrivate;
    t.extradata = st.vorbisPrivate;
  } else if (d.codec === "opus" && st.opusHead) {
    t.codecPrivate = st.opusHead;
    t.extradata = st.opusHead;
    t._skipHead = d.preskip || 0;
  } else if (d.codec === "flac" && st.flacHeader) {
    t.codecPrivate = st.flacHeader;
    t.extradata = st.flacHeader;
  }
  if (!isAudio && d.fpsNum && d.fpsDen) {
    t.defaultDurationNs = (BigInt(d.fpsDen) * 1000000000n) / BigInt(d.fpsNum);
    t.timescale = 1000000000;
  }
  st.track = t;
  return t;
}

/** Alimente un stream avec les paquets complets d'une page (headers
 * comme données : le routage dépend de headerDone, donc un BOS tardif
 * reste correctement identifié même en pleine lecture). */
function feedPage(st, h, body) {
  const { done, rest } = splitPagePackets(body, h.segTable, st.frag);
  st.frag = rest;
  for (const pkt of done) {
    if (!st.headerDone) {
      collectHeader(st, pkt);
    } else if (st.desc) {
      (st.pending = st.pending ?? []).push(pkt);
    }
    // Stream non géré (!desc) : paquets ignorés.
  }
}

/** Collecte les headers BOS → identify + headerDone. */
function collectHeader(st, pkt) {
  st.headers.push(pkt);
  if (st.headers.length === 1) {
    st.desc = identifyBos(pkt);
    if (!st.desc) {
      st.headerDone = true; // stream non géré (skeleton…) : paquets ignorés
      st.headers = [];
      return;
    }
  }
  if (!st.desc) return;
  const n = st.headers.length;
  if (st.desc.codec === "vorbis" && n === 3) {
    st.bs0 = st.desc.bs0; st.bs1 = st.desc.bs1;
    st.vorbisPrivate = buildVorbisPrivate(st.headers[0], st.headers[1], st.headers[2]);
    st.headerDone = true;
  } else if (st.desc.codec === "opus" && n === 2) {
    st.opusHead = Uint8Array.from(st.headers[0]);
    st.headerDone = true;
  } else if (st.desc.codec === "flac") {
    if (n === 1) {
      // Header "fLaC" + STREAMINFO (42o, sans le préfixe de mapping Ogg).
      const o = st.desc.headOff || 0;
      st.flacHeader = Uint8Array.from(pkt.subarray(o, o + 42));
      st.si = parseStreamInfo(pkt.subarray(o + 4, o + 42));
    } else if (pkt.length >= 2 && pkt[0] === 0xff && (pkt[1] & 0xfc) === 0xf8) {
      // 1re frame audio : les headers sont finis, rejoue ce paquet.
      st.headerDone = true;
      (st.pending = st.pending ?? []).push(pkt);
    }
    // Sinon : bloc métadonnée (commentaire…) : ignoré, on attend la 1re frame.
  } else if (st.desc.codec === "theora" && n === 3) {
    st.headerDone = true;
  }
}

/** Tail-scan : dernier granulepos valide par stream (borné 1MiB). */
async function scanTotals(source, size, streams) {
  const tail = size > BigInt(WINDOW) ? BigInt(WINDOW) : size;
  let buf;
  try {
    buf = await source.read(size - tail, Number(tail));
  } catch {
    return;
  }
  // Pages dans le tail (scan arrière simple : offsets "OggS" validés).
  const pages = [];
  for (let i = 0; i + 27 <= buf.length; i++) {
    if (buf[i] === 0x4f && buf[i + 1] === 0x67 && buf[i + 2] === 0x67 && buf[i + 3] === 0x53 && buf[i + 4] === 0) {
      const nseg = buf[i + 26];
      if (i + 27 + nseg > buf.length) continue;
      let g = 0n;
      for (let k = 0; k < 8; k++) g |= BigInt(buf[i + 6 + k]) << BigInt(k * 8);
      if (g >= 0x8000000000000000n) g -= 0x10000000000000000n;
      const serial = (buf[i + 14] | (buf[i + 15] << 8) | (buf[i + 16] << 16)) + buf[i + 17] * 0x1000000;
      pages.push({ serial, granule: g });
    }
  }
  for (let i = pages.length - 1; i >= 0; i--) {
    const st = streams.get(pages[i].serial);
    if (st && st.total == null && pages[i].granule >= 0n) {
      st.total = pages[i].granule;
    }
  }
  // FLAC : total exact STREAMINFO (prioritaire).
  for (const st of streams.values()) {
    if (st.desc?.codec === "flac" && st.si?.total) st.total = st.si.total;
  }
}

/** Échantillons d'un paquet (0 = à sauter). Met à jour l'état. */
function packetSamples(st, pkt) {
  const c = st.desc.codec;
  if (c === "vorbis") return vorbisPacketSamples(pkt, st);
  if (c === "opus") return opusPacketSamples(pkt);
  if (c === "flac") return flacFrameSamples(pkt, st.si ?? { minBlock: 4096, maxBlock: 4096 });
  if (c === "theora") return 1; // 1 frame/paquet (durée via defaultDurationNs)
  return 0;
}

/** Lecture bornée → { res:0|-11, eof, byIdx }. Fusion par ordre fichier. */
export async function readOgg(session, lib, name, opts = {}) {
  const source = { read: (o, l) => lib.read(name, o, l) };
  const limit = BigInt(opts.limit ?? 524288);
  const byIdx = {};
  const streams = session.ogg.streams;
  const size = session.size;
  let spent = 0n;
  // Draine d'abord les paquets déjà extraits (fin de phase headers).
  for (const st of streams.values()) {
    if (st.pending?.length && st.track) {
      for (const pkt of st.pending) emitPacket(session, st, pkt, byIdx);
      st.pending = [];
      if (spent >= limit) return { res: 0, eof: false, byIdx };
    }
  }
  for (let guard = 0; guard < MAX_PACKETS_PER_READ; guard++) {
    const at = await findPage(source, session.readPos, size);
    if (at < 0n) {
      session.readPos = size;
      return { res: 0, eof: true, byIdx };
    }
    const pg = await readPage(source, at);
    if (!pg) {
      session.readPos = at + 27n;
      continue;
    }
    const { head: h, body } = pg;
    session.readPos = at + BigInt(h.totalLen);
    spent += BigInt(h.totalLen);
    const st = streams.get(h.serial);
    // Serial inconnu (BOS tardif hors phase headers, quasi-impossible) :
    // ignoré (pas d'index stable à chaud).
    if (!st || !st.desc || !st.track) continue;
    feedPage(st, h, body);
    const pend = st.pending ?? [];
    st.pending = [];
    for (const pkt of pend) emitPacket(session, st, pkt, byIdx);
    // Snap granulepos (sauf page EOS : le granulepos y exclut le padding
    // final — la rogne via total possède la fin, reculer casserait pos).
    if (h.granule >= 0n && st.desc.codec !== "theora" && !h.eos) {
      st.pos = h.granule;
    }
    if (spent >= limit) return { res: 0, eof: false, byIdx };
  }
  return { res: 0, eof: false, byIdx };
}

/** Émet un paquet (timestamps, rogne de fin, clés). */
function emitPacket(session, st, pkt, byIdx) {
  const t = st.track;
  const sr = t.timescale || 1;
  const n = packetSamples(st, pkt);
  void session;
  if (n <= 0) return;
  if (st.desc.codec === "vorbis" && !st.started) {
    // Pré-roll : le 1er paquet couvre [-D0, 0) (parité ffprobe pts<0,
    // clampé à 0 à l'émission comme le delay LAME).
    st.started = true;
    st.pos = BigInt(-n);
  }
  const start = st.pos;
  st.pos += BigInt(n);
  // Rogne de fin (padding) : total connu par tail-scan/STREAMINFO.
  let emit = n;
  if (st.total != null && start >= st.total) return; // padding final
  if (st.total != null && start + BigInt(n) > st.total) {
    emit = Number(st.total - start);
    if (emit <= 0) return;
  }
  const ts = start >= BigInt(t._skipHead) ? nsSamp(start - BigInt(t._skipHead), sr)
    : 0; // pre-skip clampé (motif LAME)
  const isVideo = t.ffCodecType === 0;
  const key = isVideo ? theoraIsKey(pkt) : true;
  const dur = isVideo ? Number(t.defaultDurationNs) : nsSamp(BigInt(emit), sr);
  const vts = isVideo ? nsSamp(BigInt(st.frames) * BigInt(t.defaultDurationNs), 1000000000) : ts;
  (byIdx[t.index] = byIdx[t.index] ?? []).push({
    pts: vts,
    dts: vts,
    size: pkt.length, data: pkt,
    time_base_num: 1, time_base_den: 1000000000,
    duration: dur, key,
  });
  if (isVideo) st.frames++;
}

/** Seek : bissection sur le granulepos du 1er stream audio (sinon 1er).
 * Cible en échantillons physiques (opus : +preskip, cf. conventions). */
export async function seekOgg(session, lib, name, targetNs) {
  const source = { read: (o, l) => lib.read(name, o, l) };
  const streams = session.ogg.streams;
  const size = session.size;
  const primary = [...streams.values()].find((s) => s.track?.ffCodecType === 1)
    ?? [...streams.values()][0];
  if (!primary) return;
  const t = primary.track;
  const sr = t.timescale || 1;
  let unit = (BigInt(targetNs < 0n ? 0n : targetNs) * BigInt(sr)) / 1000000000n;
  if (t._skipHead) unit += BigInt(t._skipHead);
  const ck = granuleKey(primary);
  // Bissection : [lo, hi] → 1re page avec G>=unit (cand). Départ à 0 :
  // les pages de headers (granulepos 0/-1) portent parfois de l'audio
  // (pending d'open) et doivent participer.
  let lo = 0n, hi = size;
  let cand = -1n;
  for (let it = 0; it < 40 && lo < hi; it++) {
    const mid = (lo + hi) >> 1n;
    let at = await findPage(source, mid, hi).catch(() => -1n);
    if (at < 0n) {
      // Aucune page ne commence dans [mid, hi) : mid est dans le corps
      // d'une page commençant avant mid → recule (borné par lo).
      at = await findLastPage(source, lo, mid).catch(() => -1n);
      if (at < 0n) { hi = mid; continue; }
    }
    const g = await pageGranule(source, at, primary.serial, hi).catch(() => null);
    if (!g || g.granule == null) {
      // Pas de page du stream cible : avance prudemment (fin de page lue).
      lo = g?.end ?? (at + 27n);
      continue;
    }
    if (ck(g.granule) < unit) {
      lo = g.end;
    } else {
      hi = at;
      cand = at;
    }
  }
  if (cand < 0n) cand = lo;
  // Reprise sur page fraîche (continued clair), bornée en arrière.
  let start = cand;
  for (let k = 0; k < 8; k++) {
    const pg = await readPage(source, start).catch(() => null);
    if (!pg) break;
    if (!pg.head.continued || pg.head.bos) break;
    // Recule d'une page (scan arrière borné 64Ko depuis le début audio).
    const back = start - 65536n > session.ogg.audioStart ? start - 65536n : session.ogg.audioStart;
    const at = await findLastPage(source, back, start).catch(() => -1n);
    if (at < 0n || at >= start) break;
    start = at;
  }
  // pos = dernier granulepos valide AVANT start (lookup arrière borné :
  // la bissection ne l'échantillonne pas forcément ; plancher à start-4Mo
  // pour rester borné sur gros fichiers — les snaps corrigent le résiduel).
  let prevG = 0n;
  {
    const floor = start > 4194304n ? start - 4194304n : 0n;
    let scanEnd = start;
    for (let k = 0; k < 8 && scanEnd > floor; k++) {
      const at = await findLastPage(source, floor, scanEnd).catch(() => -1n);
      if (at < 0n) break;
      const pg = await readPage(source, at).catch(() => null);
      if (!pg) { scanEnd = at; continue; }
      if (pg.head.serial === primary.serial && pg.head.granule >= 0n) {
        prevG = pg.head.granule;
        break;
      }
      scanEnd = at;
    }
  }
  // État : frag vidé, pos = dernier granulepos valide avant start.
  // (secondaires audio : pos mise à l'échelle du taux ; vidéo : compteur
  // recalé sur la cible — approximatif documenté, pas de SW theora v1).
  // Cas tête (start < audioStart : contexte frag/pending de la phase
  // headers) : restaure le snapshot d'open (frag + pending de queue,
  // positions à 0) au lieu de réinitialiser.
  if (start < session.ogg.audioStart) {
    for (const st of streams.values()) {
      st.frag = st.openSnap?.frag ?? null;
      st.pending = [...(st.openSnap?.pending ?? [])];
      st.pos = 0n;
      st.prevW = 0;
      st.started = false;
      st.frames = 0;
    }
    session.readPos = session.ogg.audioStart;
    session.eof = false;
    return;
  }
  const prate = t.timescale || 1;
  for (const st of streams.values()) {
    st.frag = null;
    st.pending = [];
    st.prevW = 0;
    st.started = true;
    if (st === primary) {
      st.pos = prevG;
    } else if (st.track?.ffCodecType === 1) {
      const r = st.track.timescale || prate;
      st.pos = (prevG * BigInt(r)) / BigInt(prate);
    } else if (st.track?.ffCodecType === 0 && st.track.defaultDurationNs > 0n) {
      st.frames = Number(BigInt(targetNs < 0n ? 0n : targetNs) / st.track.defaultDurationNs);
    }
  }
  // Ré-accumule depuis start jusqu'à la cible ? Non : la lecture reprend
  // à start avec pos=prevG (les paquets entre prevG et la cible sont émis
  // avec leurs vrais pts — le worker jette le pré-roll ≤ cible).
  session.readPos = start;
  session.eof = false;
}

/** Clé de comparaison granulepos (theora : n° iframe). */
function granuleKey(st) {
  if (st.desc?.codec === "theora") {
    const sh = BigInt(st.desc.kgShift ?? 6);
    return (g) => (g >= 0n ? g >> sh : g);
  }
  return (g) => g;
}

/** Granulepos (+fin) de la 1re page du serial depuis `at` (fenêtre bornée).
 * Retourne toujours end (fin de la 1re page lue) ; granule null si le
 * serial est absent de la fenêtre. */
async function pageGranule(lib, at, serial, end) {
  let off = BigInt(at);
  let firstEnd = null;
  for (let k = 0; k < 8; k++) {
    const pg = await readPage(lib, off);
    if (!pg) return firstEnd != null ? { granule: null, end: firstEnd } : null;
    const pe = off + BigInt(pg.head.totalLen);
    if (firstEnd == null) firstEnd = pe;
    if (pg.head.serial === serial) {
      return { granule: pg.head.granule, end: pe };
    }
    off = pe;
    if (off >= BigInt(end)) return { granule: null, end: firstEnd };
  }
  return { granule: null, end: firstEnd ?? off };
}

/** Dernière page commençant dans [from, end). */
async function findLastPage(lib, from, end) {
  let last = -1n;
  let off = BigInt(from);
  while (off < BigInt(end)) {
    const at = await findPage(lib, off, end);
    if (at < 0n || at >= BigInt(end)) break;
    last = at;
    off = at + 27n;
  }
  return last;
}
