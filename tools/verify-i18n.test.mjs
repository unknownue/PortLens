// Verifies the zh/en dictionaries: identical key sets, no empty values,
// placeholder parity, state labels present, interpolation behaviour.
import test from "node:test";
import assert from "node:assert/strict";

import { DICTS, LANGUAGES, dictKeys, translate, zh, en } from "../src/i18n.ts";
import { SERVICE_STATES } from "../src/types.ts";

const STATES = ["stopped", "starting", "healthy", "degraded", "crashed", "conflict", "unknown"];

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

test("zh and en expose exactly the same key set", () => {
  const zhKeys = dictKeys("zh");
  const enKeys = dictKeys("en");
  assert.deepEqual(enKeys, zhKeys);
  assert.equal(zhKeys.length, new Set(zhKeys).size, "no duplicate keys");
  assert.ok(zhKeys.length > 100, `expected a full dictionary, got ${zhKeys.length} keys`);
  assert.deepEqual(Object.keys(en).sort(), zhKeys);
  assert.deepEqual(Object.keys(zh).sort(), zhKeys);
  assert.deepEqual([...LANGUAGES], ["zh", "en"]);
  assert.equal(DICTS.zh, zh);
  assert.equal(DICTS.en, en);
});

test("no dictionary value is empty or whitespace only", () => {
  for (const lang of LANGUAGES) {
    for (const [key, value] of Object.entries(DICTS[lang])) {
      assert.equal(typeof value, "string", `${lang}.${key} must be a string`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test("placeholders match between zh and en", () => {
  for (const key of dictKeys("zh")) {
    assert.deepEqual(
      placeholders(en[key]),
      placeholders(zh[key]),
      `placeholder mismatch for ${key}`,
    );
  }
});

test("all 7 status label keys exist in both languages", () => {
  assert.equal(SERVICE_STATES.length, 7);
  for (const state of STATES) {
    const key = `state.${state}`;
    assert.ok(dictKeys("zh").includes(key), `zh lacks ${key}`);
    assert.ok(dictKeys("en").includes(key), `en lacks ${key}`);
    assert.notEqual(zh[key], en[key], `${key} should be translated, not copied`);
  }
});

test("dictionary covers the interactive surface used by the UI", () => {
  const required = [
    "toolbar.add",
    "toolbar.startAll",
    "toolbar.stopAll",
    "toolbar.refresh",
    "toolbar.language",
    "toolbar.theme",
    "toolbar.settings",
    "tabs.dashboard",
    "tabs.new",
    "tabs.reload",
    "tabs.external",
    "table.service",
    "table.port",
    "table.status",
    "table.pid",
    "table.latency",
    "table.uptime",
    "table.changed",
    "table.actions",
    "action.start",
    "action.stop",
    "action.restart",
    "action.probe",
    "action.openPage",
    "action.edit",
    "action.delete",
    "action.details",
    "risk.tooltip",
    "listeners.title",
    "listeners.stopTitle",
    "confirm.force",
    "confirm.forceHint",
    "drawer.timeline",
    "drawer.logs",
    "drawer.config",
    "service.addTitle",
    "service.editTitle",
    "service.nameRequired",
    "service.deleteTitle",
    "settings.title",
    "settings.importPreset",
    "settings.manifestPath",
    "probe.tcp",
    "probe.http",
    "probe.exec",
    "probe.none",
    "notice.warn",
  ];
  const keys = dictKeys("zh");
  for (const key of required) {
    assert.ok(keys.includes(key), `missing key ${key}`);
    assert.ok(dictKeys("en").includes(key), `en missing key ${key}`);
  }
});

test("translate interpolates params and survives unknown ones", () => {
  assert.equal(translate("zh", "toast.started", { name: "api" }), "已启动 api");
  assert.equal(translate("en", "toast.started", { name: "api" }), "Started api");
  assert.equal(translate("zh", "listeners.count", { count: 3 }), "3 个");
  assert.equal(translate("en", "settings.excludedNone"), "none");
  assert.equal(
    translate("zh", "toast.failed", { message: "boom" }),
    "操作失败：boom",
  );
  assert.equal(translate("zh", "toast.started"), "已启动 {name}");
  assert.equal(translate("en", "risk.tooltip").includes("EADDRINUSE"), true);
});
