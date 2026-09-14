// tests/flac-demux.test.mjs — démuxeur FLAC natif maison.
// Fixtures figées (ffmpeg : sinus 440Hz 48kHz, 3s = 144000 échantillons) :
//   flac-mono.flac   : mono 16 bits (bloc fixe 1024)
//   flac-stereo.flac : stéréo 16 bits
// Comptes ffprobe : 141 paquets chacun (140×1024 + 640, padding rogné).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, av_seek_frame,
  ff_copyout_codecpar, avcodec_get_name, AVFormatContext_duration, AV_TIME_BASE,
  AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);
const SR = 48000, SPF = 1024, TOTAL = 144000;

async function openFile(path, name = "test.flac") {
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
  for (let i = 0; i < 60; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    assert.equal(res, 0);
    out.push(...(dict[0] ?? []));
  }
  return out;
}

describe("flac-demux", () => {
  it("open mono → piste FLAC, STREAMINFO, durée exacte 3.0s", async () => {
    const { session, streams } = await openFile(FIX("flac-mono.flac"));
    assert.equal(session.kind, "flac");
    assert.equal(streams.length, 1);
    const a = streams[0];
    assert.equal(a.codec_type, AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(a.codec_id), "flac");
    const cp = await ff_copyout_codecpar(a.codecpar);
    assert.equal(cp.sample_rate, SR);
    assert.equal(cp.channels, 1);
    // Blob WebCodecs : "fLaC" + header bloc + STREAMINFO (42o, comme MKV/Ogg).
    assert.equal(Buffer.from(cp.extradata.subarray(0, 4)).toString(), "fLaC");
    assert.equal(cp.extradata.length, 42);
    // Flag "last" interdit (Chromium rejette la description sinon, vérifié
    // navigateur : "Unsupported configuration").
    assert.equal(cp.extradata[4], 0x00);
    const dur = await AVFormatContext_duration(session);
    assert.equal(dur / AV_TIME_BASE, 3.0);
  });

  it("read mono → 141 paquets, pts exacts au sample, EOF", async () => {
    const { session } = await openFile(FIX("flac-mono.flac"));
    const a = await readAll(session);
    // 144000 = 140×1024 + 640 (dernière frame rognée au total).
    assert.equal(a.length, 141);
    assert.equal(a[0].pts, 0);
    for (let i = 0; i < 140; i++) {
      assert.equal(a[i].pts, Math.floor((i * SPF * 1000000000) / SR), `paquet ${i}`);
      assert.equal(a[i].duration, Math.floor((SPF * 1000000000) / SR));
    }
    assert.equal(a[140].duration, Math.floor((640 * 1000000000) / SR)); // padding rogné
    assert.ok(Math.abs(a[140].pts + a[140].duration - 3000000000) < 2);
    // Contrat transfert : buffers uniques.
    const bufs = new Set();
    for (const p of a) {
      assert.equal(p.size, p.data.length);
      assert.ok(!bufs.has(p.data.buffer), "buffer partagé entre paquets");
      bufs.add(p.data.buffer);
    }
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("seek 1.5s → frame exacte, continu jusqu'au bout", async () => {
    const { session } = await openFile(FIX("flac-mono.flac"));
    const full = await readAll(session);
    assert.equal(await av_seek_frame(session, 0, 1500000000n, 0, 0), 0);
    const q = await readAll(session);
    // plancher(1.5×48k/1024) = 70 → pts 70×1024/48k = 1.493333s.
    assert.equal(q[0].pts, Math.floor((70 * SPF * 1000000000) / SR));
    assert.equal(q.length, 141 - 70);
    assert.ok(Math.abs(q[q.length - 1].pts + q[q.length - 1].duration - 3000000000) < 2);
    const before = full.filter((p) => p.pts < q[0].pts).length;
    assert.equal(before + q.length, full.length); // continuité exacte
  });

  it("stéréo → 141 paquets, 2 voies", async () => {
    const { session, streams } = await openFile(FIX("flac-stereo.flac"));
    const cp = await ff_copyout_codecpar(streams[0].codecpar);
    assert.equal(cp.channels, 2);
    assert.equal(cp.sample_rate, SR);
    const a = await readAll(session);
    assert.equal(a.length, 141);
    assert.equal(a[0].pts, 0);
    assert.ok(Math.abs(a[a.length - 1].pts + a[a.length - 1].duration - 3000000000) < 2);
  });

  it("seek 0 → reprise ; seek hors-fin → EOF", async () => {
    const { session } = await openFile(FIX("flac-mono.flac"));
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
