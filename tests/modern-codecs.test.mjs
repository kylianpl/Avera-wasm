// tests/modern-codecs.test.mjs — VP9/AV1/Opus/Vorbis/FLAC (WebM/MKV/MP4).
// Fixtures figées (ffmpeg : testsrc2 640x360@25 + sinus 440Hz 48kHz stéréo, 3s) :
//   webm-vp9-vorbis.webm : VP9 + Vorbis
//   mkv-vp9-opus.mkv     : VP9 + Opus (pre-skip 312 @48k)
//   mkv-av1-opus.mkv     : AV1 (SVT) + Opus
//   mp4-av1-aac.mp4      : AV1 (av1C) + AAC
//   mp4-vp9-aac.mp4      : VP9 + AAC
//   mkv-avc-flac.mkv     : H264 + FLAC (STREAMINFO "fLaC")
// Comptes ffprobe : v75 + a143/a151/a151/a142/a142/a141.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, av_seek_frame,
  ff_copyout_codecpar, avcodec_get_name, AVFormatContext_duration, AV_TIME_BASE,
  AVMEDIA_TYPE_VIDEO, AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";
import { videoStreamToConfig, audioStreamToConfig } from "../packages/wc-bridge/src/bridge.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);

async function openFile(path, name = "test") {
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

describe("modern-codecs", () => {
  it("webm vp9+vorbis → 75v+143a, configs WebCodecs", async () => {
    const { session, streams } = await openFile(FIX("webm-vp9-vorbis.webm"), "t.webm");
    assert.equal(session.kind, "mkv");
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(v.codec_id), "vp9");
    assert.equal(avcodec_get_name(a.codec_id), "vorbis");
    const cv = await ff_copyout_codecpar(v.codecpar);
    assert.equal(cv.width, 640);
    assert.equal(cv.height, 360);
    const cfg = videoStreamToConfig(cv);
    assert.equal(cfg.codec, "vp09.00.10.08");
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.equal(ca.sample_rate, 48000);
    assert.equal(ca.channels, 2);
    assert.ok(ca.extradata.length > 100); // headers Vorbis
    const acfg = audioStreamToConfig(ca);
    assert.equal(acfg.codec, "vorbis");
    assert.ok(acfg.description && acfg.description.length === ca.extradata.length);
    const { v: vv, a: aa } = await readAll(session, v.index, a.index);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 143);
    assert.ok(vv[0].key);
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("mkv vp9+opus → 75v+151a, pre-skip parsé et shifté", async () => {
    const { session, streams } = await openFile(FIX("mkv-vp9-opus.mkv"), "t.mkv");
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(v.codec_id), "vp9");
    assert.equal(avcodec_get_name(a.codec_id), "opus");
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.equal(Buffer.from(ca.extradata.subarray(0, 8)).toString(), "OpusHead");
    const acfg = audioStreamToConfig(ca);
    assert.equal(acfg.codec, "opus");
    assert.equal(acfg.sampleRate, 48000);
    // Pre-skip OpusHead (312 @48k = 6.5ms) : paquet 1 shifté, paquet 0 à 0.
    const { v: vv, a: aa } = await readAll(session, v.index, a.index);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 151);
    assert.equal(aa[0].pts, 0);
    assert.ok(aa[1].pts < 20000000 && aa[1].pts > 0, `p1=${aa[1].pts}`);
    // Seek vidéo + audio continu.
    assert.equal(await av_seek_frame(session, v.index, 1500000000n, 0, 0), 0);
    const { v: v2, a: a2 } = await readAll(session, v.index, a.index);
    assert.ok(v2.length > 0 && v2[0].key);
    assert.ok(a2.length > 0);
    assert.equal(a2[a2.length - 1].pts, aa[aa.length - 1].pts);
  });

  it("mkv av1+opus → av1C MKV, 75v+151a", async () => {
    const { session, streams } = await openFile(FIX("mkv-av1-opus.mkv"), "t.mkv");
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(v.codec_id), "av1");
    assert.equal(avcodec_get_name(a.codec_id), "opus");
    const cv = await ff_copyout_codecpar(v.codecpar);
    // CodecPrivate MKV = record av1C (marker 0x81).
    assert.equal(cv.extradata.length, 18);
    assert.equal(cv.extradata[0] & 0x7f, 1);
    const cfg = videoStreamToConfig(cv);
    assert.ok(cfg.codec.startsWith("av01.0."), `codec=${cfg.codec}`);
    assert.ok(cfg.description && cfg.description.length === 18); // AV1 exige av1C
    const { v: vv, a: aa } = await readAll(session, v.index, a.index);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 151);
    assert.ok(vv[0].key);
  });

  it("mp4 av1+aac → av1C extrait, 75v+142a", async () => {
    const { session, streams } = await openFile(FIX("mp4-av1-aac.mp4"), "t.mp4");
    assert.equal(session.kind, "mp4");
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(v.codec_id), "av1");
    assert.equal(avcodec_get_name(a.codec_id), "aac");
    const cv = await ff_copyout_codecpar(v.codecpar);
    assert.equal(cv.extradata.length, 18);
    const cfg = videoStreamToConfig(cv);
    assert.ok(cfg.codec.startsWith("av01.0."), `codec=${cfg.codec}`);
    assert.ok(cfg.description && cfg.description.length === 18);
    const { v: vv, a: aa } = await readAll(session, v.index, a.index);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 142);
    assert.ok(vv[0].key);
    assert.equal(await av_seek_frame(session, v.index, 2000000000n, 0, 0), 0);
    const { v: v2 } = await readAll(session, v.index, a.index);
    assert.ok(v2.length > 0 && v2[0].key);
  });

  it("mp4 vp9+aac → 75v+142a, codec vp09", async () => {
    const { session, streams } = await openFile(FIX("mp4-vp9-aac.mp4"), "t.mp4");
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(v.codec_id), "vp9");
    assert.equal(avcodec_get_name(a.codec_id), "aac");
    const cv = await ff_copyout_codecpar(v.codecpar);
    const cfg = videoStreamToConfig(cv);
    // vpcC ffmpeg : level 0 (non spécifié) → défaut L10.
    assert.equal(cfg.codec, "vp09.00.10.08");
    const { v: vv, a: aa } = await readAll(session, v.index, a.index);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 142);
  });

  it("mkv avc+flac → 75v+141a, STREAMINFO transmise", async () => {
    const { session, streams } = await openFile(FIX("mkv-avc-flac.mkv"), "t.mkv");
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(v.codec_id), "h264");
    assert.equal(avcodec_get_name(a.codec_id), "flac");
    const ca = await ff_copyout_codecpar(a.codecpar);
    // "fLaC" + bloc STREAMINFO (34o) = description WebCodecs.
    assert.equal(Buffer.from(ca.extradata.subarray(0, 4)).toString(), "fLaC");
    assert.equal(ca.extradata.length, 42);
    const acfg = audioStreamToConfig(ca);
    assert.equal(acfg.codec, "flac");
    assert.equal(acfg.description.length, 42);
    const { v: vv, a: aa } = await readAll(session, v.index, a.index);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 141);
  });
});
