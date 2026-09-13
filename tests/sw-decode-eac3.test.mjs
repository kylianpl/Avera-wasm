// tests/sw-decode-eac3.test.mjs — fallback audio logiciel (E)AC-3 (Phase 4).
// Stratégie : paquets élémentaires (frames (E)AC-3 découpées par sync word)
// → EAC3Session → PCM float, vérifié contre le signal analytique connu
// (sinusoïdes lavfi) + reprise exacte post-flush + wiring compat.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createEAC3Session,
} from "../packages/sw-decode/src/eac3.js";
import { splitAc3Frames } from "../packages/sw-decode/src/ac3frames.js";
import {
  ff_init_decoder,
  ff_decode_multi,
  ff_free_decoder,
  avcodec_flush_buffers,
} from "../packages/demux-compat/src/compat.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = (n) => join(root, "tests", "fixtures", n);

/** Corrélation maximale (insensible à l'amplitude ET au retard encodeur/
 *  décodeur ~512 éch.) contre sin(2πft/sr), lag cherché sur ±2000 éch. */
function sineCorrelation(pcm, ch, channels, freq, sr, skipFrames = 0, useFrames = 20) {
  const start = skipFrames * 1536;
  const n = Math.min(useFrames * 1536, pcm.length / channels - start);
  let best = -1;
  for (let lag = -2000; lag <= 2000; lag += 4) {
    let num = 0, dg = 0, dr = 0;
    for (let k = 0; k < n; k++) {
      const j = start + k + lag;
      if (j < 0 || (j + 1) * channels > pcm.length) continue;
      const g = pcm[j * channels + ch];
      const r = Math.sin((2 * Math.PI * freq * (start + k)) / sr);
      num += g * r; dg += g * g; dr += r * r;
    }
    const c = num / Math.sqrt(dg * dr);
    if (c > best) best = c;
  }
  return best;
}

function rms(pcm, ch, channels) {
  let e = 0, n = 0;
  for (let i = ch; i < pcm.length; i += channels) { e += pcm[i] * pcm[i]; n++; }
  return Math.sqrt(e / n);
}

async function decodeAll(session, frames, tbUs = 1000) {
  const chunks = [];
  let t = 0;
  for (const f of frames) {
    const out = session.decode(f, t);
    assert.equal(out.length, 1);
    assert.equal(out[0].nb_samples, 1536);
    chunks.push(out[0].data);
    t += tbUs;
  }
  const total = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) { total.set(c, o); o += c.length; }
  return total;
}

await test("sw-decode-eac3", async (t) => {
  await t.test("AC-3 stéréo → PCM fidèle au sinus 440Hz", async () => {
    const raw = await readFile(FIX("ac3-stereo.ac3"));
    const frames = splitAc3Frames(raw);
    assert.ok(frames.length >= 30, `${frames.length} frames AC-3`);
    const session = await createEAC3Session({ family: "ac3", channels: 2, sampleRate: 48000 });
    try {
      const pcm = await decodeAll(session, frames);
      assert.equal(pcm.length, frames.length * 1536 * 2);
      assert.ok(sineCorrelation(pcm, 0, 2, 440, 48000) > 0.995, "voie L ≈ sinus");
      assert.ok(sineCorrelation(pcm, 1, 2, 440, 48000) > 0.995, "voie R ≈ sinus");
    } finally {
      session.destroy();
    }
  });

  await t.test("E-AC-3 stéréo → PCM fidèle au sinus 440Hz", async () => {
    const raw = await readFile(FIX("eac3-stereo.ec3"));
    const frames = splitAc3Frames(raw);
    assert.ok(frames.length >= 30, `${frames.length} frames E-AC-3`);
    const session = await createEAC3Session({ family: "eac3", channels: 2, sampleRate: 48000 });
    try {
      const pcm = await decodeAll(session, frames);
      assert.ok(sineCorrelation(pcm, 0, 2, 440, 48000) > 0.995, "voie L ≈ sinus");
      assert.ok(sineCorrelation(pcm, 1, 2, 440, 48000) > 0.995, "voie R ≈ sinus");
    } finally {
      session.destroy();
    }
  });

  await t.test("E-AC-3 5.1 → 6 voies alimentées", async () => {
    const raw = await readFile(FIX("eac3-51.ec3"));
    const frames = splitAc3Frames(raw);
    assert.ok(frames.length >= 10, `${frames.length} frames 5.1`);
    const session = await createEAC3Session({ family: "eac3", channels: 6, sampleRate: 48000 });
    try {
      const pcm = await decodeAll(session, frames);
      assert.equal(pcm.length, frames.length * 1536 * 6);
      for (let c = 0; c < 6; c++) {
        assert.ok(rms(pcm, c, 6) > 0.01, `voie ${c} alimentée (rms=${rms(pcm, c, 6).toFixed(3)})`);
      }
    } finally {
      session.destroy();
    }
  });

  await t.test("reset : reprise à froid déterministe + proche du continu", async () => {
    const raw = await readFile(FIX("eac3-stereo.ec3"));
    const frames = splitAc3Frames(raw);
    async function run(feed, doFlush) {
      const s = await createEAC3Session({ family: "eac3", channels: 2, sampleRate: 48000 });
      try {
        const chunks = [];
        let t = 0;
        for (const step of feed) {
          if (step === "flush") { s.reset(); continue; }
          for (const f of step) { chunks.push(s.decode(f, t)[0].data); t += 1000; }
        }
        const total = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
        let o = 0;
        for (const c of chunks) { total.set(c, o); o += c.length; }
        return total;
      } finally {
        s.destroy();
      }
    }
    const cold = await run([frames.slice(10)]); // démarrage à froid (cas seek)
    const resumed = await run([frames.slice(0, 10), "flush", frames.slice(10)]);
    const tail = resumed.subarray(10 * 1536 * 2);
    // 1) Le flush réinitialise totalement l'historique : reprise bit-exacte.
    assert.equal(tail.length, cold.length);
    for (let i = 0; i < tail.length; i++) assert.equal(tail[i], cold[i], `échantillon ${i}`);
    // 2) Proche du décodage continu (écart borné : overlap froid + historique
    // verrouillé — dialnorm/AHT — comme tout seek avec flush, ffmpeg inclus).
    const cont = await run([frames]);
    const refTail = cont.subarray(10 * 1536 * 2);
    let m0 = 0, mRest = 0;
    for (let i = 0; i < cold.length; i++) {
      const d = Math.abs(cold[i] - refTail[i]);
      if (i < 1536 * 2) { if (d > m0) m0 = d; }
      else if (d > mRest) mRest = d;
    }
    assert.ok(m0 < 0.15, `1re frame post-seek bornée (max=${m0.toExponential(2)})`);
    assert.ok(mRest < 5e-5, `convergence immédiate (max=${mRest.toExponential(2)})`);
  });

  await t.test("wiring compat : ff_init_decoder/décode/flush/free (eac3)", async () => {
    const [, ctx] = await ff_init_decoder(86055, { family: "eac3", channels: 2, sampleRate: 48000 });
    const raw = await readFile(FIX("eac3-stereo.ec3"));
    const frames = splitAc3Frames(raw).slice(0, 4);
    const packets = frames.map((data, i) => ({
      data, size: data.length, pts: BigInt(i * 32000000), dts: BigInt(i * 32000000),
      time_base_num: 1, time_base_den: 1000000000, duration: 32000000, key: true,
    }));
    const out = await ff_decode_multi(ctx, {}, {}, packets);
    assert.equal(out.length, 4);
    assert.equal(out[0].format, 3);
    assert.ok(out[0].data instanceof Float32Array);
    assert.equal(out[2].pts, 64000); // pts ns → µs
    await avcodec_flush_buffers(ctx);
    const out2 = await ff_decode_multi(ctx, {}, {}, packets.slice(0, 1));
    assert.equal(out2.length, 1);
    await ff_free_decoder(ctx);
  });
});
