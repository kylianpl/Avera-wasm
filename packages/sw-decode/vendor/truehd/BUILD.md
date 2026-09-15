# vendor/truehd — décodeur logiciel TrueHD (fallback audio Phase 4)

`truehd.mjs` (généré, versionné comme `dca`) = build WebAssembly
**decode-only** du décodeur natif `truehd` de FFmpeg (`libavcodec` +
`libavutil`, **LGPL-2.1-or-later** — source :
https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz, non modifiée). Même
recette que `vendor/dca/BUILD.md` ; aucun code tiers repris, pont C
`bridge.c` original (adapté de dca : FLTP + S32P acceptés — le TrueHD
sort en s32p 24 bits, converti en float).

Usage : TrueHD/MLP (Blu-ray/UHD — ni WebCodecs ni MSE géré : quand
isConfigSupported échoue, worker.js bascule sur
setupFallbackAudioDecoder → ff_init_decoder(truehd)). Units de 40
échantillons typiques (@48kHz) ; extensions Atmos (objets) ignorées
(core 5.1/7.1 décodé, v1).

## Reproduire le build

Prérequis : `emcc` (paquet Arch `emscripten`), `make`, `xz`.

```sh
mkdir -p /tmp/opencode/truehdbuild && cd /tmp/opencode/truehdbuild
curl -sL -o ffmpeg.tar.xz https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
tar xf ffmpeg.tar.xz && cd ffmpeg-8.1.2

export PATH="/usr/lib/emscripten:$PATH"
emconfigure ./configure \
    --target-os=none \
    --arch=x86_32 \
    --enable-cross-compile \
    --disable-asm \
    --disable-x86asm \
    --disable-inline-asm \
    --disable-programs \
    --disable-doc \
    --disable-debug \
    --disable-all \
    --disable-everything \
    --disable-autodetect \
    --disable-pthreads \
    --disable-runtime-cpudetect \
    --disable-swresample \
    --disable-swscale \
    --disable-avformat \
    --disable-avfilter \
    --disable-avdevice \
    --enable-avcodec \
    --enable-decoder=truehd \
    --cc="emcc" \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-DNDEBUG -Oz -flto" \
    --extra-ldflags="-Oz -flto"

emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a

emcc /workspace/avera-wasm/packages/sw-decode/vendor/truehd/bridge.c \
    libavcodec/libavcodec.a libavutil/libavutil.a \
    -I. \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s SINGLE_FILE=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=node,worker \
    -s FILESYSTEM=0 \
    -s MALLOC=emmalloc \
    -s SUPPORT_LONGJMP=0 \
    -s EXPORTED_RUNTIME_METHODS=cwrap,HEAPU8,HEAPF32,HEAP32 \
    -s EXPORTED_FUNCTIONS=_malloc,_free,_truehd_create,_truehd_decode,_truehd_flush,_truehd_free \
    -Oz -flto \
    -o /workspace/avera-wasm/packages/sw-decode/vendor/truehd/truehd.mjs
```

Choix : pas d'encodeurs, pas de `-msimd128` (compatibilité maximale),
`ENVIRONMENT=node,worker` (decode worker + tests Node), `.mjs` ES module,
`SINGLE_FILE` (pas de fetch wasm → marche en worker ET en `file:`).

## Vérification

`node --test tests/sw-decode-truehd.test.mjs` : units TrueHD (6ch 48kHz,
40 éch., extraites par stream-copy de
`jellyfish-140-mbps-4k-uhd-hevc-10bit.mkv`, voir le test) décodées en FLT
entrelacé, niveaux comparés au natif
(`ffmpeg -threads 1 -c:a truehd -f f32le`, RMS à 1e-3 près — float LSB
inter-versions) + déterminisme strict (2 sessions + reprise post-flush).
