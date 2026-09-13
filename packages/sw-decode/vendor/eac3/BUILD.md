# vendor/eac3 — décodeur logiciel AC-3/E-AC-3 (fallback audio Phase 4)

`eac3.mjs` (généré, versionné comme `libde265`) = build WebAssembly
**decode-only** des décodeurs natifs `ac3` + `eac3` de FFmpeg
(`libavcodec` + `libavutil`, **LGPL-2.1-or-later** — même famille que
`vendor/libde265`, voir NOTICE.md). Pont C : `bridge.c` (original, ISC).

Référence de la recette : mediabunny `@mediabunny/ac3` (build FFmpeg
`--disable-everything` + `--enable-decoder=ac3/eac3`, mêmes flags
`emconfigure`), dont on ne reprend que la *recette de compilation*
(documentée dans leur README), pas le code (leur glue + framework sont
MPL-2.0 et couplés à mediabunny — refusés ici).

## Reproduire le build

Prérequis : `emcc` (paquet Arch `emscripten`, testé 6.0.9), `make`, `xz`.

```sh
cd /tmp/opencode/eac3build
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
    --enable-decoder=ac3 \
    --enable-decoder=eac3 \
    --cc="emcc" \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-DNDEBUG -Oz -flto" \
    --extra-ldflags="-Oz -flto"

emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a

emcc /workspace/avera-wasm/packages/sw-decode/vendor/eac3/bridge.c \
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
    -s EXPORTED_FUNCTIONS=_malloc,_free,_eac3_create,_eac3_decode,_eac3_flush,_eac3_free \
    -Oz -flto \
    -o /workspace/avera-wasm/packages/sw-decode/vendor/eac3/eac3.mjs
```

Choix vs la recette mediabunny : pas d'encodeurs, pas de `-msimd128`
(compatibilité maximale ; le décodage (E)AC-3 reste très largement
temps-réel sans SIMD), `ENVIRONMENT=node,worker` (decode worker +
tests Node), sortie `.mjs` ES module (le repo n'a pas de
`package.json`, `.js` serait ambigu CJS/ESM sous Node), `SINGLE_FILE`
(pas de fetch wasm → marche en worker ET en `file:` pour les tests).

## Vérification

`node --test tests/sw-decode-eac3.test.mjs` : paquets (E)AC-3 → PCM
float comparé bit-à-bit (tolérance 1e-6) contre `ffmpeg -drc_scale 0
-c:a {ac3,eac3} -ac 2 -ar 48000 -f f32le` (référence native du même
FFmpeg — `-drc_scale 0` des deux côtés car le pont désactive la DRC :
sortie plein niveau et bit-exacte après flush+reprise).
