# vendor/dca — décodeur logiciel DTS (fallback audio Phase 4)

`dca.mjs` (généré, versionné comme `eac3`) = build WebAssembly
**decode-only** du décodeur natif `dca` (DTS core) de FFmpeg (`libavcodec` +
`libavutil`, **LGPL-2.1-or-later** — source :
https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz, non modifiée). Même
recette que `vendor/eac3/BUILD.md` ; aucun code tiers repris, pont C
`bridge.c` original (adapté d'eac3 : FLTP → entrelacé float32).

Usage : DTS core (Blu-ray, DVD, TS broadcast — ni WebCodecs ni MSE géré :
quand isConfigSupported échoue, worker.js bascule sur
setupFallbackAudioDecoder → ff_init_decoder(dts)). Extensions HD
(X96/XCH/XLL) ignorées (core seul, v1) ; sorties 512/1024/2048
échantillons/frame selon nblks.

## Reproduire le build

Prérequis : `emcc` (paquet Arch `emscripten`), `make`, `xz`.

```sh
mkdir -p /tmp/opencode/dcabuild && cd /tmp/opencode/dcabuild
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
    --enable-decoder=dca \
    --cc="emcc" \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-DNDEBUG -Oz -flto" \
    --extra-ldflags="-Oz -flto"

emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a

emcc /workspace/avera-wasm/packages/sw-decode/vendor/dca/bridge.c \
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
    -s EXPORTED_FUNCTIONS=_malloc,_free,_dca_create,_dca_decode,_dca_flush,_dca_free \
    -Oz -flto \
    -o /workspace/avera-wasm/packages/sw-decode/vendor/dca/dca.mjs
```

Choix : pas d'encodeurs, pas de `-msimd128` (compatibilité maximale),
`ENVIRONMENT=node,worker` (decode worker + tests Node), `.mjs` ES module,
`SINGLE_FILE` (pas de fetch wasm → marche en worker ET en `file:`).

## Vérification

`node --test tests/sw-decode-dca.test.mjs` : frames DTS core (4ch 48kHz,
512 éch., extraites de
https://samples.ffmpeg.org/A-codecs/DTS/dts/3-1.dts — voir le test)
décodées en FLT entrelacé, comparé bit-à-bit (±1e-6, float) contre
`ffmpeg -threads 1 -c:a dca -f f32le` (même FFmpeg natif).
