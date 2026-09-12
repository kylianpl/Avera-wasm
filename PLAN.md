# PLAN — avera-wasm : AVera sans libavjs, démux WASM maison

Base qui marche (validée beta) : shell AVera (worker monolithique + pump
`queueMicrotask` + renderers WebGPU/GL2/GL/2d + sync horloge audio).
Remplacement total de libavjs, en phases validables :

## Phase 1A — démux JS prouvé + bridge fidèle (EN COURS)
- `packages/mkv-demux/` : notre démux EBML/MKV (déjà validé byte-exact).
- `packages/demux-compat/` : classe `Demux` exposant l'interface libav
  utilisée par `app/worker.js` (D1–D10 : init/range-reader/streams/packets/
  seek/chapters/duration/consts), adossée à notre démux. `worker.js`
  ne change que ses imports/appels libav.
- `packages/wc-bridge/` : réimplémentation EXACTE de
  `LibAVJSWebCodecs.{video,audio}StreamToConfig`,
  `{packetToEncodedVideoChunk,packetToEncodedAudioChunk}` d'après le code
  public libav.js (NOTICE + attribution, licence ISC). Points critiques :
  description = extradata verbatim SSI `extradata[0]!==0`, `duration`
  toujours posée, pas de `hardwareAcceleration`, hex minuscule, Opus sans
  description, ASC brut pour AAC, timestamps pts-only µs arrondis.
- SW fallback (ff_* decode) : stub erreur claire (Phase 4).

## Phase 1B — packet-reading Rust WASM
- Étendre `mkv-demux-rs` (probe/tracks/chapters existent) : lecture
  clusters/blocs + seek Cues + API wasm-bindgen miroir de demux-compat.
- Swap sous la même interface (drop-in). Objectif : parité byte-exact
  avec 1A (test : mêmes packets pour le sample Ice Age).

## Phase 2 — validation beta (USER)
Samples Ice Age/Kaguya via page beta : lecture fluide + console perf.
Critère : parité AVera d'origine.

## Phase 3 — split des threads (APRÈS validation)
Demuxer / decoder / renderer workers séparés (cf. README AVera :
« splitting the monolithic Worker »).

## Phase 4 — fallback SW via sw-decode WASM
Brancher `crates/sw-decode` (H265/EAC3/…) comme fallback décodeur.
