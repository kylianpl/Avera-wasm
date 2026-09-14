// packages/mp3-demux/src/index.js — démuxeur MP3 maison (streaming-friendly).
// ID3v2 (y compris unsynchronisation : le scan de sync qui suit tolère les
// deux conventions de taille, voir skipLeadingTags) + APEv2 toléré en tête,
// frames MPEG Layer I/II/III, Xing/Info (durée exacte), ID3v1 exclu.
// Ouverture légère (tête seule). Index de frames EXACT et dense, étendu par
//esse (fenêtres 1MiB, chaque frame parsée une seule fois) : les pts
// (idx*spf/sr) restent exacts même après seek, sans estimation.
// Lecture : lectures exactes par frame (blocs 1MiB en cache côté lib).
// Gapless LAME : delay/padding du tag parsés (shift PTS + durée exacte,
// clamp à 0 — le player compare des horloges, cf. worker.js).
// Limites v1 : free-format refusé, fichiers hétérogènes concaténés
// (version/layer/sr changeants) non supportés.

import { parseFrameHeader, sameStream, parseXing, parseLameTag, id3v2Size } from "./frames.js";

const WINDOW = 1048576;
const MAX_PACKETS_PER_READ = 400;

export function sniffMp3(head) {
  if (!head || head.length < 4) return false;
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true; // 'ID3'
  return parseFrameHeader(head, 0) !== null;
}

const nsOfSamples = (samplesBig, rate) => Number((samplesBig * 1000000000n) / BigInt(rate));

async function skipLeadingTags(source, size) {
  // Offset probable de l'audio (ID3v2 + APEv2 de tête). Le scan de sync
  // qui suit tolère les approximations (junk/Lyrics).
  let off = 0n;
  const head = await source.read(0n, 64);
  const tag = id3v2Size(head.subarray(0, Math.min(10, head.length)));
  if (tag && tag.size !== undefined) {
    // Unsynchronisation (flag 0x80) : des 0x00 sont insérés après chaque
    // 0xFF du tag. Ambiguïté historique : `size` compte les octets stockés
    // (ffmpeg) ou dé-stuffés (iTunes). Dans les deux cas le resync qui suit
    // (double sync + lookahead) retrouve la 1re frame : hint exact ou
    // légèrement en avance dans la queue du tag (junk inoffensif).
    off = BigInt(tag.size) + (tag.flags & 0x10 ? 10n : 0n); // footer éventuel
  }
  if (off + 32n < size) {
    const ah = await source.read(off, 32);
    if (ah.length >= 32 && ah[0] === 0x41 && ah[1] === 0x50 && ah[2] === 0x45 &&
        ah[3] === 0x54 && ah[4] === 0x41 && ah[5] === 0x47 && ah[6] === 0x45 && ah[7] === 0x58) {
      const tsz = (ah[12] | (ah[13] << 8) | (ah[14] << 16) | (ah[15] << 24)) >>> 0;
      if (tsz > 32 && tsz < 64 * 1048576) off += BigInt(tsz);
    }
  }
  return off;
}

async function hasId3v1(source, size) {
  if (size < 128n) return false;
  const tail = await source.read(size - 128n, 3);
  return tail.length >= 3 && tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47; // 'TAG'
}

/** Resync : scan mémoire de fenêtres + lookahead. Retourne l'offset ou -1n. */
async function resync(lib, name, from, end, ref) {
  let winOff = from;
  while (winOff < end && winOff - from < BigInt(8 * 1048576)) {
    const want = end - winOff > BigInt(WINDOW) ? WINDOW : Number(end - winOff);
    let win;
    try {
      win = await lib.read(name, winOff, want);
    } catch {
      return -1n;
    }
    if (!win.length) return -1n;
    const atEof = winOff + BigInt(win.length) >= end;
    for (let i = 0; i + 4 <= win.length && winOff + BigInt(i) < end; i++) {
      const h = parseFrameHeader(win, i);
      if (!h || (ref && !sameStream(ref, h))) continue;
      const abs = winOff + BigInt(i);
      const next = abs + BigInt(h.frameLen);
      if (next + 4n > end) {
        if (next <= end) return abs; // queue : accepte si elle tient
        continue;
      }
      let nb;
      if (i + h.frameLen + 4 <= win.length) {
        nb = win.subarray(i + h.frameLen, i + h.frameLen + 4);
      } else {
        try {
          nb = await lib.read(name, next, 4);
        } catch {
          continue;
        }
      }
      if (nb.length < 4) continue;
      if (sameStream(h, parseFrameHeader(nb, 0))) return abs;
    }
    const adv = BigInt(win.length) - 4096n; // chevauchement (sync à cheval)
    if (adv <= 0n) return -1n;
    winOff += adv;
  }
  return -1n;
}

export async function openMp3(source) {
  const size = BigInt(await source.getSize());
  if (size < 16n) throw new Error("fichier trop petit pour MP3");
  const lib = { read: (_n, o, l) => source.read(o, l) };
  const hint = await skipLeadingTags(source, size);
  const first = await resync(lib, "", hint, size, null);
  if (first < 0n) throw new Error("aucune frame MP3 trouvée");
  const probe = await source.read(first, 2881);
  const h0 = parseFrameHeader(probe, 0);
  if (!h0) throw new Error("en-tête MP3 illisible");
  const xing = parseXing(probe.subarray(0, Math.min(h0.frameLen, probe.length)));
  // Gapless : tag LAME (1re frame). Absent des CBR ffmpeg (pas de Xing).
  const lame = parseLameTag(probe.subarray(0, Math.min(h0.frameLen, probe.length)));
  const lameDelay = lame?.delay ?? 0, lamePad = lame?.pad ?? 0;
  let start = first;
  if (xing) {
    // Frame Xing/Info : métadonnée, pas de l'audio (ffprobe ne l'émet pas
    // non plus). On démarre à la frame suivante, pts 0 (parité ffprobe).
    const second = first + BigInt(h0.frameLen);
    const probe2 = await source.read(second, 4);
    if (probe2.length < 4 || !parseFrameHeader(probe2, 0)) {
      throw new Error("frame après Xing illisible");
    }
    start = second;
  }
  const audioEnd = (await hasId3v1(source, size)) ? size - 128n : size;
  const sr = h0.sampleRate, spf = h0.samplesPerFrame;
  let durationNs;
  if (xing && xing.numFrames > 0) {
    // Total exact : frames − délai − padding (réf lame --decode : N éch).
    const total = BigInt(xing.numFrames) * BigInt(spf) - BigInt(lameDelay) - BigInt(lamePad);
    durationNs = (total > 0n ? total : BigInt(xing.numFrames) * BigInt(spf)) * 1000000000n / BigInt(sr);
  } else {
    durationNs = ((audioEnd - start) * 8n * 1000000000n) / BigInt(h0.bitrate);
  }
  const track = {
    index: 0,
    number: 1n,
    kind: 2,
    codecId: "mp3",
    family: "mp3",
    ffCodecId: 86017,
    ffCodecType: 1,
    profile: -1, level: -1, audioProfile: -1,
    width: 0, height: 0,
    channels: h0.channels,
    sampleRate: sr,
    codecPrivate: new Uint8Array(0),
    extradata: new Uint8Array(0),
    name: "",
    timescale: sr,
    defaultDurationNs: 0n,
  };
  return {
    kind: "mp3",
    tracks: [track],
    durationNs,
    mp3readPos: start,
    fileSize: size,
    mp3: {
      track, first: start, audioEnd, xing, spf,
      bitrate: h0.bitrate, header0: h0,
      lameDelay, lamePad,
      index: [start], // offsets exacts des frames, dense depuis 0
      cursorIdx: 0,
    },
  };
}

/** Étend l'index (par fenêtres) jusqu'à couvrir `want` (ou EOF). */
async function extendIndex(lib, name, st, want) {
  while (st.index.length <= want) {
    const from = st.index[st.index.length - 1];
    // Re-parse l'en-tête de la dernière frame connue pour sa taille.
    const hb = await lib.read(name, from, 4).catch(() => null);
    if (!hb || hb.length < 4) break;
    const hLast = parseFrameHeader(hb, 0);
    const scanFrom = hLast ? from + BigInt(hLast.frameLen) : from + 1n;
    if (scanFrom >= st.audioEnd) break;
    const want2 = st.audioEnd - scanFrom > BigInt(WINDOW) ? WINDOW : Number(st.audioEnd - scanFrom);
    let win;
    try {
      win = await lib.read(name, scanFrom, want2);
    } catch {
      break;
    }
    if (!win.length) break;
    const atEof = scanFrom + BigInt(win.length) >= st.audioEnd;
    let i = 0, done = false;
    while (i + 4 <= win.length) {
      const abs = scanFrom + BigInt(i);
      if (abs >= st.audioEnd) { done = true; break; }
      const h = parseFrameHeader(win, i);
      if (!h || !sameStream(st.header0, h)) { i++; continue; }
      if (i + h.frameLen > win.length) {
        if (!atEof) break; // à cheval : refenêtre depuis abs
        if (abs + BigInt(h.frameLen) > st.audioEnd) break;
      }
      // Lookahead sauf en queue d'audio.
      const next = abs + BigInt(h.frameLen);
      if (next + 4n <= st.audioEnd && (i + h.frameLen + 4 <= win.length || atEof)) {
        let nb;
        if (i + h.frameLen + 4 <= win.length) {
          nb = win.subarray(i + h.frameLen, i + h.frameLen + 4);
        } else {
          try {
            nb = await lib.read(name, next, 4);
          } catch {
            break;
          }
        }
        if (nb.length >= 4) {
          const h2 = parseFrameHeader(nb, 0);
          if (!sameStream(h, h2)) { i++; continue; }
        }
      }
      st.index.push(abs);
      if (st.index.length > want) { done = true; break; }
      i += h.frameLen;
    }
    if (done) break;
    if (i <= 0) {
      // Fenêtre sans frame : avance (junk massif) avec chevauchement.
      const adv = BigInt(win.length) - 4096n;
      if (adv <= 0n) break;
      // Évite la boucle infinie : marque la progression via un index factice ?
      // Non : on avance le scan en réécrivant la dernière entrée si rien trouvé.
      // Cas quasi-impossible (junk > 1MiB) : on abandonne l'extension.
      break;
    }
    // Reboucle : la fenêtre suivante repart de la dernière frame + sa taille
    // (recalculée en tête de boucle).
  }
}

/** Lecture bornée → { res:0|-11, eof, byIdx }. */
export async function readMp3(session, lib, name, opts = {}) {
  const limit = BigInt(opts.limit ?? 524288);
  const byIdx = {};
  const st = session.mp3;
  const t = st.track;
  let spent = 0n;
  for (let guard = 0; guard < MAX_PACKETS_PER_READ; guard++) {
    if (st.cursorIdx >= st.index.length) {
      await extendIndex(lib, name, st, st.cursorIdx).catch(() => {});
      if (st.cursorIdx >= st.index.length) {
        session.readPos = session.size;
        return { res: 0, eof: true, byIdx };
      }
    }
    const off = st.index[st.cursorIdx];
    // Taille via l'en-tête (4o suffisent, frameLen ≤ 2881o).
    let hb;
    try {
      hb = await lib.read(name, off, 4);
    } catch {
      return { res: -11, eof: false, byIdx };
    }
    if (hb.length < 4) {
      session.readPos = session.size;
      return { res: 0, eof: true, byIdx };
    }
    const h = parseFrameHeader(hb, 0);
    if (!h || !sameStream(st.header0, h)) {
      // Désync (junk) : resync + réindexe depuis ici.
      st.index.length = st.cursorIdx;
      const found = await resync(lib, name, off + 1n, st.audioEnd, st.header0).catch(() => -1n);
      if (found < 0n) {
        session.readPos = session.size;
        return { res: 0, eof: true, byIdx };
      }
      st.index.push(found);
      continue;
    }
    let data;
    try {
      data = await lib.read(name, off, h.frameLen);
    } catch {
      return { res: -11, eof: false, byIdx };
    }
    if (data.length < h.frameLen) {
      session.readPos = session.size;
      return { res: 0, eof: true, byIdx };
    }
    const samp = BigInt(st.cursorIdx) * BigInt(st.spf) - BigInt(st.lameDelay);
    const pts = samp <= 0n ? 0 : nsOfSamples(samp, t.timescale);
    // Dernière frame du stream : durée rognée du padding (gapless).
    const lastSamp = st.spf - (off + BigInt(h.frameLen) >= st.audioEnd ? st.lamePad : 0);
    (byIdx[t.index] = byIdx[t.index] ?? []).push({
      pts,
      dts: pts,
      size: data.length,
      data,
      time_base_num: 1,
      time_base_den: 1000000000,
      duration: nsOfSamples(BigInt(lastSamp > 0 ? lastSamp : st.spf), t.timescale),
      key: true,
    });
    st.cursorIdx++;
    spent += BigInt(data.length);
    session.readPos = off + BigInt(data.length);
    if (spent >= limit) return { res: 0, eof: false, byIdx };
  }
  return { res: 0, eof: false, byIdx };
}

/** Seek exact : idx = plancher((cible+delay)/spf), extension si besoin. */
export function seekMp3Prepare(session, targetNs) {
  const st = session.mp3;
  const sr = st.track.timescale;
  const adj = BigInt(targetNs) * BigInt(sr) + BigInt(st.lameDelay) * 1000000000n;
  let idx = Number(adj / 1000000000n / BigInt(st.spf));
  if (!Number.isFinite(idx) || idx < 0) idx = 0;
  return idx;
}

export async function seekMp3(session, lib, name, targetNs) {
  const st = session.mp3;
  const idx = seekMp3Prepare(session, targetNs);
  await extendIndex(lib, name, st, idx).catch(() => {});
  st.cursorIdx = Math.min(idx, st.index.length);
  session.readPos = st.cursorIdx < st.index.length ? st.index[st.cursorIdx] : session.size;
  session.eof = false;
}
