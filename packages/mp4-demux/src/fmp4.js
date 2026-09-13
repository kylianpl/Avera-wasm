// packages/mp4-demux/src/fmp4.js — parse moof/traf → échantillons fragmentés.
// Entre : payload moof + offset fichier du moof + descripteurs init
// (trex par track_ID, timescale par track_ID). Sortie : Map(trackId → sample[]),
// même forme que buildProgressiveSamples (ticks piste, offsets absolus bigint).

import { BR, children, findChild } from "./boxes.js";

const TRUN_DATA_OFFSET = 0x001;
const TRUN_FIRST_FLAGS = 0x004;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_CTS = 0x800;

const TFHD_BASE_OFFSET = 0x000001;
const TFHD_DESC_INDEX = 0x000002;
const TFHD_DUR_EMPTY = 0x010000;
export const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
const TFHD_DEF_DURATION = 0x000008;
const TFHD_DEF_SIZE = 0x000010;
const TFHD_DEF_FLAGS = 0x000020;

const NON_SYNC_FLAG = 0x00010000; // sample_is_non_sync_sample

function parseTfhd(buf, start, end) {
  const r = new BR(buf, start);
  const { flags } = r.fullbox();
  const trackId = r.u32();
  const o = { trackId, flags };
  if (flags & TFHD_BASE_OFFSET) o.baseOffset = r.u64();
  if (flags & TFHD_DESC_INDEX) o.descIndex = r.u32();
  if (flags & TFHD_DEF_DURATION) o.defDuration = r.u32();
  if (flags & TFHD_DEF_SIZE) o.defSize = r.u32();
  if (flags & TFHD_DEF_FLAGS) o.defFlags = r.u32();
  return o;
}

function parseTfdt(buf, start, end) {
  const r = new BR(buf, start);
  const { version } = r.fullbox();
  return version === 0 ? BigInt(r.u32()) : r.u64();
}

function parseTrun(buf, start, end) {
  const r = new BR(buf, start);
  const { version, flags } = r.fullbox();
  const count = r.u32();
  const t = { flags, version, count, entries: [] };
  if (flags & TRUN_DATA_OFFSET) t.dataOffset = r.i32();
  if (flags & TRUN_FIRST_FLAGS) t.firstFlags = r.u32();
  for (let i = 0; i < count; i++) {
    const e = {};
    if (flags & TRUN_DURATION) e.duration = r.u32();
    if (flags & TRUN_SIZE) e.size = r.u32();
    if (flags & TRUN_FLAGS) e.flags = r.u32();
    if (flags & TRUN_CTS) e.cts = version === 0 ? r.u32() : r.i32();
    t.entries.push(e);
  }
  return t;
}

/** sdtp → tableau de bytes (1/échantillon), ou null. */
function parseSdtp(buf, start, end) {
  const r = new BR(buf, start);
  r.fullbox();
  return Uint8Array.from(buf.subarray(r.p, end));
}

/**
 * Parse un payload moof (SANS son en-tête).
 * @param {Uint8Array} buf payload [moofOff+hdr, moofEnd)
 * @param {bigint} moofOff offset fichier du début du moof (base par défaut)
 * @param {Map<number,{trex,timescale}>} init par track_ID
 */
export function parseMoof(buf, moofOff, moofEnd, init) {
  const out = new Map(); // trackId -> sample[]
  // buf couvre exactement [moofOff, moofEnd) : enfants relatifs à 0.
  for (const t of children(buf, 0, buf.length)) {
    if (t.type !== "traf") continue;
    parseTraf(buf, t.start, t.end, moofOff, init, out);
  }
  return out;
}

function parseTraf(buf, start, end, moofOff, init, out) {
  const tfhdBox = findChild(buf, start, end, "tfhd");
  if (!tfhdBox) return;
  const tfhd = parseTfhd(buf, tfhdBox.start, tfhdBox.end);
  if (tfhd.flags & TFHD_DUR_EMPTY) return;
  const ini = init.get(tfhd.trackId);
  if (!ini) return; // piste inconnue du moov init
  const trex = ini.trex ?? {};
  const tfdtBox = findChild(buf, start, end, "tfdt");
  let dts = tfdtBox ? parseTfdt(buf, tfdtBox.start, tfdtBox.end) : 0n;
  const sdtpBox = findChild(buf, start, end, "sdtp");
  const sdtp = sdtpBox ? parseSdtp(buf, sdtpBox.start, sdtpBox.end) : null;
  const base = tfhd.baseOffset !== undefined ? tfhd.baseOffset : moofOff;
  const arr = out.get(tfhd.trackId) ?? [];
  out.set(tfhd.trackId, arr);
  for (const tr of children(buf, start, end)) {
    if (tr.type !== "trun") continue;
    const run = parseTrun(buf, tr.start, tr.end);
    let off = base + BigInt(run.dataOffset ?? 0);
    for (let i = 0; i < run.entries.length; i++) {
      const e = run.entries[i];
      const dur = e.duration ?? tfhd.defDuration ?? trex.defDuration ?? 0;
      const size = e.size ?? tfhd.defSize ?? trex.defSize ?? 0;
      let flags = e.flags;
      if (flags === undefined && i === 0 && run.firstFlags !== undefined) flags = run.firstFlags;
      flags ??= tfhd.defFlags ?? trex.defFlags ?? 0;
      const cts = e.cts ?? 0;
      let key = !(flags & NON_SYNC_FLAG);
      if (sdtp && (e.flags === undefined && tfhd.defFlags === undefined && trex.defFlags === undefined)) {
        // Pas d'info de sync par flags : sdtp (depends==2 → clé).
        const sd = sdtp[i];
        if (sd !== undefined) key = ((sd >> 4) & 3) === 2;
      }
      arr.push({
        off,
        size,
        dts,
        pts: dts + BigInt(cts),
        dur,
        key,
      });
      off += BigInt(size);
      dts += BigInt(dur);
    }
  }
}

/** Parse mvex → Map(track_ID → trex defaults). */
export function parseMvex(buf, start, end) {
  const out = new Map();
  for (const b of children(buf, start, end)) {
    if (b.type !== "trex") continue;
    const r = new BR(buf, b.start);
    r.fullbox();
    const id = r.u32();
    out.set(id, {
      descIndex: r.u32(),
      defDuration: r.u32(),
      defSize: r.u32(),
      defFlags: r.u32(),
    });
  }
  return out;
}
