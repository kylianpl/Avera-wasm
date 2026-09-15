// tests/sw-decode-truehd.test.mjs — décodeur logiciel TrueHD/MLP (Phase 4).
// Bridge FFmpeg decode-only (vendor/truehd) : units TrueHD décodées en FLT
// entrelacé. Fixture stream-copée (3s, 6ch 48kHz, 40 éch./unit) de
// https://kytech.fr/sample-video-files/jellyfish-140-mbps-4k-uhd-hevc-10bit.mkv
// (le cas `codec_0` 6 voies qui a motivé le support).
// Le WASM (FFmpeg 8.1.2) et le natif (9.0.1) diffèrent au LSB près (DSP
// float) : assertions RMS relatives (relerr natif ≤ 1e-4, vérifié) +
// déterminisme strict (2 sessions + reprise post-flush bit-exactes).
// E2E : démux MKV (3599 paquets, parité ffprobe) + seek + navigateur.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTRUEHDSession } from "../packages/sw-decode/src/truehd.js";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, av_seek_frame,
  ff_copyout_codecpar, ff_init_decoder, ff_decode_multi, ff_free_decoder,
  avcodec_flush_buffers, avcodec_get_name,
  AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);

// RMS natifs (ffmpeg -threads 1 -c:a truehd -f f32le) d'une sélection d'units.
const REF_RMS = { 0: 0.048084, 1: 0.056844, 100: 0.078515, 1000: 0.089717, 3598: 0.064915 };

function rms(pcm) {
  let e = 0;
  for (let i = 0; i < pcm.length; i++) e += pcm[i] * pcm[i];
  return Math.sqrt(e / pcm.length);
}

async function openMka() {
  const data = await readFile(FIX("mka-truehd.mka"));
  const lib = new CompatLib();
  await lib.mkblockreaderdev("t.mka", data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send("t.mka", start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, "t.mka");
  return { session, streams };
}

async function readAllAudio(session, aIdx) {
  const out = [];
  for (let i = 0; i < 120; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    assert.equal(res, 0);
    out.push(...(dict[aIdx] ?? []));
  }
  return out;
}

describe("sw-decode-truehd", () => {
  it("démux mka → 3599 paquets truehd 6ch 48kHz (parité ffprobe)", async () => {
    const { session, streams } = await openMka();
    assert.equal(session.kind, "mkv");
    assert.equal(streams.length, 1);
    const a = streams[0];
    assert.equal(a.codec_type, AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(a.codec_id), "truehd");
    const cp = await ff_copyout_codecpar(a.codecpar);
    assert.equal(cp.sample_rate, 48000);
    assert.equal(cp.channels, 6);
    const pkts = await readAllAudio(session, 0);
    assert.equal(pkts.length, 3599);
    assert.equal(pkts[0].pts, 0);
    for (let i = 1; i < pkts.length; i++) assert.ok(pkts[i].pts >= pkts[i - 1].pts);
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("decode → 40 éch./unit, niveaux natifs, seek continu", async () => {
    const { session, streams } = await openMka();
    const full = await readAllAudio(session, 0);
    // Décodage SÉQUENTIEL depuis 0 (le décodeur exige le major sync,
    // toutes les 16 units : comme une keyframe — un saut direct sur une
    // unit mineure ne sort rien jusqu'au prochain major sync).
    const s = await createTRUEHDSession({ family: "truehd", channels: 6, sampleRate: 48000 });
    const outs = [];
    try {
      let t = 0;
      for (const p of full) {
        const out = s.decode(p.data, t);
        assert.equal(out.length, 1);
        outs.push(out[0]);
        t += 1000;
      }
    } finally {
      s.destroy();
    }
    assert.equal(outs.length, 3599);
    for (const [i, ref] of [[0, 0], [1, 1], [100, 100], [1000, 1000], [3598, 3598]]) {
      const o = outs[i];
      assert.equal(o.nb_samples, 40, `unit ${i} : 40 éch.`);
      assert.equal(o.channels, 6);
      assert.equal(o.sample_rate, 48000);
      assert.equal(o.format, 3); // FLT entrelacé
      for (const v of o.data) assert.ok(Number.isFinite(v), `unit ${i} finie`);
      const r = rms(o.data);
      assert.ok(Math.abs(r - REF_RMS[ref]) / REF_RMS[ref] < 1e-3, `unit ${i} rms=${r}`);
    }
    // Seek + continuité exacte jusqu'au bout.
    assert.equal(await av_seek_frame(session, 0, 1500000000n, 0, 0), 0);
    const q = await readAllAudio(session, 0);
    assert.ok(q.length > 0 && q[0].pts <= 1500000000, `q0=${q[0]?.pts}`);
    assert.equal(q[q.length - 1].pts, full[full.length - 1].pts);
    const before = full.filter((p) => p.pts < q[0].pts).length;
    assert.equal(before + q.length, full.length);
  });

  it("déterminisme strict (2 sessions) + reprise post-flush exacte", async () => {
    const { session } = await openMka();
    const full = await readAllAudio(session, 0);
    const dec11 = async (s) => {
      const outs = [];
      let t = 0;
      for (const p of full.slice(0, 11)) {
        const out = s.decode(p.data, t);
        assert.equal(out.length, 1);
        outs.push(out[0].data);
        t += 1000;
      }
      return outs;
    };
    const s1 = await createTRUEHDSession({ family: "truehd", channels: 6, sampleRate: 48000 });
    const s2 = await createTRUEHDSession({ family: "truehd", channels: 6, sampleRate: 48000 });
    try {
      const a = await dec11(s1);
      const b = await dec11(s2);
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].length, b[i].length);
        for (let k = 0; k < a[i].length; k++) assert.equal(a[i][k], b[i][k]);
      }
      // Reprise post-seek : flush puis redémarrage au major sync (unit 0).
      await avcodec_flush_buffers({ reset: () => s1.reset() });
      const c = await dec11(s1);
      assert.equal(c.length, a.length);
      for (let i = 0; i < a.length; i++) {
        for (let k = 0; k < a[i].length; k++) assert.equal(c[i][k], a[i][k]);
      }
    } finally {
      s1.destroy();
      s2.destroy();
    }
  });

  it("wiring compat : ff_init_decoder truehd", async () => {
    const [, ctx] = await ff_init_decoder(86060, { family: "truehd", channels: 6, sampleRate: 48000 });
    try {
      const out = await ff_decode_multi(ctx, {}, {}, []);
      assert.ok(Array.isArray(out));
    } finally {
      await ff_free_decoder(ctx);
    }
  });
});
