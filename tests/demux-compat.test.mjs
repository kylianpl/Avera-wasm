// tests/demux-compat.test.mjs — couche compat D1-D10 sur vrais fichiers MKV.
// Simule le côté worker (onblockread → lectures fs directes).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, av_seek_frame,
  ff_copyout_codecpar, avcodec_get_name, AVFormatContext_duration, AV_TIME_BASE,
  AVMEDIA_TYPE_VIDEO, AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIXTURE = new URL("../../mpv-web/tests/fixtures/real-h264.mkv", import.meta.url);

// Driver minimal côté "worker" : répond onblockread par lectures fs.
async function openFile(path) {
  const data = await readFile(path);
  const lib = new CompatLib();
  const name = "test.mkv";
  await lib.mkblockreaderdev(name, data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send(name, start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, name);
  return { lib, session, streams };
}

describe("demux-compat", () => {
  it("open → streams vidéo+audio, codecpar, durée", async () => {
    const { session, streams } = await openFile(FIXTURE);
    assert.ok(streams.length >= 2);
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.ok(v && a);
    assert.equal(avcodec_get_name(v.codec_id), "h264");
    const cp = await ff_copyout_codecpar(v.codecpar);
    assert.ok(cp.width > 0 && cp.height > 0);
    assert.ok(cp.extradata.length > 0 && cp.extradata[0] === 1); // avcC
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.ok(ca.sample_rate > 0 && ca.channels > 0);
    const dur = await AVFormatContext_duration(session);
    assert.ok(dur / AV_TIME_BASE > 1);
  });

  it("read → paquets V/A, premier paquet vidéo = clé, EOF propre", async () => {
    const { session, streams } = await openFile(FIXTURE);
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    let v = 0, a = 0, firstKey = null, eof = false;
    for (let i = 0; i < 200 && !eof; i++) {
      const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
      if (res === AVERROR_EOF) { eof = true; break; }
      assert.equal(res, 0);
      for (const p of dict[vIdx] ?? []) {
        v++;
        if (firstKey === null) firstKey = p.key;
        assert.ok(p.pts >= 0 && p.data.length > 0);
        assert.equal(p.time_base_den, 1000000000);
      }
      for (const p of dict[aIdx] ?? []) {
        a++;
        assert.ok(p.data.length > 0);
      }
      if (!Object.keys(dict).length && res === 0) break;
    }
    assert.ok(eof, "EOF atteint");
    assert.ok(v >= 40 && a >= 40);
    assert.equal(firstKey, true);
  });

  it("seek → reprend près de la cible", async () => {
    const { session, streams } = await openFile(FIXTURE);
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const r = await av_seek_frame(session, vIdx, 1000000000n, 0, 1);
    assert.equal(r, 0);
    const [, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    const pkts = dict[vIdx] ?? [];
    assert.ok(pkts.length > 0);
    // Recalé sur keyframe ≤ cible (tolérance large : fixture 2s).
    assert.ok(pkts[0].pts <= 1000000000);
  });
});
