// E2E: in-app multi-tab page browsing (real child webviews), driven over CDP.
//
// Usage:
//   node tools/e2e-pages.mjs            # launches the release exe with an isolated data dir
//   node tools/e2e-pages.mjs --attach   # attach to an already running instance
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  APP_DIR,
  appTarget,
  assertAppStaysUp,
  cdpTargets,
  connect,
  invoke,
  launchRelease,
  makeDataDir,
  report,
  sleep,
  waitFor,
} from "./cdp.mjs";

const PORT_A = 15211;
const PORT_B = 15212;
const ATTACH = process.argv.includes("--attach");
const RECT = { x: 0, y: 120, w: 900, h: 500 };

const checks = [];
const record = (name, ok, detail = "") => checks.push({ name, ok, detail });

const serve = (port, body) =>
  new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>page-${port}</title></head><body><h1>${body}</h1></body></html>`);
    });
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`port ${port} is busy (leftover from an earlier run?) — free it and retry`));
      } else {
        reject(error);
      }
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

const serverA = await serve(PORT_A, "PORTLENS-PAGE-A");
const serverB = await serve(PORT_B, "PORTLENS-PAGE-B");
const dataDir = makeDataDir("pages");
const appChild = ATTACH ? null : launchRelease({ dataDir });
if (appChild) await assertAppStaysUp(appChild);

const targetUrls = async () => (await cdpTargets()).filter((t) => t.type === "page").map((t) => t.url || "");

let client;
try {
  client = await connect(await appTarget());

  const tabA = await invoke(client, "open_page", {
    url: `http://127.0.0.1:${PORT_A}/`,
    title: "page A",
    ...RECT,
  });
  const tabB = await invoke(client, "open_page", {
    url: `http://127.0.0.1:${PORT_B}/`,
    title: "page B",
    ...RECT,
  });
  record("open_page returns distinct labels", tabA.label !== tabB.label, `${tabA.label} / ${tabB.label}`);

  const both = await waitFor(
    "both child webviews are live targets",
    async () => {
      const urls = await targetUrls();
      return urls.some((u) => u.includes(`:${PORT_A}`)) && urls.some((u) => u.includes(`:${PORT_B}`)) ? urls : false;
    },
    20000,
  );
  record("two page tabs created two real webviews", both.length >= 2, `targets=${both.length}`);

  const pages = await invoke(client, "list_pages");
  record("list_pages reports both tabs", pages.length === 2, `count=${pages.length}`);

  await invoke(client, "activate_page", { label: tabA.label });
  await invoke(client, "close_page", { label: tabA.label });
  const gone = await waitFor(
    "closed tab target disappears",
    async () => !(await targetUrls()).some((u) => u.includes(`:${PORT_A}`)),
    15000,
  );
  record("close_page destroys the child webview", gone === true);

  const remaining = await invoke(client, "list_pages");
  record("closing leaves the other tab", remaining.length === 1 && remaining[0].label === tabB.label, JSON.stringify(remaining));

  await invoke(client, "navigate_page", { label: tabB.label, url: `http://127.0.0.1:${PORT_A}/` });
  const navigated = await waitFor(
    "navigated target shows the new url",
    async () => (await targetUrls()).some((u) => u.includes(`:${PORT_A}`)),
    15000,
  );
  record("navigate_page loads the new url", navigated === true);

  const renamed = await invoke(client, "rename_page", { label: tabB.label, title: "renamed B" });
  void renamed;
  const afterRename = (await invoke(client, "list_pages")).find((tab) => tab.label === tabB.label);
  record("rename_page persists the title", afterRename?.title === "renamed B", `title=${afterRename?.title}`);

  await invoke(client, "activate_page", { label: null });
  const uiPath = path.join(dataDir, "ui.json");
  await waitFor("ui.json written", () => fs.existsSync(uiPath), 8000);
  const ui = JSON.parse(fs.readFileSync(uiPath, "utf8"));
  record("tabs are persisted to ui.json", Array.isArray(ui.tabs) && ui.tabs.length === 1, `tabs=${JSON.stringify(ui.tabs)}`);
  record("persisted tab keeps the navigated url", ui.tabs[0]?.url?.includes(`:${PORT_A}`), `url=${ui.tabs[0]?.url}`);

  const saved = await invoke(client, "take_saved_pages");
  record("take_saved_pages hands the session over", saved.length === 1, `count=${saved.length}`);

  void APP_DIR;
  void sleep;
} catch (error) {
  record("unexpected failure", false, String(error && error.stack ? error.stack.split("\n")[0] : error));
} finally {
  serverA.close();
  serverB.close();
  if (appChild) spawnSync("taskkill", ["/PID", String(appChild.pid), "/T", "/F"], { stdio: "ignore" });
  const ok = report("e2e-pages", checks);
  process.exit(ok ? 0 : 1);
}
