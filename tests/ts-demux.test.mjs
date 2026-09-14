// tests/ts-demux.test.mjs — démuxeur MPEG-TS maison (188/192o, m2ts).
// Fixtures figées (ffmpeg : testsrc2 640x360@25 + sinus 440Hz 48kHz stéréo, 3s) :
//   ts-h264-aac.ts  : H264 (-bf 0) + AAC (PAT/PMT/PCR)
//   ts-hevc-aac.ts  : HEVC + AAC (hvcC reconstruit, IRAP)
//   ts-mpeg2-mp2.ts : MPEG-2 vidéo + MP2 (stream_type 0x03 → layer réel)
//   ts-h264-ac3.ts  : H264 + AC-3
//   ts-h264-eac3.ts : H264 + E-AC-3
//   ts-h264-aac.m2ts : H264 + AAC, stride 192 (TP_extra_header, AAC en 0x06 nu)
// Comptes ffprobe : parité exacte (voir chaque test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, av_seek_frame,
  ff_copyout_codecpar, avcodec_get_name, AVFormatContext_duration, AV_TIME_BASE,
  ff_init_decoder, ff_decode_multi, ff_free_decoder,
  AVMEDIA_TYPE_VIDEO, AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";
import { videoStreamToConfig } from "../packages/wc-bridge/src/bridge.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);

async function openFile(path, name = "test.ts") {
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
  for (let i = 0; i < 90; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    assert.equal(res, 0);
    if (vIdx !== -1) v.push(...(dict[vIdx] ?? []));
    if (aIdx !== -1) a.push(...(dict[aIdx] ?? []));
  }
  return { v, a };
}

describe("ts-demux", () => {
  it("open h264-aac → streams, avcC/SPS parsés, durée PCR", async () => {
    const { session, streams } = await openFile(FIX("ts-h264-aac.ts"));
    assert.equal(session.kind, "ts");
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.ok(v && a);
    assert.equal(avcodec_get_name(v.codec_id), "h264");
    assert.equal(avcodec_get_name(a.codec_id), "aac");
    const cp = await ff_copyout_codecpar(v.codecpar);
    assert.equal(cp.width, 640);
    assert.equal(cp.height, 360);
    assert.ok(cp.extradata.length > 7 && cp.extradata[0] === 1); // avcC in-band
    const cfg = videoStreamToConfig(cp);
    assert.ok(cfg.codec.startsWith("avc1."), `codec=${cfg.codec}`);
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.equal(ca.sample_rate, 48000);
    assert.equal(ca.channels, 2);
    assert.equal(Buffer.from(ca.extradata).length, 2); // ASC
    const dur = await AVFormatContext_duration(session);
    assert.ok(Math.abs(dur / AV_TIME_BASE - 2.96) < 0.15, `durée=${dur / AV_TIME_BASE}`);
  });

  it("read h264-aac → 75v+142a, avcc, clés 0/25/50", async () => {
    const { session, streams } = await openFile(FIX("ts-h264-aac.ts"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const { v, a } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    assert.equal(a.length, 142);
    assert.deepEqual(v.map((p) => p.key), v.map((_, i) => i % 25 === 0));
    assert.ok(v[0].key && v[0].pts >= 0);
    for (let i = 1; i < v.length; i++) assert.ok(v[i].dts >= v[i - 1].dts);
    for (const p of v) {
      assert.ok(p.data.length > 4);
      const l0 = (p.data[0] * 0x1000000) + ((p.data[1] << 16) | (p.data[2] << 8) | p.data[3]);
      assert.ok(l0 > 0 && l0 < p.data.length, `1re NAL plausible (${l0}/${p.data.length})`);
      assert.equal(p.size, p.data.length);
    }
    // Offset A/V préservé (t0 normalisé sur le min) : audio à 0, vidéo +1 frame AAC.
    assert.equal(a[0].pts, 0);
    assert.equal(v[0].pts, 21333333);
    for (let i = 1; i < a.length; i++) assert.ok(a[i].pts >= a[i - 1].pts);
    // Contrat transfert : buffers uniques (un buffer partagé duplique la
    // transfer list → postMessage jette le batch, vu en navigateur AC-3).
    const bufs = new Set();
    for (const p of [...v, ...a]) {
      assert.equal(p.size, p.data.length);
      assert.ok(!bufs.has(p.data.buffer), "buffer partagé entre paquets");
      bufs.add(p.data.buffer);
    }
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("seek 2s → clé + audio continu jusqu'au bout", async () => {
    const { session, streams } = await openFile(FIX("ts-h264-aac.ts"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const full = await readAll(session, vIdx, aIdx);
    assert.equal(await av_seek_frame(session, vIdx, 2000000000n, 0, 0), 0);
    const { v, a } = await readAll(session, vIdx, aIdx);
    assert.ok(v.length > 0 && v[0].key);
    assert.ok(v[0].pts <= 2100000000 && v[0].pts >= 1900000000, `v0=${v[0].pts}`);
    assert.ok(a.length > 0 && a[0].pts <= 2000000000);
    assert.equal(a[a.length - 1].pts, full.a[full.a.length - 1].pts); // jusqu'au bout
    const before = full.a.filter((p) => p.pts < a[0].pts).length;
    assert.equal(before + a.length, full.a.length); // continuité exacte
  });

  it("hevc-aac → 75v+142a, hvcC reconstruit, IRAP", async () => {
    const { session, streams } = await openFile(FIX("ts-hevc-aac.ts"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const v = streams[vIdx];
    assert.equal(avcodec_get_name(v.codec_id), "hevc");
    const cp = await ff_copyout_codecpar(v.codecpar);
    assert.equal(cp.width, 640);
    assert.equal(cp.height, 360);
    assert.ok(cp.extradata.length > 23 && cp.extradata[0] === 1); // hvcC minimal
    const { v: vv, a: aa } = await readAll(session, vIdx, aIdx);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 142);
    assert.ok(vv[0].key);
    // SW decode HEVC (libde265 + hvcC) sur les 1ers paquets.
    const [, ctx] = await ff_init_decoder(v.codec_id, v.codecpar);
    try {
      const out = await ff_decode_multi(ctx, {}, {}, vv.slice(0, 3));
      assert.ok(out.length >= 1, "au moins 1 frame HEVC");
      assert.equal(out[0].width, 640);
      assert.equal(out[0].height, 360);
    } finally {
      await ff_free_decoder(ctx);
    }
  });

  it("mpeg2-mp2 → 75v+125a, séquence parsée, MP2 via layer", async () => {
    const { session, streams } = await openFile(FIX("ts-mpeg2-mp2.ts"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const v = streams[vIdx], a = streams[aIdx];
    assert.equal(avcodec_get_name(v.codec_id), "mpeg2video");
    // stream_type 0x03 affiné en mp2 par le layer réel (ffmpeg signale ainsi).
    assert.equal(avcodec_get_name(a.codec_id), "mp2");
    const cp = await ff_copyout_codecpar(v.codecpar);
    assert.equal(cp.width, 640);
    assert.equal(cp.height, 360);
    const { v: vv, a: aa } = await readAll(session, vIdx, aIdx);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 125);
    assert.deepEqual(vv.map((p) => p.key), vv.map((_, i) => i % 12 === 0)); // GOP 12
    // SW decode MPEG-2 (libav WASM) sur les 1ers paquets (bit-exact : voir
    // tests/sw-decode-mpeg2.test.mjs pour les 75 frames).
    const [, ctx] = await ff_init_decoder(v.codec_id, v.codecpar);
    try {
      const out = await ff_decode_multi(ctx, {}, {}, vv.slice(0, 3));
      assert.ok(out.length >= 1, "au moins 1 frame MPEG-2");
      assert.equal(out[0].width, 640);
      assert.equal(out[0].height, 360);
      assert.equal(out[0].format, 0);
    } finally {
      await ff_free_decoder(ctx);
    }
  });

  it("ac3/eac3 → 75v+94a, têtes parsées (stéréo 48k)", async () => {
    for (const f of ["ts-h264-ac3.ts", "ts-h264-eac3.ts"]) {
      const { session, streams } = await openFile(FIX(f));
      const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
      const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
      const a = streams[aIdx];
      assert.equal(avcodec_get_name(a.codec_id), f.includes("eac3") ? "eac3" : "ac3", f);
      const ca = await ff_copyout_codecpar(a.codecpar);
      assert.equal(ca.sample_rate, 48000, f);
      assert.equal(ca.channels, 2, f);
      const { v, a: ap } = await readAll(session, vIdx, aIdx);
      assert.equal(v.length, 75, f);
      assert.equal(ap.length, 94, f);
      // SW decode (E)AC-3 sur les 1ers paquets.
      const [, ctx] = await ff_init_decoder(a.codec_id, a.codecpar);
      try {
        const out = await ff_decode_multi(ctx, {}, {}, ap.slice(0, 2));
        assert.ok(out.length >= 1, `${f} : au moins 1 frame`);
        assert.equal(out[0].sample_rate, 48000, f);
      } finally {
        await ff_free_decoder(ctx);
      }
    }
  });

  it("m2ts 192o → 75v+142a, AAC 0x06 nu sniffé", async () => {
    const { session, streams } = await openFile(FIX("ts-h264-aac.m2ts"), "test.m2ts");
    assert.equal(session.kind, "ts");
    assert.equal(session.ts.stride, 192);
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const a = streams[aIdx];
    assert.equal(avcodec_get_name(a.codec_id), "aac");
    const { v, a: ap } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    assert.equal(ap.length, 142);
    assert.deepEqual(v.map((p) => p.key), v.map((_, i) => i % 25 === 0));
    assert.equal(await av_seek_frame(session, vIdx, 2000000000n, 0, 0), 0);
    const { v: v2 } = await readAll(session, vIdx, aIdx);
    assert.ok(v2.length > 0 && v2[0].key);
  });
});
