// packages/sub-decode/src/index.js — parsers de sous-titres texte maison.
// SRT (MKV : texte verbatim), ASS (MKV : `ReadOrder,Layer,Style,…` sans
// préfixe "Dialogue:", timing du Block), tx3g/mov_text (MP4 : u16 longueur
// + texte + boîtes optionnelles ; échantillon vide = effacement).
// Sortie : texte brut (\n) — l'échappement HTML et la mise en page sont du
// ressort de l'UI (jamais de HTML ici). Styles/couleurs/positions ASS :
// ignorés v1 (texte seul, documenté).

const td = new TextDecoder("utf-8", { fatal: false });

/** Octets → texte (BOM éventuel retiré, fins de ligne normalisées, rogné). */
export function bytesToText(data) {
  let s = td.decode(data ?? new Uint8Array(0));
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
}

/** Retire les balises SRT (<i>, <b>, <u>, <font…>) et accolades SSA. */
export function stripSrtTags(text) {
  return String(text ?? "")
    .replace(/<[^<>]*>/g, "")
    .replace(/\{[^}]*\}/g, "");
}

/** Paquet SRT (MKV) → texte brut. */
export function parseSrtPacket(data) {
  return stripSrtTags(bytesToText(data));
}

/** Retire les overrides ASS ({\\b1}…) et convertit \N en \n. */
export function stripAssOverrides(text) {
  return String(text ?? "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ");
}

/** Paquet ASS (MKV : 8 virgules d'en-tête puis texte) → texte brut.
 * Tolérant : moins de 8 virgules → tout le paquet (sans overrides). */
export function parseAssPacket(data) {
  const raw = bytesToText(data);
  let commas = 0, cut = -1;
  for (let i = 0; i < raw.length && commas < 8; i++) {
    if (raw[i] === ",") {
      commas++;
      if (commas === 8) cut = i + 1;
    }
  }
  const text = cut < 0 ? raw : raw.slice(cut);
  return stripAssOverrides(text);
}

/** Échantillon tx3g (MP4) → texte brut, ou null si vide/effacement.
 * Layout : u16BE longueur + texte UTF-8 + boîtes (styl, …) ignorées. */
export function parseTx3gSample(data) {
  if (!data || data.length < 2) return null;
  const len = (data[0] << 8) | data[1];
  if (len === 0) return null; // échantillon vide : efface l'affichage
  if (2 + len > data.length) return null; // tronqué : ignoré (pas d'boom)
  return stripSrtTags(bytesToText(data.subarray(2, 2 + len)));
}

/** Fabrique un cue { startNs, endNs, text } depuis un paquet démuxé
 * (pts/duration en ns) + texte parsé. null si texte vide/blanc. */
export function packetToCue(pkt, text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const start = Math.max(0, Number(pkt.pts) || 0);
  const end = start + Math.max(0, Number(pkt.duration) || 0);
  if (!(end > start)) return null;
  return { startNs: start, endNs: end, text: t };
}
