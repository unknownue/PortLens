// Number/time formatting. Pure module: no React, relative imports only,
// importable by `node --test`.

/** Placeholder for "no value"; never localized so tests and tables stay stable. */
export const EMPTY = "—";

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * Compact duration: `0s`, `<1s`, `12s`, `3m 20s`, `2h 5m`, `1d 3h`.
 * `null`/`undefined`/negative render as `EMPTY`.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return EMPTY;
  if (ms === 0) return "0s";
  if (ms < MS_PER_SECOND) return "<1s";
  if (ms < MS_PER_MINUTE) return `${Math.floor(ms / MS_PER_SECOND)}s`;
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (ms < MS_PER_DAY) {
    const hours = Math.floor(ms / MS_PER_HOUR);
    const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/** Uptime column: only `healthy` reports non-zero uptime, so 0 means "not running". */
export function formatUptime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return ms === 0 ? "0s" : EMPTY;
  }
  return formatDuration(ms);
}

/** Probe latency: `0ms`, `999ms`, `1.5s`. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return EMPTY;
  if (ms < MS_PER_SECOND) return `${Math.round(ms)}ms`;
  const seconds = ms / MS_PER_SECOND;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

/** Local wall clock `HH:MM:SS`; epoch 0 / null means "never". */
export function formatClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return EMPTY;
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Local `YYYY-MM-DD HH:MM:SS`; used for tooltips. */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return EMPTY;
  const date = new Date(ms);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${formatClock(ms)}`;
}

/** Default URL for "open page": the service port on loopback. */
export function serviceUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Accepts bare hosts (`localhost:3000`) and prefixes `http://`; null for blank input. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/** Tab title derived from a URL: host:port, falling back to the raw string. */
export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}
