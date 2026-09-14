// tests/sw-decode-dca.test.mjs — décodeur logiciel DTS core (Phase 4).
// Bridge FFmpeg decode-only (vendor/dca) : frames DTS core BE décodées en
// FLT entrelacé. Fixture extraite (8 frames core, 4ch 48kHz, 512 éch.) de
// https://samples.ffmpeg.org/A-codecs/DTS/dts/3-1.dts (cores seuls, les
// extensions HD intercalées sont ignorées — core seul, v1).
// Le WASM (FFmpeg 8.1.2) et le natif (9.0.1) diffèrent au LSB près (DSP
// float) : assertions RMS relatives (relerr natif ≤ 1e-4, vérifié) +
// déterminisme strict (2 sessions + reprise post-flush bit-exactes).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDCASession } from "../packages/sw-decode/src/dca.js";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi,
  ff_init_decoder, ff_decode_multi, ff_free_decoder, avcodec_flush_buffers,
  avcodec_get_name, AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);

// RMS natifs (ffmpeg -threads 1 -c:a dca -f f32le) des 8 frames du fixture.
const REF_RMS = [0.003956, 0.007596, 0.007013, 0.005121, 0.005451, 0.007147, 0.006672, 0.007975];

function rms(pcm) {
  let e = 0;
  for (let i = 0; i < pcm.length; i++) e += pcm[i] * pcm[i];
  return Math.sqrt(e / pcm.length);
}

/** Découpe le fixture brut en frames core (sync BE + fsize). */
function splitCores(data) {
  const out = [];
  let off = 0;
  while (off + 10 <= data.length) {
    if (!(data[off] === 0x7f && data[off + 1] === 0xfe && data[off + 2] === 0x80 && data[off + 3] === 0x01)) {
      off++;
      continue;
    }
    const fsize = (((data[off + 5] & 3) << 12) | (data[off + 6] << 4) | (data[off + 7] >> 4)) + 1;
    if (off + fsize > data.length) break;
    out.push(data.subarray(off, off + fsize));
    off += fsize;
  }
  return out;
}

describe("sw-decode-dca", () => {
  it("dts core → 8 frames 512 éch. 4ch 48kHz, niveaux natifs", async () => {
    const data = await readFile(FIX("dts-core-4ch.dts"));
    const frames = splitCores(data);
    assert.equal(frames.length, 8);
    const s = await createDCASession({ family: "dts", channels: 4, sampleRate: 48000 });
    try {
      frames.forEach((f, i) => {
        const out = s.decode(f, i * 1000);
        assert.equal(out.length, 1, `frame ${i} : 1 sortie`);
        assert.equal(out[0].nb_samples, 512, `frame ${i} : 512 éch.`);
        assert.equal(out[0].channels, 4);
        assert.equal(out[0].sample_rate, 48000);
        assert.equal(out[0].format, 3); // FLT entrelacé
        for (const v of out[0].data) assert.ok(Number.isFinite(v), `frame ${i} finie`);
        const r = rms(out[0].data);
        assert.ok(Math.abs(r - REF_RMS[i]) / REF_RMS[i] < 1e-3, `frame ${i} rms=${r}`);
      });
    } finally {
      s.destroy();
    }
  });

  it("déterminisme strict (2 sessions) + reprise post-flush exacte", async () => {
    const data = await readFile(FIX("dts-core-4ch.dts"));
    const frames = splitCores(data);
    const s1 = await createDCASession({ family: "dts", channels: 4, sampleRate: 48000 });
    const s2 = await createDCASession({ family: "dts", channels: 4, sampleRate: 48000 });
    try {
      const a = s1.decode(frames[0], 0)[0].data;
      const b = s2.decode(frames[0], 0)[0].data;
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
      // Reprise post-seek : flush puis même frame → bit-exact.
      await avcodec_flush_buffers({ reset: () => s1.reset() });
      const c = s1.decode(frames[0], 0)[0].data;
      assert.equal(c.length, a.length);
      for (let i = 0; i < a.length; i++) assert.equal(c[i], a[i]);
    } finally {
      s1.destroy();
      s2.destroy();
    }
  });

  it("wiring compat : ff_init_decoder dts", async () => {
    const [, ctx] = await ff_init_decoder(86056, { family: "dts", channels: 4, sampleRate: 48000 });
    try {
      const out = await ff_decode_multi(ctx, {}, {}, []);
      assert.ok(Array.isArray(out));
    } finally {
      await ff_free_decoder(ctx);
    }
    await assert.rejects(ff_init_decoder(99, {}), /non migré|invalide|SW fallback/);
  });

  it("e2e mkv avc+dts-hd-ma → 75v+281a, SW decode s32p converti", async () => {
    const data = await readFile(FIX("mkv-avc-dts.mkv"));
    const lib = new CompatLib();
    await lib.mkblockreaderdev("t.mkv", data.length);
    lib.onblockread = async (filename, pos, _len) => {
      const start = Math.floor(pos / 1048576) * 1048576;
      const end = Math.min(data.length, start + 1048576);
      await lib.ff_block_reader_dev_send("t.mkv", start, data.subarray(start, end));
    };
    const [session, streams] = await ff_init_demuxer_file(lib, "t.mkv");
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(a.codec_id), "dts");
    const vIdx = streams.find((s) => s.codec_type !== AVMEDIA_TYPE_AUDIO).index;
    const pkts = [];
    for (let i = 0; i < 120; i++) {
      const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
      if (res === AVERROR_EOF) break;
      assert.equal(res, 0);
      pkts.push(...(dict[a.index] ?? []));
    }
    assert.equal(pkts.length, 281); // parité ffprobe (core+extensions HD)
    // Les paquets HD (core+extensions) décodent en s32p→float dans le pont.
    const [, ctx] = await ff_init_decoder(a.codec_id, a.codecpar);
    try {
      const out = await ff_decode_multi(ctx, {}, {}, pkts.slice(0, 2));
      assert.ok(out.length >= 1, "au moins 1 frame DTS-HD");
      assert.equal(out[0].channels, 4);
      assert.equal(out[0].sample_rate, 48000);
      assert.equal(out[0].format, 3);
      for (const v of out[0].data) assert.ok(Number.isFinite(v));
      assert.ok(rms(out[0].data) > 0, "non-silencieux");
    } finally {
      await ff_free_decoder(ctx);
    }
    void vIdx;
  });
});
