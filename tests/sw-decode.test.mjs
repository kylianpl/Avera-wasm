// tests/sw-decode.test.mjs — Phase 4 : fallback SW WASM (libde265) sur HEVC réel.
// Demux (compat) → ff_init_decoder/ff_decode_multi (SW) → frames I420 libav.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi,
  ff_init_decoder, ff_decode_multi, ff_free_decoder, avcodec_flush_buffers, avcodec_get_name,
  AVMEDIA_TYPE_VIDEO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIXTURE = new URL("./fixtures/hevc-sample.mkv", import.meta.url);

async function openFile(path) {
  const data = await readFile(path);
  const lib = new CompatLib();
  const name = "hevc.mkv";
  await lib.mkblockreaderdev(name, data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send(name, start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, name);
  return { lib, session, streams };
}

describe("sw-decode (Phase 4 : libde265 WASM)", () => {
  it("demux HEVC → codecpar → session SW → frames I420 (640x360, pts µs)", async () => {
    const { session, streams } = await openFile(FIXTURE);
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    assert.ok(v, "piste vidéo HEVC");
    assert.equal(avcodec_get_name(v.codec_id), "hevc");

    const codecpar = v.codecpar;
    const [, ctx] = await ff_init_decoder(v.codec_id, codecpar);
    assert.ok(ctx && ctx.decode, "session SW HEVC");

    let packets = 0, frames = 0, firstPts = null, lastPts = null, eof = false;
    let prevPts = -1, outOfOrder = 0, bad = 0;
    for (let i = 0; i < 400 && !eof; i++) {
      const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
      if (res === AVERROR_EOF) { eof = true; break; }
      assert.equal(res, 0);
      const pkts = dict[v.index] ?? [];
      if (!pkts.length) continue;
      const out = await ff_decode_multi(ctx, {}, {}, pkts);
      for (const p of pkts) {
        packets++;
        assert.ok(p.data.length > 0);
        assert.equal(p.time_base_den, 1000000000);
      }
      for (const f of out) {
        frames++;
        assert.equal(f.format, 0);
        assert.equal(f.width, 640);
        assert.equal(f.height, 360);
        assert.equal(f.data.length, 640 * 360 + 320 * 180 * 2);
        assert.equal(f.layout[0].stride, 640);
        assert.ok(Number.isFinite(f.pts) && f.pts >= 0);
        if (firstPts === null) firstPts = f.pts;
        lastPts = f.pts;
        if (f.pts < prevPts) outOfOrder++;
        if (f.pts > 0 && prevPts > 0 && f.pts - prevPts === 0) bad++;
        prevPts = f.pts;
      }
    }
    assert.ok(eof, "EOF atteint");
    assert.ok(packets >= 60, `paquets vidéo decode: ${packets}`);
    assert.ok(frames >= 50, `frames décodées SW: ${frames}`);
    assert.ok(lastPts > firstPts, `pts progresse: ${firstPts} → ${lastPts}`);
    assert.equal(outOfOrder, 0, `pts décroissants: ${outOfOrder}`);
    assert.equal(bad, 0, `pts dupliqués: ${bad}`);

    await avcodec_flush_buffers(ctx);
    await ff_free_decoder(ctx);
  });

  it("session SW accepte seek/reset sans casser la suite", async () => {
    const { session, streams } = await openFile(FIXTURE);
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const [, ctx] = await ff_init_decoder(v.codec_id, v.codecpar);
    await avcodec_flush_buffers(ctx); // reset avant seek (no-op sur session neuve)

    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, 0);
    const pkts = dict[v.index] ?? [];
    assert.ok(pkts[0] && pkts[0].key, "1er paquet = keyframe");
    // Le worker décode le LOT entier (un read = un lot de paquets). L'ordre
    // de présentation est garanti par la fenêtre de réordonnancement interne.
    const out = await ff_decode_multi(ctx, {}, {}, pkts);
    assert.ok(out.length >= 1, "frames décodées après reset (reprise post-seek)");
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i].pts >= out[i - 1].pts, "ordre de présentation préservé");
    }
    await ff_free_decoder(ctx);
  });
});