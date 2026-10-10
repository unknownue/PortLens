// Pure-logic tests for the log tab helpers (docs/CONTRACT.md section 10).
import assert from "node:assert/strict";
import { test } from "node:test";

import { dictKeys, translate } from "../src/i18n.ts";
import {
  filterLogLines,
  joinLines,
  logTabForService,
  logTabTitle,
  matchSummary,
  nextLogTabId,
  noisyLine,
  warnLine,
} from "../src/logtab.ts";

test("nextLogTabId skips taken ids", () => {
  assert.equal(nextLogTabId([]), "log-1");
  assert.equal(nextLogTabId([{ id: "log-1", serviceId: "a", title: "a" }]), "log-2");
  assert.equal(
    nextLogTabId([
      { id: "log-1", serviceId: "a", title: "a" },
      { id: "log-3", serviceId: "b", title: "b" },
    ]),
    "log-2",
  );
});

test("logTabForService finds the bound tab", () => {
  const tabs = [
    { id: "log-1", serviceId: "a", title: "a" },
    { id: "log-2", serviceId: "b", title: "b" },
  ];
  assert.equal(logTabForService(tabs, "b")?.id, "log-2");
  assert.equal(logTabForService(tabs, "c"), undefined);
});

test("logTabTitle appends the suffix", () => {
  assert.equal(logTabTitle("svc", "日志"), "svc · 日志");
  assert.equal(logTabTitle("  ", "logs"), "service · logs");
  assert.equal(logTabTitle("svc", ""), "svc");
});

test("keyword filter is case-insensitive and keeps order", () => {
  const lines = ["boot ok", "ERROR upstream failed", "warn: slow", "error retry"];
  assert.deepEqual(filterLogLines(lines, "error"), ["ERROR upstream failed", "error retry"]);
  assert.deepEqual(filterLogLines(lines, ""), lines);
  assert.deepEqual(filterLogLines(lines, "   "), lines);
  assert.deepEqual(filterLogLines(lines, "nomatch"), []);
});

test("regex filter works and an invalid pattern falls back to a literal match", () => {
  const lines = ["tick 1", "tick 42", "tick 7"];
  assert.deepEqual(filterLogLines(lines, "tick \\d{2}", true), ["tick 42"]);
  // "[" is an invalid regex; the literal search finds nothing instead of throwing.
  assert.deepEqual(filterLogLines(["a[b", "zzz"], "[", true), ["a[b"]);
});

test("noisy/warn classification", () => {
  assert.equal(noisyLine("ERROR tick 5 upstream failed"), true);
  assert.equal(noisyLine("2026-10-10 启动失败：端口被占用"), true);
  assert.equal(noisyLine("WARN slow"), false);
  assert.equal(warnLine("WARN tick 3 slow response"), true);
  assert.equal(warnLine("警告：重试"), true);
  assert.equal(warnLine("ERROR tick 5"), false);
  assert.equal(warnLine("plain line"), false);
});

test("matchSummary and joinLines", () => {
  assert.deepEqual(matchSummary(3, 42), { visible: 3, total: 42 });
  assert.equal(joinLines(["a", "b"]), "a\nb");
  assert.equal(joinLines([]), "");
});

test("log tab strings are translated in both languages", () => {
  const keys = dictKeys("zh").filter((key) => key.startsWith("logtab."));
  assert.ok(keys.length >= 15, `expected log tab keys, got ${keys.length}`);
  for (const key of keys) {
    const zh = translate("zh", key);
    const en = translate("en", key);
    assert.ok(zh.trim().length > 0, `${key} zh empty`);
    assert.ok(en.trim().length > 0, `${key} en empty`);
    assert.notEqual(en, key, `${key} missing in en`);
  }
  assert.equal(translate("zh", "logtab.open"), "打开日志标签");
  assert.equal(translate("en", "logtab.open"), "Open log tab");
});
