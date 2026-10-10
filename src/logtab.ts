// Pure helpers for the log tab (no React, importable by `node --test`).

import type { LogTab } from "./types";

/** Next free log tab id: `log-1`, `log-2`, ... */
export function nextLogTabId(existing: readonly LogTab[]): string {
  let index = 1;
  while (existing.some((tab) => tab.id === `log-${index}`)) index += 1;
  return `log-${index}`;
}

export function logTabTitle(serviceName: string, suffix: string): string {
  const name = serviceName.trim() || "service";
  return suffix ? `${name} · ${suffix}` : name;
}

export function logTabForService(tabs: readonly LogTab[], serviceId: string): LogTab | undefined {
  return tabs.find((tab) => tab.serviceId === serviceId);
}

/** Lines that deserve an alert colour. Kept ASCII+CJK aware on purpose. */
export function noisyLine(line: string): boolean {
  return /(\berror\b|\bfail(ed|ure)?\b|\bexception\b|\bpanic\b|错误|失败|异常|致命)/i.test(line);
}

export function warnLine(line: string): boolean {
  return !noisyLine(line) && /(\bwarn(ing)?\b|警告|超时|timeout|retry)/i.test(line);
}

/**
 * Filter log lines. Empty query returns everything; `useRegex` builds a case-insensitive regex
 * (an invalid pattern falls back to a literal substring match instead of throwing).
 */
export function filterLogLines(lines: readonly string[], query: string, useRegex = false): string[] {
  const text = query.trim();
  if (!text) return [...lines];
  if (useRegex) {
    try {
      const re = new RegExp(text, "i");
      return lines.filter((line) => re.test(line));
    } catch {
      // fall through to the literal match
    }
  }
  const needle = text.toLowerCase();
  return lines.filter((line) => line.toLowerCase().includes(needle));
}

/** `match / total` for the filter badge; total is the unfiltered line count. */
export function matchSummary(visible: number, total: number): { visible: number; total: number } {
  return { visible, total };
}

/** Text of the visible lines, for the copy action. */
export function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}
