// packages/mkv-demux/src/ebml.js — lecteur EBML générique + parse Tracks/Chapters/Cues.
// IDs en number (32-bit), tailles/offsets en bigint, temps en i64 ns (bigint).
import { readId, readVint, readUint, NeedMoreData, EbmlError } from "./vint.js";

export { NeedMoreData, EbmlError };

export class Reader {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  get eof() { return this.p >= this.b.length; }
  u8() { if (this.p >= this.b.length) throw new NeedMoreData("eof"); return this.b[this.p++]; }
  bytes(n) {
    const v = Number(n);
    if (this.p + v > this.b.length) throw new NeedMoreData("trunc");
    const s = this.b.subarray(this.p, this.p + v); this.p += v; return s;
  }
  skip(n) {
    const v = Number(n);
    if (this.p + v > this.b.length) throw new NeedMoreData("trunc skip");
    this.p += v;
  }
  uint(n) {
    const v = readUint(this.b, this.p, Number(n)); this.p += Number(n); return v;
  }
  float(n) {
    const b = this.bytes(n);
    if (n === 4n || n === 4) return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, false);
    if (n === 8n || n === 8) return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, false);
    throw new EbmlError("bad float len");
  }
  elem() {
    const { id, width: w1 } = readId(this.b, this.p); this.p += w1;
    const { size, width: w2 } = readVint(this.b, this.p); this.p += w2;
    return { id, size }; // size: bigint|null (null = unknown)
  }
  text(n) { return new TextDecoder().decode(this.bytes(n)); }
}

/** ticks (int64) * scale (u64 ns/tick) → ns (i64). Tout en bigint. */
export function ticksToNs(ticks, scale) {
  return BigInt(ticks) * BigInt(scale);
}

/** IDs Matroska utiles */
export const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Void: 0xec, CRC: 0xbf,
  Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5,
  TrackType: 0x83, FlagDefault: 0x88, FlagForced: 0x55aa, DefaultDuration: 0x23e383,
  CodecID: 0x86, CodecPrivate: 0x63a2, Language: 0x22b59c, Name: 0x536e,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Audio: 0xe1, SamplingFreq: 0xb5, Channels: 0x9f, BitDepth: 0x6264,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0,
  Block: 0xa1, BlockDuration: 0x9b, ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7,
  CueTrack: 0xf7, CueClusterPosition: 0xf1, CueRelativePosition: 0xf0,
  Chapters: 0x1043a770, EditionEntry: 0x45b9, ChapterAtom: 0xb6,
  ChapterUID: 0x73c4, ChapterTimeStart: 0x91, ChapterTimeEnd: 0x92,
  ChapterDisplay: 0x80, ChapString: 0x85,
  SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  DocType: 0x4282,
};

/** Parse le payload Tracks → TrackEntry[] */
export function parseTracks(payload) {
  const r = new Reader(payload);
  const out = [];
  while (!r.eof) {
    const { id, size } = r.elem();
    const end = size === null ? payload.length : r.p + Number(size);
    if (id === ID.TrackEntry) out.push(parseEntry(r, end));
    r.p = Math.min(end, payload.length);
  }
  return out;
}

function parseEntry(r, end) {
  const t = {
    number: 0n, uid: 0n, kind: 0, default: false, forced: false,
    codecId: "", lang: "eng", name: "", defaultDurationNs: 0n,
    width: 0n, height: 0n, channels: 0n, sampleRate: 0, bitDepth: 0n,
    codecPrivate: new Uint8Array(0),
  };
  while (r.p < end) {
    const { id, size } = r.elem();
    const n = size === null ? 0n : size;
    const de = size === null ? end : Math.min(end, r.p + Number(size));
    switch (id) {
      case ID.TrackNumber: t.number = r.uint(n); break;
      case ID.TrackUID: t.uid = r.uint(n); break;
      case ID.TrackType: t.kind = Number(r.uint(n)); break;
      case ID.FlagDefault: t.default = r.uint(n) !== 0n; break;
      case ID.FlagForced: t.forced = r.uint(n) !== 0n; break;
      case ID.CodecID: t.codecId = r.text(n); break;
      case ID.Language: t.lang = r.text(n); break;
      case ID.Name: t.name = r.text(n); break;
      case ID.DefaultDuration: t.defaultDurationNs = r.uint(n); break;
      case ID.CodecPrivate: t.codecPrivate = Uint8Array.from(r.bytes(n)); break;
      case ID.Video:
        while (r.p < de) {
          const e = r.elem(); const nn = e.size ?? 0n;
          if (e.id === ID.PixelWidth) t.width = r.uint(nn);
          else if (e.id === ID.PixelHeight) t.height = r.uint(nn);
          else r.skip(nn);
        }
        break;
      case ID.Audio:
        while (r.p < de) {
          const e = r.elem(); const nn = e.size ?? 0n;
          if (e.id === ID.Channels) t.channels = r.uint(nn);
          else if (e.id === ID.SamplingFreq) t.sampleRate = r.float(nn);
          else if (e.id === ID.BitDepth) t.bitDepth = r.uint(nn);
          else r.skip(nn);
        }
        break;
      default: r.skip(n); break;
    }
    r.p = Math.min(de, end);
  }
  return t;
}

/** Parse le payload Chapters → ChapterAtom[] {uid,startNs,endNs,title} */
export function parseChapters(payload) {
  const r = new Reader(payload);
  const out = [];
  while (!r.eof) {
    const { id, size } = r.elem();
    const end = size === null ? payload.length : r.p + Number(size);
    if (id === ID.EditionEntry) {
      const er = new Reader(r.b.subarray(r.p, end));
      while (!er.eof) {
        const a = er.elem();
        const e2 = a.size === null ? er.b.length : er.p + Number(a.size);
        if (a.id === ID.ChapterAtom) {
          const c = { uid: 0n, startNs: 0n, endNs: -1n, hidden: false, enabled: true, title: "", lang: "eng" };
          while (er.p < e2) {
            const f = er.elem(); const nn = f.size ?? 0n;
            if (f.id === ID.ChapterUID) c.uid = er.uint(nn);
            else if (f.id === ID.ChapterTimeStart) c.startNs = er.uint(nn);
            else if (f.id === ID.ChapterTimeEnd) c.endNs = er.uint(nn);
            else if (f.id === ID.ChapterDisplay) {
              const de3 = er.p + Number(nn);
              while (er.p < de3) {
                const g = er.elem(); const n4 = g.size ?? 0n;
                if (g.id === ID.ChapString) { c.title = er.text(n4); }
                else er.skip(n4);
              }
            } else er.skip(nn);
          }
          out.push(c);
        }
        er.p = e2;
      }
    }
    r.p = Math.min(end, payload.length);
  }
  return out;
}

/** Parse le payload Cues → CuePoint[] triés par timeNs */
export function parseCues(payload, timecodeScale) {
  const scale = BigInt(timecodeScale);
  const r = new Reader(payload);
  const out = [];
  while (!r.eof) {
    const { id, size } = r.elem();
    const end = size === null ? payload.length : r.p + Number(size);
    if (id === ID.CuePoint) {
      let t = 0n;
      const c = { timeNs: 0n, track: 0n, clusterPos: 0n, relPos: 0n, blockNo: 0, durNs: -1n };
      const cr = new Reader(r.b.subarray(r.p, end));
      while (!cr.eof) {
        const f = cr.elem(); const nn = f.size ?? 0n;
        if (f.id === ID.CueTime) t = cr.uint(nn);
        else if (f.id === ID.CueTrackPositions) {
          const de = cr.p + Number(nn);
          while (cr.p < de) {
            const g = cr.elem(); const n2 = g.size ?? 0n;
            if (g.id === ID.CueTrack) c.track = cr.uint(n2);
            else if (g.id === ID.CueClusterPosition) c.clusterPos = cr.uint(n2);
            else if (g.id === ID.CueRelativePosition) c.relPos = cr.uint(n2);
            else cr.skip(n2);
          }
        } else cr.skip(nn);
      }
      c.timeNs = t * scale;
      out.push(c);
    }
    r.p = Math.min(end, payload.length);
  }
  out.sort((a, b) => (a.timeNs < b.timeNs ? -1 : a.timeNs > b.timeNs ? 1 : 0));
  return out;
}

/** Choisit le cue ≤ target (seek). */
export function pickCue(cues, targetNs) {
  let lo = 0, hi = cues.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cues[m].timeNs <= targetNs) lo = m + 1; else hi = m; }
  if (lo === 0) return cues[0] ?? null;
  return cues[lo - 1] ?? null;
}
