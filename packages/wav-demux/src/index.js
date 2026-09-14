// packages/wav-demux/src/index.js — démuxeur WAV/RIFF maison.
// fmt (PCM entier 0x0001, flottant 0x0003, extensible 0xFFFE) + data.
// Paquets à taille fixe (4096 échantillons), seek exact au byte,
// durée exacte. Pont SW pcm.js existant (u8/s16/s24/s32/f32/f64).
// Limites v1 : RF64/double-data (>4Go), ADPCM et autres codecs (erreur
// propre), cue/list-info ignorés (pas de chapitres).

import { chunkHeader, chunkEnd } from "../../avi-demux/src/riff.js";

export function sniffWav(head) {
  return !!head && head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && // 'RIFF'
    head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45; // 'WAVE'
}

/** fmt (≥16o) → { tag, channels, rate, align, bits, isFloat } ou null. */
function parseFmt(b) {
  if (!b || b.length < 16) return null;
  const tag = b[0] | (b[1] << 8);
  const channels = b[2] | (b[3] << 8);
  const rate = ((b[4] | (b[5] << 8) | (b[6] << 16)) + b[7] * 0x1000000) >>> 0;
  const align = b[12] | (b[13] << 8);
  let bits = b[14] | (b[15] << 8);
  let isFloat = tag === 0x0003;
  if (tag === 0xfffe) {
    // Extensible : validBits(16) + mask(32) + subformat GUID(16).
    if (b.length < 40) return null;
    bits = b[16] | (b[17] << 8);
    const sub = b[20];
    if (sub === 0x01) isFloat = false;
    else if (sub === 0x03) isFloat = true;
    else return null; // non-PCM (ex. DTS/WMA dans WAV)
  } else if (tag !== 0x0001 && tag !== 0x0003) {
    return null; // ADPCM, MP3-in-WAV… : refusé (v1)
  }
  if (!channels || channels > 8 || !rate || rate > 192000) return null;
  const alignOk = align || (channels * bits) / 8;
  if (!(alignOk > 0) || !(bits > 0)) return null;
  return { tag, channels, rate, align: alignOk, bits, isFloat };
}

const PACKET_SAMPLES = 4096;
const MAX_PACKETS_PER_READ = 400;

export async function openWav(source) {
  const size = BigInt(await source.getSize());
  if (size < 12n) throw new Error("fichier trop petit pour WAV");
  const head = await source.read(0n, 12);
  if (!sniffWav(head)) throw new Error("pas un RIFF/WAVE");
  let off = 12n;
  let fmt = null, data = null;
  for (let g = 0; g < 256 && off + 8n <= size; g++) {
    const hb = await source.read(off, 12);
    if (hb.length < 8) break;
    const h = chunkHeader(hb, 0);
    const id = h.id;
    if (id === "fmt ") {
      const fb = await source.read(off + 8n, Math.min(h.size, 64));
      fmt = parseFmt(fb.subarray(0, Math.min(fb.length, h.size)));
      if (!fmt) throw new Error("format WAV non-PCM non supporté (v1 : PCM/flottant)");
    } else if (id === "data" && !data) {
      data = { off: off + 8n, size: BigInt(h.size) };
    }
    // fact/cue/LIST-INFO : ignorés (durée dérivée de data).
    const nx = chunkEnd(off, { hdr: 8, size: BigInt(h.size) });
    if (nx <= off) break;
    off = nx;
  }
  if (!fmt) throw new Error("chunk fmt introuvable");
  if (!data) throw new Error("chunk data introuvable");
  const total = Number(data.size / BigInt(fmt.align)); // échantillons (frames)
  const t = {
    index: 0,
    number: 1n,
    kind: 2,
    codecId: "pcm",
    family: "pcm",
    ffCodecId: 65536,
    ffCodecType: 1,
    profile: -1, level: -1, audioProfile: -1,
    width: 0, height: 0,
    channels: fmt.channels,
    sampleRate: fmt.rate,
    codecPrivate: new Uint8Array(0),
    extradata: new Uint8Array(0),
    name: "",
    timescale: fmt.rate,
    defaultDurationNs: 0n,
    bitsPerSample: fmt.bits,
    isFloat: fmt.isFloat,
    _align: fmt.align, // bytes/frame (blockAlign fmt, jamais 0 ici)
  };
  const durationNs = (BigInt(total) * 1000000000n) / BigInt(fmt.rate);
  return {
    kind: "wav",
    tracks: [t],
    durationNs,
    wavreadPos: data.off,
    fileSize: size,
    wav: { track: t, data, total, cursor: 0 },
  };
}

/** Lecture bornée → { res:0|-11, eof, byIdx }. Paquets 4096 éch. */
export async function readWav(session, lib, name, opts = {}) {
  const limit = BigInt(opts.limit ?? 524288);
  const byIdx = {};
  const st = session.wav;
  const t = st.track;
  const sr = t.timescale;
  let spent = 0n;
  for (let guard = 0; guard < MAX_PACKETS_PER_READ; guard++) {
    if (st.cursor >= st.total) {
      session.readPos = session.size;
      return { res: 0, eof: true, byIdx };
    }
    const n = Math.min(PACKET_SAMPLES, st.total - st.cursor);
    const align = t._align;
    const bytes = n * align;
    const off = st.data.off + BigInt(st.cursor) * BigInt(align);
    let data;
    try {
      data = await lib.read(name, off, bytes);
    } catch {
      return { res: -11, eof: false, byIdx };
    }
    if (!data || data.length < bytes) {
      session.readPos = session.size;
      return { res: 0, eof: true, byIdx };
    }
    const samp = BigInt(st.cursor);
    (byIdx[t.index] = byIdx[t.index] ?? []).push({
      pts: Number((samp * 1000000000n) / BigInt(sr)),
      dts: Number((samp * 1000000000n) / BigInt(sr)),
      size: data.length,
      data,
      time_base_num: 1,
      time_base_den: 1000000000,
      duration: Number((BigInt(n) * 1000000000n) / BigInt(sr)),
      key: true,
    });
    st.cursor += n;
    spent += BigInt(data.length);
    session.readPos = off + BigInt(data.length);
    if (spent >= limit) return { res: 0, eof: false, byIdx };
  }
  return { res: 0, eof: false, byIdx };
}

/** Seek exact : curseur = plancher(cible×sr), borné. */
export async function seekWav(session, _lib, _name, targetNs) {
  const st = session.wav;
  const sr = st.track.timescale;
  let s = Number((BigInt(targetNs < 0n ? 0n : targetNs) * BigInt(sr)) / 1000000000n);
  if (!Number.isFinite(s) || s < 0) s = 0;
  st.cursor = Math.min(s, st.total);
  session.readPos = st.data.off + BigInt(st.cursor) * BigInt(st.track._align);
  session.eof = false;
}
