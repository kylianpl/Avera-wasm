// tests/mp4-demux.test.mjs — démuxeur MP4 maison (progressif + fMP4).
// Fixtures figées (ffmpeg : testsrc2 640x360@25 + sinus 48kHz, 3s) :
//   mp4-avc-aac.mp4   : h264+aac, moov-first (faststart)
//   mp4-moov-tail.mp4 : idem, moov-at-end
//   mp4-frag.mp4      : h264+aac fragmenté (empty_moov, 3 moofs)
//   mp4-hevc-eac3.mp4 : hevc+eac3 (fallback SW audio via MP4)
// Comptes ffprobe : 75v + 142a (aac) / 75v + 94a (eac3).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, av_seek_frame,
  ff_copyout_codecpar, avcodec_get_name, AVFormatContext_duration, AV_TIME_BASE,
  ff_init_decoder, ff_decode_multi, ff_free_decoder,
  AVMEDIA_TYPE_VIDEO, AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);

async function openFile(path) {
  const data = await readFile(path);
  const lib = new CompatLib();
  const name = "test.mp4";
  await lib.mkblockreaderdev(name, data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send(name, start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, name);
  return { lib, session, streams };
}

async function readAll(session, vIdx, aIdx) {
  const v = [], a = [];
  for (let i = 0; i < 400; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    assert.equal(res, 0);
    v.push(...(dict[vIdx] ?? []));
    a.push(...(dict[aIdx] ?? []));
  }
  return { v, a };
}

describe("mp4-demux", () => {
  it("open progressif → streams, codecpar, durée", async () => {
    const { session, streams } = await openFile(FIX("mp4-avc-aac.mp4"));
    assert.equal(session.kind, "mp4");
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.ok(v && a);
    assert.equal(avcodec_get_name(v.codec_id), "h264");
    assert.equal(avcodec_get_name(a.codec_id), "aac");
    const cp = await ff_copyout_codecpar(v.codecpar);
    assert.equal(cp.width, 640);
    assert.equal(cp.height, 360);
    assert.ok(cp.extradata.length > 0 && cp.extradata[0] === 1); // avcC
    assert.ok(cp.profile > 0 && cp.level > 0);
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.equal(ca.sample_rate, 48000);
    assert.equal(ca.channels, 2);
    assert.ok(ca.extradata.length >= 2 && ca.extradata[0] === 0x11); // ASC LC
    assert.equal(ca.audioProfile, 1);
    const dur = await AVFormatContext_duration(session);
    assert.ok(Math.abs(dur / AV_TIME_BASE - 3.0) < 0.2, `durée=${dur / AV_TIME_BASE}`);
  });

  it("read → 75v+142a, B-frames (dts croissants, pts non monotones), clés", async () => {
    const { session, streams } = await openFile(FIX("mp4-avc-aac.mp4"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const { v, a } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    assert.equal(a.length, 142);
    // Parité ffprobe : délai d'édition (elst media_time=1024 @12800Hz = 80ms).
    assert.equal(v[0].dts, -80000000);
    assert.equal(v[0].pts, 0);
    assert.ok(v[0].key);
    for (let i = 1; i < v.length; i++) assert.ok(v[i].dts >= v[i - 1].dts, "dts vidéo croissants");
    assert.ok(v.some((p) => !p.key), "B-frames présentes");
    assert.ok(!v.slice(1, 10).every((p, i, arr) => i === 0 || p.pts >= arr[i - 1].pts), "pts non monotones (réordonnancement)");
    const keys = v.filter((p) => p.key);
    assert.equal(keys.length, 3); // GOP 25 : k=0,25,50
    for (const p of [...v, ...a]) {
      assert.ok(p.data.length > 0 && p.size === p.data.length);
      assert.equal(p.time_base_den, 1000000000);
    }
    // EOF propre après épuisement.
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("seek 1.5s → keyframe 0.92s, reprise jusqu'à EOF (50v+71a)", async () => {
    const { session, streams } = await openFile(FIX("mp4-avc-aac.mp4"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    assert.equal(await av_seek_frame(session, vIdx, 1500000000n, 0, 0), 0);
    const { v, a } = await readAll(session, vIdx, aIdx);
    assert.ok(v.length > 0 && v[0].key, "reprise sur keyframe");
    assert.equal(v[0].dts, 920000000); // k=25 : (25*512-1024)/12800
    assert.ok(v[0].dts <= 1500000000);
    assert.equal(v.length, 50);
    assert.equal(a.length, 71);
    assert.equal(a[0].dts, 1493333333); // m=71 : (71*1024-1024)/48000, tronqué ns
  });

  it("moov-at-end → mêmes comptes", async () => {
    const { session, streams } = await openFile(FIX("mp4-moov-tail.mp4"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const { v, a } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    assert.equal(a.length, 142);
    assert.ok(v[0].key && v[0].dts === -80000000);
  });

  it("fMP4 → 75v+142a, clés par moof, seek inter-fragments", async () => {
    const { session, streams } = await openFile(FIX("mp4-frag.mp4"));
    assert.equal(session.kind, "mp4");
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const { v, a } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    assert.equal(a.length, 142);
    assert.ok(v[0].key && v[0].dts === 0);
    assert.equal(v.filter((p) => p.key).length, 3);
    for (let i = 1; i < v.length; i++) assert.ok(v[i].dts >= v[i - 1].dts);
    // Seek au milieu du 2e fragment (~1.2s) → keyframe ≤ cible, reprise.
    assert.equal(await av_seek_frame(session, vIdx, 1200000000n, 0, 0), 0);
    const r2 = await readAll(session, vIdx, aIdx);
    assert.ok(r2.v.length > 0 && r2.v[0].key && r2.v[0].dts <= 1200000000);
    assert.ok(r2.v.length + (75 - r2.v.length) === 75);
  });

  it("mp4 hevc+eac3 → streams SW + 94 frames PCM via ff_decode_multi", async () => {
    const { session, streams } = await openFile(FIX("mp4-hevc-eac3.mp4"));
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(v.codec_id), "hevc");
    assert.equal(avcodec_get_name(a.codec_id), "eac3");
    const cp = await ff_copyout_codecpar(v.codecpar);
    assert.ok(cp.extradata.length > 0 && cp.extradata[0] === 1); // hvcC
    const [, ctx] = await ff_init_decoder(a.codec_id, a.codecpar);
    try {
      let frames = 0, samples = 0;
      for (let i = 0; i < 400; i++) {
        const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
        if (res === AVERROR_EOF) break;
        const out = await ff_decode_multi(ctx, {}, {}, dict[a.index] ?? []);
        for (const f of out) {
          assert.equal(f.nb_samples, 1536);
          frames++;
          samples += f.nb_samples;
        }
      }
      assert.equal(frames, 94);
      assert.equal(samples, 94 * 1536);
    } finally {
      await ff_free_decoder(ctx);
    }
  });
});
