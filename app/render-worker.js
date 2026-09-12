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
let drawn = 0, dropped = 0;
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

self.onmessage = async (e) => {
  const d = e.data;
  switch (d.type) {
    case "init":
      canvas = d.canvas;
      port = d.port;
      // Les frames arrivent sur le PORT (decode worker), pas sur self :
      // sans onmessage le port file sans être lu et les frames s'entassent.
      port.onmessage = (ev) => onPortMessage(ev.data);
      renderer = await pickRenderer(canvas);
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
      self.postMessage({ type: "renderStats", drawn, dropped, hasFrame: !!inflight });
      break;
    default:
      break;
  }
};

// Frames + clear depuis le decode worker (canal dédié).
function onPortMessage(d) {
  if (!d) return;
  if (d.type === "frame") {
    // Nouvelle image à afficher : remplace la courante (fermée), peinte
    // aussitôt (le loop la ré-affichera ensuite à chaque tick).
    if (!renderer || !d.frame) return;
    if (inflight) { try { inflight.close(); } catch {} dropped++; }
    inflight = d.frame;
    try {
      const r = renderer.draw(inflight);
      drawn++;
      if (r && typeof r.then === "function") {
        r.then(() => port?.postMessage({ type: "drawn" }));
      } else {
        port?.postMessage({ type: "drawn" });
      }
    } catch (err) {
      console.error("Renderer draw error:", err);
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

async function pickRenderer(c) {
  // Même ordre et mêmes sondes qu'AVERA d'origine (worker.js createRenderer).
  if (typeof WebGPURenderer !== "undefined" && navigator.gpu) {
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
  if (c.getContext("webgl2")) {
    console.log("Using WebGL2 renderer");
    const r = new WebGLRenderer(c, "webgl2");
    r.kind = "webgl2";
    return r;
  }
  if (c.getContext("webgl")) {
    console.log("Using WebGL renderer");
    const r = new WebGLRenderer(c, "webgl");
    r.kind = "webgl";
    return r;
  }
  console.log("Falling back to Canvas2D renderer");
  const r = new Canvas2DRenderer(c);
  r.kind = "2d";
  return r;
}
