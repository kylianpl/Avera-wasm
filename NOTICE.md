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
