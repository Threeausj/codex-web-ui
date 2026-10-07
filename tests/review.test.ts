import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewTarget, reviewFindings } from '../src/lib/review';

test('review targets validate exact native scope and commit identity without prompt fallbacks', () => {
  assert.deepEqual(reviewTarget('uncommittedChanges'), { type: 'uncommittedChanges' });
  assert.deepEqual(reviewTarget('baseBranch', 'origin/main'), { type: 'baseBranch', branch: 'origin/main' });
  assert.deepEqual(reviewTarget('commit', 'abcdef123', 'Fix auth'), { type: 'commit', sha: 'abcdef123', title: 'Fix auth' });
  assert.deepEqual(reviewTarget('custom', ' Inspect auth races '), { type: 'custom', instructions: 'Inspect auth races' });
  for (const value of ['', '-evil', 'a..b', 'main\n--force']) assert.throws(() => reviewTarget('baseBranch', value));
  for (const value of ['', 'HEAD', 'abcdef', 'abcdegg', 'abc1234\n--force']) assert.throws(() => reviewTarget('commit', value));
  assert.throws(() => reviewTarget('custom', ''));
  assert.throws(() => reviewTarget('custom', 'x'.repeat(8001)));
});

test('public native findings expose safe absolute file locations and line ranges while leaving prose unchanged', () => {
  const good = { title: '[P1] Preserve login', body: 'A service restart should retain this session.', priority: 1, code_location: { absolute_file_path: '/workspace/demo/server/auth.ts', line_range: { start: 12, end: 14 } } };
  const output = JSON.stringify({ findings: [good, null, { ...good, code_location: { absolute_file_path: '../private', line_range: { start: 12 } } }, { ...good, title: null }, { ...good, code_location: { absolute_file_path: '/workspace/\nwrong' } }], overall_explanation: 'Review completed' });
  assert.deepEqual(reviewFindings(output), [{ title: good.title, body: good.body, priority: 1, file: good.code_location.absolute_file_path, start: 12, end: 14 }]);
  assert.equal(reviewFindings('```json\n' + output + '\n```').length, 1);
  assert.deepEqual(reviewFindings('Normal reviewer explanation'), []);
  assert.deepEqual(reviewFindings({ findings: [good] }), []);
});
