import test from "node:test";
import assert from "node:assert/strict";
import { contextUsage, hasContextUsageSample, mergeContextUsage } from "../src/lib/context-usage";

test("context usage measures the latest context instead of cumulative billed tokens", () => {
  assert.deepEqual(contextUsage({ last: { totalTokens: 25000 }, total: { totalTokens: 2000000 }, modelContextWindow: 100000 }), {
    used: 25000, limit: 100000, percent: 25,
  });
  assert.equal(contextUsage({ last: { totalTokens: 3000 }, modelContextWindow: 100000 })?.percent, 3);
  assert.deepEqual(contextUsage({ last: { totalTokens: 0 }, modelContextWindow: 100000 }), { used: 0, limit: 100000, percent: 0 });
});

test("partial native reports retain a known per-thread window without substituting billing totals", () => {
  const previous = { last: { totalTokens: 25000 }, total: { totalTokens: 2000000 }, modelContextWindow: 100000 };
  const current = mergeContextUsage(previous, { last: { totalTokens: 3000 }, modelContextWindow: null });
  assert.equal(contextUsage(current)?.percent, 3);
  assert.equal(mergeContextUsage(current, null), current);
  assert.equal(mergeContextUsage(current, { last: { totalTokens: -5 }, modelContextWindow: null }), current);
  assert.equal(contextUsage(mergeContextUsage(null, { total: { totalTokens: 100 }, modelContextWindow: 1000 })), null);
  assert.equal(contextUsage(mergeContextUsage(current, { last: { totalTokens: 0 } }))?.percent, 0);
});

test("unknown or malformed context measurements are not presented as zero; ring percentages are bounded", () => {
  for (const usage of [null, {}, { total: { totalTokens: 5 }, modelContextWindow: 10 },
    { last: { totalTokens: -1 }, modelContextWindow: 10 }, { last: { totalTokens: Infinity }, modelContextWindow: 10 },
    { last: { totalTokens: 5 }, modelContextWindow: 0 }, { last: { totalTokens: 5 }, modelContextWindow: null }]) {
    assert.equal(contextUsage(usage), null);
  }
  assert.equal(contextUsage({ last: { totalTokens: 15 }, modelContextWindow: 10 })?.percent, 100);
});

test("resumed reasoning and cache counters remain native parts of the latest context, not extra usage", () => {
  const restored = {
    last: { totalTokens: 42000, inputTokens: 30000, cachedInputTokens: 25000, outputTokens: 12000, reasoningOutputTokens: 9000 },
    total: { totalTokens: 1800000, inputTokens: 1000000, outputTokens: 800000, reasoningOutputTokens: 600000 },
    modelContextWindow: 100000,
  };
  assert.deepEqual(contextUsage(mergeContextUsage(null, restored)), { used: 42000, limit: 100000, percent: 42 });
  const resumed = mergeContextUsage(restored, { total: { totalTokens: 1900000 }, modelContextWindow: null });
  assert.equal(resumed.last.reasoningOutputTokens, 9000);
  assert.equal(resumed.total.totalTokens, 1900000);
  assert.equal(contextUsage(resumed)?.percent, 42);
  // A native fork or compaction can report a smaller context. Do not force
  // monotonic billing totals onto that valid, independent measurement.
  const fork = mergeContextUsage(null, { last: { totalTokens: 12000, reasoningOutputTokens: 2000 }, total: { totalTokens: 1900000 }, modelContextWindow: 100000 });
  assert.equal(contextUsage(fork)?.percent, 12);
  assert.equal(contextUsage(restored)?.percent, 42);
  const compacted = mergeContextUsage(restored, { last: { totalTokens: 3000, reasoningOutputTokens: 0 } });
  assert.equal(contextUsage(compacted)?.percent, 3);
  assert.equal(compacted.last.reasoningOutputTokens, 0);
});

test("invalid or incomplete accounting cannot erase a usable sample or invent fractional context", () => {
  const previous = { last: { totalTokens: 42000, reasoningOutputTokens: 9000 }, total: { totalTokens: 500000 }, modelContextWindow: 100000 };
  const merged = mergeContextUsage(previous, { last: { totalTokens: 80000, reasoningOutputTokens: -1 }, total: null });
  assert.equal(merged, previous);
  for (const count of [0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.equal(contextUsage({ last: { totalTokens: count }, modelContextWindow: 100000 }), null);
    assert.equal(contextUsage({ last: { totalTokens: 10 }, modelContextWindow: count }), null);
  }
  assert.equal(mergeContextUsage(previous, []), previous);
  assert.equal(hasContextUsageSample(previous), true);
  assert.equal(hasContextUsageSample({ last: { totalTokens: 0, reasoningOutputTokens: 0 } }), true);
  for (const partial of [null, [], { modelContextWindow: 100000 }, { total: { totalTokens: 500000 } },
    { last: { totalTokens: 80000, reasoningOutputTokens: -1 } }, { last: { totalTokens: Infinity } }])
    assert.equal(hasContextUsageSample(partial), false);
});
