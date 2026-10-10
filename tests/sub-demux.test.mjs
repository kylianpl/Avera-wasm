// tests/sub-demux.test.mjs — sous-titres démuxés (MKV srt/ass, MP4 tx3g).
// Fixtures figées (ffmpeg : testsrc2 640x360@25 -bf 0 + sinus 48kHz, 5s) :
//   mkv-sub-srt-ass.mkv : 2 cues SRT (1-2.5s, 3-4s) + 2 cues ASS (idem)
//   mp4-sub-tx3g.mp4    : 2 cues mov_text (idem, + échantillons vides)
// Parité ffprobe : comptes paquets + textes (ffmpeg -f srt/ass).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi,
  ff_copyout_codecpar, avcodec_get_name,
  AVMEDIA_TYPE_VIDEO, AVMEDIA_TYPE_AUDIO, AVMEDIA_TYPE_SUBTITLE, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";
import { parseSrtPacket, parseAssPacket, parseTx3gSample, packetToCue } from "../packages/sub-decode/src/index.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);

const EXPECT_SRT = [
  { startNs: 1000000000, endNs: 2500000000, text: "Hello world" },
  { startNs: 3000000000, endNs: 4000000000, text: "Second line\nline two" },
];
const EXPECT_ASS = [
  { startNs: 1000000000, endNs: 2500000000, text: "Hello bold world\nsecond line" },
  { startNs: 3000000000, endNs: 4000000000, text: "Plain line" },
];

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

async function readSubs(session, sIdx) {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    assert.equal(res, 0);
    out.push(...(dict[sIdx] ?? []));
  }
  return out;
}

function cuesFor(family, pkts) {
  const parse = family === "srt" ? parseSrtPacket : family === "ass" ? parseAssPacket : parseTx3gSample;
  const cues = [];
  for (const p of pkts) {
    const c = packetToCue(p, parse(p.data));
    if (c) cues.push(c);
  }
  return cues;
}

describe("sub-demux", () => {
  it("mkv → pistes srt+ass listées, A/V intacts", async () => {
    const { streams } = await openFile(FIX("mkv-sub-srt-ass.mkv"), "t.mkv");
    assert.ok(streams.some((s) => s.codec_type === AVMEDIA_TYPE_VIDEO));
    assert.ok(streams.some((s) => s.codec_type === AVMEDIA_TYPE_AUDIO));
    const subs = streams.filter((s) => s.codec_type === AVMEDIA_TYPE_SUBTITLE);
    assert.equal(subs.length, 2);
    assert.equal(avcodec_get_name(subs[0].codec_id), "subrip");
    assert.equal(avcodec_get_name(subs[1].codec_id), "ass");
  });

  it("mkv srt → 2 paquets, cues exactes", async () => {
    const { session, streams } = await openFile(FIX("mkv-sub-srt-ass.mkv"), "t.mkv");
    const srt = streams.find((s) => avcodec_get_name(s.codec_id) === "subrip");
    const pkts = await readSubs(session, srt.index);
    assert.equal(pkts.length, 2); // parité ffprobe
    assert.deepEqual(cuesFor("srt", pkts), EXPECT_SRT);
  });

  it("mkv ass → 2 paquets, cues exactes (styles ignorés)", async () => {
    const { session, streams } = await openFile(FIX("mkv-sub-srt-ass.mkv"), "t.mkv");
    const ass = streams.find((s) => avcodec_get_name(s.codec_id) === "ass");
    const pkts = await readSubs(session, ass.index);
    assert.equal(pkts.length, 2); // parité ffprobe
    assert.deepEqual(cuesFor("ass", pkts), EXPECT_ASS);
  });

  it("mp4 tx3g → piste movtext, 5 échantillons (vides inclus), 2 cues", async () => {
    const { session, streams } = await openFile(FIX("mp4-sub-tx3g.mp4"), "t.mp4");
    assert.equal(session.kind, "mp4");
    const subs = streams.filter((s) => s.codec_type === AVMEDIA_TYPE_SUBTITLE);
    assert.equal(subs.length, 1);
    assert.equal(avcodec_get_name(subs[0].codec_id), "movtext");
    const pkts = await readSubs(session, subs[0].index);
    // 5 échantillons stbl (vide, cue, vide, cue, vide final à durée 0 que
    // ffprobe masque — il en compte 4 ; les cues décodées sont identiques).
    assert.equal(pkts.length, 5);
    assert.deepEqual(cuesFor("tx3g", pkts), EXPECT_SRT);
  });

  it("paquets sous-titres : buffers uniques (transfert inter-workers)", async () => {
    const { session, streams } = await openFile(FIX("mkv-sub-srt-ass.mkv"), "t.mkv");
    const srt = streams.find((s) => avcodec_get_name(s.codec_id) === "subrip");
    const bufs = new Set();
    for (const p of await readSubs(session, srt.index)) {
      assert.equal(p.size, p.data.length);
      assert.ok(!bufs.has(p.data.buffer), "buffer partagé entre paquets");
      bufs.add(p.data.buffer);
    }
    const cp = await ff_copyout_codecpar(srt.codecpar);
    assert.ok(cp);
  });
});
