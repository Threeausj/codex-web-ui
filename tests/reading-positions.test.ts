import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadingPositions, type ReadingPosition } from '../src/lib/reading-positions';
import { privateState } from '../src/lib/private-state';

const position = (top: number): ReadingPosition => ({ top, bottom: false, anchor: { historyId: `turn-${top}`, offset: -18 } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('remembered reading positions are available before durable storage finishes, isolated by host and defensively copied', async t => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let saved: unknown;
  t.mock.method(privateState, 'read', async () => saved || []);
  t.mock.method(privateState, 'write', async (_namespace: string, _identity: string, value: unknown) => { saved = structuredClone(value); });
  const readings = new ReadingPositions(() => ready, () => 1);
  const original = position(420);
  readings.remember('nas', 'same-thread', original);
  readings.remember('gpu', 'same-thread', position(900));
  const flushing = readings.flush();
  original.top = 5000;
  original.anchor!.offset = 100;
  assert.deepEqual(readings.peek('nas', 'same-thread'), position(420));
  assert.deepEqual(readings.peek('gpu', 'same-thread'), position(900));
  const read = readings.peek('nas', 'same-thread')!;
  read.top = 17;
  read.anchor!.historyId = 'changed';
  assert.deepEqual(readings.peek('nas', 'same-thread'), position(420));
  assert.equal(saved, undefined);
  release();
  await flushing;
  assert.equal((saved as any[]).length, 2);
});

test('authentication changes discard synchronous positions and queued writes from the previous login', async t => {
  let authentication = 1;
  let saved: unknown[] = [];
  t.mock.method(privateState, 'read', async () => saved);
  t.mock.method(privateState, 'write', async (_namespace: string, _identity: string, value: unknown[]) => { saved = structuredClone(value); });
  const readings = new ReadingPositions(async () => {}, () => authentication);
  readings.remember('nas', 'thread', position(420));
  authentication++;
  assert.equal(readings.peek('nas', 'thread'), null);
  await readings.flush();
  assert.deepEqual(saved, []);
  readings.remember('nas', 'thread', position(180));
  await readings.flush();
  assert.deepEqual(readings.peek('nas', 'thread'), position(180));
  assert.equal((saved[0] as any).top, 180);
});

test('successful durable reads populate the bounded LRU cache without exposing storage records', async t => {
  const saved = Array.from({ length: 34 }, (_, index) => ({ key: JSON.stringify(['nas', `thread-${index}`]), ...position(index) }));
  t.mock.method(privateState, 'read', async () => saved);
  const readings = new ReadingPositions(async () => {}, () => 1);
  for (let index = 0; index < 32; index++) assert.deepEqual(await readings.read('nas', `thread-${index}`), position(index));
  assert.deepEqual(readings.peek('nas', 'thread-0'), position(0));
  await readings.read('nas', 'thread-32');
  assert.equal(readings.peek('nas', 'thread-1'), null);
  assert.deepEqual(readings.peek('nas', 'thread-0'), position(0));
  const restored = (await readings.read('nas', 'thread-33'))!;
  assert.equal('key' in restored, false);
  restored.anchor!.historyId = 'mutated';
  saved[33]!.anchor!.offset = 99;
  assert.deepEqual(readings.peek('nas', 'thread-33'), position(33));
});

test('a delayed durable read cannot overwrite a newer scroll remembered in the same conversation', async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(privateState, 'read', async () => {
    await hold;
    return [{ key: JSON.stringify(['nas', 'thread']), ...position(50) }];
  });
  t.mock.method(privateState, 'write', async () => {});
  const readings = new ReadingPositions(async () => {}, () => 1);
  const pending = readings.read('nas', 'thread');
  await tick();
  readings.remember('nas', 'thread', position(900));
  release();
  assert.deepEqual(await pending, position(900));
  assert.deepEqual(readings.peek('nas', 'thread'), position(900));
  await readings.flush();
});

test('authentication changes retire a delayed durable read before it can fill synchronous memory', async t => {
  let authentication = 1;
  let release!: () => void;
  t.mock.method(privateState, 'read', async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return [{ key: JSON.stringify(['nas', 'thread']), ...position(400) }];
  });
  const readings = new ReadingPositions(async () => {}, () => authentication);
  const pending = readings.read('nas', 'thread');
  await tick();
  authentication++;
  release();
  assert.equal(await pending, null);
  assert.equal(readings.peek('nas', 'thread'), null);
});
