import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPromptPresets } from '../shared/prompt-presets';
import { insertPromptPreset, usePromptPresets } from '../src/lib/prompt-presets';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(content: string, version: number) {
  const value = emptyPromptPresets();
  value.presets[0] = { slot: 1, name: '审查', content, kind: 'prompt', version };
  value.revision = version;
  return value;
}
const input = { slot: 1, name: '审查', content: '待保存', kind: 'prompt' as const, expectedVersion: 1 };

test('preset insertion preserves both sides of a selection and exact multiline text', () => {
  assert.deepEqual(insertPromptPreset('已有草稿', '逐行审查\n保留公式 $x^2$'), {
    text: '已有草稿\n\n逐行审查\n保留公式 $x^2$', position: 21,
  });
  assert.deepEqual(insertPromptPreset('前文选中内容后文', '预设', 6), {
    text: '前文选中内容\n\n预设\n\n后文', position: 10,
  });
  assert.equal(insertPromptPreset('前文\n', '\n预设\n', NaN).text, '前文\n\n预设\n');
  assert.equal(insertPromptPreset('草稿', '预设', -2).text, '预设\n\n草稿');
  assert.equal(insertPromptPreset('', '  精确保留  \n').text, '  精确保留  \n');
});

test('late preset GET and mutation responses cannot roll back a newer live snapshot', async () => {
  const get = deferred<any>(), put = deferred<any>();
  const api = usePromptPresets((_path, options) => options?.method ? put.promise : get.promise, () => 1);
  const loading = api.refresh();
  api.hydrate(snapshot('已同步', 2));
  get.resolve(snapshot('旧读取', 1));
  await loading;
  assert.equal(api.state.snapshot.presets[0]!.content, '已同步');
  const saving = api.save(input);
  api.hydrate(snapshot('更新的修改', 4));
  put.resolve(snapshot('本次保存', 3));
  await saving;
  assert.equal(api.state.snapshot.presets[0]!.content, '更新的修改');
  assert.equal(api.state.busy, false);
});

test('preset conflict forces a fresh GET even while an older read is pending', async () => {
  const first = deferred<any>(), latest = deferred<any>();
  let reads = 0, writes = 0;
  const api = usePromptPresets(async (_path, options) => {
    if (options?.method) { ++writes; throw Object.assign(new Error('其他设备已修改'), { status: 409 }); }
    return ++reads === 1 ? first.promise : latest.promise;
  }, () => 1);
  api.hydrate(snapshot('旧内容', 1));
  const oldRead = api.refresh();
  const saving = assert.rejects(api.save(input), /其他设备已修改/);
  await Promise.resolve();
  latest.resolve(snapshot('其他设备', 2));
  await saving;
  first.resolve(snapshot('旧响应', 1));
  await oldRead;
  assert.equal(reads, 2);
  assert.equal(writes, 1, 'conflicts never silently retry an overwrite');
  assert.equal(api.state.snapshot.presets[0]!.content, '其他设备');
  assert.equal(api.state.error, '其他设备已修改');
  assert.equal(api.state.loading, false);
});

test('logout prevents pending private preset reads or saves from repopulating a new login', async () => {
  let auth: number | null = 1;
  const get = deferred<any>(), put = deferred<any>();
  const api = usePromptPresets((_path, options) => options?.method ? put.promise : get.promise, () => auth);
  api.hydrate(snapshot('私密内容', 1));
  const loading = api.refresh();
  const saving = assert.rejects(api.save(input), /登录状态已变化/);
  auth = null;
  api.reset();
  auth = 2;
  api.hydrate(snapshot('新账号内容', 1));
  get.resolve(snapshot('旧账号读取', 5));
  put.resolve(snapshot('旧账号保存', 6));
  await Promise.all([loading, saving]);
  assert.equal(api.state.snapshot.presets[0]!.content, '新账号内容');
  assert.equal(api.state.busy, false);
  assert.equal(api.state.error, '');
  auth = null;
  api.reset();
  assert.equal(api.hydrate(snapshot('私密内容', 8)), false);
  await assert.rejects(api.save(input), /请先登录/);
});

test('failed or malformed preset responses preserve saved content and report local errors', async () => {
  let malformed = false;
  const api = usePromptPresets(async () => {
    if (!malformed) throw new Error('网络中断');
    return { revision: 3, presets: Array(10).fill(null) };
  }, () => 1);
  api.hydrate(snapshot('原内容', 1));
  await api.refresh();
  assert.equal(api.state.error, '网络中断');
  await assert.rejects(api.save(input), /网络中断/);
  assert.equal(api.state.snapshot.presets[0]!.content, '原内容');
  malformed = true;
  await api.refresh();
  assert.match(api.state.error, /数据不完整/);
  await assert.rejects(api.save(input), /数据不完整/);
  assert.equal(api.state.snapshot.revision, 1);
  assert.equal(api.state.busy, false);
  const invalid = snapshot('不一致', 1);
  invalid.revision = 0;
  assert.equal(api.hydrate(invalid), false);
});

test('duplicate mutation is rejected while saving and tombstone version is sent when clearing', async () => {
  const pending = deferred<any>();
  let requestBody: any;
  const api = usePromptPresets(async (_path, options) => {
    requestBody = JSON.parse(String(options!.body));
    return pending.promise;
  }, () => 1);
  const clearing = api.remove({ slot: 1, expectedVersion: 7 });
  await assert.rejects(api.save(input), /正在保存/);
  assert.deepEqual(requestBody, { expectedVersion: 7 });
  const cleared = emptyPromptPresets();
  cleared.presets[0]!.version = 8; cleared.revision = 8;
  pending.resolve(cleared);
  await clearing;
  assert.equal(api.state.snapshot.presets[0]!.version, 8);
});
