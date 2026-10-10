// Verifies the "page" surface added in v0.3 (docs/CONTRACT.md §9): the fallbacks for
// manifests without `page`, the masked-only display path, the protected-header check,
// the URL/placeholder helpers and the new dictionary keys.
// Imports the pure TS modules directly (Node 24 type stripping).
import test from "node:test";
import assert from "node:assert/strict";

import {
  asPageConfig,
  asPageConfigFromView,
  asPageView,
  blankPage,
  blankService,
  defaultPageUrl,
} from "../src/types.ts";
import {
  HEADER_ISSUE_KEY,
  MASKED_VALUE,
  checkHeaderDrafts,
  externalPageHost,
  headerDraftsFromPlain,
  headerValueKind,
  headersFromDrafts,
  isLoopbackHost,
  isProtectedHeader,
  isValidHeaderName,
  maskedHeaderRows,
  pageTitleForEditor,
  pageUrlForEditor,
  parseHttpUrl,
} from "../src/page.ts";
import { DICTS, translate } from "../src/i18n.ts";

const PAGE_KEYS = [
  "service.page",
  "service.pageHint",
  "service.pageUrl",
  "service.pageUrlPlaceholder",
  "service.pageUrlInvalid",
  "service.pageTitle",
  "service.pageTitlePlaceholder",
  "service.pageHeaders",
  "service.pageHeadersHint",
  "service.pageHeadersEmpty",
  "service.pageHeadersAdd",
  "service.pageHeadersLoadFailed",
  "service.pageHeadersRetry",
  "service.pageExternalWarning",
  "service.headerName",
  "service.headerValue",
  "service.headerNameRequired",
  "service.headerNameInvalid",
  "service.headerNameDuplicate",
  "service.headerProtected",
  "drawer.page",
  "drawer.pageUrl",
  "drawer.pageTitle",
  "drawer.pageHeaders",
  "drawer.pageHeadersEmpty",
  "drawer.pageExternalWarning",
  "action.show",
  "action.hide",
  "tabs.needsHeaders",
];

test("blankPage is an empty url/title with no headers, and each call is fresh", () => {
  assert.deepEqual(blankPage(), { url: null, headers: {}, title: null });
  assert.notEqual(blankPage(), blankPage());
  assert.notEqual(blankPage().headers, blankPage().headers);
});

test("blankService carries a blank page config next to the other defaults", () => {
  const blank = blankService();
  assert.deepEqual(blank.page, blankPage());
  assert.equal(defaultPageUrl(blank.port), "http://127.0.0.1:15001/");
  assert.equal(defaultPageUrl(15010), "http://127.0.0.1:15010/");
});

test("asPageConfig falls back for legacy manifests and normalizes what is there", () => {
  assert.deepEqual(asPageConfig(undefined), { url: null, headers: {}, title: null });
  assert.deepEqual(asPageConfig(null), { url: null, headers: {}, title: null });
  assert.deepEqual(asPageConfig({}), { url: null, headers: {}, title: null });
  assert.deepEqual(asPageConfig({ url: "   ", title: "\t" }), { url: null, headers: {}, title: null });

  const kept = asPageConfig({
    url: "  http://127.0.0.1:15901/ui  ",
    title: " stzbmcp ",
    headers: { "X-STZBMCP-Token": "${env:STZBMCP_TOKEN}" },
  });
  assert.equal(kept.url, "http://127.0.0.1:15901/ui");
  assert.equal(kept.title, "stzbmcp");
  assert.deepEqual(kept.headers, { "X-STZBMCP-Token": "${env:STZBMCP_TOKEN}" });

  // Non-string values (a hand-edited manifest) are dropped, not coerced.
  const messy = asPageConfig({ headers: { Good: "1", Bad: 2, Worse: null } });
  assert.deepEqual(messy.headers, { Good: "1" });
});

test("asPageView fills the unspecified parts and never invents headers", () => {
  const view = asPageView(undefined, 15001);
  assert.equal(view.url, "http://127.0.0.1:15001/");
  assert.equal(view.title, "");
  assert.deepEqual(view.headers, []);
  assert.equal(view.externalHost, false);

  const filled = asPageView(
    {
      url: "http://127.0.0.1:15901/",
      title: "bridge",
      externalHost: true,
      headers: [{ name: "X-STZBMCP-Token", masked: MASKED_VALUE }],
    },
    15901,
  );
  assert.equal(filled.url, "http://127.0.0.1:15901/");
  assert.equal(filled.title, "bridge");
  assert.equal(filled.externalHost, true);
  assert.deepEqual(filled.headers, [{ name: "X-STZBMCP-Token", masked: MASKED_VALUE }]);

  // A nameless row is not renderable and is dropped.
  assert.deepEqual(asPageView({ headers: [{ masked: MASKED_VALUE }] }).headers, []);
});

test("the visible header list uses `masked`, never a plaintext `value`", () => {
  const leaked = {
    url: "http://127.0.0.1:15901/",
    title: "bridge",
    externalHost: false,
    headers: [
      { name: "X-STZBMCP-Token", masked: MASKED_VALUE, value: "s3cr3t-PlainText" },
      { name: "Authorization", masked: MASKED_VALUE, value: "Bearer s3cr3t-PlainText" },
    ],
  };

  const rows = maskedHeaderRows(leaked);
  assert.deepEqual(rows, [
    { name: "X-STZBMCP-Token", masked: MASKED_VALUE },
    { name: "Authorization", masked: MASKED_VALUE },
  ]);
  assert.deepEqual(Object.keys(rows[0]), ["name", "masked"]);

  const rendered = JSON.stringify(rows);
  assert.equal(rendered.includes("s3cr3t-PlainText"), false, "plaintext must not survive the selector");
  assert.equal(rendered.includes(MASKED_VALUE), true);
  assert.equal(MASKED_VALUE.length, 6, "the mask is 6 dots (contract §9)");

  // `asPageView` rebuilds rows the same way, so a leaked payload is defused there too.
  const view = asPageView(leaked, 15901);
  assert.equal(JSON.stringify(view).includes("s3cr3t-PlainText"), false);
  assert.equal(view.headers.every((header) => header.masked === MASKED_VALUE), true);

  // The declarative shape used for `update_service` never carries the mask back either.
  assert.deepEqual(asPageConfigFromView(leaked).headers, {});
  assert.equal(asPageConfigFromView(leaked).url, "http://127.0.0.1:15901/");
  assert.equal(JSON.stringify(asPageConfigFromView(leaked)).includes(MASKED_VALUE), false);
});

test("an empty header value stays unmasked (contract §9)", () => {
  assert.deepEqual(asPageView({ headers: [{ name: "X-Empty", masked: "" }] }).headers, [
    { name: "X-Empty", masked: "" },
  ]);
});

test("protected header names are matched case-insensitively", () => {
  for (const name of ["Host", "content-length", "CONNECTION", "Transfer-Encoding", "  Upgrade  "]) {
    assert.equal(isProtectedHeader(name), true, `${name} must be protected`);
  }
  assert.equal(isProtectedHeader(":method"), true, "HTTP/2 pseudo headers are protected");

  for (const name of ["X-Token", "x-stzbmcp-token", "Authorization", "Cookie", ""]) {
    assert.equal(isProtectedHeader(name), false, `${name} must be allowed`);
  }
});

test("header names must be RFC 7230 tokens", () => {
  assert.equal(isValidHeaderName("X-STZBMCP-Token"), true);
  assert.equal(isValidHeaderName("X_Custom.Header~1"), true);
  assert.equal(isValidHeaderName(""), false);
  assert.equal(isValidHeaderName("X Token"), false);
  assert.equal(isValidHeaderName("X-Token:"), false);
});

test("checkHeaderDrafts reports blank names, bad names, duplicates and protected ones", () => {
  const drafts = (rows) =>
    rows.map(([name, value], index) => ({ key: `k${index}`, name, value, show: false }));

  assert.deepEqual(checkHeaderDrafts(drafts([["", ""]])), [], "a fully blank row is ignored");
  assert.deepEqual(checkHeaderDrafts(drafts([["X-Token", "abc"]])), []);

  const issues = checkHeaderDrafts(
    drafts([
      ["", "orphan-value"],
      ["Bad Name", "v"],
      ["Host", "example.com"],
      ["X-Token", "a"],
      ["x-token", "b"],
      ["X-Other", ""],
    ]),
  );
  assert.deepEqual(
    issues.map((issue) => issue.issue),
    ["nameRequired", "nameInvalid", "protectedName", "nameDuplicate"],
  );
  assert.deepEqual(
    issues.map((issue) => issue.index),
    [0, 1, 2, 4],
  );
  assert.equal(issues[2].name, "Host");
  for (const issue of issues) {
    const key = HEADER_ISSUE_KEY[issue.issue];
    assert.ok(key in DICTS.zh && key in DICTS.en, `${issue.issue} must map to an i18n key`);
  }
});

test("headersFromDrafts skips blank rows and keeps values verbatim", () => {
  const headers = headersFromDrafts([
    { key: "a", name: "  X-STZBMCP-Token ", value: "${env:STZBMCP_TOKEN}", show: false },
    { key: "b", name: "", value: "", show: false },
    { key: "c", name: "Accept", value: "application/json", show: false },
  ]);
  assert.deepEqual(headers, {
    "X-STZBMCP-Token": "${env:STZBMCP_TOKEN}",
    Accept: "application/json",
  });
});

test("headerDraftsFromPlain keeps the plaintext and never marks a row as revealed", () => {
  const drafts = headerDraftsFromPlain([
    { name: "X-STZBMCP-Token", value: "plain-token" },
    { name: "", value: "ignored" },
  ]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].name, "X-STZBMCP-Token");
  assert.equal(drafts[0].value, "plain-token");
  assert.equal(drafts[0].show, false, "values stay hidden until the user reveals them");
  assert.equal(new Set(drafts.map((draft) => draft.key)).size, drafts.length, "keys are unique");
  assert.deepEqual(headerDraftsFromPlain(undefined), []);
});

test("page URL helpers validate http(s) and flag non-loopback hosts", () => {
  assert.equal(parseHttpUrl("http://127.0.0.1:15901/")?.host, "127.0.0.1:15901");
  assert.equal(parseHttpUrl("https://example.com/ui")?.host, "example.com");
  assert.equal(parseHttpUrl(""), null);
  assert.equal(parseHttpUrl("127.0.0.1:15901"), null, "a scheme is required");
  assert.equal(parseHttpUrl("ftp://127.0.0.1/"), null);
  assert.equal(parseHttpUrl("http://"), null);

  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.5.6.7"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
  assert.equal(isLoopbackHost("example.com"), false);

  assert.equal(externalPageHost("http://127.0.0.1:15901/"), null);
  assert.equal(externalPageHost("http://localhost:15901/"), null);
  assert.equal(externalPageHost("http://10.0.0.5:15901/"), "10.0.0.5:15901");
  assert.equal(externalPageHost("https://example.com/ui"), "example.com");
  assert.equal(externalPageHost(""), null);
});

test("editor drafts hide the effective defaults behind placeholders", () => {
  assert.equal(pageUrlForEditor(defaultPageUrl(15001), 15001), "");
  assert.equal(pageUrlForEditor("http://127.0.0.1:15001", 15001), "http://127.0.0.1:15001");
  assert.equal(pageUrlForEditor("http://127.0.0.1:15901/", 15001), "http://127.0.0.1:15901/");
  assert.equal(pageUrlForEditor("", 15001), "");

  assert.equal(pageTitleForEditor("bridge", "bridge"), "");
  assert.equal(pageTitleForEditor("Bridge", "bridge"), "Bridge");
  assert.equal(pageTitleForEditor("", "bridge"), "");
});

test("header value placeholders are recognized", () => {
  assert.equal(headerValueKind(""), "empty");
  assert.equal(headerValueKind("   "), "empty");
  assert.equal(headerValueKind("plain"), "literal");
  assert.equal(headerValueKind("${env:STZBMCP_TOKEN}"), "env");
  assert.equal(headerValueKind("${file:D:\\secrets\\bridge.env:TOKEN}"), "file");
  assert.equal(headerValueKind("Bearer ${env:TOKEN}"), "literal", "the placeholder must be the whole value");
});

test("the new page keys exist, are non-empty and interpolate in both languages", () => {
  for (const key of PAGE_KEYS) {
    for (const lang of ["zh", "en"]) {
      const value = DICTS[lang][key];
      assert.equal(typeof value, "string", `${lang}.${key} must be a string`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
  assert.equal(translate("zh", "service.pageUrlPlaceholder", { port: 15901 }), "留空 = http://127.0.0.1:15901/");
  assert.equal(translate("en", "service.pageUrlPlaceholder", { port: 15901 }), "Empty = http://127.0.0.1:15901/");
  assert.equal(
    translate("zh", "service.pageExternalWarning", { host: "example.com" }).includes("example.com"),
    true,
  );
  assert.equal(
    translate("en", "service.pageExternalWarning", { host: "example.com" }).includes("example.com"),
    true,
  );
  assert.equal(translate("zh", "service.headerProtected", { name: "Host" }).includes("Host"), true);
  assert.equal(translate("en", "service.headerNameDuplicate", { name: "X-A" }).includes("X-A"), true);
});

test("the placeholder hint never interpolates the ${env:...} example", () => {
  const zh = translate("zh", "service.pageHeadersHint");
  const en = translate("en", "service.pageHeadersHint");
  for (const text of [zh, en]) {
    assert.equal(text.includes("${env:STZBMCP_TOKEN}"), true, "the example must survive translation");
    assert.equal(text.includes("${file:PATH:KEY}"), true);
  }
});
