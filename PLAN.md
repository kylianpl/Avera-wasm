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

### Container AVI — FAIT (suite 46/46 ✔, dont 11 AVI + restes v2 ✔)
- `packages/avi-demux` (maison-JS, 100% original) : RIFF AVI + segments
  OpenDML/AVIX chaînés (idx1 par segment, offsets relatifs à son movi ;
  fixture synthétique 75v+126a parité ffprobe), hdrl (avih +
  strh/strf/strd/strn), movi (descente récursive incl. 'rec ', chunks
  ##dc/##db/##wb, pads, chunks vides sautés), idx1 (offsets vérifiés :
  base movi-type/payload/liste/fichier), sans idx1 : balayage séquentiel
  + seek réel (recul IDR sondé paresseux pour H264 — règle "chunk
  contient IDR", pas "1re NAL" : les IDR ffmpeg commencent par SPS/PPS).
- Vidéo : H264 Annex B → avcc (`annexbToAvcc` existant), avcC reconstruit
  des SPS/PPS in-band (strd-avcC accepté), pts=dts=ordinal (les vides
  consomment un tick, parité ffprobe : pts 0,80,120… + durée 3.04s ;
  pas de ctts en AVI → B-frames en ordre de décodage, fixture -bf 3
  parité ffprobe : 75v+126a, clés 0/25/50).
  XVID/DIVX → mp4v **décodé en SW** (voir ci-dessous), autres fourcc
  verbatim.
- Audio : MP3 découpé en frames (Xing/Info skippée comme mp3-demux ;
  gapless LAME : shift −delay clampé 0 + padding rogné, faux tags
  "LAME4.0UUU" ffmpeg rejetés), (E)AC-3 verbatim (1 chunk multi-frames
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
  (pont), h264+aac RAW (WebCodecs, ASC 1190), h264+mp3 -bf 3 (B-frames),
  xvid+mp3 (SW mpeg4, 59fps), seeks delta 0 (y compris sans idx1 et
  trans-segments ODML), zéro warning.
- Limites v1 : sous-titres 'tx'.

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

### Container MP3 — FAIT (suite 46/46 ✔, dont 8 MP3 + gapless/unsync ✔)
- `packages/mp3-demux` (maison-JS, 100% original) : ID3v2 (y compris
  unsynchronisation : resync lookahead, 2 conventions de taille testées)
  + APEv2 de tête toléré, frames MPEG Layer I/II/III (MPEG 1/2/2.5),
  Xing/Info (durée exacte ; frame Info skippée comme ffprobe), ID3v1
  exclu, ouverture légère (tête seule).
- Index de frames EXACT et dense, étendu paresseusement par fenêtres :
  pts exacts après seek sans estimation (ni TOC ni proportionnel).
  Lookahead anti faux-sync, free-format refusé, gapless LAME : delay/
  padding du tag parsés (`parseLameTag`, faux "LAME4.0UUU" rejeté),
  shift PTS clampé 0 + durée exacte (réf `lame --decode` : 144000 éch),
  seek cohérent avec le shift.
- Routeur (sniff ID3/sync) + dispatch ; contrat inchangé. Audio-only
  vérifié navigateur (overlay "No Video", horloge audio, seek OK).
- Fixtures : mp3-cbr (ID3v2+Info), mp3-vbr (Xing+TOC) — 126 paquets
  chacun, parité ffprobe exacte.
- Bonus validé : `media/iceage-sample.mp4` réel (122s, 1280x694, AAC
  5.1) — 2931v/5731a exacts, open 33ms, seek 60s en 0ms, navigateur
  seek 61.2s delta -20ms @56fps. AVI reporté.

### Container MPEG-TS — FAIT (suite 70/70 ✔, dont 7 TS)
- `packages/ts-demux` (maison-JS, 100% original) : stride 188/192o
  (m2ts TP_extra_header, sync à +4), PAT/PMT (CRC32, sections
  réassemblées), PES réassemblés par PID, PTS/DTS 90kHz, PCR (durée),
  t0 normalisé sur le min (offset A/V préservé).
- Vidéo : H264/HEVC Annex B → avcc + avcC/hvcC in-band (SPS parsés :
  dims/profil/niveau ; header NAL sauté), clés IDR/IRAP (+rai) ;
  découpe en AUs sur AUD (par famille : le SEI H264 0x46 ressemble au
  AUD HEVC ; les start codes 4o se détectent 2× sans garde) ; MPEG-2
  passthrough (séquence→dims/fps, 1 paquet/image, clé=séquence).
- Audio : AAC-ADTS→RAW (+ASC), AC-3 (têtes bit-exactes jusqu'à lfeon) /
  E-AC-3 / MP3 / MP2 (layer réel : ffmpeg signale MP2 en type 0x03) /
  DTS (core BE) découpés, pts cumulés intra-PES ; 0x06 nu (AAC en m2ts
  ffmpeg) sniffé au 1er PES (pattern avi-demux), 0x84→eac3.
- Transfert : chaque paquet possède son buffer (frames AC-3 copiées —
  même bug qu'en AVI, assertion buffers-uniques en test).
- Seek : fraction bitrate + backtrack 2Mo (l'estimation peut tomber dans
  le PES clé cible) + avance à la clé PTS≥cible (approximatif, sans
  index) ; durée inconnue → reprise à 0. MPEG-2/DTS : démux OK, SW
  decode étape 6 (échec propre `non migré` asserté).
- Validé navigateur : h264+aac (188/192o), hevc (SW libde265), ac3/eac3
  (SW), seeks delta 0, zéro erreur transfert.
- Fixtures : ts-h264-aac/ac3/eac3 (75v+94/142a), ts-hevc-aac (75v+142a,
  IRAP), ts-mpeg2-mp2 (75v+125a, GOP 12), ts-h264-aac.m2ts (75v+142a) —
  parité ffprobe exacte.

### FLAC natif — FAIT (suite 75/75 ✔, dont 5 FLAC)
- `packages/flac-demux` (maison-JS, 100% original, miroir mp3-demux) :
  "fLaC" (+ ID3v2-préfixé tranché au routeur avant MP3), STREAMINFO en
  1er (requis), autres blocs sautés. Index de frames EXACT et dense,
  étendu paresseusement (fenêtres 1MiB : sync + CRC8 + continuité des
  n° frame/sample selon stratégie — même motif que mp3-demux) : pts
  exacts au sample après seek, sans estimation.
- Durée = total STREAMINFO (repli -1 si 0) ; dernière frame rognée au
  total (padding, motif gapless). WebCodecs direct (pas de SW) : blob
  "fLaC"+STREAMINFO 42o — flag "last" (0x10) PROSCRIT, Chromium rejette
  la description sinon ("Unsupported configuration", trouvé + vérifié
  en navigateur minimal, assertion en test).
- Fixtures : flac-mono/flac-stereo (141 paquets, 140×1024+640) — parité
  ffprobe exacte, seeks exacts + continuité, buffers uniques.
- Validé navigateur : mono + stéréo jouent (horloge audio, seek delta 0,
  zéro erreur).

### SW MPEG-2 vidéo + DTS — FAIT (suite 82/82 ✔, dont 3 MPEG-2 + 4 DTS)
- `packages/sw-decode/vendor/mpeg2/` : build decode-only `mpeg2video`
  FFmpeg 8.1.2 (487 Ko, même recette ; pas de désentrelacement v1,
  fixtures `-bf 0` comme mp4v). `MPEG2Session` (forme `MP4VSession`).
  Démux TS : 1er morceau PES part de 0 (séquence/GOP absorbées — sans
  le sequence header : "Invalid frame dimensions", vu en test ; pas de
  paquet header-only : `pics[0] = 0`, parité 75 conservée).
- `packages/sw-decode/vendor/dca/` : build decode-only `dca` (820 Ko).
  `DCASession` (forme `EAC3Session`, max 2048 éch./frame). Pont accepte
  FLTP + S32P (le DTS-HD MA sort en s32p 24 bits — trouvé via MKV E2E).
  WASM 8.1.2 vs natif 9.0.1 : RMS à 1e-5 près (float LSB inter-versions).
- Fixtures : ts-mpeg2-mp2.ts (75v+125a, SW 75/75 bit-exact MD5 natif +
  reprise post-flush), dts-core-4ch.dts (8 frames core extraites de
  samples.ffmpeg.org 3-1.dts : RMS natifs + déterminisme strict +
  reprise flush), mkv-avc-dts.mkv (75v+281a DTS-HD MA, E2E SW s32p).
- Validé navigateur : ts-mpeg2 (SW vidéo + MP2-via-"mp3", seek OK),
  mkv DTS-HD MA 4ch (SW audio, seek delta 0, zéro erreur).

### SW TrueHD — FAIT (suite 86/86 ✔, dont 4 TrueHD)- `packages/sw-decode/vendor/truehd/` : build decode-only `truehd`
  FFmpeg 8.1.2 (355 Ko, même recette). `TRUEHDSession` (forme
  `DCASession`, units 40 éch. @48kHz). Pont accepte FLTP + S32P + S32
  packé (le MLP sort en S32 — trouvé par instrumentation du format,
  -102 = AV_SAMPLE_FMT_S32).
- Démux MKV : `A_TRUEHD` → (truehd, 86060). Le décodeur exige le major
  sync (0xF8726FBA, toutes les 16 units ≈ 13 ms : comme une keyframe —
  un saut direct sur unit mineure ne sort rien ; reprise post-seek ≤
  13 ms de silence, tests en séquentiel + flush-reprise exacts).
- Fixtures : mka-truehd.mka (3s 6ch 48kHz stream-copée de
  jellyfish-140-mbps-4k-uhd-hevc-10bit.mkv — le cas `codec_0` 6 voies
  qui a motivé le support : 3599 paquets parité ffprobe, RMS natifs).
- Validé navigateur : .mka (horloge audio, seek delta 0) + jellyfish
  4K complet (HEVC SW + TrueHD SW : joue, drops sous charge CPU —
  attendu en double-SW 4K/140 Mbps).

### PCM : BitDepth, big-endian, flottants + matrice (suite 89/89 ✔)
Motivé par `/nightmare2.mkv` (fichier torture : h264 1080p + 61 pistes
audio — PCM LE/BE 8→32 bits et flottants, MS/ACM, AAC/AC3/EAC3,
MP2/MP3, Vorbis, Opus, FLAC, ALAC, TTA, WavPack, DTS, TrueHD, MLP).
Trouvé : `BitDepth` MKV (0x6264) n'était pas parsé → bits=0 → TOUT le
PCM MKV refusé par le pont ("profondeur inconnue"). Corrigé + pont
étendu : A_PCM/INT/BIG (BE 16/24/32, corruption silencieuse sinon),
A_PCM/FLOAT/IEEE = flottant LE (vérifié), A_MLP → truehd (même
décodeur ; le MLP exotique du fichier exige FFmpeg > 8.1.2 — échec
propre avec le message FFmpeg, écart de version documenté).
- Vérifié : les 31 pistes PCM du fichier décodent bit-exact (diff 0.0)
  vs natif ; les autres codecs supportés jouent (aac→truehd).
- Fixture commitée : mkv-pcm-matrix.mkv (9 variantes, 1s) +
  tests/pcm-matrix.test.mjs (bits/BE/flottant + sinus 440Hz > 0.9999,
  0.99 en u8 — bruit de quantification ; codec id 0 → échec propre).
- Non supportés (niches, `codec_0` + échec propre) : MS/ACM (Windows),
  ALAC, TTA, WavPack.
- Validé navigateur : matrice (9 pistes listées, lecture + seek OK) +
  nightmare2 complet (vidéo + audio par défaut jusqu'au bout 00:05,
  zéro erreur).

### Sous-titres texte — FAIT (suite 98/98 ✔, dont 4 sub-decode + 5 sub-demux)
- `packages/sub-decode` (maison-JS, pur) : SRT verbatim (+tags), ASS
  (`ReadOrder,…,Text`, timing du Block ; overrides `{…}` retirés,
  `\N`→`\n`), tx3g (u16BE + texte, vide = effacement, tronqué ignoré) ;
  jamais de HTML côté parse (échappement UI), styles/couleurs/positions
  ignorés v1. `packetToCue` (bornes ns, null si vide/durée nulle).
- Démux : MKV srt/ass déjà émis (vérifié) ; MP4 : pistes `text/sbtl/subt`
  acceptées + `tx3g` → (tx3g, 94213, movtext) — le garde SUB_FOURCC
  pré-existant renvoyait unknown (ombres : cas traité avant).
- Plomberie : RPC `subtitles` (scan complet sur session principale +
  save/restore readPos/curseurs MKV/MP4 — un design initial à 2e session
  a été abandonné au profit de cette version plus simple : un seul open,
  pas de cache dupliqué) ; decode worker décode en cues absolues (le
  seek n'a rien à refaire) ; UI : select (+Off) + overlay
  (pointer-events:none, échappé, `<br>`), sync RAF + immédiate au seek
  (même en pause).
- Transfert : paquets COPIÉS avant postMessage (vues du cache sinon :
  même buffer 2× = batch jeté — le bug qui a cassé l'ASS ; assertion
  buffers-uniques en test, même règle que l'A/V).
- Fixtures : mkv-sub-srt-ass.mkv (2+2 cues), mp4-sub-tx3g.mp4 (5
  échantillons dont vides, 2 cues — le vide final à durée 0 est masqué
  par ffprobe, documenté).
- Validé navigateur : SRT/ASS/tx3g affichés au bon temps, Off masque,
  zéro erreur.
- Limites v1 : `tx` AVI sauté, sous-titres TS/Télétexte/DVB et Kate
  droppés, pas de style ASS.
