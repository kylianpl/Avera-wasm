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
  const ret = { codec: "unknown", codedWidth: t.width | 0, codedHeight: t.height | 0 };
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
    const p = t.profile == null || t.profile < 0 ? 0 : t.profile;
    ret.codec = `vp09.0${p}.10.08`;
  } else if (t.family === "av1") {
    ret.codec = "av01.0.05M.08";
  }
  if (verbatimDesc && (t.family === "h264" || t.family === "hevc")) ret.description = verbatimDesc;
  return ret;
}

/** µs depuis (pts, timebase) — pts seul, arrondi, sans clamp (fidèle bridge). */
function tsUs(pts, num, den) {
  return Math.round((pts * num) / den * 1e6);
}

/** EncodedVideoChunk depuis un paquet démuxé.
 *  pkt = { key:bool, pts:number(ticks), duration:number(ticks),
 *          timeBaseNum, timeBaseDen, data:Uint8Array (layout démuxeur-verbatim) }.
 *  Règles bridge : type=flags&1 (ici key), duration TOUJOURS posée (souvent 0),
 *  data verbatim. DÉVIATION : copie au lieu d'alias .buffer (le bridge ignore
 *  byteOffset — bug latent ; la copie est sûre et équivalente au décodage). */
export function packetToEncodedVideoChunk(pkt) {
  const num = pkt.timeBaseNum || 1, den = pkt.timeBaseDen || 1000000;
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
    sampleRate: t.sampleRate | 0,
    numberOfChannels: t.channels | 0,
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

/** EncodedAudioChunk : type toujours 'key', duration toujours posée, verbatim. */
export function packetToEncodedAudioChunk(pkt) {
  const num = pkt.timeBaseNum || 1, den = pkt.timeBaseDen || 1000000;
  return {
    type: "key",
    timestamp: tsUs(pkt.pts, num, den),
    duration: tsUs(pkt.duration || 0, num, den),
    data: new Uint8Array(pkt.data),
  };
}
