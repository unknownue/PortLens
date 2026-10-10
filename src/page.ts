// Page-tab header logic: URL shape, protected header names, `${env:…}` / `${file:…}`
// placeholder syntax and the editor draft conversions.
// Pure module (no React, relative imports only) so `node --test` can import it.
//
// Secret handling: this module never receives a plaintext header value from a
// `ServiceView` (those carry only `masked`). Plaintext enters the app through
// `get_page_config` / `reveal_page_header` and is only ever handed back out here as a
// value the user typed or explicitly revealed.

import type { I18nKey } from "./i18n.ts";
import { defaultPageUrl, type PlainHeader } from "./types.ts";

/** Mask applied by the backend for a non-empty header value (docs/CONTRACT.md §9). */
export const MASKED_VALUE = "\u2022\u2022\u2022\u2022\u2022\u2022";

/** Headers a browser owns; WebView2 refuses to let the app inject them. */
export const PROTECTED_HEADERS: readonly string[] = [
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  "proxy-connection",
  "proxy-authorization",
  "expect",
];

/** Case-insensitive, and `:method`-style HTTP/2 pseudo headers count as protected. */
export function isProtectedHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith(":") || PROTECTED_HEADERS.includes(normalized);
}

/** RFC 7230 token: the only thing a header name may contain. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME_RE.test(name.trim());
}

/** Parses a page address; null unless it is a well-formed http(s) URL with a host. */
export function parseHttpUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed;
}

/** `localhost`, `127.0.0.0/8` and `::1` are loopback; everything else is remote. */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1" || name === "0:0:0:0:0:0:0:1" || name === "::ffff:127.0.0.1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) return Number(v4[1]) === 127;
  return false;
}

/**
 * `host` (with port) when the configured headers would leave the machine, else null.
 * Mirrors the editor warning: "the headers you configured will be sent to <host>".
 */
export function externalPageHost(input: string): string | null {
  const parsed = parseHttpUrl(input);
  if (!parsed || isLoopbackHost(parsed.hostname)) return null;
  return parsed.host;
}

export type HeaderValueKind = "empty" | "literal" | "env" | "file";

const PLACEHOLDER_RE = /^\$\{(env|file):(.+)\}$/;

/** Which of the three accepted value forms a header value uses. */
export function headerValueKind(value: string): HeaderValueKind {
  const trimmed = value.trim();
  if (!trimmed) return "empty";
  const match = PLACEHOLDER_RE.exec(trimmed);
  if (!match) return "literal";
  return match[1] === "env" ? "env" : "file";
}

/**
 * Editor row. `key` is a stable React key, never derived from the header name; `show`
 * toggles the password-style value input for that row only.
 */
export type HeaderDraft = { key: string; name: string; value: string; show: boolean };

export function headerDraftsFromPlain(headers: readonly PlainHeader[] | null | undefined): HeaderDraft[] {
  const drafts: HeaderDraft[] = [];
  for (const header of headers ?? []) {
    const name = typeof header?.name === "string" ? header.name : "";
    if (!name) continue;
    drafts.push({
      key: draftKey(drafts.length),
      name,
      value: typeof header?.value === "string" ? header.value : "",
      show: false,
    });
  }
  return drafts;
}

export function draftKey(index: number): string {
  return `h${index}-${Math.random().toString(36).slice(2, 8)}`;
}

export type HeaderIssue = "nameRequired" | "nameInvalid" | "nameDuplicate" | "protectedName";

export type HeaderCheck = { index: number; issue: HeaderIssue; name: string };

export const HEADER_ISSUE_KEY: Record<HeaderIssue, I18nKey> = {
  nameRequired: "service.headerNameRequired",
  nameInvalid: "service.headerNameInvalid",
  nameDuplicate: "service.headerNameDuplicate",
  protectedName: "service.headerProtected",
};

/**
 * Validates the editor rows. A row with neither name nor value is simply ignored;
 * a row with a value but no name is reported so nothing is dropped silently.
 */
export function checkHeaderDrafts(drafts: readonly HeaderDraft[]): HeaderCheck[] {
  const checks: HeaderCheck[] = [];
  const seen = new Map<string, number>();
  drafts.forEach((draft, index) => {
    const name = draft.name.trim();
    if (!name) {
      if (draft.value.trim()) checks.push({ index, issue: "nameRequired", name: "" });
      return;
    }
    if (!isValidHeaderName(name)) {
      checks.push({ index, issue: "nameInvalid", name });
      return;
    }
    if (isProtectedHeader(name)) {
      checks.push({ index, issue: "protectedName", name });
      return;
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      checks.push({ index, issue: "nameDuplicate", name });
      return;
    }
    seen.set(lower, index);
  });
  return checks;
}

/** Collapses the rows into the manifest shape; blank rows are skipped. */
export function headersFromDrafts(drafts: readonly HeaderDraft[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) continue;
    headers[name] = draft.value;
  }
  return headers;
}

/** Address shown in the editor: the effective default stays empty (placeholder wins). */
export function pageUrlForEditor(url: string, port: number): string {
  const trimmed = url.trim();
  return trimmed === defaultPageUrl(port) ? "" : trimmed;
}

/** Title shown in the editor: the service name is the effective default, so hide it. */
export function pageTitleForEditor(title: string, serviceName: string): string {
  const trimmed = title.trim();
  return trimmed === serviceName.trim() ? "" : trimmed;
}

/** Display rows for the drawer: `masked` only, whatever else the payload carries. */
export function maskedHeaderRows(page: unknown): { name: string; masked: string }[] {
  const source = (page ?? {}) as { headers?: unknown };
  const raw: readonly unknown[] = Array.isArray(source.headers) ? source.headers : [];
  const rows: { name: string; masked: string }[] = [];
  for (const entry of raw) {
    const row = entry as { name?: unknown; masked?: unknown } | null | undefined;
    const name = typeof row?.name === "string" ? row.name : "";
    if (!name) continue;
    rows.push({ name, masked: typeof row?.masked === "string" ? row.masked : "" });
  }
  return rows;
}
