// tests/wav-demux.test.mjs — démuxeur WAV/RIFF maison (PCM + flottant).
// Fixtures figées (ffmpeg : sinus 440Hz 48kHz stéréo, 3s = 144000 frames) :
//   wav-pcm16.wav   : PCM s16le (144000 frames, paquets 4096 → 35×4096+640)
//   wav-float32.wav : PCM f32le
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, av_seek_frame,
  ff_copyout_codecpar, avcodec_get_name, AVFormatContext_duration, AV_TIME_BASE,
  ff_init_decoder, ff_decode_multi, ff_free_decoder,
  AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);
const SR = 48000, TOTAL = 144000;

async function openFile(path, name = "test.wav") {
  const data = await readFile(path);
  const lib = new CompatLib();
  await lib.mkblockreaderdev(name, data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send(name, start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, name);
  return { lib, session, streams };
}

async function readAll(session) {
  const out = [];
  for (let i = 0; i < 100; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    assert.equal(res, 0);
    out.push(...(dict[0] ?? []));
  }
  return out;
}

function correlation(pcm, ch, channels, freq, sr) {
  const n = Math.min(48000, Math.floor(pcm.length / channels));
  let num = 0, dg = 0, dr = 0;
  for (let k = 0; k < n; k++) {
    const g = pcm[k * channels + ch];
    const r = Math.sin((2 * Math.PI * freq * k) / sr);
    num += g * r; dg += g * g; dr += r * r;
  }
  return num / Math.sqrt(dg * dr);
}

describe("wav-demux", () => {
  it("open s16 → piste PCM, durée exacte 3.0s", async () => {
    const { session, streams } = await openFile(FIX("wav-pcm16.wav"));
    assert.equal(session.kind, "wav");
    assert.equal(streams.length, 1);
    const a = streams[0];
    assert.equal(a.codec_type, AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(a.codec_id), "pcm");
    const cp = await ff_copyout_codecpar(a.codecpar);
    assert.equal(cp.sample_rate, SR);
    assert.equal(cp.channels, 2);
    assert.equal(cp.bitsPerSample, 16);
    const dur = await AVFormatContext_duration(session);
    assert.equal(dur / AV_TIME_BASE, 3.0);
  });

  it("read s16 → 36 paquets, pts exacts au sample, EOF", async () => {
    const { session } = await openFile(FIX("wav-pcm16.wav"));
    const a = await readAll(session);
    // 144000 = 35×4096 + 640 (dernier paquet court).
    assert.equal(a.length, 36);
    assert.equal(a[0].pts, 0);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].pts, Math.floor((i * 4096 * 1000000000) / SR), `paquet ${i}`);
      assert.equal(a[i].size, a[i].data.length);
    }
    assert.equal(a[35].duration, Math.floor((640 * 1000000000) / SR));
    assert.ok(Math.abs(a[35].pts + a[35].duration - 3000000000) < 2); // arrondi ns
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("s16 → pont SW bit-exact (corrélation sinus ≈ 1)", async () => {
    const { session, streams } = await openFile(FIX("wav-pcm16.wav"));
    const [, ctx] = await ff_init_decoder(streams[0].codec_id, streams[0].codecpar);
    try {
      const a = await readAll(session);
      const out = await ff_decode_multi(ctx, {}, {}, a.slice(0, 4));
      assert.equal(out.length, 4);
      assert.equal(out[0].nb_samples, 4096);
      const pcm = new Float32Array(out.reduce((n, f) => n + f.data.length, 0));
      let o = 0;
      for (const f of out) { pcm.set(f.data, o); o += f.data.length; }
      assert.ok(correlation(pcm, 0, 2, 440, SR) > 0.9999, "voie 0");
      assert.ok(correlation(pcm, 1, 2, 440, SR) > 0.9999, "voie 1");
    } finally {
      await ff_free_decoder(ctx);
    }
  });

  it("float32 → lecture + seek exacts", async () => {
    const { session, streams } = await openFile(FIX("wav-float32.wav"));
    const cp = await ff_copyout_codecpar(streams[0].codecpar);
    assert.equal(cp.bitsPerSample, 32);
    assert.ok(cp.isFloat);
    const a = await readAll(session);
    assert.equal(a.length, 36);
    assert.ok(Math.abs(a[35].pts + a[35].duration - 3000000000) < 2);
    const [, ctx] = await ff_init_decoder(streams[0].codec_id, streams[0].codecpar);
    try {
      const out = await ff_decode_multi(ctx, {}, {}, a.slice(0, 2));
      assert.equal(out.length, 2);
      const pcm = new Float32Array(out.reduce((n, f) => n + f.data.length, 0));
      let o = 0;
      for (const f of out) { pcm.set(f.data, o); o += f.data.length; }
      assert.ok(correlation(pcm, 0, 2, 440, SR) > 0.9999);
    } finally {
      await ff_free_decoder(ctx);
    }
    assert.equal(await av_seek_frame(session, 0, 1500000000n, 0, 0), 0);
    const b = await readAll(session);
    assert.equal(b[0].pts, 1500000000);
    assert.ok(Math.abs(b[b.length - 1].pts + b[b.length - 1].duration - 3000000000) < 2);
  });

  it("seek 0 → reprise ; seek hors-fin → EOF", async () => {
    const { session } = await openFile(FIX("wav-pcm16.wav"));
    await readAll(session);
    assert.equal(await av_seek_frame(session, 0, 0n, 0, 0), 0);
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, 0);
    assert.equal(dict[0][0].pts, 0);
    assert.equal(await av_seek_frame(session, 0, 999000000000n, 0, 0), 0);
    const [res2] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res2, AVERROR_EOF);
  });
});
