import test from "node:test";
import assert from "node:assert/strict";
import { previewFilePath, fileLinkLocation } from "../src/lib/file-preview.js";

test("Markdown references resolve beside the current document within the project", () => {
  assert.equal(previewFilePath("../图片/图%20一.png?raw=1", "/project/docs/readme.md", "/project"), "/project/图片/图 一.png");
  assert.equal(previewFilePath("/project/docs/next.md#intro", "/project/docs/readme.md", "/project"), "/project/docs/next.md");
});

test('conversation file links preserve their source line and safely decode filenames', () => {
  assert.deepEqual(fileLinkLocation('/project/My%20File.ts:42:7'), { path: '/project/My File.ts', line: 42, column: 7 });
  assert.deepEqual(fileLinkLocation('/project/file.ts'), { path: '/project/file.ts' });
  for (const link of ['relative.ts:2', '/project/file.ts:0', '/project/%00file.ts:2', '//evil/file.ts:2', '/project/%ZZ.ts']) assert.equal(fileLinkLocation(link), null, link);
});
test("Markdown cannot read files outside the project or turn URLs into local paths", () => {
  for (const reference of ["../../secret.png", "/project-other/secret.png", "https://example.com/image.png", "//example.com/image.png", "%2f%2fexample.com/img", "file:///secret.png", "%00.png", "..%5csecret.png", "%ZZ.png"]) {
    assert.equal(previewFilePath(reference, "/project/docs/readme.md", "/project"), null, reference);
  }
});
