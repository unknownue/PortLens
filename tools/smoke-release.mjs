// Packaged-exe smoke test: real WebView2, real CSP, real managed process.
//
// Usage:
//   node tools/smoke-release.mjs          # needs: make ports-build
import { spawnSync } from "node:child_process";
import {
  appTarget,
  assertAppStaysUp,
  connect,
  evaluate,
  invoke,
  launchRelease,
  makeDataDir,
  report,
  tcpOpen,
  waitFor,
} from "./cdp.mjs";

const PORT = 15201;
const SERVICE_ID = "smoke-15201";

const checks = [];
const record = (name, ok, detail = "") => checks.push({ name, ok, detail });

const dataDir = makeDataDir("smoke");
const appChild = launchRelease({ dataDir });
await assertAppStaysUp(appChild);
const consoleErrors = [];
const cspErrors = [];

let client;
try {
  client = await connect(
    await appTarget(),
    (msg) => {
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        consoleErrors.push(text);
        if (/content security policy/i.test(text)) cspErrors.push(text);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(msg.params?.exceptionDetails?.exception?.description || "uncaught exception");
      }
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const text = msg.params.entry.text || "";
        consoleErrors.push(text);
        if (/content security policy/i.test(text)) cspErrors.push(text);
      }
    },
  );
  await client.send("Runtime.enable");
  await client.send("Log.enable");

  const rendered = await waitFor(
    "UI renders",
    async () => evaluate(client, "document.getElementById('root')?.children.length > 0"),
    20000,
  );
  record("packaged exe renders the UI", rendered === true);

  const title = await evaluate(client, "document.title");
  record("document title is PortLens", title === "PortLens", `title=${title}`);

  await invoke(client, "add_service", {
    service: {
      id: SERVICE_ID,
      name: "Smoke 服务",
      port: PORT,
      command: `node -e "require('net').createServer(s=>s.end()).listen(${PORT})"`,
      cwd: null,
      health: { type: "tcp", intervalMs: 500, timeoutMs: 500, failureThreshold: 2 },
    },
  });
  await invoke(client, "start_service", { id: SERVICE_ID });
  const healthy = await waitFor(
    "smoke service healthy",
    async () => {
      const list = await invoke(client, "get_services");
      const view = list.find((v) => v.id === SERVICE_ID);
      return view && view.status.state === "healthy" ? view : false;
    },
    30000,
  );
  record("packaged exe starts and probes a managed service", healthy.status.state === "healthy", `pid=${healthy.status.pid}`);
  record("smoke service actually listens", (await tcpOpen(PORT)) === true);

  await invoke(client, "stop_service", { id: SERVICE_ID, force: false });
  const released = await waitFor("port released", async () => !(await tcpOpen(PORT)), 15000);
  record("packaged exe stops the managed service", released === true);

  await invoke(client, "remove_service", { id: SERVICE_ID });

  const env = await invoke(client, "get_environment");
  record("environment reports a manifest path", typeof env.manifestPath === "string" && env.manifestPath.length > 0, env.manifestPath);
  record("no CSP violations in the packaged build", cspErrors.length === 0, cspErrors[0] || "");
  record("no console errors on startup", consoleErrors.length === 0, consoleErrors[0] || "");
} catch (error) {
  record("unexpected failure", false, String(error && error.stack ? error.stack.split("\n")[0] : error));
} finally {
  if (appChild) spawnSync("taskkill", ["/PID", String(appChild.pid), "/T", "/F"], { stdio: "ignore" });
  const ok = report("smoke-release", checks);
  process.exit(ok ? 0 : 1);
}
