# vendor/mpeg2 — décodeur logiciel MPEG-1/2 vidéo (fallback vidéo Phase 4)

`mpeg2.mjs` (généré, versionné comme `eac3`/`mp4v`) = build WebAssembly
**decode-only** du décodeur natif `mpeg2video` de FFmpeg (`libavcodec` +
`libavutil`, **LGPL-2.1-or-later** — source :
https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz, non modifiée). Même
recette que `vendor/mp4v/BUILD.md` ; aucun code tiers repris, pont C
`bridge.c` original (adapté de mp4v : YUV planaire 8 bits → I420 dense).

Usage : MPEG-2 vidéo (DVD, TV, TS broadcast — ni WebCodecs ni libde265).
L'entrelacé n'est pas désentrelacé (champs recopiés tels quels, v1) ;
pas de réordonnancement B-frames côté session (fixtures `-bf 0`, même
limite documentée que mp4v/AVI).

## Reproduire le build

Prérequis : `emcc` (paquet Arch `emscripten`), `make`, `xz`.

```sh
mkdir -p /tmp/opencode/mpeg2build && cd /tmp/opencode/mpeg2build
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
    --enable-decoder=mpeg2video \
    --cc="emcc" \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-DNDEBUG -Oz -flto" \
    --extra-ldflags="-Oz -flto"

emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a

emcc /workspace/avera-wasm/packages/sw-decode/vendor/mpeg2/bridge.c \
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
    -s EXPORTED_RUNTIME_METHODS=cwrap,HEAPU8,HEAP32 \
    -s EXPORTED_FUNCTIONS=_malloc,_free,_mpeg2_create,_mpeg2_decode,_mpeg2_flush,_mpeg2_free \
    -Oz -flto \
    -o /workspace/avera-wasm/packages/sw-decode/vendor/mpeg2/mpeg2.mjs
```

Choix : pas d'encodeurs, pas de `-msimd128` (compatibilité maximale),
`ENVIRONMENT=node,worker` (decode worker + tests Node), `.mjs` ES module,
`SINGLE_FILE` (pas de fetch wasm → marche en worker ET en `file:`).

## Vérification

`node --test tests/sw-decode-mpeg2.test.mjs` : paquets MPEG-2 (TS 640x360,
progressif, `-bf 0`) → I420 comparé contre
`ffmpeg -threads 1 -c:v mpeg2video -f rawvideo` (même FFmpeg natif).
