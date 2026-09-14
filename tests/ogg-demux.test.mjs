// tests/ogg-demux.test.mjs — démuxeur Ogg maison (Vorbis/Opus/FLAC/Theora).
// Fixtures figées (ffmpeg : testsrc2 640x360@25 + sinus 440Hz 48kHz stéréo, 3s,
// sauf theora 640x360) :
//   ogg-vorbis.ogg       : Vorbis seul (143 paquets)
//   ogg-opus.ogg         : Opus seul, pre-skip 312 (151 paquets)
//   ogg-flac.ogg         : FLAC seul (141 paquets)
//   ogg-theora-vorbis.ogv : Theora + Vorbis (passthrough vidéo, 75v+143a)
// Comptes ffprobe : parité exacte (le filler/pré-roll : voir chaque test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi, av_seek_frame,
  ff_copyout_codecpar, avcodec_get_name, AVFormatContext_duration, AV_TIME_BASE,
  AVMEDIA_TYPE_VIDEO, AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";
import { parsePageHeader, splitPagePackets } from "../packages/ogg-demux/src/pages.js";
import {
  identifyBos, vorbisPacketSamples, opusPacketSamples, flacFrameSamples,
  parseStreamInfo,
} from "../packages/ogg-demux/src/codecs.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);

async function openFile(path, name = "test.ogg") {
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
    if (vIdx !== -1) v.push(...(dict[vIdx] ?? []));
    if (aIdx !== -1) a.push(...(dict[aIdx] ?? []));
  }
  return { v, a };
}

/** Vérifie Σ intra-page == Δ granulepos (exactitude des durées).
 * Pages non-finales : égalité stricte. Page finale : dépassement borné
 * (padding final exclu du granulepos, < un bloc). Lève sinon. */
async function checkPageSpans(path) {
  const data = await readFile(path);
  let off = 0;
  const pages = [];
  while (off + 27 <= data.length) {
    const h = parsePageHeader(data, off);
    if (!h) { off++; continue; }
    pages.push({ h, body: data.subarray(off + h.hdrLen, off + h.hdrLen + h.bodyLen) });
    off += h.hdrLen + h.bodyLen;
  }
  const serial = pages[0].h.serial;
  let frag = null, headers = [], desc = null, si = null, vst = null;
  let pos = null, started = false;
  let checked = 0;
  const lastPage = (pages.map((p, i) => (p.h.serial === serial ? i : -1)).filter((i) => i >= 0)).pop();
  for (let pi = 0; pi < pages.length; pi++) {
    const { h, body } = pages[pi];
    if (h.serial !== serial) continue;
    const { done, rest } = splitPagePackets(body, h.segTable, frag);
    frag = rest;
    for (const pkt of done) {
      if (!desc || !desc.headerDone) {
        headers.push(pkt);
        if (headers.length === 1) {
          desc = identifyBos(pkt);
          assert.ok(desc, `stream identifié (${path})`);
          if (desc.codec === "flac") si = parseStreamInfo(pkt.subarray((desc.headOff || 0) + 4, (desc.headOff || 0) + 42));
          if (desc.codec === "vorbis") vst = { modes: [0, 1], bs0: desc.bs0, bs1: desc.bs1, prevW: 0 };
          desc.headerDone = false;
        }
        if (desc.codec === "vorbis" && headers.length === 3) desc.headerDone = true;
        else if (desc.codec === "opus" && headers.length === 2) desc.headerDone = true;
        else if (desc.codec === "flac" && headers.length > 1 && pkt[0] === 0xff) {
          // 1re frame audio : headers finis MAIS paquet compté (fallthrough).
          desc.headerDone = true;
        } else continue;
      }
      let n = 0;
      if (desc.codec === "vorbis") n = vorbisPacketSamples(pkt, vst);
      else if (desc.codec === "opus") n = opusPacketSamples(pkt);
      else if (desc.codec === "flac") n = flacFrameSamples(pkt, si);
      if (n <= 0) continue;
      if (desc.codec === "vorbis" && !started) { started = true; pos = -n; }
      pos += n;
    }
    if (h.granule >= 0n && desc?.headerDone && h.seq > 1) {
      if (pi === lastPage) {
        const over = pos - Number(h.granule);
        assert.ok(over >= 0 && over < 4096, `${path} padding final ${over}`);
      } else {
        assert.equal(pos, Number(h.granule), `${path} page seq=${h.seq}`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 2, `${path} : pages vérifiées (${checked})`);
}

describe("ogg-demux", () => {
  it("spans exacts : Σ intra-page == Δ granulepos (vorbis/opus/flac)", async () => {
    await checkPageSpans(FIX("ogg-vorbis.ogg"));
    await checkPageSpans(FIX("ogg-opus.ogg"));
    await checkPageSpans(FIX("ogg-flac.ogg"));
  });

  it("vorbis → 143 paquets, privé format MKV, fin exacte", async () => {
    const { session, streams } = await openFile(FIX("ogg-vorbis.ogg"));
    assert.equal(session.kind, "ogg");
    assert.equal(streams.length, 1);
    const a = streams[0];
    assert.equal(avcodec_get_name(a.codec_id), "vorbis");
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.equal(ca.sample_rate, 48000);
    assert.equal(ca.channels, 2);
    // Privé identique au packing Matroska (Xiph lacing : 02 + len×2).
    assert.equal(ca.extradata[0], 2);
    assert.ok(ca.extradata.length > 1000);
    const dur = await AVFormatContext_duration(session);
    assert.ok(Math.abs(dur / AV_TIME_BASE - 3.0) < 0.02, `durée=${dur / AV_TIME_BASE}`);
    const { a: ap } = await readAll(session, -1, 0);
    assert.equal(ap.length, 143);
    assert.equal(ap[0].pts, 0); // pré-roll -128 clampé (parité delay LAME)
    for (let i = 1; i < ap.length; i++) assert.ok(ap[i].pts >= ap[i - 1].pts);
    assert.ok(Math.abs(ap[ap.length - 1].pts + ap[ap.length - 1].duration - 3000000000) < 2);
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("opus → 151 paquets, pre-skip shifté, fin exacte 3.0s", async () => {
    const { session, streams } = await openFile(FIX("ogg-opus.ogg"));
    const a = streams[0];
    assert.equal(avcodec_get_name(a.codec_id), "opus");
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.equal(Buffer.from(ca.extradata.subarray(0, 8)).toString(), "OpusHead");
    const { a: ap } = await readAll(session, -1, 0);
    assert.equal(ap.length, 151);
    assert.equal(ap[0].pts, 0);
    assert.ok(ap[1].pts > 0 && ap[1].pts < 20000000, `p1=${ap[1].pts}`);
    assert.equal(ap[ap.length - 1].pts + ap[ap.length - 1].duration, 3000000000);
  });

  it("flac → 141 paquets, STREAMINFO 42o, seek en tête", async () => {
    const { session, streams } = await openFile(FIX("ogg-flac.ogg"));
    const a = streams[0];
    assert.equal(avcodec_get_name(a.codec_id), "flac");
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.equal(Buffer.from(ca.extradata.subarray(0, 4)).toString(), "fLaC");
    assert.equal(ca.extradata.length, 42);
    const { a: ap } = await readAll(session, -1, 0);
    assert.equal(ap.length, 141);
    assert.equal(ap[0].pts, 0);
    // Seek 0.5s (dans la zone headers/pending d'open) : continuité exacte.
    assert.equal(await av_seek_frame(session, 0, 500000000n, 0, 0), 0);
    const q = await readAll(session, -1, 0);
    assert.ok(q.a.length > 0 && q.a[0].pts <= 500000000);
    assert.ok(Math.abs(q.a[q.a.length - 1].pts + q.a[q.a.length - 1].duration - 3000000000) < 2);
    const before = ap.filter((p) => p.pts < q.a[0].pts).length;
    assert.equal(before + q.a.length, ap.length);
  });

  it("seek 1.5s vorbis/opus → page-précis, continu jusqu'au bout", async () => {
    for (const [f, total] of [["ogg-vorbis.ogg", 143], ["ogg-opus.ogg", 151]]) {
      const { session, streams } = await openFile(FIX(f));
      const full = await readAll(session, -1, 0);
      assert.equal(full.a.length, total, f);
      assert.equal(await av_seek_frame(session, 0, 1500000000n, 0, 0), 0);
      const q = await readAll(session, -1, 0);
      assert.ok(q.a.length > 0 && q.a[0].pts <= 1500000000, `${f} q0=${q.a[0]?.pts}`);
      assert.equal(q.a[q.a.length - 1].pts + q.a[q.a.length - 1].duration,
        full.a[full.a.length - 1].pts + full.a[full.a.length - 1].duration, f);
      const before = full.a.filter((p) => p.pts < q.a[0].pts).length;
      assert.equal(before + q.a.length, full.a.length, `${f} continuité`);
    }
  });

  it("theora+vorbis → 75v+143a, clés FTYPE, audio continu", async () => {
    const { session, streams } = await openFile(FIX("ogg-theora-vorbis.ogv"), "t.ogv");
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.ok(v && a);
    assert.equal(avcodec_get_name(v.codec_id), "theora");
    assert.equal(avcodec_get_name(a.codec_id), "vorbis");
    const { v: vv, a: aa } = await readAll(session, v.index, a.index);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 143);
    // Clés = frames 0,12,…,72 (parité ffprobe ; bit 6, cf. codecs.js).
    assert.deepEqual(vv.map((p) => p.key), vv.map((_, i) => i % 12 === 0));
    assert.equal(vv[vv.length - 1].pts, 74 * 40000000);
    for (const p of [...vv, ...aa]) {
      assert.equal(p.size, p.data.length);
      assert.ok(p.pts >= 0);
    }
  });
});
