# tests/e2e — tests navigateurs réels (Chromium + Firefox)

Vérifications **de bout en bout**, au-delà des tests unitaires : un vrai
navigateur lit un vrai fichier, on enregistre ce qui est réellement affiché
et joué, puis on analyse l'enregistrement.

## Ce qui est vérifié

| Scénario | Fixture | Contrôles |
|---|---|---|
| `sync` | `av-sync-10s.mkv` (flashs blancs + beeps à 1/4/7 s) | flashs réellement affichés, période 3 s, audio non silencieux, beeps 3 s, **décalage A/V dans l'enregistrement** (< 120 ms), dérive interne |
| `playback` | `media/beta-60s.mkv` | frames dessinées, taux d'unicité (pas d'image figée), freeze > 500 ms, frames décodées affichées (≥ 85 %), **seek** effectif + reprise |
| `hdr` | `mkv-hevc-hdr10-pq.mkv` (PQ 100/1000 nits) | tone mapping actif, valeurs SDR attendues (~204/253) |
| `subs` | `mkv-sub-srt-ass.mkv` | pistes listées, cue SRT/ASS affichée après seek |
| `sw` | `hevc-sample.mkv` | décodage logiciel libde265, image visible et contrastée |

## Comment ça marche

- **Enregistrement** : le mode `?capture=1` fait renvoyer par le
  render-worker un `ImageBitmap` du canvas (~25 fps) ; le thread principal
  le recopie dans un canvas enregistrable. Un tap audio (patch de
  `AudioNode.connect`) duplique la sortie vers un `MediaStreamDestination`.
  `MediaRecorder` enregistre **vidéo + audio ensemble** → la synchro A/V se
  mesure dans un seul fichier.
- **Analyse** : `ffprobe` donne les timestamps réels (l'enregistrement est
  VFR), `ffmpeg` décode en gris (luminance) et en f32 (audio) ; on détecte
  flashs et onsets puis on compare. Le tap audio étant pris à la sortie du
  graphe (sans la latence du périphérique), la comparaison **ajoute
  `outputLatency + baseLatency`** avant de juger : le lecteur, lui, cale la
  vidéo sur le son réellement entendu. Avec cette compensation, les écarts
  mesurés tombent à ~10-20 ms.
- **Stats du player** : les messages des workers (`statsReport`,
  `renderStats`, `avDrift`, `workerLagReport`) sont collectés dans la page et
  lus par le harnais.

## Lancer

```sh
# serveur (obligatoire) :
node server.mjs --port 8899

# Playwright (dev only) : soit installé localement, soit chemin explicite
export PLAYWRIGHT_CORE=/chemin/vers/playwright-core/index.mjs
node tests/e2e/run.mjs                       # les deux navigateurs
node tests/e2e/run.mjs --browser=chromium    # un seul
node tests/e2e/run.mjs --scenario=sync       # un scénario
node tests/e2e/run.mjs --outdir=/tmp/e2e     # enregistrements + report.json
```

Prérequis : Chromium système (`/usr/bin/chromium`, surchargeable via
`CHROMIUM=…`) et Firefox Playwright (`npx playwright-core install firefox`).
`media/beta-60s.mkv` n'est pas versionné (médias locaux) : le scénario
`playback` le signale et est ignoré s'il est absent.

## Limites connues

- **Firefox headless n'a pas de sortie audio** : `AudioContext.resume()`
  reste *pending*, le son n'est pas testable → les contrôles audio/A-V sont
  marqués `skip` (pas des échecs). Le reste (vidéo, seek, HDR, sous-titres,
  SW) est validé.
- Chromium headless rend en software (SwiftShader) : les fps sont plus bas
  qu'en conditions réelles.
- Le scénario `hdr` mesure des valeurs numériques (PQ 100/1000 nits) ; il ne
  remplace pas un écran HDR.
