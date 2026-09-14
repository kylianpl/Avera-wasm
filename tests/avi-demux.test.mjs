// tests/avi-demux.test.mjs — démuxeur AVI/RIFF maison.
// Fixtures figées (ffmpeg, testsrc2 640x360@25 -bf 0 -g 25 + sinus 48kHz, 3s) :
//   avi-h264-mp3.avi : H264 Annex B + MP3 CBR (avcC reconstruit des SPS/PPS)
//   avi-h264-ac3.avi : H264 + AC-3 (1 chunk à 2 frames → découpage)
//   avi-h264-pcm.avi : H264 + PCM s16le (pont logiciel, corrélation = 1)
//   avi-xvid-mp3.avi : MPEG-4 ASP + MP3 (conteneur OK, décodage non migré)
//   avi-h264-aac.avi : H264 + AAC RAW (1 chunk = 1 frame, filler "Lavc" skippé)
// Comptes ffprobe : v75 + a126/a94/a141/a126/a141(+1 filler).
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

async function openFile(path) {
  const data = await readFile(path);
  const lib = new CompatLib();
  const name = "test.avi";
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
  for (let i = 0; i < 60; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    assert.equal(res, 0);
    if (vIdx !== -1) v.push(...(dict[vIdx] ?? []));
    if (aIdx !== -1) a.push(...(dict[aIdx] ?? []));
  }
  return { v, a };
}

function correlation(pcm, ch, channels, freq, sr) {
  const n = Math.min(48000, Math.floor(pcm.length / channels));
  let num = 0, dg = 0, dr = 0;
  for (let k = 0; k < n; k++) {
    const g = pcm[k * channels + ch];
    const r = Math.sin((2 * Math.PI * freq * k) / sr);
    num += g * r; dg += g * g; dr += r * r;
  }
  return num / Math.sqrt(dg * dr);
}

describe("avi-demux", () => {
  it("open h264-mp3 → streams, avcC reconstruit, durée 3.04s", async () => {
    const { session, streams } = await openFile(FIX("avi-h264-mp3.avi"));
    assert.equal(session.kind, "avi");
    assert.ok(session.avi.hasIndex);
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.ok(v && a);
    assert.equal(avcodec_get_name(v.codec_id), "h264");
    assert.equal(avcodec_get_name(a.codec_id), "mp3");
    const cp = await ff_copyout_codecpar(v.codecpar);
    assert.equal(cp.width, 640);
    assert.equal(cp.height, 360);
    assert.ok(cp.extradata.length > 7 && cp.extradata[0] === 1); // avcC reconstruit
    assert.ok(cp.profile > 0 && cp.level > 0);
    const cfg = videoStreamToConfig(cp);
    assert.ok(cfg.codec.startsWith("avc1."), `codec=${cfg.codec}`);
    assert.ok(cfg.description && cfg.description[0] === 1);
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.equal(ca.sample_rate, 48000);
    assert.equal(ca.channels, 2);
    const dur = await AVFormatContext_duration(session);
    assert.ok(Math.abs(dur / AV_TIME_BASE - 3.04) < 0.1, `durée=${dur / AV_TIME_BASE}`); // 76 ticks (vide inclus)
  });

  it("read h264-mp3 → 75v+126a, paquets avcc, 3 clés", async () => {
    const { session, streams } = await openFile(FIX("avi-h264-mp3.avi"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const { v, a } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    assert.equal(a.length, 126);
    assert.ok(v[0].key && v[0].pts === 0);
    // Le chunk vide ffmpeg (file1) consomme un tick : pts 0,80,120… (ffprobe).
    assert.equal(v[1].pts, 80000000);
    for (let i = 1; i < v.length; i++) assert.ok(v[i].dts >= v[i - 1].dts);
    assert.equal(v.filter((p) => p.key).length, 3); // IDR à file0,26,51 (-bf 0, -g 25)
    for (const p of v) {
      // Length-prefixed (pas de start code) : u32BE == reste du paquet (1re NAL).
      assert.ok(p.data.length > 4);
      const l0 = (p.data[0] * 0x1000000) + ((p.data[1] << 16) | (p.data[2] << 8) | p.data[3]);
      assert.ok(!(p.data[0] === 0 && p.data[1] === 0 && (p.data[2] === 1 || (p.data[2] === 0 && p.data[3] === 1))), "pas de start code");
      assert.ok(l0 > 0 && l0 < p.data.length, `1re NAL plausible (${l0}/${p.data.length})`);
      assert.equal(p.time_base_den, 1000000000);
    }
    assert.equal(a[0].pts, 0);
    for (let i = 1; i < a.length; i++) assert.ok(a[i].pts > a[i - 1].pts, "pts audio croissants");
    assert.equal(a[125].pts, 3000000000);
    // Contrat transfert : size numérique == data.length ET buffers uniques
    // (un size=data objet duplique le buffer dans la transfer list → le
    // postMessage inter-workers jette tout le batch, vu en navigateur).
    const bufs = new Set();
    for (const p of [...v, ...a]) {
      assert.equal(typeof p.size, "number");
      assert.equal(p.size, p.data.length);
      assert.ok(!bufs.has(p.data.buffer), "buffer partagé entre paquets");
      bufs.add(p.data.buffer);
    }
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("seek 1.5s → clé 1.04s, 50v restants, audio continu jusqu'au bout", async () => {
    const { session, streams } = await openFile(FIX("avi-h264-mp3.avi"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const full = await readAll(session, vIdx, aIdx);
    assert.equal(await av_seek_frame(session, vIdx, 1500000000n, 0, 0), 0);
    const { v, a } = await readAll(session, vIdx, aIdx);
    assert.ok(v.length > 0 && v[0].key);
    assert.equal(v[0].dts, 1040000000); // k=file26 (vide en file1 : 26×40ms)
    assert.equal(v.length, 50);
    assert.ok(a.length > 0);
    assert.ok(a[0].pts <= 1500000000 && a[0].pts > 1300000000);
    assert.equal(a[a.length - 1].pts, full.a[full.a.length - 1].pts); // jusqu'au bout
    const before = full.a.filter((p) => p.pts < a[0].pts).length;
    assert.equal(before + a.length, full.a.length); // continuité exacte
  });

  it("ac3 → 75v+94a, PCM logiciel exact via ff_decode_multi", async () => {
    const { session, streams } = await openFile(FIX("avi-h264-ac3.avi"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const a = streams[aIdx];
    assert.equal(avcodec_get_name(a.codec_id), "ac3");
    const { v, a: ap } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    assert.equal(ap.length, 94); // 93 chunks idx1 dont 1 à 2 frames
    const [, ctx] = await ff_init_decoder(a.codec_id, a.codecpar);
    try {
      const out = await ff_decode_multi(ctx, {}, {}, ap.slice(0, 4));
      assert.equal(out.length, 4);
      assert.equal(out[0].nb_samples, 1536);
      assert.equal(out[0].sample_rate, 48000);
      assert.equal(out[0].channels, 2);
      assert.ok(out[0].data instanceof Float32Array);
    } finally {
      await ff_free_decoder(ctx);
    }
  });

  it("pcm → 75v+141a, pont logiciel bit-exact (corrélation ≈ 1)", async () => {
    const { session, streams } = await openFile(FIX("avi-h264-pcm.avi"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const a = streams[aIdx];
    assert.equal(avcodec_get_name(a.codec_id), "pcm");
    const cp = await ff_copyout_codecpar(a.codecpar);
    assert.equal(cp.bitsPerSample, 16);
    const { v, a: ap } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    assert.equal(ap.length, 141);
    const [, ctx] = await ff_init_decoder(a.codec_id, a.codecpar);
    try {
      const out = await ff_decode_multi(ctx, {}, {}, ap.slice(0, 8));
      assert.equal(out.length, 8);
      assert.equal(out[0].nb_samples, 1024); // 4096o / (2ch × 2o)
      const pcm = new Float32Array(out.reduce((n, f) => n + f.data.length, 0));
      let o = 0;
      for (const f of out) { pcm.set(f.data, o); o += f.data.length; }
      assert.ok(correlation(pcm, 0, 2, 440, 48000) > 0.9999, "sinus lossy-exact");
      assert.ok(correlation(pcm, 1, 2, 440, 48000) > 0.9999);
    } finally {
      await ff_free_decoder(ctx);
    }
  });

  it("xvid → conteneur OK (75v+126a), décodage SW mpeg4", async () => {
    const { session, streams } = await openFile(FIX("avi-xvid-mp3.avi"));
    const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
    const a = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO);
    assert.equal(avcodec_get_name(v.codec_id), "mp4v");
    assert.equal(avcodec_get_name(a.codec_id), "mp3");
    const { v: vv, a: aa } = await readAll(session, v.index, a.index);
    assert.equal(vv.length, 75);
    assert.equal(aa.length, 126);
    // Chemin decode complet (détails bit-exacts : tests/sw-decode-mp4v).
    const [, ctx] = await ff_init_decoder(v.codec_id, v.codecpar);
    try {
      const out = await ff_decode_multi(ctx, {}, {}, vv.slice(0, 3));
      assert.equal(out.length, 3);
      assert.equal(out[0].format, 0);
      assert.equal(out[0].width, 640);
      assert.equal(out[0].height, 360);
      assert.equal(out[0].data.length, 640 * 360 * 3 / 2);
    } finally {
      await ff_free_decoder(ctx);
    }
  });

  it("aac → 75v+141a RAW, ASC 1190, pts cumulés 1024 éch/frame", async () => {
    const { session, streams } = await openFile(FIX("avi-h264-aac.avi"));
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const a = streams[aIdx];
    assert.equal(avcodec_get_name(a.codec_id), "aac");
    const ca = await ff_copyout_codecpar(a.codecpar);
    assert.equal(ca.sample_rate, 48000);
    assert.equal(ca.channels, 2);
    // ASC LC 48kHz stéréo (strf ext rognée du padding : 11 90).
    assert.equal(Buffer.from(ca.extradata).toString("hex"), "1190");
    const { v, a: ap } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    // ffprobe compte 142 paquets audio dont le filler "Lavc" de tête (pos
    // 9998, 286o, non décodable) : on l'émet pas, cum inchangé → 141 paquets.
    assert.equal(ap.length, 141);
    assert.equal(ap[0].pts, 0);
    assert.equal(ap[0].size, 363); // 1er vrai frame (pos 18200 ffprobe)
    assert.equal(ap[0].data[0], 0x21);
    for (const p of ap) {
      assert.equal(p.duration, 21333333); // 1024 éch @48kHz, arrondi ns
      assert.equal(p.size, p.data.length);
    }
    for (let i = 1; i < ap.length; i++) assert.ok(ap[i].pts > ap[i - 1].pts, "pts audio croissants");
    assert.equal(ap[ap.length - 1].pts + ap[ap.length - 1].duration, 3007999999);
    const [res] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, AVERROR_EOF);
  });

  it("sans idx1 → lecture complète, seek dégradé à 0", async () => {
    const raw = await readFile(FIX("avi-h264-mp3.avi"));
    const at = raw.indexOf(Buffer.from("idx1")); // début du chunk idx1
    assert.ok(at > 0);
    // Tronque l'idx1 + ajuste la taille RIFF : AVI sans index valide.
    const cut = Buffer.from(raw.subarray(0, at));
    cut.writeUInt32LE(cut.length - 8, 4);
    const lib = new CompatLib();
    await lib.mkblockreaderdev("noidx.avi", cut.length);
    lib.onblockread = async (filename, pos, _len) => {
      const start = Math.floor(pos / 1048576) * 1048576;
      const end = Math.min(cut.length, start + 1048576);
      await lib.ff_block_reader_dev_send("noidx.avi", start, cut.subarray(start, end));
    };
    const [session, streams] = await ff_init_demuxer_file(lib, "noidx.avi");
    assert.ok(!session.avi.hasIndex);
    const vIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO).index;
    const aIdx = streams.find((s) => s.codec_type === AVMEDIA_TYPE_AUDIO).index;
    const { v, a } = await readAll(session, vIdx, aIdx);
    assert.equal(v.length, 75);
    assert.equal(a.length, 126);
    assert.equal(await av_seek_frame(session, vIdx, 2000000000n, 0, 0), 0);
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    assert.equal(res, 0);
    assert.equal(dict[vIdx][0].pts, 0); // reprise à 0 documentée
  });
});
