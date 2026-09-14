# PLAN — avera-wasm : AVera sans libavjs, démux WASM maison

Base qui marche (validée beta) : shell AVera (worker monolithique + pump
`queueMicrotask` + renderers WebGPU/GL2/GL/2d + sync horloge audio).
Remplacement total de libavjs, en phases validables :

## Phase 1A — démux JS prouvé + bridge fidèle ✅
- `packages/mkv-demux/` : démux EBML/MKV JS (byte-exact, validé ffmpeg).
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
- SW fallback (ff_* decode) : stubs → Phase 4.

## Phase 1B — packet-reading Rust WASM ✅
- `crates/mkv-demux` étendu : clusters/blocs + lacing + BlockGroup +
  Cues via SeekHead exact + API wasm-bindgen miroir de demux-compat.
- Builds WASM : `packages/demux-wasm/web|nodejs/` (wasm-pack web+nodejs).
- Parité byte-exact avec 1A (test : mêmes packets pour le sample Ice Age).
- Swap sous la même interface (`?nowasm=1` force JS).

## Phase 2 — validation beta ✅
- Samples Ice Age (48kHz 5.1) / Kaguya (44.1kHz stéréo) via page beta :
  lecture fluide, console perf, A/V synchro.
- `?src=…` + serveur Range/206 + COOP/COEP.
- Fix Firefox #2054811 (VA-API H264 paddé) : `?sw=1/0`, auto FF Linux <157.

## Phase 3 — split des threads ✅
- **Slice 1** (`render-worker.js`) : serveur de dessin. Reçoit VideoFrames
  transférables, peint sur OffscreenCanvas via pickRenderer (WebGPU→WebGL2→
  WebGL→Canvas2D), boucle rAF propre, fermeture propre.
- **Slice 2** (`demux-worker.js`) : démux isolé, RPC (open/read/seek/close),
  I/O HTTP Range sérialisée (mutex à chaîne de promesses), paquets
  transférables. Generation pour invalider les réponses périmées.
- **Decode worker** (`worker.js`) : décode WebCodecs + sync horloge audio
  + file frames + pacing + décision présentation. Fencing `seekSerial`
  (époque) + `_priming` (prime audio/video pendant seek/start).
- Fixes validates : seeks rapides sans pause, switch audio, changement
  de source cross-rate (48kHz↔44.1kHz), prime audio au démarrage.

## Phase 4 — fallback SW via sw-decode WASM (EN COURS)
Brancher `packages/sw-decode` comme fallback décodeur logiciel pour les
codecs non supportés par WebCodecs (H265/HEVC, EAC3, AC3, etc.).

Objectif : quand `VideoDecoder.isConfigSupported` retourne `false`, le
décodeur logiciel WASM prend le relais de manière transparente.

### Vidéo HEVC/H.265 — FAIT (tests 9/9 ✔)
Backend retenu après probe npm : **`@yume-chan/libde265`** (libde265 WASM,
356 Ko, LGPL-3.0, ciblé decodeur pur — contrairement à `@hevcjs/core`
orienté transcode/MSE et à ffmpeg.wasm, trop gros). `eac3` et
`@flow-player/software-decoder-ffmpeg` non viables (deps git cassées).

`packages/sw-decode/src/index.js` (wrapper original) :
- Chargement du module via `instantiateWasm` injecté (pas de XHR → marche en
  worker ET en Node pour les tests).
- `packetNals` : détection Annex B / length-prefixed → NALs (réutilise
  `mkv-demux/src/annexb.js`).
- `extractHvcCParameterSets` : VPS/SPS/PPS hors-bande depuis le hvcC
  (ffmpeg regroupe les paramètres du 1er bloc dans un faux "NAL" VPS
  inutilisable → on les re-fournit explicitement, et après chaque `reset()`
  car libde265 les vide au reset : indispensable pour la reprise post-seek).
- `HEVCSession` : pushNal/AU + **réordonnancement de présentation** (libde265
  sort les B-frames en ordre de décodage → fenêtre de finalisation par pts,
  cohérent avec WebCodecs) ; frames I420 format 0 (10-bit → 8-bit via >>2).
- Branché dans `compat.js` (`ff_init_decoder`/`ff_decode_multi`/
  `ff_free_decoder`/`avcodec_flush_buffers`) : `worker.js` n'utilise que des
  wrappers RPC inchangés (forward d'args ajouté).

Sous-objectifs restants :
- `setupFallbackAudioDecoder` (fallback audio EAC3/AC3) — non migré.
- Tests parité vidéo : packets in → frames out vs ffmpeg (sample fiché
  `tests/fixtures/hevc-sample.mkv`, 640x360 x265 3s).
- Validation navigateur (Chromium headless) : `?sw=` + HEVC → lecture fluide.

### Audio (E)AC-3 — FAIT (tests 15/15 ✔)
`ac3go` (AGPL-3.0) et `@mediabunny/ac3` (MPL-2.0 + couplage framework +
worker dédié) refusés. Retenu : **build maison decode-only FFmpeg 8.1.2
(`ac3` + `eac3`, LGPL-2.1-or-later, 579 Ko SINGLE_FILE, emcc 6.0.9)** —
`packages/sw-decode/vendor/eac3/` (`bridge.c` + `BUILD.md` + `eac3.mjs`).
`EAC3Session` (`src/eac3.js`) : PCM float entrelacé compatible
`bufferAudioSamples` sans modif worker, `reset()` post-seek bit-exact
(reprise à froid déterministe, prouvé par test), DRC désactivée.
Branchée dans `compat.js` (`ff_init_decoder` 86019/86055). Validée
navigateur (MKV h264+eac3 : 94/94 paquets décodés, seek propre).

### Containers MP4 — FAIT (tests 21/21 ✔)
- `packages/mp4-demux` (maison-JS, 100% original) : moov-first + moov-at-end
  (balayage d'en-têtes range-reader) + **fMP4** (moof/traf), tables
  stts/ctts/stsc/stsz/stz2/stco/co64/stss, paquets en ordre de décodage
  avec vrais pts/dts (B-frames), extradata avcC/hvcC/esds→ASC/dac3/dec3,
  seek binaire sur dts + recul keyframe (vidéo), edit list mono-segment
  (parité ffprobe : premiers pts/dts négatifs tolérés par le worker).
- Routeur dans `ff_init_demuxer_file` (sniff EBML vs ftyp) + dispatch
  read/seek par `session.kind` ; contrat paquets/streams inchangé.
- Fixtures : mp4-avc-aac, mp4-moov-tail, mp4-frag (3 moofs), mp4-hevc-eac3
  (exerce les deux fallbacks SW à la fois).
- Validé navigateur : AVC/AAC (WebCodecs), HEVC+EAC3 (double SW),
  fMP4 — seeks delta 0, aucun warning.

### Container AVI — FAIT (tests 34/34 ✔)
- `packages/avi-demux` (maison-JS, 100% original) : RIFF unique (AVIX
  refusé explicitement), hdrl (avih + strh/strf/strd/strn), movi
  (descente récursive incl. 'rec ', chunks ##dc/##db/##wb, pads, chunks
  vides sautés), idx1 (offsets vérifiés : base movi-type/payload/liste/
  fichier), sans idx1 : balayage séquentiel (lecture OK, seek → reprise
  à 0 documentée).
- Vidéo : H264 Annex B → avcc (`annexbToAvcc` existant), avcC reconstruit
  des SPS/PPS in-band (strd-avcC accepté), pts=dts=ordinal (les vides
  consomment un tick, parité ffprobe : pts 0,80,120… + durée 3.04s ;
  pas de ctts en AVI → fixtures -bf 0 ; B-frames non présentables).
  XVID/DIVX → mp4v **décodé en SW** (voir ci-dessous), autres fourcc
  verbatim.
- Audio : MP3 découpé en frames, (E)AC-3 verbatim (1 chunk multi-frames
  OK), PCM verbatim, AAC RAW ffmpeg (1 chunk = 1 frame 1024 éch, filler
  "Lavc" skippé) ou ADTS découpé si sync détectée (+ASC strf ou synthétisé
  LC) ; pts cumulés exacts (pas d'estimation), tags 0xFFFE/inconnus sniffés.
- `sw-decode` : `ac3frames.js` (splitter déménagé des tests + numblks
  E-AC-3 d'après ac3_parser.c FFmpeg), `pcm.js` (pont s8/s16/s24/s32/
  f32/f64 → FLT, bit-exact), `ff_init_decoder` route pcm (65536).
- Bug navigateur trouvé par l'AVI : `size: bytes` (objet partagé
  data/size → buffer dupliqué dans la transfer list → postMessage qui
  jette le batch) — corrigé + assertion buffers-uniques en test.
- Validé navigateur : h264+mp3 (WebCodecs), h264+ac3 (SW), h264+pcm
  (pont), h264+aac RAW (WebCodecs, ASC 1190), xvid+mp3 (SW mpeg4, 59fps),
  seeks delta 0, zéro warning.
- Limites v1 : OpenDML/AVIX, seek sans idx1, B-frames AVI, sous-titres
  'tx'.

### Vidéo MPEG-4 ASP et cousins — FAIT (tests 40/40 ✔)
Build maison decode-only FFmpeg 8.1.2 (`mpeg4` + `h263` + `msmpeg4v1/v2/v3`
+ `mjpeg`, LGPL-2.1-or-later, 779 Ko SINGLE_FILE) — `vendor/mp4v/`
(`bridge.c` + `BUILD.md` + `mp4v.mjs`). `MP4VSession` : I420 dense au
format libav (422/444→420 dans le pont, 400→gris+128). Pièges trouvés
par les tests : facteurs de sous-échantillonnage inversés (luma exacte,
chroma fausse), MSMPEG4 veut ses dimensions avant ouverture, le v3
s'enregistre `msmpeg4` (pas `msmpeg4v3`), le natif duplique une frame
(chunk vide → réf mappée i<2→i, i≥2→i+1). Références natives MD5
bit-exactes (xvid/h263/mjpeg420), moyennes + déterminisme (422/444),
reprise post-seek bit-exacte depuis clé. Branché dans `compat.js`
(`mp4v`→mpeg4, VFW-affiné, h263/msmpeg4/mjpeg) : XVID/DIVX/DivX3/H.263/
MJPEG jouables (MKV VFW et MP4-mp4v inclus gratis).

### Container MP3 — FAIT (tests 27/27 ✔)
- `packages/mp3-demux` (maison-JS, 100% original) : ID3v2 (sauf
  unsynchronisation) + APEv2 de tête toléré, frames MPEG Layer I/II/III
  (MPEG 1/2/2.5), Xing/Info (durée exacte ; frame Info skippée comme
  ffprobe), ID3v1 exclu, ouverture légère (tête seule).
- Index de frames EXACT et dense, étendu paresseusement par fenêtres :
  pts exacts après seek sans estimation (ni TOC ni proportionnel).
  Lookahead anti faux-sync, free-format refusé, gapless LAME ignoré
  (documenté, comme ffprobe : 1er pts = 0).
- Routeur (sniff ID3/sync) + dispatch ; contrat inchangé. Audio-only
  vérifié navigateur (overlay "No Video", horloge audio, seek OK).
- Fixtures : mp3-cbr (ID3v2+Info), mp3-vbr (Xing+TOC) — 126 paquets
  chacun, parité ffprobe exacte.
- Bonus validé : `media/iceage-sample.mp4` réel (122s, 1280x694, AAC
  5.1) — 2931v/5731a exacts, open 33ms, seek 60s en 0ms, navigateur
  seek 61.2s delta -20ms @56fps. AVI reporté.
