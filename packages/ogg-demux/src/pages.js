// packages/ogg-demux/src/pages.js — pages Ogg (RFC 3533/7845 §3).
// En-tête 27o + table de segments + corps (≤ 255×255o). Pas de vérif
// CRC (coûteuse) : validation structurelle (capture, version, tailles).
// Les paquets sont réassemblés par l'appelant (fragments inter-pages).

export function sniffOgg(head) {
  return !!head && head.length >= 4 &&
    head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53; // 'OggS'
}

/** Parse l'en-tête + table à `off` (27o + n). Retourne null si invalide.
 * { off, serial, seq, continued, bos, eos, granule (-1n si inconnue),
 *   hdrLen, bodyLen, totalLen }. granule = i64 LE signé. */
export function parsePageHeader(buf, off) {
  if (off + 27 > buf.length) return null;
  if (buf[off] !== 0x4f || buf[off + 1] !== 0x67 ||
      buf[off + 2] !== 0x67 || buf[off + 3] !== 0x53) return null;
  if (buf[off + 4] !== 0) return null; // version
  const flags = buf[off + 5];
  // granulepos i64 LE signé (0xFF… = -1 = inconnue).
  let g = 0n;
  for (let i = 0; i < 8; i++) g |= BigInt(buf[off + 6 + i]) << BigInt(i * 8);
  if (g >= 0x8000000000000000n) g -= 0x10000000000000000n;
  const serial = (buf[off + 14] | (buf[off + 15] << 8) |
    (buf[off + 16] << 16)) + buf[off + 17] * 0x1000000;
  const seq = (buf[off + 18] | (buf[off + 19] << 8) |
    (buf[off + 20] << 16)) + buf[off + 21] * 0x1000000;
  const nseg = buf[off + 26];
  if (off + 27 + nseg > buf.length) return null;
  let bodyLen = 0;
  for (let i = 0; i < nseg; i++) bodyLen += buf[off + 27 + i];
  return {
    off, serial, seq,
    continued: !!(flags & 0x01), bos: !!(flags & 0x02), eos: !!(flags & 0x04),
    granule: g,
    hdrLen: 27 + nseg, bodyLen,
    totalLen: 27 + nseg + bodyLen,
    segTable: buf.subarray(off + 27, off + 27 + nseg),
  };
}

/** Découpe le corps en paquets COMPLETS + reste : les segments < 255
 * terminent un paquet. Retourne { done: [Uint8Array…], rest: Uint8Array }
 * où rest = fragment final (paquet à cheval, à préfixer à la page suivie).
 * Les copies sont neuves (contrat transfert inter-workers). */
export function splitPagePackets(body, segTable, pending) {
  const done = [];
  let cur = pending && pending.length ? [pending] : [];
  let curLen = pending ? pending.length : 0;
  let p = 0;
  for (let i = 0; i < segTable.length; i++) {
    const n = segTable[i];
    const part = body.subarray(p, p + n);
    p += n;
    if (n > 0) { cur.push(part); curLen += n; }
    if (n < 255) {
      // Paquet terminé : concatène (copie neuve).
      const pkt = new Uint8Array(curLen);
      let o = 0;
      for (const c of cur) { pkt.set(c, o); o += c.length; }
      done.push(pkt);
      cur = []; curLen = 0;
    }
  }
  let rest = null;
  if (curLen > 0) {
    rest = new Uint8Array(curLen);
    let o = 0;
    for (const c of cur) { rest.set(c, o); o += c.length; }
  }
  return { done, rest };
}

/** Cherche la prochaine page valide depuis `from` (scan borné).
 * Retourne l'offset ou -1n. Valide : capture + version + table tenue
 * dans une fenêtre de 27+255o (le corps peut dépasser, relu ensuite). */
export async function findPage(source, from, end, maxScan = 1048576) {
  let off = BigInt(from);
  const stop = BigInt(end);
  let scanned = 0;
  const CH = 282;
  while (off + 27n <= stop && scanned < maxScan) {
    const want = Number((stop - off > BigInt(CH) ? BigInt(CH) : stop - off));
    let win;
    try {
      win = await source.read(off, want);
    } catch {
      return -1n;
    }
    if (!win || !win.length) return -1n;
    for (let i = 0; i + 27 <= win.length; i++) {
      if (win[i] === 0x4f && win[i + 1] === 0x67 &&
          win[i + 2] === 0x67 && win[i + 3] === 0x53 && win[i + 4] === 0) {
        const nseg = win[i + 26];
        if (i + 27 + nseg <= win.length || BigInt(off) + BigInt(i) + 27n + BigInt(nseg) <= stop) {
          return off + BigInt(i);
        }
      }
    }
    // Avance en gardant un chevauchement (capture à cheval).
    const adv = BigInt(win.length) - 30n;
    if (adv <= 0n) return -1n;
    off += adv;
    scanned += Number(adv);
  }
  return -1n;
}

/** Lit une page complète à `off` (en-tête + corps). Retourne
 * { head, body } ou null. */
export async function readPage(source, off) {
  let hb;
  try {
    hb = await source.read(BigInt(off), 282);
  } catch {
    return null;
  }
  if (!hb || hb.length < 27) return null;
  const head = parsePageHeader(hb, 0);
  if (!head) return null;
  let body = hb.subarray(head.hdrLen, head.hdrLen + head.bodyLen);
  if (body.length < head.bodyLen) {
    // Corps tronqué dans la fenêtre : complète.
    try {
      const rest = await source.read(BigInt(off) + BigInt(head.hdrLen) + BigInt(body.length),
        head.bodyLen - body.length);
      const full = new Uint8Array(head.bodyLen);
      full.set(body);
      full.set(rest.subarray(0, head.bodyLen - body.length), body.length);
      body = full;
    } catch {
      return null;
    }
  }
  return { head, body };
}
