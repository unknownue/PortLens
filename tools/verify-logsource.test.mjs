// Verifies the logSource declaration surface: defaults, blank definitions, the
// encoding list, the legacy-manifest fallback and the new dictionary keys.
// Imports the pure TS modules directly (Node 24 type stripping).
import test from "node:test";
import assert from "node:assert/strict";

import {
  LOG_ENCODINGS,
  LOG_SOURCE_TYPES,
  asLogEncoding,
  asLogSource,
  blankService,
  defaultLogSource,
  isLogSourceType,
} from "../src/types.ts";
import { DICTS } from "../src/i18n.ts";

const LOG_SOURCE_KEYS = [
  "logSource.process",
  "logSource.file",
  "service.logSource",
  "service.logSourceHint",
  "service.logPath",
  "service.logPathPlaceholder",
  "service.logPathBrowse",
  "service.logPathRequired",
  "service.logEncoding",
  "service.logEncodingHint",
  "drawer.logSource",
  "drawer.logSourceFile",
  "drawer.logSourceFileMissing",
];

test("defaultLogSource is process with no path and no encoding override", () => {
  const source = defaultLogSource();
  assert.equal(source.type, "process");
  assert.equal(source.path, null);
  assert.equal(source.encoding, null);
  assert.notEqual(defaultLogSource(), source, "each call returns a fresh object");
});

test("blankService carries a default logSource next to the default health", () => {
  const blank = blankService();
  assert.deepEqual(blank.logSource, defaultLogSource());
  assert.equal(blank.logSource.type, "process");
  assert.equal(blank.id, "");
  assert.equal(blank.port, 15001);
  assert.deepEqual(blankService(15010).logSource, defaultLogSource());
  assert.equal(blankService(15010).port, 15010);
});

test("log source types are exactly process and file", () => {
  assert.deepEqual([...LOG_SOURCE_TYPES], ["process", "file"]);
  assert.equal(isLogSourceType("process"), true);
  assert.equal(isLogSourceType("file"), true);
  assert.equal(isLogSourceType("stdout"), false);
  assert.equal(isLogSourceType(""), false);
});

test("LOG_ENCODINGS offers utf-8 and gbk plus the contract encodings", () => {
  assert.ok(LOG_ENCODINGS.includes("utf-8"), "utf-8 must be selectable");
  assert.ok(LOG_ENCODINGS.includes("gbk"), "gbk must be selectable");
  assert.deepEqual(
    [...LOG_ENCODINGS].sort(),
    ["big5", "gb18030", "gbk", "shift_jis", "utf-16be", "utf-16le", "utf-8"].sort(),
  );
  assert.equal(new Set(LOG_ENCODINGS).size, LOG_ENCODINGS.length, "no duplicate encodings");
  assert.equal(LOG_ENCODINGS[0], "utf-8", "utf-8 is the default, so it leads the list");
  for (const encoding of LOG_ENCODINGS) {
    assert.equal(encoding, encoding.toLowerCase(), `${encoding} must be lower case`);
  }
});

test("asLogSource falls back to the default for legacy manifests", () => {
  assert.deepEqual(asLogSource(undefined), defaultLogSource());
  assert.deepEqual(asLogSource(null), defaultLogSource());
  assert.deepEqual(asLogSource({ type: "bogus" }), defaultLogSource());
  assert.deepEqual(asLogSource({ type: "file", path: "D:\\logs\\app.log" }), {
    type: "file",
    path: "D:\\logs\\app.log",
    encoding: null,
  });
  assert.deepEqual(asLogSource({ type: "file", path: "a.log", encoding: "gbk" }).encoding, "gbk");
  assert.equal(asLogSource({ type: "process" }).path, null);
});

test("asLogEncoding keeps known encodings and falls back to utf-8", () => {
  assert.equal(asLogEncoding("gbk"), "gbk");
  assert.equal(asLogEncoding("utf-16le"), "utf-16le");
  assert.equal(asLogEncoding("GBK"), "utf-8", "matching is case sensitive, like the backend");
  assert.equal(asLogEncoding("cp936"), "utf-8");
  assert.equal(asLogEncoding(""), "utf-8");
  assert.equal(asLogEncoding(null), "utf-8");
  assert.equal(asLogEncoding(undefined), "utf-8");
  for (const encoding of LOG_ENCODINGS) {
    assert.equal(asLogEncoding(encoding), encoding);
  }
});

test("the new logSource keys exist and are non-empty in zh and en", () => {
  for (const key of LOG_SOURCE_KEYS) {
    for (const lang of ["zh", "en"]) {
      const value = DICTS[lang][key];
      assert.equal(typeof value, "string", `${lang}.${key} must be a string`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
    assert.notEqual(DICTS.zh[key], DICTS.en[key], `${key} should be translated, not copied`);
  }
});

test("the file label interpolates the path and keeps zh/en placeholder parity", () => {
  assert.equal(DICTS.zh["drawer.logSourceFile"].includes("{path}"), true);
  assert.equal(DICTS.en["drawer.logSourceFile"].includes("{path}"), true);
  assert.equal(DICTS.zh["drawer.logSourceFile"].replace("{path}", "D:\\a.log"), "文件：D:\\a.log");
  assert.equal(DICTS.en["drawer.logSourceFile"].replace("{path}", "D:\\a.log"), "File: D:\\a.log");
});
