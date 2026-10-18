import test from 'node:test';
import assert from 'node:assert/strict';
import { steerWithConfirmedTurn } from '../src/lib/turn-steer';

const mismatch = (old = 'cached-turn', next = 'native-turn') => new Error(`expected active turn id ${old} but found ${next}`);
function scenario() {
  const calls: string[] = [];
  let state = { turnId: 'cached-turn', busy: true, revision: 7 };
  const recovery = {
    current: () => true,
    runtime: () => ({ ...state }),
    readLatest: async () => ({ id: 'native-turn', status: 'inProgress' }),
    terminal: (_id: string) => false,
    discarded: (_id: string) => false,
    acceptActiveTurn: (turnId: string) => { state = { turnId, busy: true, revision: state.revision + 1 }; },
  };
  const send = async (id: string) => { calls.push(id); if (calls.length === 1) throw mismatch(); return { turnId: id }; };
  return { calls, recovery, send, get state() { return state; }, set state(value) { state = value; } };
}

test('a native continuation missed by the browser accepts the same input only after confirming the current turn', async () => {
  const run = scenario();
  let reads = 0;
  run.recovery.readLatest = async () => { reads++; return { id: 'native-turn', status: 'inProgress' }; };
  assert.deepEqual(await steerWithConfirmedTurn('cached-turn', run.send, run.recovery), { turnId: 'native-turn' });
  assert.deepEqual(run.calls, ['cached-turn', 'native-turn']);
  assert.equal(reads, 1);
  assert.equal(run.state.turnId, 'native-turn');
});

test('accepted steering never waits for a new turn or performs a synchronization read', async () => {
  const run = scenario();
  run.recovery.readLatest = async () => { assert.fail('accepted steering must not read history'); };
  const reply = { turnId: 'cached-turn' };
  assert.equal(await steerWithConfirmedTurn('cached-turn', async () => reply, run.recovery), reply);
});

test('timeout, disconnected and unrelated errors never replay an input or read history', async () => {
  for (const error of [Object.assign(mismatch(), { uncertain: true }), new Error('连接已断开，服务端可能已接收'), new Error('request timed out'), new Error('expected active turn id unrelated but found native-turn')]) {
    const run = scenario();
    let sends = 0;
    run.recovery.readLatest = async () => { assert.fail('an uncertain send must not enter recovery'); };
    await assert.rejects(steerWithConfirmedTurn('cached-turn', async () => { sends++; throw error; }, run.recovery), cause => cause === error);
    assert.equal(sends, 1);
  }
});

test('a completed or replaced continuation never turns steering into a new task', async () => {
  for (const latest of [undefined, { id: 'native-turn', status: 'completed' }, { id: 'native-turn', status: 'interrupted' }, { id: 'native-turn', status: 'failed' }, { id: 'another-turn', status: 'inProgress' }, { id: 'native-turn' }]) {
    const run = scenario();
    run.recovery.readLatest = async () => latest as any;
    await assert.rejects(steerWithConfirmedTurn('cached-turn', run.send, run.recovery), /消息尚未发送/);
    assert.deepEqual(run.calls, ['cached-turn']);
  }
});

test('newer live events win over a delayed history snapshot', async () => {
  for (const state of [{ turnId: '', busy: false, revision: 8 }, { turnId: 'cached-turn', busy: true, revision: 8 }, { turnId: 'newer-turn', busy: true, revision: 8 }, { turnId: 'native-turn', busy: false, revision: 8 }]) {
    const run = scenario();
    run.recovery.readLatest = async () => { run.state = state; return { id: 'native-turn', status: 'inProgress' }; };
    await assert.rejects(steerWithConfirmedTurn('cached-turn', run.send, run.recovery), /消息尚未发送/);
    assert.deepEqual(run.calls, ['cached-turn']);
    assert.deepEqual(run.state, state);
  }
});

test('a confirmed same-turn live update is retained without overriding its revision', async () => {
  const run = scenario();
  const state = { turnId: 'native-turn', busy: true, revision: 8 };
  run.recovery.readLatest = async () => { run.state = state; return { id: 'native-turn', status: 'inProgress' }; };
  run.recovery.acceptActiveTurn = () => assert.fail('the current live turn must not be replaced');
  assert.deepEqual(await steerWithConfirmedTurn('cached-turn', run.send, run.recovery), { turnId: 'native-turn' });
  assert.deepEqual(run.state, state);
});

test('a host/session change, discarded history or completed live identity prevents the retry', async () => {
  for (const blocked of ['scope', 'discarded', 'terminal']) {
    const run = scenario();
    let read = false;
    run.recovery.current = () => blocked !== 'scope' || !read;
    run.recovery.discarded = () => blocked === 'discarded';
    run.recovery.terminal = () => blocked === 'terminal';
    run.recovery.readLatest = async () => { read = true; return { id: 'native-turn', status: 'inProgress' }; };
    await assert.rejects(steerWithConfirmedTurn('cached-turn', run.send, run.recovery), /消息尚未发送/);
    assert.deepEqual(run.calls, ['cached-turn']);
  }
});

test('a second continuation is not followed and an uncertain recovery reply is not replayed', async () => {
  for (const uncertain of [false, true]) {
    const run = scenario();
    const second = Object.assign(mismatch('native-turn', 'newer-turn'), uncertain ? { uncertain: true } : {});
    const send = async (id: string) => { run.calls.push(id); throw run.calls.length === 1 ? mismatch() : second; };
    await assert.rejects(steerWithConfirmedTurn('cached-turn', send, run.recovery), error => uncertain ? error === second : /消息尚未发送/.test((error as Error).message));
    assert.deepEqual(run.calls, ['cached-turn', 'native-turn']);
  }
});

test('a failing confirmation read preserves the failure and leaves the cached runtime unchanged', async () => {
  const run = scenario();
  const failure = new Error('history unavailable');
  run.recovery.readLatest = async () => { throw failure; };
  await assert.rejects(steerWithConfirmedTurn('cached-turn', run.send, run.recovery), cause => cause === failure);
  assert.deepEqual(run.calls, ['cached-turn']);
  assert.equal(run.state.turnId, 'cached-turn');
});
