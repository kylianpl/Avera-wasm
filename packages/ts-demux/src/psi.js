// packages/ts-demux/src/psi.js — tables PSI (PAT/PMT) + mapping des streams.
// Sections réassemblées (pointer_field), CRC32 vérifié, descripteurs
// lus pour les streams privés (0x06 : AC3/EAC3/DTS/soustitres→ignorés).
// Multi-programmes : 1er programme avec A/V (documenté v1).

import { crc32 } from "./ts.js";

/** Assemble une section : payload (après pointer_field si PUSI).
 * state = { buf } persistant par PID. Retourne la section complète
 * (sans pointer) ou null (incomplète). */
export function feedSection(state, payload, pusi) {
  if (pusi) {
    if (!payload.length) return null;
    const ptr = payload[0];
    if (ptr + 1 > payload.length) return null;
    state.buf = payload.subarray(ptr + 1);
  } else if (state.buf) {
    const nb = new Uint8Array(state.buf.length + payload.length);
    nb.set(state.buf);
    nb.set(payload, state.buf.length);
    state.buf = nb;
  } else {
    return null; // suite sans début : ignore
  }
  if (state.buf.length < 3) return null;
  const len = ((state.buf[1] & 0x0f) << 8) | state.buf[2];
  if (state.buf.length < 3 + len) return null; // incomplète
  const sec = state.buf.subarray(0, 3 + len);
  state.buf = state.buf.length > 3 + len ? state.buf.subarray(3 + len) : null;
  if (!checkCrc(sec)) return null;
  return sec;
}

function checkCrc(sec) {
  if (sec.length < 4) return false;
  const got = ((sec[sec.length - 4] * 0x1000000) + ((sec[sec.length - 3] << 16) |
    (sec[sec.length - 2] << 8) | sec[sec.length - 1])) >>> 0;
  return crc32(sec, 0, sec.length - 4) === got;
}

/** PAT → [{ program, pmtPid }] (program 0 = réseau, exclu). */
export function parsePat(sec) {
  if (!sec || sec[0] !== 0x00) return [];
  const out = [];
  const end = sec.length - 4;
  for (let p = 8; p + 4 <= end; p += 4) {
    const program = (sec[p] << 8) | sec[p + 1];
    const pid = ((sec[p + 2] & 0x1f) << 8) | sec[p + 3];
    if (program !== 0) out.push({ program, pmtPid: pid });
  }
  return out;
}

// stream_type → { family, id } (null = ignoré : sous-titres/télétexte/données).
function mapStreamType(t, descs) {
  switch (t) {
    case 0x02: return { family: "mpeg2video", id: 2 };
    case 0x1b: return { family: "h264", id: 27 };
    case 0x24: return { family: "hevc", id: 173 };
    case 0x03: return { family: "mp3", id: 86017 };
    case 0x04: return { family: "mp2", id: 86016 };
    case 0x0f: return { family: "aac", id: 86018 }; // ADTS (LATM 0x11 refusé v1)
    case 0x81: return { family: "ac3", id: 86019 };
    case 0x87: return { family: "eac3", id: 86055 };
    case 0x82: case 0x8a: return { family: "dts", id: 86056 };
    case 0x84: return { family: "eac3", id: 86055 }; // E-AC-3 secondaire (Blu-ray/m2ts)
    case 0x06: {
      // Privé : descripteurs (tag, len, …).
      let p = 0;
      while (p + 2 <= descs.length) {
        const tag = descs[p], len = descs[p + 1];
        if (tag === 0x6a) return { family: "ac3", id: 86019 };
        if (tag === 0x7a) return { family: "eac3", id: 86055 };
        if (tag === 0x7b) return { family: "dts", id: 86056 };
        p += 2 + len;
      }
      // Sans descripteur (muxers laxistes, ex. ffmpeg -mpegts_m2ts_mode 1
      // qui met l'AAC en 0x06 nu) : marqué à sniffer (1er PES, cf. openTs).
      // Avec descripteurs non reconnus (sous-titres/télétexte…) : ignoré.
      if (descs.length === 0) return { family: "unknown", id: 0, private: true };
      return null; // sous-titres/LPCM/télétexte… (v1)
    }
    default: return null; // 0x05, 0xEA (VC-1)… : ignorés (v1)
  }
}

/** PMT → [{ type, pid, descs }] mappés [{ family, id, pid }]. */
export function parsePmt(sec) {
  if (!sec || sec[0] !== 0x02) return [];
  const out = [];
  const pil = ((sec[10] & 0x0f) << 8) | sec[11];
  const end = sec.length - 4;
  let p = 12 + pil;
  while (p + 5 <= end) {
    const type = sec[p];
    const pid = ((sec[p + 1] & 0x1f) << 8) | sec[p + 2];
    const il = ((sec[p + 3] & 0x0f) << 8) | sec[p + 4];
    const descs = sec.subarray(p + 5, Math.min(p + 5 + il, end));
    const m = mapStreamType(type, descs);
    if (m) out.push({ ...m, pid, streamType: type });
    p += 5 + il;
  }
  return out;
}
