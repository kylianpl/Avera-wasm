// tests/pcm-matrix.test.mjs — PCM sous toutes ses formes (pont logiciel).
// Fixture figée (ffmpeg : sinus 440Hz 48kHz mono, 1s → 48000 échantillons) :
//   mkv-pcm-matrix.mkv : s16le/be, s24le/be, s32le/be, f32le, u8, f64le
// Couvre : BitDepth MKV (sans lui : bits=0 → refus propre), big-endian
// (A_PCM/INT/BIG — corruption silencieuse sans le pont BE), flottants
// (A_PCM/FLOAT/IEEE = LE, vérifié), u8 non signé.
// Chaque piste porte le même sinus : corrélation analytique > 0.9999
// (même méthode que le test avi-h264-pcm).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi,
  ff_copyout_codecpar, avcodec_get_name,
  ff_init_decoder, ff_decode_multi, ff_free_decoder,
  AVMEDIA_TYPE_AUDIO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);

// [bits, isFloat, isBigEndian] attendus par piste.
const EXPECT = [
  [16, false, false], [16, false, true],
  [24, false, false], [24, false, true],
  [32, false, false], [32, false, true],
  [32, true, false], [8, false, false], [64, true, false],
];

async function openFile() {
  const data = await readFile(FIX("mkv-pcm-matrix.mkv"));
  const lib = new CompatLib();
  await lib.mkblockreaderdev("t.mkv", data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send("t.mkv", start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, "t.mkv");
  return { session, streams };
}

async function decodeTrack(session, aIdx) {
  const st = streamsOf(session)[aIdx];
  const [, ctx] = await ff_init_decoder(st.codec_id, st.codecpar);
  const pcm = [];
  try {
    for (let i = 0; i < 30; i++) {
      const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
      if (res === AVERROR_EOF) break;
      assert.equal(res, 0);
      for (const f of await ff_decode_multi(ctx, {}, {}, dict[aIdx] ?? [])) {
        pcm.push(...f.data);
      }
    }
  } finally {
    await ff_free_decoder(ctx);
  }
  return new Float32Array(pcm);
}

function streamsOf(session) {
  return session.tracks.map((t, i) => ({ codec_id: t.ffCodecId, codecpar: t, index: i }));
}

function correlation(pcm, freq, sr) {
  const n = Math.min(48000, pcm.length);
  let num = 0, dg = 0, dr = 0;
  for (let k = 0; k < n; k++) {
    const g = pcm[k];
    const r = Math.sin((2 * Math.PI * freq * k) / sr);
    num += g * r; dg += g * g; dr += r * r;
  }
  return num / Math.sqrt(dg * dr);
}

describe("pcm-matrix", () => {
  it("open → 9 pistes, bits/BE/flottant corrects", async () => {
    const { streams } = await openFile();
    assert.equal(streams.length, 9);
    for (let i = 0; i < 9; i++) {
      const a = streams[i];
      assert.equal(a.codec_type, AVMEDIA_TYPE_AUDIO);
      assert.equal(avcodec_get_name(a.codec_id), "pcm");
      const cp = await ff_copyout_codecpar(a.codecpar);
      assert.equal(cp.sample_rate, 48000, `piste ${i} sr`);
      assert.equal(cp.channels, 1, `piste ${i} ch`);
      assert.equal(cp.bitsPerSample, EXPECT[i][0], `piste ${i} bits`);
      assert.equal(cp.isFloat, EXPECT[i][1], `piste ${i} float`);
      assert.equal(cp.isBigEndian, EXPECT[i][2], `piste ${i} BE`);
    }
  });

  it("decode → sinus 440Hz bit-fidèle sur les 9 variantes", async () => {
    // Session fraîche par piste (le curseur de lecture est partagé).
    for (let i = 0; i < 9; i++) {
      const { session } = await openFile();
      const pcm = await decodeTrack(session, i);
      assert.equal(pcm.length, 48000, `piste ${i} : 1s complète`);
      // u8 : bruit de quantification (bit-exact vs natif par ailleurs).
      const seuil = EXPECT[i][0] === 8 ? 0.99 : 0.9999;
      assert.ok(correlation(pcm, 440, 48000) > seuil, `piste ${i} sinus intact`);
    }
  });

  it("codec inconnu (id 0, ex. MS/ACM·ALAC·TTA·WV) → échec propre", async () => {
    await assert.rejects(ff_init_decoder(0, {}), /non migré/);
  });
});
