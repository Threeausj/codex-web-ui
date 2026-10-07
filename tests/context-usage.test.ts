import test from "node:test";
import assert from "node:assert/strict";
import { contextUsage } from "../src/lib/context-usage";

test("context usage measures the latest context instead of cumulative billed tokens", () => {
  assert.deepEqual(contextUsage({ last: { totalTokens: 25000 }, total: { totalTokens: 2000000 }, modelContextWindow: 100000 }), {
    used: 25000, limit: 100000, percent: 25,
  });
  assert.equal(contextUsage({ last: { totalTokens: 3000 }, modelContextWindow: 100000 })?.percent, 3);
  assert.deepEqual(contextUsage({ last: { totalTokens: 0 }, modelContextWindow: 100000 }), { used: 0, limit: 100000, percent: 0 });
});

test("unknown or malformed context measurements are not presented as zero; ring percentages are bounded", () => {
  for (const usage of [null, {}, { total: { totalTokens: 5 }, modelContextWindow: 10 },
    { last: { totalTokens: -1 }, modelContextWindow: 10 }, { last: { totalTokens: Infinity }, modelContextWindow: 10 },
    { last: { totalTokens: 5 }, modelContextWindow: 0 }, { last: { totalTokens: 5 }, modelContextWindow: null }]) {
    assert.equal(contextUsage(usage), null);
  }
  assert.equal(contextUsage({ last: { totalTokens: 15 }, modelContextWindow: 10 })?.percent, 100);
});
