// tests/color-meta.test.mjs — métadonnées couleur/HDR (CICP, VUI, MP4).
// Vecteurs unitaires + intégration sur les fixtures HDR10 (MKV/MP4) :
// l'essentiel est le repli VUI, car ffmpeg n'écrit pas toujours
// transfer/primaries dans le conteneur (vérifié : ffprobe dit "unknown"
// alors que la VUI du SPS porte bien PQ/BT.2020).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeColor, mergeColor, isHdr, hdrMode, toWebCodecsColorSpace,
  parseColrBox, parseMdcvBox, parseClliBox, parseHevcSpsColor,
} from "../packages/color-meta/src/index.js";
import {
  CompatLib, ff_init_demuxer_file, ff_copyout_codecpar,
  AVMEDIA_TYPE_VIDEO,
} from "../packages/demux-compat/src/compat.js";
import { videoStreamToConfig } from "../packages/wc-bridge/src/bridge.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);

async function openVideo(path, name = "t") {
  const data = await readFile(path);
  const lib = new CompatLib();
  await lib.mkblockreaderdev(name, data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send(name, start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, name);
  const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
  const cp = await ff_copyout_codecpar(v.codecpar);
  return { session, streams, v, cp };
}

const PQ = { primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false };

describe("color-meta", () => {
  it("normalize/merge : CICP → WebCodecs, 2 = unspecified n'écrase pas", async () => {
    assert.deepEqual(normalizeColor({ primaries: 9, transfer: 16, matrix: 9 }), {
      primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl",
    });
    // Conteneur "unspecified" (2) ne doit pas écraser la VUI exploitable.
    assert.deepEqual(mergeColor({ primaries: 2, transfer: 2, matrix: 9 },
      { primaries: 9, transfer: 16, matrix: 9 }),
      { primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl" });
    // Conteneur prioritaire quand il est spécifié.
    assert.equal(mergeColor({ primaries: 1, transfer: 1, matrix: 1 },
      { primaries: 9, transfer: 16, matrix: 9 }).transfer, "bt709");
    // matrix 0 = rgb (pas "unspecified") : conservé.
    assert.equal(normalizeColor({ matrix: 0 }).matrix, "rgb");
    assert.equal(normalizeColor({ primaries: 2, transfer: 2 }), null);
  });

  it("isHdr/hdrMode/toWebCodecsColorSpace", async () => {
    assert.equal(isHdr(PQ), true);
    assert.equal(hdrMode(PQ), "pq");
    assert.equal(hdrMode({ ...PQ, transfer: "hlg" }), "hlg");
    assert.equal(hdrMode({ transfer: "bt709" }), "sdr");
    assert.deepEqual(toWebCodecsColorSpace(PQ), {
      primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false,
    });
    assert.equal(toWebCodecsColorSpace({ transfer: "pq" }), null); // < 2 champs
  });

  it("colr/mdcv/clli MP4 → CICP", async () => {
    const colr = Uint8Array.from([
      0x6e, 0x63, 0x6c, 0x78, 0, 9, 0, 16, 0, 9, 0x80, // nclx 9/16/9 full
    ]);
    assert.deepEqual(parseColrBox(colr), {
      primaries: 9, transfer: 16, matrix: 9, fullRange: true,
    });
    const mdcv = new Uint8Array(24);
    mdcv.set([0x84, 0xd0, 0x3e, 0x80], 0); // rx=0.68, ry=0.32
    mdcv.set([0x00, 0x03, 0xd0, 0x90], 16); // lumMax 25 nits
    const m = parseMdcvBox(mdcv);
    assert.ok(Math.abs(m.rx - 0.68) < 1e-4 && Math.abs(m.ry - 0.32) < 1e-4);
    assert.ok(Math.abs(m.lumMax - 25) < 1e-6);
    assert.deepEqual(parseClliBox(Uint8Array.from([0x03, 0xe8, 0x01, 0x90])),
      { maxCLL: 1000, maxFALL: 400 });
  });

  it("VUI HEVC : SPS erroné → null (jamais d'exception)", async () => {
    assert.equal(parseHevcSpsColor(Uint8Array.from([0x42, 0x01])), null);
    assert.equal(parseHevcSpsColor(new Uint8Array(4)), null);
  });

  it("MKV HDR10 → PQ/BT.2020 détecté via VUI (ffprobe dit unknown)", async () => {
    const { cp } = await openVideo(FIX("mkv-hevc-hdr10.mkv"), "t.mkv");
    assert.equal(cp.color.transfer, "pq");
    assert.equal(cp.color.primaries, "bt2020");
    assert.equal(cp.color.matrix, "bt2020-ncl");
    const cfg = videoStreamToConfig(cp);
    assert.ok(cfg.codec.startsWith("hvc1."));
    assert.deepEqual(cfg.colorSpace, {
      primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false,
    });
  });

  it("MP4 HDR10 → colorSpace depuis colr + VUI", async () => {
    const { cp } = await openVideo(FIX("mp4-hevc-hdr10.mp4"), "t.mp4");
    assert.equal(cp.color.transfer, "pq");
    assert.equal(cp.color.primaries, "bt2020");
    assert.equal(videoStreamToConfig(cp).colorSpace.transfer, "pq");
  });

  it("MKV HDR10 PQ (niveaux réels) → PQ/BT.2020", async () => {
    const { cp } = await openVideo(FIX("mkv-hevc-hdr10-pq.mkv"), "t.mkv");
    assert.equal(cp.color.transfer, "pq");
    assert.equal(hdrMode(cp.color), "pq");
    assert.equal(videoStreamToConfig(cp).colorSpace.transfer, "pq");
  });

  it("SDR (AVC/VP9/TS) → pas de colorSpace HDR, config inchangée", async () => {
    for (const [f, name] of [["mkv-avc-flac.mkv", "t.mkv"], ["mkv-vp9-opus.mkv", "t.mkv"],
      ["ts-h264-aac.ts", "t.ts"]]) {
      const { cp } = await openVideo(FIX(f), name);
      assert.ok(!isHdr(cp.color), `${f} ne doit pas être HDR`);
      const cfg = videoStreamToConfig(cp);
      assert.equal(cfg.colorSpace, undefined, `${f} : pas de colorSpace`);
    }
  });
});
