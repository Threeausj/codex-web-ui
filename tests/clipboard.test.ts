import test from "node:test";
import assert from "node:assert/strict";
import { clipboardFiles } from "../src/lib/clipboard";

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

test("item and FileList aliases do not upload twice, while separate images and extension-only files survive", () => {
  const first = new File(["first"], "one.png", { type: "image/png", lastModified: 1 });
  const alias = new File(["first"], "one.png", { type: "image/png", lastModified: 1 });
  const second = new File(["other"], "two.png", { type: "image/png", lastModified: 1 });
  const noMime = new File(["third"], "android.webp", { lastModified: 2 });
  assert.deepEqual(clipboardFiles(data([item(first), item(second)], [alias, second, noMime])), [first, second, noMime]);
});

test("unreadable clipboard items fall back to files and text-only pastes stay empty", () => {
  const image = new File(["fallback"], "fallback.png", { type: "image/png" });
  assert.deepEqual(clipboardFiles(data([item(null), { kind: "file", getAsFile: () => { throw new Error("unavailable"); } }], [image])), [image]);
  assert.deepEqual(clipboardFiles(data([{ kind: "string", type: "text/plain" }])), []);
  assert.deepEqual(clipboardFiles(null), []);
});
