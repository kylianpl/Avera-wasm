// packages/flac-demux/src/index.js — démuxeur FLAC natif maison.
// "fLaC" + blocs métadonnées (STREAMINFO en 1er) + frames contiguës.
// Index de frames EXACT et dense, étendu paresseusement (fenêtres 1MiB,
// sync + CRC8 + continuité des n° — même motif que mp3-demux) : pts
// exacts après seek, sans estimation. Durée = total STREAMINFO (repli -1
// si 0). Dernière frame rognée au total (padding, motif LAME/Opus).
// Limites v1 : ID3v1 de queue (refusé si présent… en pratique absent),
// RF64-like (>4Go : tailles 64 bits non prévues par le format).

import { parseStreamInfoContent, parseFrameHeader, id3v2Size } from "./frames.js";

const WINDOW = 1048576;
const MAX_PACKETS_PER_READ = 400;

export function sniffFlac(head) {
  // 'fLaC' uniquement (le cas ID3v2-préfixé, rare, est tranché par le
  // routeur qui vérifie fLaC après le tag — sinon tout MP3 taggé
  // routerait ici).
  return !!head && head.length >= 4 &&
    head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43;
}

const nsOfSamples = (samplesBig, rate) => Number((samplesBig * 1000000000n) / BigInt(rate));

export async function openFlac(source) {
  const size = BigInt(await source.getSize());
  if (size < 42n) throw new Error("fichier trop petit pour FLAC");
  let off = 0n;
  const head = await source.read(0n, 10);
  const tag = id3v2Size(head.subarray(0, Math.min(10, head.length)));
  if (tag !== -1 && tag > 0) off = BigInt(tag); // .flac taggé ID3v2 (rare)
  const magic = await source.read(off, 4);
  if (magic.length < 4 || magic[0] !== 0x66 || magic[1] !== 0x4c || magic[2] !== 0x61 || magic[3] !== 0x43) {
    throw new Error("marqueur fLaC introuvable");
  }
  off += 4n;
  // Blocs métadonnées (STREAMINFO en 1er, norme).
  let si = null, siRaw = null;
  for (let g = 0; g < 64; g++) {
    const hb = await source.read(off, 4);
    if (hb.length < 4) throw new Error("métadonnées FLAC tronquées");
    const last = !!(hb[0] & 0x80), type = hb[0] & 0x7f;
    const len = (hb[1] << 16) | (hb[2] << 8) | hb[3];
    if (len > 16 * 1048576) throw new Error("bloc métadonnée démesuré");
    if (type === 0) {
      const body = await source.read(off + 4n, len);
      if (body.length < len || len < 34) throw new Error("STREAMINFO illisible");
      si = parseStreamInfoContent(body.subarray(0, 34));
      if (!si) throw new Error("STREAMINFO invalide");
      siRaw = body.subarray(0, 34);
    }
    off += 4n + BigInt(len);
    if (!si && g === 0) throw new Error("STREAMINFO absent en tête");
    if (last) break;
    if (off >= size) throw new Error("audio FLAC introuvable");
  }
  if (!si) throw new Error("STREAMINFO introuvable");
  const audioStart = off;
  const total = si.total; // BigInt (0 = inconnu)
  const durationNs = total > 0n ? (total * 1000000000n) / BigInt(si.rate) : -1n;
  // Blob WebCodecs : "fLaC" + header bloc + STREAMINFO (mêmes octets que
  // le privé MKV/Ogg). Le flag "last" (0x10) est PROSCRIT ici : Chromium
  // rejette la description ("Unsupported configuration", vérifié) —
  // l'Ogg fonctionne avec 0x00, on s'aligne.
  const flacHeader = new Uint8Array(42);
  flacHeader[0] = 0x66; flacHeader[1] = 0x4c; flacHeader[2] = 0x61; flacHeader[3] = 0x43;
  flacHeader[4] = 0x00; flacHeader[5] = 0; flacHeader[6] = 0; flacHeader[7] = 34;
  flacHeader.set(siRaw, 8);
  const track = {
    index: 0,
    number: 1n,
    kind: 2,
    codecId: "flac",
    family: "flac",
    ffCodecId: 86028,
    ffCodecType: 1,
    profile: -1, level: -1, audioProfile: -1,
    width: 0, height: 0,
    channels: si.channels,
    sampleRate: si.rate,
    codecPrivate: flacHeader,
    extradata: flacHeader,
    name: "",
    timescale: si.rate,
    defaultDurationNs: 0n,
  };
  return {
    kind: "flac",
    tracks: [track],
    durationNs,
    flacreadPos: audioStart,
    fileSize: size,
    flac: {
      track, audioStart, audioEnd: size, si, total,
      frames: [], // { off, samples } dense depuis 0 (offsets exacts)
      cum: [0n], // cum[i] = échantillon de départ de la frame i
      cursorIdx: 0,
    },
  };
}

/** Continuité attendue du n° suivant (fixe : +1 ; variable : cum). */
function expectNum(st, frame) {
  if (frame.variable) return st.cum[st.cum.length - 1] + BigInt(frame.samples);
  return frame.num + 1n;
}

/** Étend l'index jusqu'à couvrir la frame `want` (+1 pour sa taille) ou EOF. */
async function extendIndex(lib, name, st, want) {
  while (st.frames.length <= want + 1) {
    // Base : dernière frame connue (ou début audio).
    let cur;
    if (!st.frames.length) {
      const hb = await lib.read(name, st.audioStart, 32).catch(() => null);
      if (!hb || !hb.length) break;
      const h = parseFrameHeader(hb, 0, st.si);
      if (!h) throw new Error("1re frame FLAC illisible");
      cur = { off: st.audioStart, h };
    } else {
      cur = null; // on repart de la dernière frame connue (ci-dessous)
    }
    if (cur) {
      st.frames.push({ off: cur.off, samples: cur.h.samples, num: cur.h.num, variable: cur.h.variable });
      st.cum.push(st.cum[st.cum.length - 1] + BigInt(cur.h.samples));
      continue;
    }
    // Cherche la frame suivante : scan sync depuis la fin estimée.
    const last = st.frames[st.frames.length - 1];
    const from = last.off + 2n; // (la frame fait ≥ ~16o ; +2 évite l'auto-sync)
    if (from >= st.audioEnd) break;
    const want2 = st.audioEnd - from > BigInt(WINDOW) ? WINDOW : Number(st.audioEnd - from);
    let win;
    try {
      win = await lib.read(name, from, want2);
    } catch {
      break;
    }
    if (!win.length) break;
    const atEof = from + BigInt(win.length) >= st.audioEnd;
    let found = null;
    const wantNum = expectNum(st, last);
    for (let i = 0; i + 6 <= win.length; i++) {
      if (win[i] !== 0xff || (win[i + 1] & 0xfc) !== 0xf8) continue;
      const h = parseFrameHeader(win, i, st.si);
      if (!h) continue;
      if (h.num !== wantNum) continue; // continuité (anti faux-sync)
      found = { off: from + BigInt(i), h };
      break;
    }
    if (!found) {
      if (!atEof) break; // à cheval : borne v1 (fenêtre 1Mo >> frame max)
      break; // queue sans sync : fin (padding de fin éventuel ignoré)
    }
    st.frames.push({ off: found.off, samples: found.h.samples, num: found.h.num, variable: found.h.variable });
    st.cum.push(st.cum[st.cum.length - 1] + BigInt(found.h.samples));
  }
}

/** Lecture bornée → { res:0|-11, eof, byIdx }. */
export async function readFlac(session, lib, name, opts = {}) {
  const limit = BigInt(opts.limit ?? 524288);
  const byIdx = {};
  const st = session.flac;
  const t = st.track;
  let spent = 0n;
  for (let guard = 0; guard < MAX_PACKETS_PER_READ; guard++) {
    await extendIndex(lib, name, st, st.cursorIdx).catch(() => {});
    if (st.cursorIdx >= st.frames.length) {
      session.readPos = session.size;
      return { res: 0, eof: true, byIdx };
    }
    const f = st.frames[st.cursorIdx];
    // Taille = offset suivant (ou fin de fichier).
    let end;
    if (st.cursorIdx + 1 < st.frames.length) {
      end = st.frames[st.cursorIdx + 1].off;
    } else {
      await extendIndex(lib, name, st, st.cursorIdx + 1).catch(() => {});
      end = st.cursorIdx + 1 < st.frames.length ? st.frames[st.cursorIdx + 1].off : st.audioEnd;
    }
    const len = Number(end - f.off);
    if (len <= 0 || len > 1048576) {
      st.cursorIdx++; // garde-fou (jamais vu) : saute, pas de boucle infinie
      continue;
    }
    let data;
    try {
      data = await lib.read(name, f.off, len);
    } catch {
      return { res: -11, eof: false, byIdx };
    }
    if (!data || data.length < len) {
      session.readPos = session.size;
      return { res: 0, eof: true, byIdx };
    }
    const start = st.cum[st.cursorIdx];
    let emit = f.samples;
    if (st.total > 0n && start >= st.total) {
      st.cursorIdx++;
      continue; // padding final au-delà du total
    }
    if (st.total > 0n && start + BigInt(f.samples) > st.total) {
      emit = Number(st.total - start); // rogne (motif gapless)
    }
    (byIdx[t.index] = byIdx[t.index] ?? []).push({
      pts: nsOfSamples(start, t.timescale),
      dts: nsOfSamples(start, t.timescale),
      size: data.length,
      data,
      time_base_num: 1,
      time_base_den: 1000000000,
      duration: nsOfSamples(BigInt(emit > 0 ? emit : f.samples), t.timescale),
      key: true,
    });
    st.cursorIdx++;
    spent += BigInt(data.length);
    session.readPos = f.off + BigInt(data.length);
    if (spent >= limit) return { res: 0, eof: false, byIdx };
  }
  return { res: 0, eof: false, byIdx };
}

/** Seek exact : idx = dernière frame avec cumStart <= cible. */
export function seekFlacPrepare(session, targetNs) {
  const st = session.flac;
  const sr = st.track.timescale;
  const unit = (BigInt(targetNs < 0n ? 0n : targetNs) * BigInt(sr)) / 1000000000n;
  return unit;
}

export async function seekFlac(session, lib, name, targetNs) {
  const st = session.flac;
  const unit = seekFlacPrepare(session, targetNs);
  // Étend jusqu'à couvrir l'unité (ou EOF).
  for (;;) {
    if (st.cum[st.cum.length - 1] >= unit) break;
    const before = st.frames.length;
    await extendIndex(lib, name, st, st.frames.length + 64).catch(() => {});
    if (st.frames.length === before) break; // EOF
  }
  let lo = 0, hi = st.cum.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (st.cum[m] <= unit) lo = m;
    else hi = m - 1;
  }
  st.cursorIdx = Math.min(lo, st.frames.length);
  session.readPos = st.cursorIdx < st.frames.length ? st.frames[st.cursorIdx].off : session.size;
  session.eof = false;
}
