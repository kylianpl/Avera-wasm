# NOTICE — attribution

`packages/wc-bridge/src/bridge.js` réimplémente la SÉMANTIQUE des helpers
`LibAVJSWebCodecs` du projet libav.js (https://github.com/Yahweasel/libav.js,
licence ISC — voir `upstream-libavjs-bridge` étudié en référence, jamais copié
verbatime ni embarqué) :
- `videoStreamToConfig` / `packetToEncodedVideoChunk`
- `audioStreamToConfig` / `packetToEncodedAudioChunk`

Règles reprises à l'identique : description = extradata verbatim SSI
`extradata[0] !== 0`, `duration` toujours posée, pas de `hardwareAcceleration`,
hex minuscule, Opus sans description, ASC brut pour AAC, timestamps pts-only
µs arrondis. Déviations volontaires documentées dans le code (copie data au
lieu d'alias `.buffer`).

`packages/sw-decode/vendor/libde265/` embarque `@yume-chan/libde265`
(https://github.com/yume-chan/libde265, Simon Chan) : build WebAssembly de
libde265 (http://www.libde265.org/, Joachim Bauch et al.) — licence
**LGPL-3.0** (voir `vendor/libde265/README.md`). Utilisé comme décodeur
logiciel de secours HEVC/H.265 (Phase 4) quand WebCodecs n'accepte pas le
codec. Le wrapper `packages/sw-decode/src/index.js` est original (MIT/ISC du
repo) : chargement du module (via `instantiateWasm`, pas de XHR), découpage
NAL length-prefixed → Annex B, extraction VPS/SPS/PPS du hvcC, remappage des
images libde265 vers des frames I420 au format libav, et réordonnancement de
présentation (libde265 sort les B-frames en ordre de décodage).

`packages/sw-decode/vendor/eac3/` contient `eac3.mjs`, build WebAssembly
**decode-only** des décodeurs natifs `ac3` + `eac3` de FFmpeg 8.1.2
(`libavcodec` + `libavutil`, **LGPL-2.1-or-later** — source :
https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz, non modifiée).
Seule la *recette de compilation* (`--disable-everything` +
`--enable-decoder=ac3/eac3`, documentée dans `vendor/eac3/BUILD.md`)
s'inspire de celle publiée par mediabunny `@mediabunny/ac3` (MPL-2.0) —
aucun de leur code n'est repris (glue + framework refusés : couplage
trop lourd). Le pont C `bridge.c` et le wrapper `src/eac3.js` sont
originaux : `eac3_create/decode/flush/free`, sortie float entrelacée,
DRC désactivée (`drc_scale=0` : plein niveau, bit-exact après flush).
Utilisé comme décodeur logiciel de secours AC-3/E-AC-3 (WebCodecs ne les
expose pas) ; AC-3 inclus gratis (même famille de décodeurs).

`packages/sw-decode/vendor/mp4v/` contient `mp4v.mjs`, build WebAssembly
**decode-only** des décodeurs natifs `mpeg4` + `h263` + `msmpeg4v1/v2/v3` +
`mjpeg` de FFmpeg 8.1.2 (`libavcodec` + `libavutil`,
**LGPL-2.1-or-later** — source :
https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz, non modifiée).
Même recette que `vendor/eac3` (voir `vendor/mp4v/BUILD.md`) ; pont C
`bridge.c` original (slots, I420 dense, rééchantillonnage 422/444→420).
Utilisé comme décodeur logiciel de secours MPEG-4 ASP (XVID/DIVX),
H.263, DivX 3 et MJPEG — jamais exposés par WebCodecs.
