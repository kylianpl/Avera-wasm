// tests/sw-decode-mpeg2.test.mjs — décodeur logiciel MPEG-1/2 vidéo.
// Bridge FFmpeg decode-only (vendor/mpeg2) : mpeg2video. Référence native
// bit-exacte (MD5, 75 frames — pas de B-frames, fixtures `-bf 0` : l'ordre
// de décodage == présentation, pas de doublon natif ici).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createMPEG2Session } from "../packages/sw-decode/src/mpeg2.js";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi,
  ff_init_decoder, ff_decode_multi, ff_free_decoder, avcodec_flush_buffers,
  AVMEDIA_TYPE_VIDEO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);
const md5 = (b) => createHash("md5").update(b).digest("hex");

// MD5 natifs (ffmpeg -threads 1 -c:v mpeg2video -f rawvideo -pix_fmt yuv420p),
// 75 frames 640x360 du TS binaire (testsrc2 + sinus, 3s, -bf 0 -g 12).
const REF_MPEG2 = [
"a48efe4d3c1acf5054b326a6725789e3","c9e680ad9fd6143b4f9b5e4cebe44d5d","9ec9af4e7f4a2871c9e797d0b98d9661",
"8cdc7482cb8455b6c185d27b79db2443","37c0a43946919c09940d4c589a3eadfd","a34346e654ea4262701f8437ee79071a",
"f07b923148eb30eec2fe4a234fc108b5","50cb16bc63b8427872c7b5ca6d6104ac","53165f655c683525c6eb587b99506be4",
"d308c89e1de4186929639c910e9249e2","4774294635c816fa7184f23075717b04","0bd5810aa1ad1e7601877ed234d07508",
"38692ece7b53b85d715ee3179c064f64","925f556b061ecc266d9d24d56de82cf8","d7611058db3ff56059337cec077149d5",
"6f04052aa14a0872a55ed964822021ce","6658301a67f60d7fffec0d13d176a3bf","ab2f2ad6c8765258bbb35079711efc34",
"8675a9011a6f27b1b29f8dc7f97e40f1","94978c1e0e572c3950b5b72aa237667a","24ca1bdc9cd2195b1e7db78e39861aff",
"f32990e4a286df2f0167c5e06e44c233","e27a95b19cc881537d5296bcae564bd6","6ff59bf67b1ff289a4c3928d83921de8",
"1364ed1f10464cfd5f933230ead7914c","a18cb8bdc112258c58779c12a6185fd6","1aeada857a19864ab17726f0e4200598",
"66e39615844c629dca032133b99c4225","817a7fd75c869670c3662a659474c876","cb3b86bb92438233f997b4853ea517f3",
"af25dc7fb031d78a059049e29f219553","4270a2d177a4a6d59757f5c23ba4140d","ffd80af5b644471bd8aefcb104b2c662",
"c6f2102dfafdbe6f0fedd52eb235e503","84306c7948e74a7210cfc31ad2279d6a","ec44c6656dde41670954d84b12890915",
"fa67214b7ac04a578be25ecd98e46e13","c900e813004dfd4dcec7c398aef0723d","1b19b447b3c30580e82eeebecef18169",
"8ca544646b974764d7e0500906d3d7b2","c87f7ac53112b1cb7b8745917bcfdc2b","6cfe6ea10d174a603013914d8e69ff60",
"1a92eddbc028f74c297260babd4a0b7d","c37da4bb9ff6370c88f44572ce19c64b","392e9772f99481a8d0dab44c9eed18be",
"a9f99304037e7c3615e2bf5982e2f22f","2c21088626e843da1d8fb56c58e22cec","9cd19e7a76fe8a5a6541d98f2614fc9f",
"27810fc7418e9b6eb0d5896c0da93914","1971ec1af24c6aa8c02c1dc5cc880fe0","effe3e3fc26b85200ee215f16f74dd95",
"a7967f5ded71800fb1fdc356074d8ed5","191dd35c0227b8fe8fbf15fc5c381d8f","629132c3ec32b00a5caf37e8159657f0",
"4941fd0a18448a471f7085a5b8221098","87894cbe42231ece06f9dd366f42ac10","5bc08d76048568afa2e9106f5a9a3496",
"9a038d1be5e59923c3007fa066129d19","b677230d6cae1059bd5862ebe43a75d2","bba13e928992d2d5f6e691f79bb05b56",
"a1d1a162226078ac38c252f2523f7166","065f81593402498d366711abb5ed603d","58cb65743eb570e302002f8fffe620d3",
"afc55c312ed7184808b5837d2d370641","d87afd94eef57f077dc0f8485f49d21c","ce7266b2f8b240b1c5d8887c8ce10f61",
"13b2ff01a034b6f0f29290525153839f","827afe2d1da734b6b0f25e397d2fc9ca","207e171dcd1447f2b12e2fd5e905b3a4",
"94c21af536770fe00927297dc62cfa29","81b87fa6197e15471d09d07594a30097","61fef4b4997ee7e5744e30f43ed0cd14",
"1b6d883e9b5600e844f1c2372c2f2b83","dd7e2e0d531fe20fa4ddddf03b69e4ca","2f0165342ae7c33654f136d9c139061a",
];

async function openTsPackets(path) {
  const data = await readFile(path);
  const lib = new CompatLib();
  const name = "t.ts";
  await lib.mkblockreaderdev(name, data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send(name, start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, name);
  const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
  const pkts = [];
  for (let i = 0; i < 90; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    pkts.push(...(dict[v.index] ?? []));
  }
  return { v, pkts };
}

async function decodeAll(codecpar, codec, pkts) {
  const s = await createMPEG2Session(codecpar, codec);
  const out = [];
  try {
    let t = 0;
    for (const p of pkts) {
      for (const f of s.decode(p.data, t)) out.push(f);
      t += 40000;
    }
    for (const f of s.drain()) out.push(f);
  } finally {
    s.destroy();
  }
  return out;
}

describe("sw-decode-mpeg2", () => {
  it("mpeg2video → 75 frames 640x360 bit-exactes vs natif", async () => {
    const { v, pkts } = await openTsPackets(FIX("ts-mpeg2-mp2.ts"));
    assert.equal(pkts.length, 75);
    const frames = await decodeAll(v.codecpar, "mpeg2video", pkts);
    assert.equal(frames.length, 75);
    for (const f of frames) {
      assert.equal(f.format, 0);
      assert.equal(f.width, 640);
      assert.equal(f.height, 360);
      assert.equal(f.data.length, 640 * 360 * 3 / 2);
    }
    frames.forEach((f, i) => assert.equal(md5(f.data), REF_MPEG2[i], `frame ${i}`));
  });

  it("reset() → reprise déterministe bit-exacte (depuis une clé)", async () => {
    const { v, pkts } = await openTsPackets(FIX("ts-mpeg2-mp2.ts"));
    const ref = await decodeAll(v.codecpar, "mpeg2video", pkts);
    // Reprise post-seek = depuis une keyframe (comme le demux : recul clé).
    const at = pkts.findIndex((p, i) => i >= 20 && p.key);
    assert.ok(at > 0, "clé trouvée");
    const s = await createMPEG2Session(v.codecpar, "mpeg2video");
    try {
      let t = 0;
      for (const p of pkts.slice(0, at)) { s.decode(p.data, t); t += 40000; }
      await avcodec_flush_buffers({ reset: () => s.reset() });
      const tail = [];
      for (const p of pkts.slice(at)) {
        for (const f of s.decode(p.data, t)) tail.push(f);
        t += 40000;
      }
      for (const f of s.drain()) tail.push(f);
      assert.equal(tail.length, ref.length - at);
      tail.forEach((f, i) => assert.equal(md5(f.data), md5(ref[at + i].data), `reprise ${i}`));
    } finally {
      s.destroy();
    }
  });

  it("wiring compat : ff_init_decoder mpeg2video", async () => {
    const { v } = await openTsPackets(FIX("ts-mpeg2-mp2.ts"));
    const [, ctx] = await ff_init_decoder(2, v.codecpar);
    try {
      const out = await ff_decode_multi(ctx, {}, {}, []);
      assert.ok(Array.isArray(out));
    } finally {
      await ff_free_decoder(ctx);
    }
  });
});
