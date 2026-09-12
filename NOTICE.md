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
