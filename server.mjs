// server.mjs — statique racine avera-wasm + Range + COOP/COEP (SAB requis).
// Usage: node server.mjs --port 8899
//   TLS: node server.mjs --port 8455 --tls --cert <crt> --key <key>
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, statSync, createReadStream } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const argv = (k, d) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? d : (process.argv[i + 1] ?? d);
};
const port = Number(argv("--port", 8899));
const useTls = argv("--tls", null) !== null;
const ROOT = new URL(".", import.meta.url).pathname;
const MIME = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html",
  ".json": "application/json", ".mkv": "video/x-matroska", ".mp4": "video/mp4",
  ".wasm": "application/wasm",
};

const handler = (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Accept-Ranges", "bytes");
  try {
    const url = new URL(req.url, "http://x");
    let p = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let st = null;
    try { st = statSync(p); } catch {}
    if (st?.isDirectory()) p = join(p, "index.html");
    try { st = statSync(p); } catch { res.writeHead(404).end("nope"); return; }
    if (!st.isFile()) { res.writeHead(404).end("nope"); return; }
    const mime = MIME[extname(p)] ?? "application/octet-stream";
    const total = st.size;
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": mime, "Content-Length": total }).end();
      return;
    }
    const h = req.headers.range;
    if (!h) {
      res.writeHead(200, { "Content-Type": mime, "Content-Length": total });
      createReadStream(p).on("error", () => { try { res.destroy(); } catch {} }).pipe(res);
      return;
    }
    const m = h.match(/bytes=(\d*)-(\d*)/);
    if (!m) { res.writeHead(416, { "Content-Range": `bytes */${total}` }).end(); return; }
    const start = m[1] === "" ? Math.max(0, total - Number(m[2] || 0)) : Number(m[1]);
    const end = m[2] === "" ? total - 1 : Math.min(total - 1, Number(m[2]));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || end < start) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": mime,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": end - start + 1,
    });
    createReadStream(p, { start, end }).on("error", () => { try { res.destroy(); } catch {} }).pipe(res);
  } catch (e) {
    res.writeHead(500).end(String(e?.message ?? e));
  }
};
void sep;
const server = useTls
  ? createHttpsServer({ key: readFileSync(argv("--key", "")), cert: readFileSync(argv("--cert", "")) }, handler)
  : createServer(handler);
server.listen(port, () => console.log(`[avera-wasm] ${useTls ? "https" : "http"}://127.0.0.1:${port}`));
