// tests/e2e/run.mjs — tests de bout en bout navigateurs réels (Chromium + Firefox).
//
// Ce que ça vérifie (au-delà des tests unitaires) :
//  1. Le média se lit (frames réellement dessinées, pas d'écran noir).
//  2. Le rythme (fps) et les drops (stats du player + unicité des frames
//     enregistrées).
//  3. L'audio : présent, non silencieux, cadencé comme le média (beeps à
//     1 s / 4 s / 7 s sur la fixture de sync).
//  4. La synchro A/V : flashs vidéo vs onsets audio DANS le même
//     enregistrement (MediaRecorder canvas+audio) + dérive interne (avDrift).
//  5. Le seek : la lecture reprend et les frames continuent.
//  6. HDR : tone mapping vérifié numériquement (fixture PQ à niveaux connus).
//  7. Sous-titres : cue affichée à l'instant attendu.
//  8. Décodage logiciel (HEVC/WASM) : frames visibles (régression passée : noir).
//
// Usage :
//   node tests/e2e/run.mjs [--browser=chromium,firefox] [--outdir=/tmp/e2e]
//                          [--scenario=all|sync|playback|hdr|subs|sw]
//   (le serveur doit tourner : node server.mjs --port 8899)
// Playwright est un outil de test optionnel : chemin surchargeable via
// PLAYWRIGHT_CORE (fichier index.mjs), sinon résolution npm classique.
const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const { chromium, firefox } = pw;
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8899";
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const BROWSERS = String(args.browser ?? "chromium,firefox").split(",");
const SCENARIO = String(args.scenario ?? "all");
const OUT = String(args.outdir ?? "/tmp/opencode/e2e");
const FIX = (n) => `../tests/fixtures/${n}`;
const MEDIA = (n) => `../media/${n}`;

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  const mark = ok ? "ok  " : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Environnement sans sortie audio (headless) : on ne peut pas valider le son.
function skip(name, why) {
  results.push({ name, skipped: true, detail: why });
  console.log(`  [skip] ${name} — ${why}`);
}

async function audioAvailable(page) {
  const st = await page.evaluate(() => window.__e2e?.audioState?.() ?? null);
  return !!st && st.state === "running";
}

// ---------------------------------------------------------------- init script
// Injection AVANT les scripts de la page : tap audio + capture des messages
// des workers (stats du player) + neutralisation des gestes automatiques.
const INIT = `
(() => {
  window.__messages = [];
  const OW = window.Worker;
  window.Worker = function (url, opts) {
    const w = new OW(url, opts);
    try {
      w.addEventListener("message", (e) => {
        const d = e.data;
        if (d && typeof d.type === "string") window.__messages.push(d);
      });
    } catch {}
    return w;
  };
  window.Worker.prototype = OW.prototype;

  // Tap audio : duplique tout ce qui va vers destination dans un
  // MediaStreamDestination (pour l'enregistrement E2E).
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    try {
      const ctx = dest && dest.context;
      if (ctx && dest === ctx.destination) {
        if (!ctx.__tap) {
          ctx.__tap = ctx.createMediaStreamDestination();
          window.__tapDest = ctx.__tap;
        }
        origConnect.call(this, ctx.__tap);
      }
    } catch {}
    return r;
  };
})();
`;

// ---------------------------------------------------------------- helpers
async function launch(name) {
  const common = { headless: true };
  if (name === "chromium") {
    return chromium.launch({
      ...common,
      executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
    });
  }
  return firefox.launch({ ...common });
}

async function openPlayer(page, src, extra = "") {
  await page.goto(`${BASE}/app/index.html?src=${src}${extra}`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById("playStopButton").disabled, null, { timeout: 30000 });
}

async function play(page) {
  // Volume UI par défaut = 1 % : le monter pour que le tap audio soit audible
  // (sinon toute mesure audio paraît silencieuse).
  await page.evaluate(() => {
    const v = document.getElementById("volumeControl");
    v.value = "1";
    v.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#playStopButton");
  await page.waitForFunction(() => document.getElementById("currentTime").textContent !== "Loading...", null, { timeout: 10000 });
  // Le tap audio n'existe qu'après la connexion gainNode→destination.
  await page.waitForFunction(() => !!window.__tapDest?.stream, null, { timeout: 8000 }).catch(() => {});
}

async function startRecording(page, seconds) {
  return page.evaluate(async ({ seconds }) => {
    const cap = window.__capture;
    if (!cap) throw new Error("mode capture absent (?capture=1)");
    const v = cap.canvas.captureStream(25);
    const tracks = [...v.getVideoTracks()];
    if (window.__tapDest?.stream) tracks.push(...window.__tapDest.stream.getAudioTracks());
    const stream = new MediaStream(tracks);
    const mimes = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
    const mimeType = mimes.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 4_000_000 } : undefined);
    window.__rec = { rec, chunks: [], started: performance.now() };
    rec.ondataavailable = (e) => { if (e.data.size) window.__rec.chunks.push(e.data); };
    rec.start(250);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await new Promise((resolve) => {
      rec.onstop = resolve;
      rec.stop();
      setTimeout(resolve, 3000);
    });
    const blob = new Blob(window.__rec.chunks, { type: "video/webm" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return { b64: btoa(bin), mime: blob.type, frames: cap.frames ?? 0 };
  }, { seconds });
}

function saveRecording(b64, path) {
  return writeFile(path, Buffer.from(b64, "base64"));
}

// Analyse vidéo : frames grises 32x18 → moyennes + hash (unicité/drops).
function analyzeVideo(webm) {
  // L'enregistrement canvas est VFR : les timestamps viennent de ffprobe
  // (pas d'index/25, qui fausserait toutes les mesures de temps).
  let pts = [];
  try {
    const j = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "frame=pts_time", "-of", "json", webm,
    ], { maxBuffer: 1 << 26 }).toString());
    pts = (j.frames ?? []).map((f) => Number(f.pts_time)).filter((t) => Number.isFinite(t));
  } catch {}
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", webm, "-an", "-fps_mode", "passthrough",
    "-vf", "scale=32:18,format=gray", "-f", "rawvideo", "-",
  ], { maxBuffer: 1 << 28 });
  const N = 32 * 18;
  const n = Math.floor(raw.length / N);
  const frames = [];
  for (let i = 0; i < n; i++) {
    let sum = 0, sum2 = 0;
    for (let k = 0; k < N; k++) {
      const v = raw[i * N + k];
      sum += v; sum2 += v * v;
    }
    frames.push({ mean: sum / N, hash: `${Math.round(sum)}:${Math.round(sum2)}`, t: pts[i] ?? i / 25 });
  }
  return frames;
}

// Analyse audio : f32 mono 48 kHz → onsets (fenêtres 20 ms > seuil).
function analyzeAudio(webm) {
  let raw;
  try {
    raw = execFileSync("ffmpeg", [
      "-v", "error", "-i", webm, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-",
    ], { maxBuffer: 1 << 28 });
  } catch {
    return null;
  }
  const n = Math.floor(raw.length / 4);
  if (!n) return null;
  const s = new Float32Array(raw.buffer, raw.byteOffset, n);
  const win = 960; // 20 ms
  const rms = [];
  for (let i = 0; i + win <= n; i += win) {
    let e = 0;
    for (let k = 0; k < win; k++) e += s[i + k] * s[i + k];
    rms.push(Math.sqrt(e / win));
  }
  const peak = Math.max(...rms);
  const onsets = [];
  let active = false;
  for (let i = 0; i < rms.length; i++) {
    const on = rms[i] > Math.max(0.02, peak * 0.2);
    if (on && !active) onsets.push((i * win) / 48000);
    active = on;
  }
  return { onsets, peak, duration: n / 48000 };
}

function firstFlashes(frames, threshold = 200) {
  const out = [];
  let on = false;
  for (const fr of frames) {
    const f = fr.mean > threshold;
    if (f && !on) out.push(fr.t);
    on = f;
  }
  return out;
}

async function statsFrom(page) {
  await page.evaluate(() => window.__e2e?.requestStats?.()).catch(() => {});
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const m = window.__messages ?? [];
    const drift = m.filter((x) => x.type === "avDrift").map((x) => x.driftMs ?? 0);
    const stats = m.filter((x) => x.type === "statsReport");
    const render = m.filter((x) => x.type === "renderStats");
    const lag = m.filter((x) => x.type === "workerLagReport");
    const last = stats[stats.length - 1] ?? {};
    const lastRender = render[render.length - 1] ?? {};
    return {
      driftMax: drift.length ? Math.max(...drift.map(Math.abs)) : 0,
      driftSamples: drift.length,
      vFed: last.vFed ?? 0, vOut: last.vOut ?? 0,
      posted: last.posted ?? 0, staleDropped: last.staleDropped ?? 0,
      drawn: lastRender.drawn ?? 0, replaced: lastRender.replaced ?? 0,
      fps: lag.length ? lag[lag.length - 1].fps : null,
      captureFrames: window.__capture?.frames ?? 0,
    };
  });
}

async function seekTo(page, ratio) {
  await page.evaluate(({ ratio }) => {
    const bar = document.getElementById("progressBar");
    const r = bar.getBoundingClientRect();
    bar.dispatchEvent(new MouseEvent("click", {
      bubbles: true, clientX: r.left + r.width * ratio, clientY: r.top + r.height / 2,
    }));
  }, { ratio });
}

// ---------------------------------------------------------------- scénarios
async function scenarioSync(browser, name) {
  console.log(`\n== [${name}] A/V sync + audio (av-sync-10s.mkv)`);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(INIT);
  await openPlayer(page, FIX("av-sync-10s.mkv"), "&capture=1");
  await play(page);
  const hasAudio = await audioAvailable(page);
  if (!hasAudio) skip("audio (headless sans périphérique)", "AudioContext suspendu — son non testable ici");
  const rec = await startRecording(page, 9);
  const out = join(OUT, `${name}-sync.webm`);
  await saveRecording(rec.b64, out);
  const frames = analyzeVideo(out);
  const audio = analyzeAudio(out);
  const flashes = firstFlashes(frames).filter((t) => t > 0.2);
  check("enregistrement vidéo non vide", frames.length > 100, `${frames.length} frames`);
  check("frames non noires", frames.some((f) => f.mean > 100), `max mean=${Math.round(Math.max(...frames.map((f) => f.mean)))}`);
  check("flashs détectés (1 s / 4 s / 7 s)", flashes.length >= 3, `t=${flashes.map((t) => t.toFixed(2)).join(", ")}`);
  const gaps = flashes.slice(1).map((t, i) => t - flashes[i]);
  check("période des flashs ≈ 3 s", gaps.every((g) => Math.abs(g - 3) < 0.2), `écarts=${gaps.map((g) => g.toFixed(2)).join(", ")}`);
  if (hasAudio) {
    check("audio présent et non silencieux", !!audio && audio.peak > 0.05, audio ? `pic=${audio.peak.toFixed(3)} durée=${audio.duration.toFixed(1)}s` : "pas de piste audio");
  }
  if (hasAudio && audio) {
    const onsets = audio.onsets.filter((_, i) => i < 4);
    const og = onsets.slice(1).map((t, i) => t - onsets[i]);
    check("beeps détectés (espacement ≈ 3 s)", onsets.length >= 3 && og.every((g) => Math.abs(g - 3) < 0.2),
      `onsets=${onsets.map((t) => t.toFixed(2)).join(", ")}`);
    if (flashes.length && onsets.length) {
      // Le tap audio (MediaStreamDestination) est pris à la sortie du graphe,
      // SANS la latence de sortie ; le lecteur, lui, cale la vidéo sur le son
      // ENTENDU (getMediaTime soustrait outputLatency). On compense donc la
      // latence de sortie avant de juger la synchro.
      const latMs = await page.evaluate(() => {
        const a = window.__e2e?.audioState?.();
        return a ? ((a.outputLatency ?? 0) + (a.baseLatency ?? 0)) * 1000 : 0;
      });
      const offsets = [];
      for (const f of flashes) {
        const near = onsets.reduce((b, o) => (Math.abs(o - f) < Math.abs(b - f) ? o : b), onsets[0]);
        offsets.push(near - f + latMs / 1000);
      }
      const max = Math.max(...offsets.map(Math.abs));
      check("synchro A/V dans l'enregistrement (< 120 ms)", max < 0.12,
        `décalages=${offsets.map((o) => (o * 1000).toFixed(0) + "ms").join(", ")}` +
        ` (latence sortie ${latMs.toFixed(0)} ms compensée)`);
    }
  }
  const st = await statsFrom(page);
  if (hasAudio) {
    check("aucune dérive A/V > 100 ms signalée", st.driftMax < 100,
      st.driftSamples ? `${st.driftMax.toFixed(0)} ms sur ${st.driftSamples} mesures` : "aucune alerte (seuil 100 ms)");
  }
  check("aucune erreur console", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
  return { st, frames: frames.length };
}

async function scenarioPlayback(browser, name) {
  console.log(`\n== [${name}] lecture + seek + rythme (beta-60s.mkv)`);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(INIT);
  await openPlayer(page, MEDIA("beta-60s.mkv"), "&capture=1");
  await play(page);
  const rec = await startRecording(page, 7);
  await saveRecording(rec.b64, join(OUT, `${name}-playback.webm`));
  const before = await statsFrom(page);
  await seekTo(page, 0.7);
  // Le seek peut prendre > 1 s (préroll) : attendre que l'horloge saute.
  await page.waitForFunction(() => {
    const t = document.getElementById("currentTime").textContent;
    const [m, s] = t.split(":").map(Number);
    return m * 60 + s > 20;
  }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const after = await statsFrom(page);
  const frames = analyzeVideo(join(OUT, `${name}-playback.webm`));
  const unique = new Set(frames.map((f) => f.hash)).size;
  const freezes = [];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].hash === frames[i - 1].hash) {
      let j = i;
      while (j < frames.length && frames[j].hash === frames[i].hash) j++;
      const dur = frames[j] ? frames[j].t - frames[i].t : 0;
      if (dur > 0.5) freezes.push({ at: frames[i].t, dur });
      i = j;
    }
  }
  check("frames enregistrées", frames.length > 100, `${frames.length} frames`);
  check("contenu réel (frames distinctes)", unique / frames.length > 0.5, `${unique}/${frames.length} uniques`);
  check("pas de freeze > 500 ms", freezes.length === 0, freezes.map((f) => `@${f.at.toFixed(1)}s ${f.dur.toFixed(1)}s`).join(", "));
  check("rendu non noir", Math.max(...frames.map((f) => f.mean)) > 20, `max=${Math.max(...frames.map((f) => f.mean)).toFixed(0)}`);
  check("frames postées au render", before.posted > 50, `${before.posted} postées, ${before.drawn} dessinées`);
  // Ce qui compte visuellement : les frames décodées finissent-elles à
  // l'écran ? (staleDropped compte les sauts de rattrapage quand le décode
  // est légèrement en retard : ce n'est pas une perte de frame.)
  check("frames décodées réellement affichées (≥ 85 %)", before.vOut === 0 || before.posted / before.vOut >= 0.85,
    `${before.posted} affichées / ${before.vOut} décodées (${before.staleDropped} rattrapages)`);
  if (await audioAvailable(page)) {
    check("dérive < 100 ms", before.driftMax < 100, `${before.driftMax.toFixed(0)} ms`);
  } else {
    skip("dérive A/V", "audio indisponible (headless)");
  }
  const seeked = await page.evaluate(() => document.getElementById("currentTime").textContent);
  check("seek effectif (~42 s)", /:4[0-9]|:3[5-9]/.test(seeked), `t=${seeked}`);
  check("reprise après seek (nouvelles frames)", after.posted > before.posted, `${before.posted} → ${after.posted}`);
  check("aucune erreur console", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
  return { before, after };
}

async function scenarioHdr(browser, name) {
  console.log(`\n== [${name}] HDR10 → SDR (mkv-hevc-hdr10-pq.mkv)`);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.addInitScript(INIT);
  await openPlayer(page, FIX("mkv-hevc-hdr10-pq.mkv"), "&capture=1");
  await play(page);
  await page.waitForTimeout(900);
  const px = await page.evaluate(() => {
    const c = window.__capture.canvas;
    const t = document.createElement("canvas"); t.width = 64; t.height = 36;
    const g = t.getContext("2d"); g.drawImage(c, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    const avg = (x0, x1) => {
      let s = 0, n = 0;
      for (let y = 4; y < 32; y++) for (let x = x0; x < x1; x++) {
        const i = (y * 64 + x) * 4;
        s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++;
      }
      return s / n;
    };
    return { left: avg(2, 26), right: avg(38, 62) };
  });
  check("tone mapping actif (log [hdr])", logs.some((l) => l.includes("[hdr] stream pq")),
    logs.find((l) => l.includes("[hdr] stream pq")) ?? "absent");
  // 100 nits PQ → ~204 (sRGB), 1000 nits → ~253 ; sans mapping : 130/192.
  check("100 nits mappés (~180-230)", px.left > 180 && px.left < 235, `gauche=${px.left.toFixed(0)}`);
  check("1000 nits mappés (~235-255)", px.right > 235, `droite=${px.right.toFixed(0)}`);
  check("mapping effectif (pas 130/192 bruts)", px.left > 160 && px.right > 200, `${px.left.toFixed(0)}/${px.right.toFixed(0)}`);
  await ctx.close();
  return px;
}

async function scenarioSubs(browser, name) {
  console.log(`\n== [${name}] sous-titres (mkv-sub-srt-ass.mkv)`);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  await openPlayer(page, FIX("mkv-sub-srt-ass.mkv"));
  const opts = await page.$$eval("#subtitleStream option", (os) => os.map((o) => o.textContent));
  check("pistes sous-titres listées", opts.length >= 3, opts.join(" | "));
  await page.selectOption("#subtitleStream", "2").catch(async () => {
    await page.evaluate(() => {
      const s = document.getElementById("subtitleStream");
      s.value = "2"; s.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  await play(page);
  await page.waitForTimeout(700);
  await seekTo(page, 0.3);
  await page.waitForTimeout(500);
  const txt = await page.evaluate(() => document.getElementById("subtitleOverlay").innerText);
  check("cue SRT affichée après seek", txt.includes("Hello world"), JSON.stringify(txt));
  await page.evaluate(() => {
    const s = document.getElementById("subtitleStream");
    s.value = "3"; s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(900);
  await seekTo(page, 0.3);
  await page.waitForTimeout(500);
  const txt2 = await page.evaluate(() => document.getElementById("subtitleOverlay").innerText);
  check("cue ASS affichée (override retiré)", txt2.includes("Hello bold world"), JSON.stringify(txt2));
  await ctx.close();
  return { txt, txt2 };
}

async function scenarioSw(browser, name) {
  console.log(`\n== [${name}] décodage logiciel HEVC (hevc-sample.mkv)`);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.addInitScript(INIT);
  await openPlayer(page, FIX("hevc-sample.mkv"), "&capture=1");
  await play(page);
  await page.waitForTimeout(900);
  const px = await page.evaluate(() => {
    const c = window.__capture.canvas;
    const t = document.createElement("canvas"); t.width = 32; t.height = 18;
    const g = t.getContext("2d"); g.drawImage(c, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    let s = 0, s2 = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      s += l; s2 += l * l;
    }
    return { mean: s / n, std: Math.sqrt(s2 / n - (s / n) ** 2) };
  });
  check("libde265 utilisé", logs.some((l) => l.includes("libde265")), "");
  check("image SW visible (non noire, contrastée)", px.mean > 10 && px.std > 8,
    `moyenne=${px.mean.toFixed(0)} écart-type=${px.std.toFixed(0)}`);
  await ctx.close();
  return px;
}

// ---------------------------------------------------------------- main
await mkdir(OUT, { recursive: true });
const report = {};
for (const name of BROWSERS) {
  console.log(`\n######## ${name} ########`);
  let browser;
  try {
    browser = await launch(name);
  } catch (e) {
    check(`lancement ${name}`, false, e.message.split("\n")[0]);
    continue;
  }
  const entry = {};
  try {
    if (SCENARIO === "all" || SCENARIO === "sync") entry.sync = await scenarioSync(browser, name);
    if (SCENARIO === "all" || SCENARIO === "playback") entry.playback = await scenarioPlayback(browser, name);
    if (SCENARIO === "all" || SCENARIO === "hdr") entry.hdr = await scenarioHdr(browser, name);
    if (SCENARIO === "all" || SCENARIO === "subs") entry.subs = await scenarioSubs(browser, name);
    if (SCENARIO === "all" || SCENARIO === "sw") entry.sw = await scenarioSw(browser, name);
  } catch (e) {
    check(`scénario ${name}`, false, e.message.split("\n")[0]);
  } finally {
    await browser.close().catch(() => {});
  }
  report[name] = entry;
}

await writeFile(join(OUT, "report.json"), JSON.stringify({ results, report }, null, 2));
const total = results.length;
const skipped = results.filter((r) => r.skipped).length;
const ok = results.filter((r) => r.ok).length;
console.log(`\n===== ${ok}/${total - skipped} vérifications OK, ${skipped} ignorées (${OUT}/report.json) =====`);
if (failures) {
  console.log("ÉCHECS :");
  for (const r of results.filter((x) => x.ok === false)) console.log(` - [${r.name}] ${r.detail ?? ""}`);
}
process.exit(failures ? 1 : 0);
