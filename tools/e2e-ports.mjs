// E2E: service lifecycle + foreign port occupancy, driven through the real app over CDP.
//
// Usage:
//   node tools/e2e-ports.mjs            # launches the release exe with an isolated data dir
//   node tools/e2e-ports.mjs --attach   # attach to an already running instance (uses its manifest)
import { spawn, spawnSync } from "node:child_process";
import {
  appTarget,
  connect,
  invoke,
  launchRelease,
  makeDataDir,
  report,
  sleep,
  tcpOpen,
  waitFor,
} from "./cdp.mjs";

const PORT = 15200;
const SERVICE_ID = "e2e-15200";
const ATTACH = process.argv.includes("--attach");
const NODE_CMD = `node -e "require('net').createServer(s=>s.end()).listen(${PORT})"`;

const checks = [];
const record = (name, ok, detail = "") => checks.push({ name, ok, detail });

const appChild = ATTACH ? null : launchRelease({ dataDir: makeDataDir("ports") });
const foreign = spawn(process.execPath, ["-e", `require('net').createServer(s=>s.end()).listen(${PORT})`], {
  stdio: "ignore",
});

let client;
try {
  client = await connect(await appTarget());

  const freePort = async (timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const listeners = await invoke(client, "list_listeners");
      const hit = listeners.find((l) => l.port === PORT);
      if (!hit) return true;
      await invoke(client, "stop_pid", { pid: hit.pid, force: true }).catch(() => {});
      await sleep(300);
    }
    return false;
  };

  // 1. foreign listener shows up as unmanaged
  await waitFor("foreign listener up", () => tcpOpen(PORT));
  await waitFor("listener enumerates the foreign process", async () => {
    const listeners = await invoke(client, "list_listeners");
    const hit = listeners.find((l) => l.port === PORT);
    if (!hit) return false;
    return hit;
  }).then((hit) => {
    record("list_listeners reports port with pid/exe", hit.pid > 0 && hit.exe.length > 0, `pid=${hit.pid} exe=${hit.exe}`);
    record("foreign listener is not marked ours", hit.ours === false, `ours=${hit.ours}`);
    record("foreign listener has no service id", hit.serviceId === null, `serviceId=${hit.serviceId}`);
  });

  // 2. declaring a monitor-only service links the foreign listener to it
  await invoke(client, "add_service", {
    service: {
      id: SERVICE_ID,
      name: "E2E 服务",
      port: PORT,
      command: null,
      cwd: null,
      health: { type: "tcp", intervalMs: 500, timeoutMs: 500, failureThreshold: 2 },
    },
  });
  const linked = await waitFor("service linked to foreign listener", async () => {
    const listeners = await invoke(client, "list_listeners");
    return listeners.find((l) => l.port === PORT && l.serviceId === SERVICE_ID);
  });
  record("declared service links to the occupying port", linked.ours === false, `ours=${linked.ours}`);

  const afterStop = await freePort();
  record("stop_pid frees a foreign port", afterStop === true && !(await tcpOpen(PORT)));

  // 3. start our own managed process for the same service
  const views = await invoke(client, "update_service", {
    service: {
      id: SERVICE_ID,
      name: "E2E 服务",
      port: PORT,
      command: NODE_CMD,
      cwd: null,
      health: { type: "tcp", intervalMs: 500, timeoutMs: 500, failureThreshold: 2 },
    },
  });
  record("update_service keeps one service", views.length === 1, `count=${views.length}`);

  await invoke(client, "start_service", { id: SERVICE_ID });
  const healthy = await waitFor(
    "managed service becomes healthy",
    async () => {
      const list = await invoke(client, "get_services");
      const view = list.find((v) => v.id === SERVICE_ID);
      return view && view.status.state === "healthy" ? view : false;
    },
    25000,
  );
  record("managed service reaches healthy", healthy.status.state === "healthy", `state=${healthy.status.state}`);
  record("managed service reports a pid", typeof healthy.status.pid === "number", `pid=${healthy.status.pid}`);

  const ours = await waitFor("listener marked as ours", async () => {
    const listeners = await invoke(client, "list_listeners");
    return listeners.find((l) => l.port === PORT && l.ours === true) || false;
  });
  // 命令经 cmd /C 执行，监听端口的是孙进程（node.exe），所以只断言归属，
  // 不断言 pid 相等（本工具记录的是 cmd.exe 的 pid）。
  record(
    "listener owned by our process tree",
    ours.serviceId === SERVICE_ID && ours.pid !== healthy.status.pid,
    `owner=${ours.pid} (${ours.name}) managed=${healthy.status.pid}`,
  );

  // 4. kill it from the outside -> crashed, then start again
  await invoke(client, "stop_pid", { pid: ours.pid, force: true });
  const crashed = await waitFor(
    "state becomes crashed after external kill",
    async () => {
      const list = await invoke(client, "get_services");
      const view = list.find((v) => v.id === SERVICE_ID);
      return view && ["crashed", "conflict", "stopped"].includes(view.status.state) ? view : false;
    },
    25000,
  );
  record("external kill is detected", crashed.status.state === "crashed", `state=${crashed.status.state}`);

  await freePort();
  await invoke(client, "start_service", { id: SERVICE_ID }).catch(() => {});
  const healthyAgain = await waitFor(
    "restart after crash",
    async () => {
      const list = await invoke(client, "get_services");
      const view = list.find((v) => v.id === SERVICE_ID);
      return view && view.status.state === "healthy" ? view : false;
    },
    25000,
  );
  record("service restarts after crash", healthyAgain.status.state === "healthy");

  // 5. stop through the app and verify the port is released and the state settles
  await invoke(client, "stop_service", { id: SERVICE_ID, force: false });
  const settled = await waitFor(
    "port released and state settles",
    async () => {
      if (await tcpOpen(PORT)) return false;
      const list = await invoke(client, "get_services");
      const view = list.find((v) => v.id === SERVICE_ID);
      return view && view.status.state === "stopped" ? view : false;
    },
    20000,
  );
  record("stop_service releases the port and settles to stopped", settled.status.state === "stopped");

  // 6. logs captured the child output
  const logs = await invoke(client, "get_service_logs", { id: SERVICE_ID, limit: 50 });
  record("service logs are captured", logs.some((line) => line.includes("started pid=")), `lines=${logs.length}`);

  await invoke(client, "remove_service", { id: SERVICE_ID });
  const after = await invoke(client, "get_services");
  record("remove_service removes it", after.length === 0, `count=${after.length}`);
} catch (error) {
  record("unexpected failure", false, String(error && error.stack ? error.stack.split("\n")[0] : error));
} finally {
  try {
    if (client) await freePort(3000).catch(() => {});
  } catch {
    // ignore
  }
  foreign.kill();
  if (appChild) spawnSync("taskkill", ["/PID", String(appChild.pid), "/T", "/F"], { stdio: "ignore" });
  const ok = report("e2e-ports", checks);
  process.exit(ok ? 0 : 1);
}
