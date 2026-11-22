// app/render-worker.js — Slice 1 Phase 3 : serveur de dessin.
// Reçoit des VideoFrame transférables, les peint sur OffscreenCanvas, les ferme.
// Aucune décision de présentation ici (file/horloge/stale restent côté decode) :
// ce worker isole le coût GL/upload du thread démux+décode.
import {
  WebGLRenderer,
  WebGPURenderer,
  Canvas2DRenderer,
} from "./video-renderer.js";

let renderer = null;
let canvas = null;
let port = null; // vers decode worker (acks)
let drawn = 0, replaced = 0; // replaced = frame remplacée avant ré-affichage (normal)
// État couleur/HDR du flux courant (tone mapping côté renderer WebGL).
let colorState = { mode: "sdr", bt2020: false, peak: 203 };
// Capture E2E (opt-in) : image du canvas renvoyée au thread principal.
let capture = false;
let lastCapture = 0;
const CAPTURE_INTERVAL = 40; // ~25 fps

function maybeCapture() {
  if (!capture || !canvas) return;
  const now = performance.now();
  if (now - lastCapture < CAPTURE_INTERVAL) return;
  lastCapture = now;
  try {
    createImageBitmap(canvas).then((bitmap) => {
      try {
        self.postMessage({ type: "captureFrame", bitmap, ts: now }, [bitmap]);
      } catch { bitmap.close?.(); }
    }).catch(() => {});
  } catch {}
}
// Image courante (transférée) : ré-affichée à chaque tick, remplacée à
// chaque nouvelle frame, jetée sur 'clear'. Pas de file (le decode décide).
let inflight = null;
// Boucle rAF propre : ré-affiche l'image courante (nécessaire en WebGL sans
// preserveDrawingBuffer — le compositeur peut invalider le backbuffer).
// Même pixels que le worker d'origine (qui redessinait la tête à chaque tick).
let rafId = null, playing = false;
function loop() {
  rafId = null;
  if (!playing) return;
  if (inflight && renderer) {
    try {
      const r = renderer.draw(inflight);
      maybeCapture();
      if (r && typeof r.then === "function") r.catch((e) => console.error("Renderer draw error:", e));
    } catch (e) {
      console.error("Renderer draw error:", e);
    }
  }
  rafId = self.requestAnimationFrame(loop);
}
function playLoop() {
  if (rafId === null && playing) rafId = self.requestAnimationFrame(loop);
}

// Largeur d'affichage (pixels physiques) : le canvas ne peint pas plus grand
// que ce qui est visible (source 4K dans une fenêtre 1080p).
let maxDisplayWidth = 0;
let renderPref = ""; // "" = auto ; "webgl" | "canvas2d" | "webgpu" (?render=)
function applyMaxWidth() {
  try { renderer?.setMaxDisplayWidth?.(maxDisplayWidth); } catch {}
}

self.onmessage = async (e) => {
  const d = e.data;
  switch (d.type) {
    case "init":
      canvas = d.canvas;
      port = d.port;
      renderPref = String(d.render ?? "");
      // Les frames arrivent sur le PORT (decode worker), pas sur self :
      // sans onmessage le port file sans être lu et les frames s'entassent.
      port.onmessage = (ev) => onPortMessage(ev.data);
      renderer = await pickRenderer(canvas);
      applyMaxWidth();
      if (renderer.setColorState) renderer.setColorState(colorState);
      self.postMessage({ type: "renderReady", backend: renderer?.kind ?? "?" });
      break;
    case "play":
      playing = true;
      playLoop();
      break;
    case "pause":
      playing = false;
      if (rafId !== null) { try { self.cancelAnimationFrame(rafId); } catch {} rafId = null; }
      break;
    case "stats":
      self.postMessage({ type: "renderStats", drawn, replaced, hasFrame: !!inflight });
      break;
    case "displaySize":
      maxDisplayWidth = Math.max(0, d.width | 0);
      applyMaxWidth();
      break;
    case "capture":
      // Mode test E2E (?capture=1) : renvoie des ImageBitmap du canvas vers
      // le thread principal pour l'enregistrement A/V (MediaRecorder).
      capture = !!d.enabled;
      break;
    default:
      break;
  }
};

// Frames + clear depuis le decode worker (canal dédié).
async function onPortMessage(d) {
  if (!d) return;
  if (d.type === "frame") {
    // Nouvelle image à afficher : remplace la courante (fermée), peinte
    // aussitôt (le loop la ré-affichera ensuite à chaque tick).
    if (!renderer || !d.frame) {
      // Toujours acquitter : le decode worker limite les frames en vol (2).
      try { d.frame?.close?.(); } catch {}
      try { port?.postMessage({ type: "drawn" }); } catch {}
      return;
    }
    if (inflight) { try { inflight.close(); } catch {} replaced++; }
    inflight = d.frame;
    try {
      const r = renderer.draw(inflight);
      maybeCapture();
      drawn++;
      if (r && typeof r.then === "function") {
        r.then(() => port?.postMessage({ type: "drawn" }));
      } else {
        port?.postMessage({ type: "drawn" });
      }
    } catch (err) {
      console.error("Renderer draw error:", err);
      try { port?.postMessage({ type: "drawn" }); } catch {}
    }
    return;
  }
  if (d.type === "color") {
    // Nouvel état couleur (ouverture / changement de piste vidéo).
    colorState = { ...colorState, ...(d.state ?? {}) };
    const hdr = colorState.mode === "pq" || colorState.mode === "hlg";
    if (renderer?.setColorState) {
      renderer.setColorState(colorState);
    } else if (hdr && renderer) {
      // WebGPU/Canvas2D : pas de tone mapping ici → bascule WebGL (v1).
      try { renderer.clear?.(); } catch {}
      const next = await pickRenderer(canvas, { preferWebGL: true });
      next.setColorState?.(colorState);
      renderer = next;
      applyMaxWidth();
      console.log(`[render] HDR (${colorState.mode}): WebGL render + tone mapping`);
    }
    if (inflight) {
      try { renderer.draw(inflight); } catch {}
    }
    return;
  }
  if (d.type === "clear") {
    // Oublie l'image (seek/track-change) SANS effacer le canvas — parité
    // avec l'origine (l'ancien pixels restent jusqu'aux prochaines frames).
    if (inflight) { try { inflight.close(); } catch {} inflight = null; }
    return;
  }
}

async function pickRenderer(c, { preferWebGL = false } = {}) {
  // Même ordre et mêmes sondes qu'AVERA d'origine (worker.js createRenderer).
  // ?render=webgl|canvas2d : diagnostic/contournement GPU (HDR = WebGL).
  if (!preferWebGL && renderPref === "canvas2d") {
    console.log("Canvas2D forced (?render=canvas2d)");
    const r = new Canvas2DRenderer(c, c.getContext("2d"));
    r.kind = "2d";
    return r;
  }
  if (!preferWebGL && renderPref === "webgl") {
    const g2 = c.getContext("webgl2");
    if (g2) {
      console.log("WebGL2 forced (?render=webgl)");
      const r = new WebGLRenderer(c, "webgl2", g2);
      r.kind = "webgl2";
      return r;
    }
    const g1 = c.getContext("webgl");
    if (g1) {
      console.log("WebGL1 forced (?render=webgl)");
      const r = new WebGLRenderer(c, "webgl", g1);
      r.kind = "webgl";
      return r;
    }
    console.warn("WebGL unavailable, falling back automatically");
  }
  if (!preferWebGL && renderPref !== "canvas2d" && typeof WebGPURenderer !== "undefined" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        console.log("Using WebGPU renderer");
        const r = new WebGPURenderer(c);
        r.kind = "webgpu";
        return r;
      }
    } catch (e) {
      console.warn("WebGPU not available, falling back to WebGL:", e);
    }
  }
  const gl2 = c.getContext("webgl2");
  if (gl2) {
    console.log("Using WebGL2 renderer");
    const r = new WebGLRenderer(c, "webgl2", gl2);
    r.kind = "webgl2";
    return r;
  }
  const gl1 = c.getContext("webgl");
  if (gl1) {
    console.log("Using WebGL renderer");
    const r = new WebGLRenderer(c, "webgl", gl1);
    r.kind = "webgl";
    return r;
  }
  console.log("Falling back to Canvas2D renderer");
  const r = new Canvas2DRenderer(c, c.getContext("2d"));
  r.kind = "2d";
  return r;
}
