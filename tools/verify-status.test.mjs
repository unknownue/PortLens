// Verifies the status presentation map: 7 states, label keys, tone/color classes,
// sort weights. Imports the pure TS modules directly (Node 24 type stripping).
import test from "node:test";
import assert from "node:assert/strict";

import {
  STATE_LABEL_KEY,
  STATE_SORT_WEIGHT,
  STATE_TONE,
  TONE_BADGE_CLASS,
  TONE_DOT_CLASS,
  canStart,
  canStop,
  compareBySeverity,
  isPortRisky,
  normalizeState,
  stateBadgeClass,
  stateDotClass,
  stateLabelKey,
  stateSortWeight,
  stateTone,
} from "../src/status.ts";
import { SERVICE_STATES } from "../src/types.ts";
import { DICTS, dictKeys } from "../src/i18n.ts";

const STATES = ["stopped", "starting", "healthy", "degraded", "crashed", "conflict", "unknown"];

const TONE_BY_STATE = {
  healthy: "success",
  starting: "info",
  degraded: "warning",
  conflict: "caution",
  crashed: "danger",
  stopped: "muted",
  unknown: "neutral",
};

const COLOR_TOKEN = {
  success: "emerald",
  info: "blue",
  warning: "amber",
  caution: "orange",
  danger: "red",
  muted: "zinc",
  neutral: "slate",
};

test("all 7 states are declared exactly once", () => {
  assert.equal(SERVICE_STATES.length, 7);
  assert.deepEqual([...SERVICE_STATES].sort(), [...STATES].sort());
  assert.equal(new Set(SERVICE_STATES).size, 7);
});

test("every state maps to an existing label key in both dictionaries", () => {
  for (const state of STATES) {
    assert.equal(stateLabelKey(state), `state.${state}`);
    assert.equal(STATE_LABEL_KEY[state], `state.${state}`);
    assert.ok(dictKeys("zh").includes(`state.${state}`), `zh lacks state.${state}`);
    assert.ok(dictKeys("en").includes(`state.${state}`), `en lacks state.${state}`);
    assert.equal(DICTS.zh[`state.${state}`].length > 0, true);
    assert.equal(DICTS.en[`state.${state}`].length > 0, true);
  }
});

test("tone mapping follows the contract colors", () => {
  for (const state of STATES) {
    assert.equal(stateTone(state), TONE_BY_STATE[state]);
    assert.equal(STATE_TONE[state], TONE_BY_STATE[state]);
  }
});

test("badge and dot classes use the tone color token", () => {
  for (const state of STATES) {
    const tone = TONE_BY_STATE[state];
    const token = COLOR_TOKEN[tone];
    const badge = stateBadgeClass(state);
    const dot = stateDotClass(state);
    assert.equal(badge, TONE_BADGE_CLASS[tone]);
    assert.ok(badge.includes(token), `${state} badge should mention ${token}`);
    assert.ok(badge.includes("border-"), `${state} badge needs a border class`);
    assert.ok(/bg-[a-z]+-\d{3}/.test(badge), `${state} badge needs a tinted background`);
    assert.ok(badge.includes("dark:text-"), `${state} badge needs a dark-mode text color`);
    assert.equal(dot, TONE_DOT_CLASS[tone]);
    assert.ok(dot.includes(token) && dot.startsWith("bg-"), `${state} dot should be a ${token} fill`);
  }
});

test("sort weights rank problems first and stopped last", () => {
  const weights = STATES.map((state) => stateSortWeight(state));
  assert.equal(new Set(weights).size, 7, "weights must be unique");
  assert.deepEqual(
    [...STATES].sort(compareBySeverity),
    ["crashed", "conflict", "degraded", "starting", "healthy", "unknown", "stopped"],
  );
  assert.ok(stateSortWeight("crashed") < stateSortWeight("healthy"));
  assert.ok(stateSortWeight("healthy") < stateSortWeight("stopped"));
  assert.equal(STATE_SORT_WEIGHT.crashed, 0);
  assert.equal(compareBySeverity("healthy", "healthy"), 0);
});

test("unknown payload values degrade to unknown instead of throwing", () => {
  assert.equal(normalizeState("healthy"), "healthy");
  assert.equal(normalizeState("bogus"), "unknown");
  assert.equal(normalizeState(""), "unknown");
  assert.equal(normalizeState(undefined), "unknown");
  assert.equal(stateLabelKey(normalizeState("nope")), "state.unknown");
});

test("action affordances match state semantics", () => {
  assert.equal(canStart("stopped"), true);
  assert.equal(canStart("crashed"), true);
  assert.equal(canStart("healthy"), false);
  assert.equal(canStart("starting"), false);
  assert.equal(canStop("healthy"), true);
  assert.equal(canStop("conflict"), true);
  assert.equal(canStop("stopped"), false);
});

test("port risk mirrors the backend netsh check", () => {
  const env = { dynamicStart: 1024, dynamicCount: 13977, excluded: [[50000, 50010]] };
  assert.equal(isPortRisky(1024, env), true);
  assert.equal(isPortRisky(15000, env), true);
  assert.equal(isPortRisky(15001, env), false, "15001 is right above 1024+13977-1");
  assert.equal(isPortRisky(50005, env), true);
  assert.equal(isPortRisky(50011, env), false);
  assert.equal(isPortRisky(15001, null), false);
  assert.equal(isPortRisky(15001, undefined), false);
  assert.equal(
    isPortRisky(20000, { dynamicStart: 0, dynamicCount: 0, excluded: [] }),
    false,
    "an empty environment flags nothing",
  );
});
