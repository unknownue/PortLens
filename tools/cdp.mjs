// Minimal Chrome DevTools Protocol client for PortLens E2E (Node 22+ global WebSocket).
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

export const CDP_PORT = Number(process.env.PORTLENS_CDP_PORT || 19223);
export const APP_DIR = path.resolve(import.meta.dirname, "..");

export async function cdpTargets(port = CDP_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (!res.ok) throw new Error(`CDP /json failed: ${res.status}`);
  return res.json();
}

/** The app's main webview target (dev server URL or tauri:// asset URL). */
export async function appTarget(port = CDP_PORT, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await cdpTargets(port);
      const page = list.find(
        (t) => t.type === "page" && /(tauri|localhost:15273|127\.0\.0\.1:15273|index\.html)/i.test(t.url || ""),
      );
      if (page) return page;
    } catch {
      // devtools endpoint not up yet
    }
    await sleep(300);
  }
  throw new Error(`no app page target on CDP port ${port}`);
}

export async function connect(target, onEvent = null) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${e.message || e.type}`)), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id === undefined) {
      if (onEvent) onEvent(msg);
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, close: () => ws.close() };
}

export async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`eval exception: ${JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails)}`);
  }
  return result.result.value;
}

/** Call a Tauri command through the injected IPC bridge (no global __TAURI__ needed). */
export async function invoke(client, command, args = {}) {
  const payload = JSON.stringify(args);
  const value = await evaluate(
    client,
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${payload}).then(r => ({ ok: true, value: r }), e => ({ ok: false, error: String(e) }))`,
  );
  if (!value || value.ok !== true) {
    throw new Error(`invoke ${command} failed: ${value ? value.error : "no result"}`);
  }
  return value.value;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(label, fn, timeoutMs = 20000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}

export function tcpOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const fail = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", fail);
    socket.once("timeout", fail);
    socket.connect(port, "127.0.0.1");
  });
}

/** Launch the built release exe with CDP enabled and an isolated data dir. */
export function launchRelease({ dataDir }) {
  const exe = path.join(APP_DIR, "src-tauri", "target", "release", "PortLens.exe");
  if (!fs.existsSync(exe)) {
    throw new Error(`release exe not found: ${exe} (run: make ports-build)`);
  }
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      PORTLENS_DATA_DIR: dataDir,
    },
    stdio: "ignore",
  });
  return child;
}

export function makeDataDir(tag) {
  const dir = path.join(APP_DIR, "tmp", `e2e-${tag}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function report(name, checks) {
  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `  -- ${check.detail}` : ""}`);
  }
  console.log(`\n${name}: ${checks.length - failed.length}/${checks.length} passed`);
  return failed.length === 0;
}
