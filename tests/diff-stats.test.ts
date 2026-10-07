import test from 'node:test';
import assert from 'node:assert/strict';
import { diffStats } from '../src/lib/diff-stats.js';
test('patch statistics exclude headers and handle multiple hunks and header-looking content', () => {
  assert.deepEqual(diffStats('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,3 @@\n-old\n+new\n+++content\n same\n@@ -6 +7 @@\n-removed\n+added\n'), { added: 3, removed: 2 });
  assert.deepEqual(diffStats('Binary files differ\n--- a/a\n+++ b/a'), { added: 0, removed: 0 });
});
