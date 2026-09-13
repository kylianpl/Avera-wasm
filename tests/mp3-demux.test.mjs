// tests/mp3-demux.test.mjs — démuxeur MP3 maison.
// Fixtures figées (ffmpeg libmp3lame, sinus 440Hz 48kHz stéréo, 3s) :
//   mp3-cbr.mp3 : CBR 128k + ID3v2 (titre) + frame Info (skippée, cf. ffprobe)
//   mp3-vbr.mp3 : VBR -q:a 4 + Xing + TOC
// Comptes ffprobe : 126 paquets chacun (1152 éch./frame, 1er pts = 0).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, av_seek_frame,
  ff_copyout_codecpar, avcodec_get_name, AVFormatContext_duration, AV_TIME_BASE,
  AVMEDIA_TYPE_VIDEO, AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);
const FRAME_NS = 24000000; // 1152 éch. @48kHz

async function openFile(path) {
  const data = await readFile(path);
  const lib = new CompatLib();
  const name = "test.mp3";
  await lib.mkblockreaderdev(name, data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send(name, start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, name);
  return { lib, session, streams };
}

async function readAll(session, aIdx) {
  const out = [];
  for (let i = 0; i < 50; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    assert.equal(res, 0);
    out.push(...(dict[aIdx] ?? []));
  }
  return out;
}

describe("mp3-demux", () => {
  it("open CBR → 1 piste audio, codecpar, durée 3.024s", async () => {
    const { session, streams } = await openFile(FIX("mp3-cbr.mp3"));
    assert.equal(session.kind, "mp3");
    assert.equal(streams.length, 1);
    assert.ok(!streams.some((s) => s.codec_type === AVMEDIA_TYPE_VIDEO));
    const a = streams[0];
    assert.equal(a.codec_type, AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(a.codec_id), "mp3");
    const cp = await ff_copyout_codecpar(a.codecpar);
    assert.equal(cp.sample_rate, 48000);
    assert.equal(cp.channels, 2);
    const dur = await AVFormatContext_duration(session);
    assert.ok(Math.abs(dur / AV_TIME_BASE - 3.024) < 0.05, `durée=${dur / AV_TIME_BASE}`);
  });

  it("read CBR → 126 paquets (parité ffprobe), pts 0..3.0s, frame Info skippée", async () => {
    const { session, streams } = await openFile(FIX("mp3-cbr.mp3"));
    // ID3v2 (80o) + frame Info (384o) sautées : 1er paquet à 464.
    assert.equal(session.mp3.index[0], 464n);
    const a = await readAll(session, 0);
    assert.equal(a.length, 126);
    assert.equal(a[0].pts, 0);
    assert.equal(a[0].dts, 0);
    assert.equal(a[0].duration, FRAME_NS);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].pts, i * FRAME_NS, `pts paquet ${i}`);
      assert.equal(a[i].dts, a[i].pts);
      assert.ok(a[i].key);
      assert.ok(a[i].data.length > 0 && a[i].size === a[i].data.length);
      assert.equal(a[i].time_base_den, 1000000000);
    }
    assert.equal(a[125].pts, 3000000000);
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("seek 1.5s CBR → frame 62 exacte, 64 paquets restants", async () => {
    const { session } = await openFile(FIX("mp3-cbr.mp3"));
    assert.equal(await av_seek_frame(session, 0, 1500000000n, 0, 0), 0);
    const a = await readAll(session, 0);
    assert.equal(a.length, 64);
    assert.equal(a[0].pts, 62 * FRAME_NS);
    for (let i = 1; i < a.length; i++) assert.equal(a[i].pts, a[0].pts + i * FRAME_NS);
  });

  it("VBR → 126 paquets, durée Xing, seek exact sans estimation", async () => {
    const { session, streams } = await openFile(FIX("mp3-vbr.mp3"));
    assert.equal(session.kind, "mp3");
    assert.ok(session.mp3.xing && session.mp3.xing.toc, "TOC Xing présente");
    const dur = await AVFormatContext_duration(session);
    assert.ok(Math.abs(dur / AV_TIME_BASE - 3.024) < 0.05);
    const a = await readAll(session, 0);
    assert.equal(a.length, 126);
    assert.equal(a[0].pts, 0);
    assert.equal(a[125].pts, 3000000000);
    assert.equal(streams.length, 1);
  });

  it("seek VBR (tailles variables) → pts exacts", async () => {
    const { session } = await openFile(FIX("mp3-vbr.mp3"));
    assert.equal(await av_seek_frame(session, 0, 2000000000n, 0, 0), 0);
    const a = await readAll(session, 0);
    const idx = Math.floor(2000000000 / FRAME_NS); // 83
    assert.equal(a[0].pts, idx * FRAME_NS);
    assert.equal(a.length, 126 - idx);
  });

  it("seek 0 → reprend au début ; seek hors-fin → EOF", async () => {
    const { session } = await openFile(FIX("mp3-cbr.mp3"));
    await readAll(session, 0);
    assert.equal(await av_seek_frame(session, 0, 0n, 0, 0), 0);
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, 0);
    assert.equal(dict[0][0].pts, 0);
    assert.equal(await av_seek_frame(session, 0, 999000000000n, 0, 0), 0);
    const [res2] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res2, AVERROR_EOF);
  });
});
