// E2E: custom request headers for page tabs (docs/CONTRACT.md section 9).
//
//   node tools/e2e-headers.mjs            # launches the release exe with an isolated data dir
//   node tools/e2e-headers.mjs --attach   # attach to an already running instance
//
// Proves: headers reach the document, its same-origin subresources, fetch and XHR; they never leave
// the configured origin; a misconfigured/absent header shows up as a 403 hint; nothing leaks into
// ui.json, list_pages or get_services.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  APP_DIR,
  appTarget,
  assertAppStaysUp,
  cdpTargets,
  connect,
  evaluate,
  invoke,
  launchRelease,
  makeDataDir,
  report,
  sleep,
  waitFor,
} from "./cdp.mjs";

const SERVICE_PORT = 15220;
const PEER_PORT = 15221;
const TOKEN = "e2e-token-4711";
const SERVICE_ID = "e2e-headers-15220";
const ATTACH = process.argv.includes("--attach");
const RECT = { x: 0, y: 120, w: 900, h: 500 };

const checks = [];
const record = (name, ok, detail = "") => checks.push({ name, ok, detail });

const dataDir = makeDataDir("headers");
const obsFile = path.join(dataDir, "observed.jsonl");
fs.writeFileSync(obsFile, "");

const fixture = path.join(APP_DIR, "tools", "fixtures", "token-service.mjs");
const service = spawn(
  process.execPath,
  [fixture, "--role", "service", "--port", String(SERVICE_PORT), "--token", TOKEN, "--peer", String(PEER_PORT), "--obs", obsFile],
  { stdio: "ignore" },
);
const peer = spawn(process.execPath, [fixture, "--role", "peer", "--port", String(PEER_PORT), "--obs", obsFile], {
  stdio: "ignore",
});

const appChild = ATTACH ? null : launchRelease({ dataDir });
if (appChild) await assertAppStaysUp(appChild);

const observed = () =>
  fs
    .readFileSync(obsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** Attach to a page target by URL substring (child webviews are separate CDP targets). */
async function childClient(urlPart, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = (await cdpTargets()).find((t) => t.type === "page" && (t.url || "").includes(urlPart));
    if (target) return connect(target);
    await sleep(300);
  }
  throw new Error(`no child target matching ${urlPart}`);
}

let client;
try {
  client = await connect(await appTarget());

  // Collect page-status events on the app webview (401/403 hint channel).
  await evaluate(
    client,
    `(() => {
       window.__e2e = { pageStatus: [] };
       const id = window.__TAURI_INTERNALS__.transformCallback((e) => window.__e2e.pageStatus.push(e.payload));
       window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'page-status', target: { kind: 'Any' }, handler: id });
       return true;
     })()`,
  );

  // ---- R1: manifest field, masked view ----
  const views = await invoke(client, "add_service", {
    service: {
      id: SERVICE_ID,
      name: "E2E 受保护服务",
      port: SERVICE_PORT,
      command: null,
      cwd: null,
      health: { type: "http", path: "/health", intervalMs: 1000, timeoutMs: 800, failureThreshold: 2 },
      logSource: { type: "process" },
      page: {
        url: `http://127.0.0.1:${SERVICE_PORT}/page`,
        headers: { "X-Test-Token": TOKEN },
        title: "受保护页面",
      },
    },
  });
  const view = views.find((v) => v.id === SERVICE_ID);
  record("R1 page.url/title are exposed", view?.page?.url === `http://127.0.0.1:${SERVICE_PORT}/page` && view.page.title === "受保护页面", JSON.stringify(view?.page));
  record(
    "R1 header is masked in the service list",
    view?.page?.headers?.[0]?.name === "X-Test-Token" && view.page.headers[0].masked === "••••••",
    JSON.stringify(view?.page?.headers),
  );
  record("R4 loopback target is not flagged as external", view?.page?.externalHost === false, `externalHost=${view?.page?.externalHost}`);

  const raw = await invoke(client, "get_page_config", { id: SERVICE_ID });
  record("R3 get_page_config returns the plaintext for the editor", raw.headers[0]?.value === TOKEN);
  const revealed = await invoke(client, "reveal_page_header", { id: SERVICE_ID, name: "X-Test-Token" });
  record("R3 reveal_page_header returns the plaintext on demand", revealed === TOKEN);

  // ---- R2: open the service page, headers reach document + subresources ----
  const tab = await invoke(client, "open_service_page", { id: SERVICE_ID, ...RECT });
  record("R2 open_service_page registers the tab", tab?.url === `http://127.0.0.1:${SERVICE_PORT}/page`, JSON.stringify(tab));

  const page = await childClient(`:${SERVICE_PORT}/page`);
  const body = await waitFor(
    "protected page renders",
    async () => {
      const out = await evaluate(
        page,
        `({ text: document.body.innerText, script: window.__sameOriginScript || '', peer: window.__peerLoaded === true })`,
      );
      return out && out.text.includes("PROTECTED-PAGE") && out.text.includes("SAME-ORIGIN-FETCH") && out.text.includes("SAME-ORIGIN-XHR") ? out : false;
    },
    30000,
  );
  record("R2 document was served (not 403)", body.text.includes("PROTECTED-PAGE") && !body.text.includes("invalid or missing"), body.text.split("\n").slice(0, 3).join(" | "));
  record("R2 same-origin <script> carried the header", body.script === "SAME-ORIGIN-OK", `__sameOriginScript=${body.script}`);
  record("R2 fetch carried the header", body.text.includes("SAME-ORIGIN-FETCH"));
  record("R2 XHR carried the header", body.text.includes("SAME-ORIGIN-XHR"));

  // ---- R4: the cross-origin script must not carry it ----
  await waitFor("cross-origin script request observed", () => observed().some((e) => e.who === "peer" && e.path === "/cross.js"), 15000);
  const peerHits = observed().filter((e) => e.who === "peer");
  const leaked = peerHits.filter((e) => "x-test-token" in e.headers);
  record("R4 cross-origin request carries no configured header", leaked.length === 0, `${peerHits.length} peer request(s), leaked=${leaked.length}`);
  const serviceHits = observed().filter((e) => e.who === "service");
  record(
    "R2 every service-side request carried the header",
    serviceHits.length >= 4 && serviceHits.every((e) => e.headers["x-test-token"] === TOKEN),
    `${serviceHits.length} request(s): ${serviceHits.map((e) => e.path).join(", ")}`,
  );

  // ---- R5: 403 hint for a tab opened without headers ----
  await invoke(client, "open_page", { url: `http://127.0.0.1:${SERVICE_PORT}/status`, title: "no headers", ...RECT });
  const bare = await childClient(`:${SERVICE_PORT}/status`);
  const bareBody = await waitFor(
    "bare tab shows the 403 payload",
    async () => {
      const text = await evaluate(bare, "document.body.innerText");
      return text && text.includes("invalid or missing") ? text : false;
    },
    30000,
  );
  record("R5 without headers the service answers 403", bareBody.includes("invalid or missing X-Test-Token"));
  const hint = await waitFor(
    "page-status hint arrives",
    async () => {
      const list = await evaluate(client, "window.__e2e.pageStatus");
      return Array.isArray(list) && list.some((p) => p.status === 403) ? list : false;
    },
    20000,
  );
  record("R5 a 403 raises the page-status hint", hint.some((p) => p.status === 403), JSON.stringify(hint[0]));

  // ---- R3: nothing leaks into ui.json / list_pages / get_services ----
  const pages = await invoke(client, "list_pages");
  const services = await invoke(client, "get_services");
  const uiText = fs.readFileSync(path.join(dataDir, "ui.json"), "utf8");
  record("R3 ui.json has no header value", !uiText.includes(TOKEN) && !uiText.toLowerCase().includes("x-test-token"), uiText.slice(0, 160));
  record("R3 list_pages has no header value", !JSON.stringify(pages).includes(TOKEN), JSON.stringify(pages).slice(0, 160));
  record("R3 get_services carries only the masked value", !JSON.stringify(services).includes(TOKEN) && JSON.stringify(services).includes("••••••"));
  record("R3 tab titles carry no header value", pages.every((p) => !p.title.includes(TOKEN) && !p.url.includes(TOKEN)));
  record("R1 tab bookkeeping stays label/title/url", pages.every((p) => Object.keys(p).sort().join(",") === "label,title,url"), JSON.stringify(Object.keys(pages[0] || {})));

  // ---- R1: a reload keeps the injection (filter stays registered) ----
  await invoke(client, "reload_page", { label: tab.label });
  const afterReload = await waitFor(
    "reload keeps the injection",
    async () => {
      const text = await evaluate(page, "document.body.innerText");
      return text && text.includes("PROTECTED-PAGE") && text.includes("SAME-ORIGIN-XHR") ? text : false;
    },
    30000,
  );
  record("R2 refresh keeps the injection", afterReload.includes("PROTECTED-PAGE"));

  // ---- 验收5: a restored tab (ui.json only keeps the url) still gets the headers ----
  await invoke(client, "close_page", { label: tab.label });
  const restoredTab = await invoke(client, "open_page", {
    url: `http://127.0.0.1:${SERVICE_PORT}/page`,
    title: "受保护页面",
    ...RECT,
  });
  const restoredPage = await childClient(`:${SERVICE_PORT}/page`);
  const restoredText = await waitFor(
    "restored tab renders the protected page",
    async () => {
      const text = await evaluate(restoredPage, "document.body.innerText");
      return text && text.includes("PROTECTED-PAGE") && text.includes("SAME-ORIGIN-XHR") ? text : false;
    },
    30000,
  );
  record(
    "restored tab matches page.url and re-reads the headers",
    restoredText.includes("PROTECTED-PAGE"),
    `label=${restoredTab.label}`,
  );

  // ---- R1: validation rejects bad configs ----
  const reject = async (patch, label) => {
    try {
      await invoke(client, "update_service", {
        service: {
          id: SERVICE_ID,
          name: "E2E 受保护服务",
          port: SERVICE_PORT,
          command: null,
          cwd: null,
          health: { type: "tcp", intervalMs: 1000, timeoutMs: 800, failureThreshold: 2 },
          logSource: { type: "process" },
          page: { url: `http://127.0.0.1:${SERVICE_PORT}/page`, headers: { "X-Test-Token": TOKEN }, title: "受保护页面", ...patch },
        },
      });
      record(label, false, "unexpectedly accepted");
    } catch (error) {
      record(label, true, String(error).slice(0, 90));
    }
  };
  await reject({ url: "not a url" }, "R1 invalid page.url is rejected");
  await reject({ url: "file:///C:/x.html" }, "R1 non-http(s) page.url is rejected");
  await reject({ headers: { Host: "evil" } }, "R1 protected header is rejected");
  await reject({ headers: { "X-Bad": "a\r\nX-Evil: 1" } }, "R1 control characters are rejected");
} catch (error) {
  record("unexpected failure", false, String(error && error.stack ? error.stack.split("\n")[0] : error));
} finally {
  service.kill();
  peer.kill();
  if (appChild) spawnSync("taskkill", ["/PID", String(appChild.pid), "/T", "/F"], { stdio: "ignore" });
  const ok = report("e2e-headers", checks);
  process.exit(ok ? 0 : 1);
}
