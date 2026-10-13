import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { waitForCompaction } from '../src/lib/compaction-send';

test('a compressed dedicated turn finishes before sending, while a new active continuation can receive input', async () => {
  const state = reactive({ valid: true, compacting: true, dedicatedTurnActive: true, failed: false });
  let released = false;
  const wait = waitForCompaction(() => ({ ...state })).then(() => { released = true; });
  state.compacting = false;
  await Promise.resolve();
  assert.equal(released, false);
  state.dedicatedTurnActive = false;
  await wait;
  assert.equal(released, true);
});

test('A → B → A scope changes cancel a pending send rather than sending to the returned conversation', async () => {
  const state = reactive({ valid: true, compacting: true, dedicatedTurnActive: false, failed: false });
  const wait = waitForCompaction(() => ({ ...state }));
  state.valid = false;
  state.valid = true;
  state.compacting = false;
  await assert.rejects(wait, /消息已取消.*草稿已保留/);
});

test('failure and a bounded wait reject before any native submission is attempted', async () => {
  const state = reactive({ valid: true, compacting: true, dedicatedTurnActive: false, failed: false });
  const wait = waitForCompaction(() => ({ ...state }));
  state.failed = true;
  await assert.rejects(wait, /压缩未成功/);
  state.failed = false;
  await assert.rejects(waitForCompaction(() => ({ ...state }), 5), /压缩超时/);
});

test('an automatic compaction inside a running model turn can resume without waiting for that model task to end', async () => {
  const state = reactive({ valid: true, compacting: true, dedicatedTurnActive: false, failed: false });
  const wait = waitForCompaction(() => ({ ...state }));
  state.compacting = false;
  await wait;
});
