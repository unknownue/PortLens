// E2E: log tabs (docs/CONTRACT.md section 10).
//
//   node tools/e2e-logtab.mjs            # launches the release exe with an isolated data dir
//   node tools/e2e-logtab.mjs --attach   # attach to an already running instance
//
// Drives the real UI through the data-testid hooks: open a log tab from the service row, watch it
// follow a foreign writer live, filter, pause, clear, persist the tab identity, and restore it
// after a restart.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  APP_DIR,
  appTarget,
  assertAppStaysUp,
  connect,
  evaluate,
  invoke,
  launchRelease,
  makeDataDir,
  report,
  sleep,
  waitFor,
} from "./cdp.mjs";

const PORT = 15230;
const SERVICE_ID = "e2e-logtab-15230";
const ATTACH = process.argv.includes("--attach");

const checks = [];
const record = (name, ok, detail = "") => checks.push({ name, ok, detail });

const dataDir = makeDataDir("logtab");
const logFile = path.join(dataDir, "service.log");
fs.writeFileSync(logFile, "");

const manifest = {
  version: 1,
  settings: { pollIntervalMs: 1000, language: "zh", theme: "dark", stopManagedOnExit: false },
  services: [
    {
      id: SERVICE_ID,
      name: "E2E 日志服务",
      port: PORT,
      command: null,
      cwd: null,
      health: { type: "tcp", intervalMs: 1000, timeoutMs: 800, failureThreshold: 2 },
      logSource: { type: "file", path: logFile, encoding: "utf-8" },
    },
  ],
};
fs.writeFileSync(path.join(dataDir, "services.json"), JSON.stringify(manifest, null, 2));

const writer = spawn(
  process.execPath,
  [path.join(APP_DIR, "tools", "fixtures", "log-writer.mjs"), "--port", String(PORT), "--log", logFile, "--interval", "200"],
  { stdio: "ignore" },
);

let app = ATTACH ? null : launchRelease({ dataDir });
if (app) await assertAppStaysUp(app);

async function clickTestId(client, testId) {
  const ok = await evaluate(
    client,
    `(() => { const el = document.querySelector('[data-testid="${testId}"]'); if (!el) return false; el.click(); return true; })()`,
  );
  return ok === true;
}

async function setInput(client, testId, value) {
  return evaluate(
    client,
    `(() => {
       const el = document.querySelector('[data-testid="${testId}"]');
       if (!el) return false;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(el, ${JSON.stringify(value)});
       el.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
  );
}

// Line count that works whether the view renders one element per line or a single <pre>.
const logLines = (client) =>
  evaluate(
    client,
    `(() => {
       const box = document.querySelector('[data-testid="log-tab-lines"]');
       if (!box) return 0;
       if (box.children.length > 0) return box.children.length;
       const text = (box.innerText || '').trim();
       return text ? text.split('\\n').length : 0;
     })()`,
  );
const logText = (client) => evaluate(client, `(document.querySelector('[data-testid="log-tab-lines"]')?.innerText || '')`);

let client;
try {
  client = await connect(await appTarget());

  await waitFor("dashboard renders the service row", async () => evaluate(client, `!!document.querySelector('[data-testid="service-row-logs"]')`), 20000);

  // ---- open the log tab from the service row ----
  record("log button exists on the service row", await clickTestId(client, "service-row-logs"));
  await waitFor("log tab appears", async () => evaluate(client, `!!document.querySelector('[data-testid="log-tab"]')`), 15000);
  record("log tab view is rendered", true);
  record(
    "log tab title names the service",
    String(await evaluate(client, `document.querySelector('[data-testid="log-tab-title"]')?.innerText || ''`)).includes("E2E 日志服务"),
    String(await evaluate(client, `document.querySelector('[data-testid="log-tab-title"]')?.innerText || ''`)),
  );

  // ---- live follow ----
  const first = await waitFor("first lines arrive", async () => (await logLines(client)) > 0 ? await logLines(client) : false, 25000);
  const grown = await waitFor("line count keeps growing", async () => {
    const count = await logLines(client);
    return count > first + 2 ? count : false;
  }, 25000);
  record("log tab follows a foreign writer live", grown > first, `${first} -> ${grown} line(s)`);

  // ---- filter ----
  await setInput(client, "log-tab-filter", "ERROR");
  const filtered = await waitFor("filter narrows the view", async () => {
    const count = await logLines(client);
    return count > 0 && count < grown ? count : false;
  }, 15000);
  const filteredText = String(await logText(client));
  record("keyword filter keeps only matching lines", filteredText.includes("ERROR") && !filteredText.includes("WARN tick"), `${filtered} of ${grown}`);
  await setInput(client, "log-tab-filter", "");

  // ---- pause / resume ----
  await clickTestId(client, "log-tab-pause");
  await sleep(400);
  const frozen = await logLines(client);
  await sleep(1500);
  const stillFrozen = await logLines(client);
  record("pause freezes the view", stillFrozen === frozen, `${frozen} -> ${stillFrozen}`);
  await clickTestId(client, "log-tab-pause");
  const resumed = await waitFor("resume brings the missed lines back", async () => {
    const count = await logLines(client);
    return count > stillFrozen ? count : false;
  }, 20000);
  record("resume catches up", resumed > stillFrozen, `${stillFrozen} -> ${resumed}`);

  // ---- persistence: identity only ----
  await waitFor("ui.json keeps the log tab", () => {
    const ui = JSON.parse(fs.readFileSync(path.join(dataDir, "ui.json"), "utf8"));
    return Array.isArray(ui.logTabs) && ui.logTabs.length === 1;
  }, 10000);
  const uiText = fs.readFileSync(path.join(dataDir, "ui.json"), "utf8");
  const ui = JSON.parse(uiText);
  record("ui.json stores the log tab identity", ui.logTabs[0].serviceId === SERVICE_ID && typeof ui.logTabs[0].title === "string", JSON.stringify(ui.logTabs));
  record("ui.json carries no log content", !uiText.includes("log-line-"), uiText.slice(0, 120).replace(/\s+/g, " "));

  // ---- clear ----
  await clickTestId(client, "log-tab-clear");
  const cleared = await waitFor("clear empties the view", async () => (await logLines(client)) === 0, 10000);
  record("clear empties the view", cleared === true);

  // ---- switching back to the dashboard keeps the tab ----
  const backToDashboard = await evaluate(
    client,
    `(() => { const el = document.querySelector('[data-testid="tab-strip-item"]'); if (!el) return false; el.click(); return true; })()`,
  );
  record("dashboard tab is reachable", backToDashboard === true);
  await sleep(500);
  record(
    "log tab stays available after switching",
    (await evaluate(client, `document.querySelectorAll('[data-testid="tab-strip-item"]').length`)) >= 2,
    `tabs=${await evaluate(client, `document.querySelectorAll('[data-testid="tab-strip-item"]').length`)}`,
  );

  // ---- restore after a restart ----
  if (!ATTACH) {
    spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    await sleep(1500);
    app = launchRelease({ dataDir });
    await assertAppStaysUp(app);
    const restored = await connect(await appTarget());
    const restoredTabs = await waitFor(
      "log tab comes back after restart",
      async () => {
        const count = await evaluate(restored, `document.querySelectorAll('[data-testid="tab-strip-item"]').length`);
        return count >= 2 ? count : false;
      },
      25000,
    );
    record("log tab is restored on startup", restoredTabs >= 2, `${restoredTabs} tabs`);
    // The dashboard was active before the restart, so the restored log tab must be clicked.
    await evaluate(
      restored,
      `(() => { const items = [...document.querySelectorAll('[data-testid="tab-strip-item"]')]; items[items.length - 1].click(); return true; })()`,
    );
    await waitFor("restored log tab renders", async () => evaluate(restored, `!!document.querySelector('[data-testid="log-tab"]')`), 15000);
    record(
      "restored log tab shows fresh lines again",
      await waitFor("restored tab receives lines", async () => (await logLines(restored)) > 0, 25000),
    );
    client = restored;
  }
} catch (error) {
  record("unexpected failure", false, String(error && error.stack ? error.stack.split("\n")[0] : error));
} finally {
  writer.kill();
  if (app) spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  const ok = report("e2e-logtab", checks);
  process.exit(ok ? 0 : 1);
}
