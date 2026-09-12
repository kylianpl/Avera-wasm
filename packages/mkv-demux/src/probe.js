// packages/mkv-demux/src/probe.js — index haut niveau d'un fichier MKV/WebM.
// Entrée : source {read(offset:bigint,len:number):Promise<Uint8Array>, getSize?()}
// Sortie : {segOff, docType, timecodeScale, durationNs, tracks, chapters, cues, seek, firstClusterOff}
// Tout en bigint. Variant sync probeBuffer(buf) pour tests.

import { Reader, ID } from "./ebml.js";
import { NeedMoreData } from "./vint.js";

export const PROBE_LEN = 65536n;
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];

/** Parse l'en-tête EBML au début du buffer. Retourne {docType, headerEnd}. */
export function parseEbmlHeader(buf) {
  const r = new Reader(buf, 0);
  const h = r.elem();
  if (h.id !== ID.EBML) throw new Error("not EBML (missing 0x1A45DFA3)");
  const end = h.size === null ? buf.length : Math.min(buf.length, r.p + Number(h.size));
  let docType = "";
  while (r.p < end) {
    const e = r.elem();
    const n = e.size ?? 0n;
    if (e.id === ID.DocType) docType = r.text(n);
    else r.skip(n);
  }
  return { docType, headerEnd: r.p };
}

function scanFor(buf, from, idBytes) {
  outer: for (let i = from; i + idBytes.length <= buf.length; i++) {
    for (let j = 0; j < idBytes.length; j++) if (buf[i + j] !== idBytes[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Index synchrone d'un buffer (head 64K déjà fetché).
 * @param {Uint8Array} buf
 * @param {bigint} baseOff offset fichier du début du buffer (0n en général)
 */
export function probeBuffer(buf, baseOff = 0n) {
  const { docType } = parseEbmlHeader(buf);
  const r0 = new Reader(buf, 0);
  // Avance jusqu'au Segment : l'en-tête EBML a une taille connue, on scanne après.
  const hdr = r0.elem();
  const hdrEnd = hdr.size === null ? 0 : r0.p + Number(hdr.size);
  const segPos = scanFor(buf, hdrEnd, SEGMENT_ID);
  if (segPos < 0) throw new Error("Segment not found in probe window");
  const r = new Reader(buf, segPos);
  const seg = r.elem();
  if (seg.id !== ID.Segment) throw new Error("not a Segment");
  const segOff = baseOff + BigInt(r.p); // payload Segment = base des offsets SeekHead
  const segEnd = seg.size === null ? buf.length : Math.min(buf.length, r.p + Number(seg.size));
  const out = {
    docType,
    segOff,
    timecodeScale: 1000000n,
    durationNs: -1n,
    tracks: null,
    chapters: null,
    cues: null,
    seek: [],
    firstClusterOff: null,
  };
  while (r.p < segEnd) {
    const idOff = r.p;
    let e;
    try {
      e = r.elem();
    } catch (err) {
      if (err instanceof NeedMoreData) break;
      throw err;
    }
    const elemOff = baseOff + BigInt(idOff); // offset fichier de l'ID
    const dataOff = baseOff + BigInt(r.p);
    const end = e.size === null ? segEnd : Math.min(segEnd, r.p + Number(e.size));
    if (e.id === ID.Info) {
      const ir = new Reader(buf.subarray(r.p, end));
      while (!ir.eof) {
        const f = ir.elem();
        const nn = f.size ?? 0n;
        if (f.id === ID.TimecodeScale) out.timecodeScale = ir.uint(nn);
        else if (f.id === ID.Duration) {
          const fl = ir.float(nn); // float en unités timecodeScale
          out.durationNs = !(fl >= 0) ? -1n : BigInt(Math.round(fl * Number(out.timecodeScale)));
        } else ir.skip(nn);
      }
    } else if (e.id === ID.SeekHead) {
      const sr = new Reader(buf.subarray(r.p, end));
      while (!sr.eof) {
        const s = sr.elem();
        const se = s.size === null ? sr.b.length : sr.p + Number(s.size);
        if (s.id === ID.Seek) {
          let sid = 0;
          let spos = 0n;
          while (sr.p < se) {
            const g = sr.elem();
            const nn = g.size ?? 0n;
            if (g.id === ID.SeekID) sid = Number(sr.uint(nn));
            else if (g.id === ID.SeekPosition) spos = sr.uint(nn);
            else sr.skip(nn);
          }
          out.seek.push({ id: sid, pos: spos }); // pos relative au Segment
        }
        sr.p = se;
      }
    } else if (e.id === ID.Tracks) {
      out.tracks = { off: dataOff, size: e.size };
    } else if (e.id === ID.Chapters) {
      out.chapters = { off: dataOff, size: e.size };
    } else if (e.id === ID.Cues) {
      out.cues = { off: dataOff, size: e.size };
    } else if (e.id === ID.Cluster) {
      out.firstClusterOff = elemOff;
      break; // le reste se lit en streaming
    } else if (e.id !== ID.Void && e.id !== ID.CRC) {
      // inconnu : skip
    }
    if (e.size === null) break; // unknown-size non-Cluster → fin de fenêtre
    r.p = end;
  }
  return out;
}

/** Probe async via source : 64K puis index. */
export async function probeSource(source, opts = {}) {
  const len = opts.probeLen ?? PROBE_LEN;
  const n = Number(len > 65536n ? 65536n : len);
  const head = await source.read(0n, n);
  const idx = probeBuffer(head, 0n);
  const size = typeof source.getSize === "function" ? await source.getSize().catch(() => null) : null;
  return { ...idx, size };
}

export { ID };
