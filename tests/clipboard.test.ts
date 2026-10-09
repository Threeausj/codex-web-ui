import test from "node:test";
import assert from "node:assert/strict";
import { clipboardFiles, uniqueClipboardFiles } from "../src/lib/clipboard";

const data = (items: any[], files: File[] = []) => ({ items, files }) as unknown as DataTransfer;
const item = (file: File | null) => ({ kind: "file", getAsFile: () => file });

test("paste captures file items synchronously even when the browser FileList is empty", () => {
  const image = new File([new Uint8Array([1, 2, 3])], "clipboard.png", { type: "image/png" });
  let available = true;
  const clipboard = data([{ kind: "string", type: "text/plain" }, {
    kind: "file", getAsFile: () => available ? image : null,
  }]);
  const captured = clipboardFiles(clipboard);
  available = false;
  assert.deepEqual(captured, [image]);
});

test("item and FileList aliases do not upload twice, while separate images and extension-only files survive", async () => {
  const first = new File(["first"], "one.png", { type: "image/png", lastModified: 1 });
  const alias = new File(["first"], "one.png", { type: "image/png", lastModified: 1 });
  const second = new File(["other"], "two.png", { type: "image/png", lastModified: 1 });
  const noMime = new File(["third"], "android.webp", { lastModified: 2 });
  const captured = clipboardFiles(data([item(first), item(second)], [alias, second, noMime]));
  assert.deepEqual(await uniqueClipboardFiles(captured), [first, second, noMime]);
});

test("aliases with changed names, timestamps or MIME types are compared by content within one paste", async () => {
  const image = new File(["same bytes"], "clipboard.png", { type: "image/png", lastModified: 1 });
  const alias = new File(["same bytes"], "image.png", { lastModified: 2 });
  assert.deepEqual(await uniqueClipboardFiles(clipboardFiles(data([item(image)], [alias]))), [image]);
  assert.deepEqual(await uniqueClipboardFiles([alias]), [alias]); // A second paste is intentional.
});

test("different images with identical metadata remain separate and retain clipboard order", async () => {
  const first = new File(["abcd"], "image.png", { type: "image/png", lastModified: 1 });
  const otherSize = new File(["longer"], "other.png", { type: "image/png", lastModified: 1 });
  const second = new File(["abce"], "image.png", { type: "image/png", lastModified: 1 });
  const alias = new File(["abcd"], "alias.png", { type: "image/png", lastModified: 2 });
  assert.deepEqual(await uniqueClipboardFiles(clipboardFiles(data([item(first), item(otherSize), item(second)], [alias]))), [first, otherSize, second]);
});

test("unreadable content never silently drops an attachment", async () => {
  const first = new File(["abcd"], "first.png", { type: "image/png" });
  const second = new File(["abcd"], "second.png", { type: "image/png" });
  Object.defineProperty(first, "arrayBuffer", { value: async () => { throw new Error("unavailable"); } });
  assert.deepEqual(await uniqueClipboardFiles([first, second]), [first, second]);
});

test("unreadable clipboard items fall back to files and text-only pastes stay empty", () => {
  const image = new File(["fallback"], "fallback.png", { type: "image/png" });
  assert.deepEqual(clipboardFiles(data([item(null), { kind: "file", getAsFile: () => { throw new Error("unavailable"); } }], [image])), [image]);
  assert.deepEqual(clipboardFiles(data([{ kind: "string", type: "text/plain" }])), []);
  assert.deepEqual(clipboardFiles(null), []);
});
