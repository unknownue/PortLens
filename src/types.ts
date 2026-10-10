// Shared shapes. Field names mirror the Rust serde output (see docs/CONTRACT.md).
// This module must stay importable by plain `node --test`: relative imports only,
// no enums, no decorators, no React.

export type ServiceState =
  | "stopped"
  | "starting"
  | "healthy"
  | "degraded"
  | "crashed"
  | "conflict"
  | "unknown";

/** Declaration order used for documentation; sorting uses `stateSortWeight`. */
export const SERVICE_STATES: readonly ServiceState[] = [
  "stopped",
  "starting",
  "healthy",
  "degraded",
  "crashed",
  "conflict",
  "unknown",
];

export type ProbeType = "tcp" | "http" | "exec" | "none";

export const PROBE_TYPES: readonly ProbeType[] = ["tcp", "http", "exec", "none"];

export function isProbeType(value: string): value is ProbeType {
  return (PROBE_TYPES as readonly string[]).includes(value);
}

export type LogSourceType = "process" | "file";

export const LOG_SOURCE_TYPES: readonly LogSourceType[] = ["process", "file"];

export function isLogSourceType(value: string): value is LogSourceType {
  return (LOG_SOURCE_TYPES as readonly string[]).includes(value);
}

export type LogEncoding =
  | "utf-8"
  | "gbk"
  | "gb18030"
  | "utf-16le"
  | "utf-16be"
  | "shift_jis"
  | "big5";

export const LOG_ENCODINGS: readonly LogEncoding[] = [
  "utf-8",
  "gbk",
  "gb18030",
  "utf-16le",
  "utf-16be",
  "shift_jis",
  "big5",
];

export function asLogEncoding(value: string | null | undefined): LogEncoding {
  return value && (LOG_ENCODINGS as readonly string[]).includes(value)
    ? (value as LogEncoding)
    : "utf-8";
}

/** `process` = stdout/stderr of the process we started; `file` = tail-follow `path`. */
export type LogSource = {
  type: LogSourceType;
  path?: string | null;
  encoding?: string | null;
};

export type HealthConfig = {
  type: string;
  path?: string | null;
  command?: string | null;
  intervalMs: number;
  timeoutMs: number;
  failureThreshold: number;
};

export type ServiceDef = {
  id: string;
  name: string;
  port: number;
  command?: string | null;
  cwd?: string | null;
  health: HealthConfig;
  logSource: LogSource;
};

export type ServiceStatus = {
  id: string;
  state: ServiceState;
  detail: string;
  pid: number | null;
  latencyMs: number | null;
  sinceMs: number;
  uptimeMs: number;
  exitCode: number | null;
  history: boolean[];
};

export type ServiceView = ServiceDef & { status: ServiceStatus; risky: boolean };

export type ListenerView = {
  port: number;
  addr: string;
  pid: number;
  name: string;
  exe: string;
  ppid: number;
  parentName: string;
  established: number;
  serviceId: string | null;
  ours: boolean;
};

export type Settings = {
  pollIntervalMs: number;
  language: string;
  theme: string;
  stopManagedOnExit: boolean;
};

export type EnvView = {
  manifestPath: string;
  dataDir: string;
  dynamicStart: number;
  dynamicCount: number;
  excluded: [number, number][];
};

export type PageTab = { label: string; title: string; url: string };

export type Rect = { x: number; y: number; w: number; h: number };

export type NoticeLevel = "info" | "warn" | "error";

export type Notice = { level: NoticeLevel; code: string; detail: string };

export type PageLoadPayload = { label: string; url: string; phase: "started" | "finished" };

export type LogPayload = { id: string; lines: string[] };

export type Language = "zh" | "en";

export type Theme = "dark" | "light";

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalMs: 1000,
  language: "zh",
  theme: "dark",
  stopManagedOnExit: false,
};

export function defaultHealth(): HealthConfig {
  return { type: "tcp", path: null, command: null, intervalMs: 2000, timeoutMs: 1000, failureThreshold: 2 };
}

export function defaultLogSource(): LogSource {
  return { type: "process", path: null, encoding: null };
}

/** Manifests written before v0.2 have no `logSource`; fall back to the default. */
export function asLogSource(value: Partial<LogSource> | null | undefined): LogSource {
  if (!value) return defaultLogSource();
  return {
    type: isLogSourceType(value.type ?? "") ? (value.type as LogSourceType) : "process",
    path: value.path ?? null,
    encoding: value.encoding ?? null,
  };
}

/** Blank definition for the "new service" dialog; `id` is derived by the backend. */
export function blankService(port = 15001): ServiceDef {
  return {
    id: "",
    name: "",
    port,
    command: null,
    cwd: null,
    health: defaultHealth(),
    logSource: defaultLogSource(),
  };
}

export function asLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "zh";
}

export function asTheme(value: string | null | undefined): Theme {
  return value === "light" ? "light" : "dark";
}
