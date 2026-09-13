# vendor/mp4v — décodeur logiciel MPEG-4 ASP et cousins (fallback vidéo Phase 4)

`mp4v.mjs` (généré, versionné comme `libde265`/`eac3`) = build WebAssembly
**decode-only** des décodeurs natifs `mpeg4` + `h263` + `msmpeg4v1/v2/v3` +
`mjpeg` de FFmpeg (`libavcodec` + `libavutil`, **LGPL-2.1-or-later** —
source : https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz, non modifiée).
Même recette que `vendor/eac3/BUILD.md` (dont on reprend la méthode,
documentée aussi par mediabunny `@mediabunny/ac3`), étendue à ces
décodeurs vidéo ; aucun code tiers repris, pont C `bridge.c` original.

Usage : XVID/DIVX (MPEG-4 ASP, ni WebCodecs ni libde265), H.263,
DivX 3 (MSMPEG4v3 — le décodeur FFmpeg s'enregistre sous le nom `msmpeg4`,
particularité gérée dans `compat.js`), MJPEG (yuvj 420/422/444 → I420).
Les B-frames MPEG-4 ne sont pas réordonnées (pas de ctts en AVI ;
fixtures `-bf 0`, même limite documentée que le démuxeur AVI).

## Reproduire le build

Prérequis : `emcc` (paquet Arch `emscripten`), `make`, `xz`.

```sh
mkdir -p /tmp/opencode/mp4vbuild && cd /tmp/opencode/mp4vbuild
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
    --enable-decoder=mpeg4 \
    --enable-decoder=h263 \
    --enable-decoder=msmpeg4v1 \
    --enable-decoder=msmpeg4v2 \
    --enable-decoder=msmpeg4v3 \
    --enable-decoder=mjpeg \
    --cc="emcc" \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-DNDEBUG -Oz -flto" \
    --extra-ldflags="-Oz -flto"

emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a

emcc /workspace/avera-wasm/packages/sw-decode/vendor/mp4v/bridge.c \
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
    -s EXPORTED_FUNCTIONS=_malloc,_free,_mp4v_create,_mp4v_decode,_mp4v_flush,_mp4v_free \
    -Oz -flto \
    -o /workspace/avera-wasm/packages/sw-decode/vendor/mp4v/mp4v.mjs
```

Choix : pas d'encodeurs, pas de `-msimd128` (compatibilité maximale),
`ENVIRONMENT=node,worker` (decode worker + tests Node), `.mjs` ES module,
`SINGLE_FILE` (pas de fetch wasm → marche en worker ET en `file:`).

## Vérification

`node --test tests/sw-decode-mp4v.test.mjs` : paquets XVID/H263/MJPEG →
I420 comparé bit-à-bit (tolérance 0, sinon 1e-6) contre
`ffmpeg -threads 1 -c:v {mpeg4,h263,mjpeg} -f rawvideo` (même FFmpeg natif).
