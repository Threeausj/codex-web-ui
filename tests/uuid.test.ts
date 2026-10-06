import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { randomUUID } from "../src/lib/uuid";

function withCrypto(crypto: unknown, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
  try { run(); } finally { Object.defineProperty(globalThis, "crypto", original); }
}

test("UUIDs use the native API when available", () => {
  const uuid = "2c51f32e-4c72-4fde-b829-c406759a368d";
  withCrypto({
    randomUUID: () => uuid,
    getRandomValues: () => { throw new Error("Fallback should not run"); },
  }, () => assert.equal(randomUUID(), uuid));
});

test("HTTP origins without randomUUID generate distinct valid v4 UUIDs", () => {
  withCrypto({ getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, () => {
    const values = Array.from({ length: 128 }, () => randomUUID());
    for (const value of values) {
      assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    assert.equal(new Set(values).size, values.length);
  });
});
