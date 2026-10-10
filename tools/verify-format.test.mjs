// Verifies uptime / latency / clock formatting boundaries, including 0, <1s,
// minutes, hours and null. Imports the pure TS module directly.
import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY,
  formatClock,
  formatDateTime,
  formatDuration,
  formatLatency,
  formatUptime,
  normalizeUrl,
  serviceUrl,
  titleFromUrl,
} from "../src/format.ts";

test("duration boundaries: 0, <1s, seconds, minutes, hours, days", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(1), "<1s");
  assert.equal(formatDuration(999), "<1s");
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(59_999), "59s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(200_000), "3m 20s");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(7_500_000), "2h 5m");
  assert.equal(formatDuration(86_400_000), "1d");
  assert.equal(formatDuration(90_000_000), "1d 1h");
});

test("duration rejects null / negative / NaN", () => {
  assert.equal(formatDuration(null), EMPTY);
  assert.equal(formatDuration(undefined), EMPTY);
  assert.equal(formatDuration(-1), EMPTY);
  assert.equal(formatDuration(Number.NaN), EMPTY);
  assert.equal(EMPTY, "—");
});

test("uptime keeps 0s but null stays empty", () => {
  assert.equal(formatUptime(0), "0s");
  assert.equal(formatUptime(1), "<1s");
  assert.equal(formatUptime(500), "<1s");
  assert.equal(formatUptime(1000), "1s");
  assert.equal(formatUptime(65_000), "1m 5s");
  assert.equal(formatUptime(7_200_000), "2h");
  assert.equal(formatUptime(null), EMPTY);
  assert.equal(formatUptime(undefined), EMPTY);
  assert.equal(formatUptime(-5), EMPTY);
});

test("latency rounds to ms below one second and switches to seconds above", () => {
  assert.equal(formatLatency(0), "0ms");
  assert.equal(formatLatency(0.4), "0ms");
  assert.equal(formatLatency(12.6), "13ms");
  assert.equal(formatLatency(999), "999ms");
  assert.equal(formatLatency(1000), "1.0s");
  assert.equal(formatLatency(1500), "1.5s");
  assert.equal(formatLatency(12_000), "12s");
  assert.equal(formatLatency(null), EMPTY);
  assert.equal(formatLatency(undefined), EMPTY);
  assert.equal(formatLatency(-3), EMPTY);
});

test("clock and datetime use padded local time and treat epoch 0 as never", () => {
  const sample = new Date(2026, 9, 10, 9, 5, 7).getTime();
  assert.equal(formatClock(sample), "09:05:07");
  assert.equal(formatDateTime(sample), "2026-10-10 09:05:07");
  assert.equal(formatClock(0), EMPTY);
  assert.equal(formatClock(null), EMPTY);
  assert.equal(formatClock(undefined), EMPTY);
  assert.equal(formatClock(-1), EMPTY);
  assert.equal(formatDateTime(0), EMPTY);
  assert.equal(formatDateTime(null), EMPTY);
});

test("service url and tab title helpers", () => {
  assert.equal(serviceUrl(15001), "http://127.0.0.1:15001");
  assert.equal(normalizeUrl("127.0.0.1:15001"), "http://127.0.0.1:15001");
  assert.equal(normalizeUrl("  http://localhost:3000/health  "), "http://localhost:3000/health");
  assert.equal(normalizeUrl("   "), null);
  assert.equal(titleFromUrl("http://127.0.0.1:15001/health"), "127.0.0.1:15001");
  assert.equal(titleFromUrl("not a url"), "not a url");
});
