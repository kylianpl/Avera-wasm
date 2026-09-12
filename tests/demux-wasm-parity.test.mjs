// tests/demux-wasm-parity.test.mjs — parité byte-exact JS vs Rust/WASM.
// Couvre parse_cluster (blocks/lacing/keyframes) + parse_cues sur contenu réel.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseCluster: wasmParseCluster, parseCues: wasmParseCues } = require("../packages/demux-wasm/nodejs/mpv_web_demux.js");

const ICEAGE = new URL("../media/iceage-sample.mkv", import.meta.url);
const FIXTURE = new URL("./fixtures/real-h264.mkv", import.meta.url);

// Extrait les N premiers payloads Cluster complets (JS, via ebml Reader).
async function firstClusters(path, n, scaleOut) {
  const { Reader, ID } = await import("../packages/mkv-demux/src/ebml.js");
  const data = await readFile(path);
  // Trouve le Segment puis scanne les Clusters.
  const r = new Reader(data);
  let segOff = 0n, scale = 1000000n;
  const found = [];
  const scan = (buf, base, depth) => {
    const rr = new Reader(buf);
    while (!rr.eof && found.length < n) {
      const s0 = rr.p;
      let e;
      try { e = rr.elem(); } catch { break; }
      const end = e.size === null ? buf.length : Math.min(buf.length, rr.p + Number(e.size));
      if (depth === 0 && e.id === ID.Segment) {
        scan(buf.subarray(rr.p, end), base + BigInt(rr.p), 1);
      } else if (depth === 1 && e.id === ID.Info) {
        const ir = new Reader(buf.subarray(rr.p, end));
        while (!ir.eof) {
          let ie;
          try { ie = ir.elem(); } catch { break; }
          const iend = ie.size === null ? end - (rr.p) : Math.min(end - rr.p, ir.p + Number(ie.size));
          if (ie.id === ID.TimecodeScale) scale = ir.uint(BigInt(iend - ir.p));
          ir.p = iend <= ir.p - 0 ? ir.p + 1 : iend;
          void ir;
          break;
        }
      } else if (depth === 1 && e.id === ID.Cluster && e.size !== null && end <= buf.length) {
        found.push(buf.subarray(rr.p, end));
      }
      rr.p = end <= s0 ? s0 + 1 : end;
      if (depth === 1 && e.id !== ID.Cluster && e.id !== ID.Info && found.length) {
        // continue (Cues en fin de fichier : on a ce qu'il faut)
      }
    }
  };
  void segOff;
  scan(data, 0n, 0);
  scaleOut.scale = scale;
  return found;
}

describe("demux-wasm parity", () => {
  it("parse_cluster ≡ JS (Ice Age, 3 clusters)", async (t) => {
    try { await readFile(ICEAGE); }
    catch { t.skip("sample Ice Age absent (beta local uniquement)"); return; }
    const { parseBlock } = await import("../packages/mkv-demux/src/blocks.js");
    const { Reader, ID } = await import("../packages/mkv-demux/src/ebml.js");
    const { parseClusterJs } = await import("../packages/demux-compat/src/compat.js");
    const scale = { scale: 1000000n };
    const clusters = await firstClusters(ICEAGE, 3, scale);
    assert.ok(clusters.length >= 2);
    for (const payload of clusters) {
      // Référence = le chemin JS réel du compat (SimpleBlock + BlockGroup).
      const refBlocks = parseClusterJs(payload, scale.scale);
      const got = wasmParseCluster(payload, scale.scale);
      assert.equal(got.length, refBlocks.length, "même nombre de blocs");
      for (let i = 0; i < refBlocks.length; i++) {
        const g = got[i], w = refBlocks[i].block;
        const wpayload = refBlocks[i].payload;
        assert.equal(g.track, Number(w.track), `track bloc ${i}`);
        assert.equal(g.ptsNs, Number(w.ptsNs), `pts bloc ${i}`);
        assert.equal(g.key, w.key, `key bloc ${i}`);
        assert.equal(g.frames.length, w.frames.length, `frames bloc ${i}`);
        for (let j = 0; j < w.frames.length; j++) {
          assert.equal(g.frames[j].off, w.frames[j].off);
          assert.equal(g.frames[j].len, w.frames[j].len);
        }
        assert.ok(Buffer.from(g.data).equals(Buffer.from(wpayload)), `bytes bloc ${i}`);
      }
    }
  });

  it("parse_cues ≡ JS (Ice Age, queue de fichier)", async (t) => {
    try { await readFile(ICEAGE); }
    catch { t.skip("sample Ice Age absent (beta local uniquement)"); return; }
    const { parseCues: parseCuesJs } = await import("../packages/mkv-demux/src/ebml.js");
    const data = await readFile(ICEAGE);
    // Cues en queue : cherche l'ID Cues dans les derniers 2Mo.
    const tail = data.subarray(data.length - 2 * 1048576);
    const needle = Buffer.from([0x1c, 0x53, 0xbb, 0x6b]);
    const at = tail.indexOf(needle);
    assert.ok(at >= 0, "Cues trouvées");
    // Taille : lit le vint suivant (fenêtre : parse ce qui suit comme payload partiel).
    const { Reader, ID } = await import("../packages/mkv-demux/src/ebml.js");
    const r = new Reader(tail.subarray(at));
    const e = r.elem();
    assert.equal(e.id, ID.Cues);
    const payload = tail.subarray(at + r.p, at + r.p + Number(e.size));
    const js = parseCuesJs(payload, 1000000n);
    const rs = wasmParseCues(payload, 1000000n);
    assert.ok(js.length > 0 && rs.length > 0);
    assert.equal(rs.length, js.length);
    for (let i = 0; i < js.length; i++) {
      assert.equal(rs[i].timeNs, Number(js[i].timeNs), `cue ${i} temps`);
      assert.equal(rs[i].clusterPos, Number(js[i].clusterPos), `cue ${i} pos`);
    }
  });

  it("parse_cluster fixture (baseline synthétique)", async () => {
    const scale = { scale: 1000000n };
    const clusters = await firstClusters(FIXTURE, 2, scale);
    assert.ok(clusters.length >= 1);
    const got = wasmParseCluster(clusters[0], scale.scale);
    assert.ok(got.length > 0);
    assert.equal(got[0].key, true);
  });
});
