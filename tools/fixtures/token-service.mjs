// Fixture for tools/e2e-headers.mjs
//
//   node tools/fixtures/token-service.mjs --role service --port 15220 --token <t> --peer 15221 --obs <file>
//   node tools/fixtures/token-service.mjs --role peer    --port 15221 --obs <file>
//
// service: every path except /health requires `X-Test-Token`. /page pulls a same-origin script, a
// same-origin fetch, a same-origin XHR and a cross-origin script from the peer origin.
// All requests are appended to the observation file as JSON lines so the test can prove which
// headers actually left the browser.
import { createServer } from "node:http";
import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const role = arg("role", "service");
const port = Number(arg("port"));
const obs = arg("obs");
const token = arg("token");
const peer = arg("peer");

const record = (entry) => {
  fs.appendFileSync(obs, JSON.stringify(entry) + "\n");
};

const headersOf = (req) => {
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) out[name.toLowerCase()] = value;
  return out;
};

if (role === "peer") {
  createServer((req, res) => {
    record({ who: "peer", path: req.url, headers: headersOf(req) });
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end('window.__peerLoaded = true;\n');
  }).listen(port, "127.0.0.1", () => console.log(`peer listening on ${port}`));
} else {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>protected-page</title></head>
<body>
<h1>PROTECTED-PAGE</h1>
<div id="same-script">missing</div>
<div id="same-fetch">missing</div>
<div id="same-xhr">missing</div>
<script src="/same-origin.js"></script>
<script src="http://127.0.0.1:${peer}/cross.js"></script>
<script>
  document.getElementById('same-script').textContent = window.__sameOriginScript || 'missing';
  fetch('/same-origin.json').then(r => r.text()).then(t => { document.getElementById('same-fetch').textContent = t; });
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/same-origin-xhr.txt');
  xhr.onload = () => { document.getElementById('same-xhr').textContent = xhr.responseText; };
  xhr.send();
</script>
</body></html>`;

  createServer((req, res) => {
    const headers = headersOf(req);
    record({ who: "service", path: req.url, method: req.method, headers });
    const send = (status, type, body) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    if (req.url === "/health") {
      return send(200, "text/plain", "OK");
    }
    if (headers["x-test-token"] !== token) {
      return send(403, "application/json", JSON.stringify({ ok: false, error: "invalid or missing X-Test-Token" }));
    }
    if (req.url === "/page") return send(200, "text/html; charset=utf-8", page);
    if (req.url === "/status") {
      return send(200, "application/json", JSON.stringify({ ok: true, clients: ["client-a", "client-b"] }));
    }
    if (req.url === "/same-origin.js") {
      return send(200, "application/javascript", 'window.__sameOriginScript = "SAME-ORIGIN-OK";\n');
    }
    if (req.url === "/same-origin.json") return send(200, "text/plain", "SAME-ORIGIN-FETCH");
    if (req.url === "/same-origin-xhr.txt") return send(200, "text/plain", "SAME-ORIGIN-XHR");
    return send(404, "text/plain", "not found");
  }).listen(port, "127.0.0.1", () => console.log(`service listening on ${port}`));
}
