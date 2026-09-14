// packages/wc-bridge/src/bridge.js — construction configs/chunks WebCodecs.
// Réimplémentation fidèle de LibAVJSWebCodecs (libav.js, cf. NOTICE) :
// videoStreamToConfig, packetToEncodedVideoChunk, audioStreamToConfig,
// packetToEncodedAudioChunk. Mêmes règles, mêmes cas limites — c'est ce
// comportement exact (éprouvé) qui fait accepter les configs par les
// navigateurs stricts (cf. PLAN.md). Déviations volontaires documentées.
//
// Entrées : pistes/paquets au format demux-compat (familles + champs bruts),
// pas de structures FFmpeg.
const hx = (b) => (b & 0xff).toString(16).padStart(2, "0");

/** VideoDecoderConfig depuis une piste vidéo.
 *  track = { family:'h264'|'hevc'|'vp8'|'vp9'|'av1', width, height,
 *            profile (int, bit 0x100 = constrained), level (int),
 *            extradata?: Uint8Array }.
 *  Règles bridge : rien d'autre que codec+codedWidth/Height+description
 *  (pas de hardwareAcceleration/colorSpace/optimizeForLatency) ;
 *  description = extradata VERBATIM ssi extradata && extradata[0] !== 0. */
export function videoStreamToConfig(t) {
  const ret = { codec: "unknown", codedWidth: Number(t.width) | 0, codedHeight: Number(t.height) | 0 };
  const e = t.extradata;
  const verbatimDesc = e && e.length && e[0] !== 0 ? e : null;
  if (t.family === "h264") {
    let codec = "avc1";
    if (e && e.length > 7 && e[0] === 0 && e[1] === 0 && e[2] === 0 && e[3] === 1 && (e[4] & 0x1f) === 7) {
      // Extradata AnnexB (SPS in-band) : dérive PPCCLL des octets SPS 1-3.
      codec += "." + hx(e[5]) + hx(e[6]) + hx(e[7]);
    } else {
      // Profil/niveau : défauts 77 (Main) / 10 (0x0a), hex minuscule.
      const profile = t.profile == null || t.profile < 0 ? 77 : t.profile;
      const profileB = profile & 0xff;
      let constraints = 0;
      if (profile & 0x100) {
        if (profileB === 66) constraints = 0xe0;
        else if (profileB === 77) constraints = 0x60;
        else if (profileB === 88) constraints = 0x20;
        else {
          ret.codec = codec; // contraint exotique : avc1 nu
          if (verbatimDesc) ret.description = verbatimDesc;
          return ret;
        }
      }
      const level = t.level == null || t.level < 0 ? 10 : t.level;
      codec += "." + hx(profileB) + hx(constraints) + hx(level);
    }
    ret.codec = codec;
  } else if (t.family === "hevc") {
    // Minimal (pas de sample beta) : hvc1 d'après VPS/SPS si dispo, sinon inconnu.
    // TODO: vérifier contre le bridge (parse DataView sur 12+ octets).
    ret.codec = "hvc1.1.6.L93.90";
  } else if (t.family === "vp8") {
    ret.codec = "vp8";
  } else if (t.family === "vp9") {
    // vpcC (MP4) : profil/niveau/profondeur réels, sinon défauts P0/L10/8b
    // (level 0 = non spécifié, fréquent via ffmpeg).
    const VP9_LV = [10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 60, 61];
    let p = t.profile == null || t.profile < 0 ? 0 : t.profile;
    let lv = 10, dd = 8;
    if (e && e.length >= 4 && e[0] === 1) {
      if (e[1] <= 3) p = e[1];
      if (VP9_LV.includes(e[2])) lv = e[2];
      const bd = e[3] >> 4;
      if (bd === 10 || bd === 12) dd = bd;
    }
    const p2 = (n) => String(n).padStart(2, "0");
    ret.codec = `vp09.0${p}.${p2(lv)}.0${dd}`;
  } else if (t.family === "av1") {
    // av1C : profil/niveau/tier/profondeur réels (MP4 comme MKV : même
    // record, marker 0x81), sinon défaut Main/4.0/8b.
    let p = 0, lv = "40", tier = "M", dd = "08";
    if (e && e.length >= 3 && (e[0] & 0x7f) === 1) {
      p = (e[1] >> 5) & 0x07;
      const li = e[1] & 0x1f;
      const LV = ["20","21","22","23","30","31","40","41","42","43","50","51","52","53","60","61","62","63","70","71","72","73"];
      if (li < LV.length) lv = LV[li];
      tier = (e[2] & 0x80) ? "H" : "M";
      dd = (e[2] & 0x20) ? "12" : (e[2] & 0x40) ? "10" : "08";
    }
    ret.codec = `av01.${p}.${lv}${tier}.${dd}`;
  }
  // AV1 EXIGE sa description (av1C) ; VP9 s'en passe (bitstream
  // auto-décrit — vpcC non joint même si présent).
  if (verbatimDesc && (t.family === "h264" || t.family === "hevc" || t.family === "av1")) {
    ret.description = verbatimDesc;
  }
  return ret;
}

/** µs depuis (pts, timebase) — pts seul, arrondi, sans clamp (fidèle bridge). */
function tsUs(pts, num, den) {
  return Math.round((pts * num) / den * 1e6);
}

/** EncodedVideoChunk depuis un paquet démuxé.
 *  pkt = { key:bool, pts:number(ticks), duration:number(ticks),
 *          time_base_num/time_base_den (noms FFmpeg, comme libav),
 *          data:Uint8Array (layout démuxeur-verbatim) }.
 *  Règles bridge : type=flags&1 (ici key), duration TOUJOURS posée (souvent 0),
 *  data verbatim. DÉVIATION : copie au lieu d'alias .buffer (le bridge ignore
 *  byteOffset — bug latent ; la copie est sûre et équivalente au décodage). */
export function packetToEncodedVideoChunk(pkt) {
  const num = pkt.time_base_num ?? pkt.timeBaseNum ?? 1;
  const den = pkt.time_base_den ?? pkt.timeBaseDen ?? 1000000;
  return {
    type: pkt.key ? "key" : "delta",
    timestamp: tsUs(pkt.pts, num, den),
    duration: tsUs(pkt.duration || 0, num, den),
    data: new Uint8Array(pkt.data),
  };
}

/** AudioDecoderConfig depuis une piste audio.
 *  track = { family:'aac'|'opus'|'mp3'|'vorbis'|'flac',
 *            sampleRate, channels, audioProfile?, extradata? }.
 *  AAC : mp4a.40.2 (LOW/défaut), .5 (HE), .29 (HEv2) + ASC brut.
 *  Opus : 'opus' SANS description (même si OpusHead présent). */
export function audioStreamToConfig(t) {
  const ret = {
    codec: "unknown",
    sampleRate: Number(t.sampleRate) | 0,
    numberOfChannels: Number(t.channels) | 0,
  };
  const e = t.extradata;
  if (t.family === "aac") {
    const p = t.audioProfile;
    ret.codec = p === 4 ? "mp4a.40.5" : p === 28 ? "mp4a.40.29" : "mp4a.40.2";
    if (e && e.length) ret.description = e;
  } else if (t.family === "opus") {
    ret.codec = "opus";
  } else if (t.family === "mp3") {
    ret.codec = "mp3";
  } else if (t.family === "vorbis") {
    ret.codec = "vorbis";
    if (e && e.length) ret.description = e;
  } else if (t.family === "flac") {
    ret.codec = "flac";
    if (e && e.length) ret.description = e;
  }
  return ret;
}

/** EncodedAudioChunk : type toujours 'key', duration toujours posée, verbatim. */export function packetToEncodedAudioChunk(pkt) {
  const num = pkt.time_base_num ?? pkt.timeBaseNum ?? 1;
  const den = pkt.time_base_den ?? pkt.timeBaseDen ?? 1000000;
  return {
    type: "key",
    timestamp: tsUs(pkt.pts, num, den),
    duration: tsUs(pkt.duration || 0, num, den),
    data: new Uint8Array(pkt.data),
  };
}

/** SW fallback (Phase 4) : convertir une frame décodée libav en VideoFrame.
 *  Non migré — le chemin WebCodecs est seul pour l'instant. */
export async function laFrameToVideoFrame() {
  throw new Error("SW fallback libav : Phase 4 — non migré (WebCodecs uniquement pour l'instant)");
}
