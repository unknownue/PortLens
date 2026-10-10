// Status presentation logic: i18n label keys, color tones, sort weights.
// Pure module (no React, relative imports only) so `node --test` can import it.

import type { ServiceState } from "./types.ts";
import { SERVICE_STATES } from "./types.ts";
import type { I18nKey } from "./i18n.ts";

/** Mirrors `netsh::PortEnv`: dynamic range start/count plus inclusive exclusion ranges. */
export type PortEnv = { dynamicStart: number; dynamicCount: number; excluded: [number, number][] };

/** Semantic color group behind a state; Tailwind classes are attached per tone. */
export type StateTone = "success" | "info" | "warning" | "caution" | "danger" | "muted" | "neutral";

export const STATE_LABEL_KEY: Record<ServiceState, I18nKey> = {
  stopped: "state.stopped",
  starting: "state.starting",
  healthy: "state.healthy",
  degraded: "state.degraded",
  crashed: "state.crashed",
  conflict: "state.conflict",
  unknown: "state.unknown",
};

export const STATE_TONE: Record<ServiceState, StateTone> = {
  healthy: "success",
  starting: "info",
  degraded: "warning",
  conflict: "caution",
  crashed: "danger",
  stopped: "muted",
  unknown: "neutral",
};

/** Badge surface: tinted background + readable text in both themes. */
export const TONE_BADGE_CLASS: Record<StateTone, string> = {
  success: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  info: "border-blue-500/40 bg-blue-500/15 text-blue-700 dark:text-blue-300",
  warning: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  caution: "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-300",
  danger: "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300",
  muted: "border-zinc-500/40 bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  neutral: "border-slate-500/40 bg-slate-500/15 text-slate-600 dark:text-slate-300",
};

export const TONE_DOT_CLASS: Record<StateTone, string> = {
  success: "bg-emerald-500",
  info: "bg-blue-500",
  warning: "bg-amber-500",
  caution: "bg-orange-500",
  danger: "bg-red-500",
  muted: "bg-zinc-400 dark:bg-zinc-500",
  neutral: "bg-slate-400 dark:bg-slate-500",
};

/** Lower weight sorts first: problems on top, stopped services at the bottom. */
export const STATE_SORT_WEIGHT: Record<ServiceState, number> = {
  crashed: 0,
  conflict: 1,
  degraded: 2,
  starting: 3,
  healthy: 4,
  unknown: 5,
  stopped: 6,
};

export function normalizeState(value: string): ServiceState {
  return (SERVICE_STATES as readonly string[]).includes(value)
    ? (value as ServiceState)
    : "unknown";
}

export function stateLabelKey(state: ServiceState): I18nKey {
  return STATE_LABEL_KEY[state] ?? "state.unknown";
}

export function stateTone(state: ServiceState): StateTone {
  return STATE_TONE[state] ?? "neutral";
}

export function stateBadgeClass(state: ServiceState): string {
  return TONE_BADGE_CLASS[stateTone(state)];
}

export function stateDotClass(state: ServiceState): string {
  return TONE_DOT_CLASS[stateTone(state)];
}

export function stateSortWeight(state: ServiceState): number {
  return STATE_SORT_WEIGHT[state] ?? STATE_SORT_WEIGHT.unknown;
}

export function compareBySeverity(a: ServiceState, b: ServiceState): number {
  return stateSortWeight(a) - stateSortWeight(b);
}

/** States where starting the service again makes sense. */
export function canStart(state: ServiceState): boolean {
  return state === "stopped" || state === "crashed" || state === "unknown";
}

export function canStop(state: ServiceState): boolean {
  return state !== "stopped";
}

/**
 * Client-side mirror of `netsh::is_risky`: a port is risky when it falls inside the
 * dynamic range or any winnet exclusion. Used to warn before a service is saved.
 */
export function isPortRisky(port: number, env: PortEnv | null | undefined): boolean {
  if (!env || !Number.isFinite(port)) return false;
  const start = env.dynamicStart;
  const count = env.dynamicCount;
  if (start > 0 && count > 0 && port >= start && port <= start + count - 1) return true;
  return env.excluded.some(([from, to]) => port >= from && port <= to);
}
