// E2E: log tailing for a service that PortLens did NOT start (foreign process writing a log file).
//
// Usage:
//   node tools/e2e-logs.mjs            # launches the release exe with an isolated data dir
//   node tools/e2e-logs.mjs --attach   # attach to an already running instance
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  appTarget,
  assertAppStaysUp,
  connect,
  invoke,
  launchRelease,
  makeDataDir,
  report,
  sleep,
  waitFor,
} from "./cdp.mjs";

const PORT = 15205;
const SERVICE_ID = "e2e-foreign-logs";
const ATTACH = process.argv.includes("--attach");

const checks = [];
const record = (name, ok, detail = "") => checks.push({ name, ok, detail });

const dataDir = makeDataDir("logs");
const logDir = path.join(dataDir, "foreign-logs");
fs.mkdirSync(logDir, { recursive: true });
const logPattern = path.join(logDir, "service-*.log");
const logFile = path.join(logDir, "service-1.log");

// Foreign service: listens on PORT and appends one line every 200ms. PortLens never spawns it.
const foreign = spawn(
  process.execPath,
  [
    "-e",
    "const fs=require('fs'),http=require('http');let i=0;" +
      "http.createServer((q,s)=>{s.writeHead(204);s.end()}).listen(Number(process.argv[2]));" +
      "setInterval(()=>{i++;fs.appendFileSync(process.argv[1],'foreign-line-'+i+'\\n')},200);",
    logFile,
    String(PORT),
  ],
  { stdio: "ignore" },
);

const appChild = ATTACH ? null : launchRelease({ dataDir });
if (appChild) await assertAppStaysUp(appChild);

let client;
try {
  client = await connect(await appTarget());

  // Wait until the foreign process has written something before declaring the service.
  await waitFor("foreign log file appears", () => fs.existsSync(logFile), 10000);
  await waitFor(
    "foreign service is listening",
    async () => {
      const listeners = await invoke(client, "list_listeners");
      return listeners.some((l) => l.port === PORT);
    },
    15000,
  );

  const views = await invoke(client, "add_service", {
    service: {
      id: SERVICE_ID,
      name: "E2E 外部日志服务",
      port: PORT,
      command: null,
      cwd: null,
      health: { type: "tcp", intervalMs: 500, timeoutMs: 500, failureThreshold: 2 },
      logSource: { type: "file", path: logPattern, encoding: "utf-8" },
    },
  });
  const view = views.find((v) => v.id === SERVICE_ID);
  record(
    "service keeps the file log source",
    view?.logSource?.type === "file" && view.logSource.path === logPattern,
    JSON.stringify(view?.logSource),
  );

  const seeded = await waitFor(
    "existing log lines are tailed",
    async () => {
      const lines = await invoke(client, "get_service_logs", { id: SERVICE_ID, limit: 500 });
      return lines.some((line) => /^foreign-line-\d+$/.test(line)) ? lines : false;
    },
    20000,
  );
  record("tail picks up lines written before PortLens attached", seeded.length > 0, `${seeded.length} lines`);

  // Real time: the foreign process keeps appending, so the line count must keep growing.
  const indexOf = (lines) =>
    lines.reduce((max, line) => {
      const hit = /^foreign-line-(\d+)$/.exec(line);
      return hit ? Math.max(max, Number(hit[1])) : max;
    }, 0);
  const firstIndex = indexOf(seeded);
  const grown = await waitFor(
    "new lines arrive while running",
    async () => {
      const lines = await invoke(client, "get_service_logs", { id: SERVICE_ID, limit: 500 });
      return indexOf(lines) > firstIndex + 3 ? lines : false;
    },
    20000,
  );
  record(
    "live tail keeps up with a foreign writer",
    indexOf(grown) > firstIndex,
    `line ${firstIndex} -> ${indexOf(grown)}`,
  );

  // The service is not ours: no managed pid, not started by the tool.
  const state = (await invoke(client, "get_services")).find((v) => v.id === SERVICE_ID);
  record(
    "foreign service is not managed (no spawn, no pid)",
    state?.status?.pid === null && state?.status?.state === "healthy",
    `state=${state?.status?.state} pid=${state?.status?.pid}`,
  );

  // Truncation: wiping the file must not stop the tail (offset reset).
  const beforeTruncate = indexOf(await invoke(client, "get_service_logs", { id: SERVICE_ID, limit: 500 }));
  fs.writeFileSync(logFile, "");
  const afterTruncate = await waitFor(
    "tail survives truncation",
    async () => {
      const lines = await invoke(client, "get_service_logs", { id: SERVICE_ID, limit: 500 });
      return indexOf(lines) > beforeTruncate + 3 ? indexOf(lines) : false;
    },
    20000,
  );
  record("tail recovers from a truncated log file", afterTruncate > beforeTruncate, `line ${beforeTruncate} -> ${afterTruncate}`);

  // Rotation through the glob: a new file with a newer timestamp becomes the tail target.
  // The writer is stopped first so it cannot recreate the old path and win the "newest match" race.
  foreign.kill();
  await sleep(500);
  fs.renameSync(logFile, path.join(logDir, "service-1.log.old"));
  const rotated = path.join(logDir, "service-2.log");
  fs.writeFileSync(rotated, "rotated-line-1\n");
  const rotationSeen = await waitFor(
    "rotation to the newest glob match",
    async () => {
      const lines = await invoke(client, "get_service_logs", { id: SERVICE_ID, limit: 500 });
      return lines.includes("rotated-line-1") ? lines : false;
    },
    20000,
  );
  record("glob follows a rotated (newer) log file", Array.isArray(rotationSeen));

  const cleared = await invoke(client, "clear_service_logs", { id: SERVICE_ID });
  void cleared;
  const afterClear = await invoke(client, "get_service_logs", { id: SERVICE_ID, limit: 20 });
  record("clear_service_logs empties the ring", afterClear.length === 0, `${afterClear.length} lines`);

  await invoke(client, "remove_service", { id: SERVICE_ID });
  record("service removed", (await invoke(client, "get_services")).length === 0);
} catch (error) {
  record("unexpected failure", false, String(error && error.stack ? error.stack.split("\n")[0] : error));
} finally {
  foreign.kill();
  if (appChild) spawnSync("taskkill", ["/PID", String(appChild.pid), "/T", "/F"], { stdio: "ignore" });
  const ok = report("e2e-logs", checks);
  process.exit(ok ? 0 : 1);
}
