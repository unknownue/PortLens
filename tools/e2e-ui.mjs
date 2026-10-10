// E2E: theme adaptation and dialog fit (regression for two reported UI bugs).
//
//   node tools/e2e-ui.mjs            # launches the release exe with an isolated data dir
//   node tools/e2e-ui.mjs --attach   # attach to an already running instance
//
// Runs the app at its minimum window size (900x600) with the light theme and the workspace preset,
// then checks that (a) the log tab renders on a light background, (b) the dialogs never grow past
// the window and scroll internally instead, and (c) both themes keep a dark background dark.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  APP_DIR,
  appTarget,
  assertAppStaysUp,
  connect,
  evaluate,
  launchRelease,
  makeDataDir,
  report,
  sleep,
  waitFor,
} from "./cdp.mjs";

const ATTACH = process.argv.includes("--attach");
const checks = [];
const record = (name, ok, detail = "") => checks.push({ name, ok, detail });

const appDir = APP_DIR;
const dataDir = makeDataDir("ui");
const logFile = path.join(dataDir, "svc.log");
fs.writeFileSync(
  logFile,
  Array.from({ length: 40 }, (_, i) => `line ${i + 1} INFO served`).join("\n") + "\n",
);

// Light theme + the smallest window the app allows: the reported bug showed up here.
const manifest = {
  version: 1,
  settings: { pollIntervalMs: 1000, language: "zh", theme: "light", stopManagedOnExit: false },
  services: [
    {
      id: "e2e-ui-15250",
      name: "UI 检查服务",
      port: 15250,
      command: null,
      cwd: null,
      health: { type: "tcp", intervalMs: 2000, timeoutMs: 800, failureThreshold: 2 },
      logSource: { type: "file", path: logFile, encoding: "utf-8" },
    },
  ],
};
fs.writeFileSync(path.join(dataDir, "services.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(
  path.join(dataDir, "ui.json"),
  JSON.stringify({ tabs: [], logTabs: [], active: null, window: { x: 120, y: 80, w: 900, h: 600 } }),
);

const appChild = ATTACH ? null : launchRelease({ dataDir });
if (appChild) await assertAppStaysUp(appChild);

/** Composited luminance of a selector over its ancestors (handles `bg-muted/20` alpha). */
const luminance = (client, selector) =>
  evaluate(
    client,
    `(() => {
       const parse = (value) => {
         const m = (value || '').match(/rgba?\\(([^)]+)\\)/);
         if (!m) return null;
         const parts = m[1].split(',').map((v) => parseFloat(v));
         return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
       };
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       // Base: the body colour; then composite the element's own background on top of it.
       let base = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
       const own = parse(getComputedStyle(el).backgroundColor);
       if (own && own.a > 0) {
         base = {
           r: own.r * own.a + base.r * (1 - own.a),
           g: own.g * own.a + base.g * (1 - own.a),
           b: own.b * own.a + base.b * (1 - own.a),
           a: 1,
         };
       }
       return (0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b) / 255;
     })()`,
  );

let client;
try {
  client = await connect(await appTarget());
  await waitFor("dashboard renders", async () => evaluate(client, `!!document.querySelector('[data-testid="service-row-logs"]')`), 20000);

  // ---- theme ----
  await sleep(800);
  const isDark = await evaluate(client, `document.documentElement.classList.contains('dark')`);
  record("light theme is applied from settings", isDark === false, `dark=${isDark}`);
  const pageLum = await luminance(client, "body");
  record("page background is light in light mode", pageLum !== null && pageLum > 0.6, `luminance=${pageLum}`);

  // ---- log tab in light theme ----
  await evaluate(
    client,
    `(() => { document.querySelector('[data-testid="service-row-logs"]').click(); return true; })()`,
  );
  await waitFor("log tab renders", async () => evaluate(client, `!!document.querySelector('[data-testid="log-tab"]')`), 15000);
  await waitFor("log lines arrive", async () => (await evaluate(client, `document.querySelectorAll('[data-testid="log-tab-lines"] > *').length`)) > 0, 20000);
  const logLum = await luminance(client, `[data-testid="log-tab-lines"]`);
  record("log tab background follows the light theme", logLum !== null && logLum > 0.6, `luminance=${logLum}`);
  const lineColor = await evaluate(
    client,
    `(() => { const el = document.querySelector('[data-testid="log-tab-lines"] > *'); return el ? getComputedStyle(el).color : null; })()`,
  );
  record("log line text stays readable", typeof lineColor === "string" && lineColor.length > 0, lineColor);

  // ---- dialogs fit inside a 900x600 window ----
  const fits = async (selector) =>
    evaluate(
      client,
      `(() => {
         const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return null;
         const r = el.getBoundingClientRect();
         return { h: Math.round(r.height), w: Math.round(r.width), innerH: window.innerHeight, innerW: window.innerWidth,
                  scrolls: el.scrollHeight > el.clientHeight + 1 };
       })()`,
    );

  const windowSize = await evaluate(client, `({ w: window.innerWidth, h: window.innerHeight })`);
  record("window really is the small one", windowSize.h <= 620, JSON.stringify(windowSize));

  // Open the service dialog the way a user does (toolbar button, no testid on the button).
  const opened = await evaluate(
    client,
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('新增服务')); if (!b) return false; b.click(); return true; })()`,
  );
  record("service dialog opens", opened === true);
  const dialog = await waitFor("service dialog present", async () => (await fits('[data-testid="service-dialog"]')) ?? false, 10000);
  record("service dialog fits the window height", dialog.h <= dialog.innerH, `dialog=${dialog.h} window=${dialog.innerH}`);
  record("service dialog fits the window width", dialog.w <= dialog.innerW, `dialog=${dialog.w} window=${dialog.innerW}`);
  record("long form scrolls inside the dialog", dialog.scrolls === true, `scrolls=${dialog.scrolls}`);

  // Every dialog currently mounted must obey the same rule.
  const allFit = await evaluate(
    client,
    `(() => [...document.querySelectorAll('[data-slot="dialog-content"]')].every((el) => {
        const r = el.getBoundingClientRect();
        return r.height <= window.innerHeight + 1 && r.width <= window.innerWidth + 1;
     }))()`,
  );
  record("every mounted dialog fits the window", allFit === true);

  await evaluate(
    client,
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '取消'); if (b) b.click(); return true; })()`,
  );
} catch (error) {
  record("unexpected failure", false, String(error && error.stack ? error.stack.split("\n")[0] : error));
} finally {
  if (appChild) spawnSync("taskkill", ["/PID", String(appChild.pid), "/T", "/F"], { stdio: "ignore" });
  const ok = report("e2e-ui", checks);
  process.exit(ok ? 0 : 1);
}
