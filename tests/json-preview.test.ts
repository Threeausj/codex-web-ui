import test from "node:test";
import assert from "node:assert/strict";
import { isJsonPath, jsonUnicodePreview } from "../src/lib/json-preview.js";

test("JSON Unicode reading preserves document layout and exact number spellings", () => {
  const source = String.raw`{
  "\u4e2d\u6587": "/datasets/4\u67089\u53f7\u65b0\u6570\u636e/\u4e0b\u54bd",
  "large": 900719925474099312345, "decimal": 1.2300e+09,
  "duplicate": 1, "duplicate": 2
}
`;
  const preview = jsonUnicodePreview(source);
  assert.equal(preview, source.replace(String.raw`\u4e2d\u6587`, "中文")
    .replace(String.raw`\u6708`, "月")
    .replace(String.raw`\u53f7\u65b0\u6570\u636e`, "号新数据")
    .replace(String.raw`\u4e0b\u54bd`, "下咽"));
  assert.equal(preview.split("\n").length, source.split("\n").length);
});

test("literal backslashes and JSON ASCII escapes are never decoded twice", () => {
  const source = String.raw`{"literal":"\\u4e2d","mixed":"\\\u4e2d","slashes":"\\\\u4e2d","ascii":"\u0022\u005c\u002f\u0041\n\t\"","text":"\u4E2D"}`;
  const preview = jsonUnicodePreview(source);
  assert.equal(preview, String.raw`{"literal":"\\u4e2d","mixed":"\\中","slashes":"\\\\u4e2d","ascii":"\u0022\u005c\u002f\u0041\n\t\"","text":"中"}`);
  assert.deepEqual(JSON.parse(preview), JSON.parse(source));
});

test("valid surrogate pairs render supplementary characters while lone surrogates stay escaped", () => {
  const source = String.raw`{"emoji":"\uD83D\uDE80","cjk":"\ud840\udc00","high":"\uD83D","low":"\uDE80","followed":"\uD83D\u4e2d"}`;
  const preview = jsonUnicodePreview(source);
  assert.equal(preview, String.raw`{"emoji":"🚀","cjk":"𠀀","high":"\uD83D","low":"\uDE80","followed":"\uD83D中"}`);
  assert.deepEqual(JSON.parse(preview), JSON.parse(source));
});

test("control, invisible formatting and line separators retain their escape spellings", () => {
  const source = String.raw`{"text":"\u0000\u001b\u007f\u0085\u00ad\u061c\u200b\u200d\u200e\u2028\u2029\u202e\u2066\ufeff\u4e2d"}`;
  assert.equal(jsonUnicodePreview(source), source.replace(String.raw`\u4e2d`, "中"));
});

test("JSON Lines renders string tokens without changing line boundaries", () => {
  const source = String.raw`{"name":"\u4e2d\u6587","id":18446744073709551615}
{"name":"\u6587\u4ef6","escaped":"\\u4e2d"}
`;
  const preview = jsonUnicodePreview(source);
  assert.equal(preview, String.raw`{"name":"中文","id":18446744073709551615}
{"name":"文件","escaped":"\\u4e2d"}
`);
  assert.equal(preview.split("\n").length, source.split("\n").length);
});

test("malformed or unterminated strings are preserved and text outside strings is untouched", () => {
  for (const source of [
    String.raw`{"name":"\u4e2d\q"}`,
    String.raw`{"name":"\u4e2d\u12xz"}`,
    String.raw`{"name":"\u4e2d`,
    '{"name":"\\u4e2d\nbreak"}',
    String.raw`\u4e2d outside`,
  ]) assert.equal(jsonUnicodePreview(source), source);
  assert.equal(jsonUnicodePreview(String.raw`{"bad":"\u4e2d\q","good":"\u6587"}`),
    String.raw`{"bad":"\u4e2d\q","good":"文"}`);
});

test("JSON preview recognizes only supported file formats", () => {
  for (const path of ["/project/data.json", "data.JSON", "/data/events.jsonl", "/data/events.NDJSON"])
    assert.equal(isJsonPath(path), true, path);
  for (const path of ["/data/tsconfig.jsonc", "/data/json", "/data/file.json.md", "/data/file.json5"])
    assert.equal(isJsonPath(path), false, path);
});

test("multi-megabyte single-line strings work without recursive parsing or large regex groups", () => {
  const ascii = "x".repeat(2 * 1024 * 1024);
  const source = '{"path":"' + ascii + String.raw`\u4e2d\u6587","exact":900719925474099312345}`;
  assert.equal(jsonUnicodePreview(source), '{"path":"' + ascii + '中文","exact":900719925474099312345}');
  const escaped = String.raw`\u4e2d\u6587`.repeat(150_000);
  assert.equal(jsonUnicodePreview('"' + escaped + '"'), '"' + "中文".repeat(150_000) + '"');
});
