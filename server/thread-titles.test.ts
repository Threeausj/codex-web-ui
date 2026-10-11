import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadTitleService } from './thread-titles.js';
import type { Host, RpcMessage } from './types.js';

type Call = { method: string; params: any; timeout?: number };
type HelperTurn = { threadId: string; turnId: string };
const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }];
const local: Host = { id: 'local', name: 'Fixture local', kind: 'local' };
const remote: Host = { id: 'remote', name: 'Fixture remote', kind: 'ssh', hostname: 'fixture.invalid', username: 'fixture', port: 22 };

async function until(predicate: () => boolean, description: string) {
  for (let count = 0; count < 200; count++) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail(description);
}

function fixture(options: ConstructorParameters<typeof ThreadTitleService>[1] = {}) {
  let service: ThreadTitleService;
  const bridges = new Map<string, ReturnType<typeof bridgeFixture>>();
  const internalEvents: { hostId: string; message: RpcMessage; hidden: boolean }[] = [];
  function observe(host: Host, message: RpcMessage) {
    service.observe(host, message);
    const threadId = (message.params as any)?.threadId ?? (message.params as any)?.thread?.id;
    if (typeof threadId === 'string' && threadId.startsWith('title-helper-'))
      internalEvents.push({ hostId: host.id, message, hidden: service.isInternalThread(host.id, threadId) });
  }
  function bridgeFixture(host: Host) {
    const calls: Call[] = [];
    const threads = new Map<string, any>();
    const helpers: HelperTurn[] = [];
    let sequence = 0;
    const control = { autoComplete: true, output: JSON.stringify({ title: '邮件系统的部署方案' }), sandboxType: 'readOnly', reasoningEfforts: ['low', 'medium', 'high'],
      failMethod: '', holdFinalRead: false, releaseFinalRead: undefined as undefined | (() => void),
      holdThreadStart: false, releaseThreadStart: undefined as undefined | (() => void),
      holdTurnStart: false, releaseTurnStart: undefined as undefined | (() => void),
      hangCleanup: false };
    const finish = (helper = helpers.at(-1)!, status = 'completed') => {
      const answer = { id: `${helper.turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text: control.output };
      observe(host, { method: 'item/completed', params: { threadId: helper.threadId, turnId: helper.turnId, item: answer } });
      observe(host, { method: 'turn/completed', params: { threadId: helper.threadId, turn: { id: helper.turnId, status, items: [answer] } } });
    };
    const bridge = {
      async request(method: string, params: any = {}, timeout?: number): Promise<any> {
        calls.push({ method, params: structuredClone(params), timeout });
        if (method === control.failMethod) throw new Error(`Fixture ${method} failed`);
        if (method === 'config/read') return { config: { model: 'config-model', model_provider: 'config-provider', service_tier: 'flex',
          mcp_servers: { fixture: { command: 'must-never-launch' }, second: { url: 'https://must-never-request.invalid/mcp' } } } };
        if (method === 'model/list') return { data: [{ model: 'selected-turn-model',
          supportedReasoningEfforts: control.reasoningEfforts.map(reasoningEffort => ({ reasoningEffort })) }] };
        if (method === 'thread/start') {
          const thread = { id: `title-helper-${host.id}-${++sequence}`, ephemeral: true, name: null, cwd: params.cwd };
          threads.set(thread.id, thread);
          if (control.holdThreadStart) await new Promise<void>(resolve => { control.releaseThreadStart = resolve; });
          return { thread, model: params.model, modelProvider: params.modelProvider,
            sandbox: { type: control.sandboxType }, activePermissionProfile: { id: params.permissions || ':read_only', extends: null } };
        }
        if (method === 'turn/start') {
          assert.ok(params.threadId.startsWith('title-helper-'), 'title inference must never execute in the user conversation');
          const helper = { threadId: params.threadId, turnId: `${params.threadId}-turn` };
          helpers.push(helper);
          if (control.holdTurnStart) {
            // A lost native notification must not prevent cleanup once its
            // delayed allocation acknowledgment reveals the real identity.
            await new Promise<void>(resolve => { control.releaseTurnStart = resolve; });
            return { turn: { id: helper.turnId, status: 'inProgress', items: [] } };
          }
          observe(host, { method: 'turn/started', params: { threadId: helper.threadId, turn: { id: helper.turnId, status: 'inProgress', items: [] } } });
          // A real app-server may complete a short title before acknowledging its
          // start. The completion must be retained rather than waiting forever.
          if (control.autoComplete) finish(helper);
          return { turn: { id: helper.turnId, status: 'inProgress', items: [] } };
        }
        if (method === 'thread/read') {
          const result = { thread: structuredClone(threads.get(params.threadId)) };
          if (control.holdFinalRead && helpers.length && !params.threadId.startsWith('title-helper-')) {
            control.holdFinalRead = false;
            await new Promise<void>(resolve => { control.releaseFinalRead = resolve; });
          }
          return result;
        }
        if (method === 'thread/name/set') {
          assert.ok(!params.threadId.startsWith('title-helper-'));
          const thread = threads.get(params.threadId);
          if (!thread) throw new Error('Original conversation no longer exists');
          thread.name = params.name;
          observe(host, { method: 'thread/name/updated', params: { threadId: thread.id, threadName: thread.name } });
          return {};
        }
        if (['turn/interrupt', 'thread/unsubscribe', 'thread/archive', 'thread/delete'].includes(method)) {
          if (control.hangCleanup) return new Promise(() => {});
          return {};
        }
        throw new Error(`Unexpected title-generation RPC: ${method}`);
      },
    };
    return { host, calls, threads, helpers, control, bridge, finish,
      named: () => calls.filter(call => call.method === 'thread/name/set'),
      starts: () => calls.filter(call => call.method === 'thread/start'),
      cleanup: () => calls.filter(call => ['thread/unsubscribe', 'thread/archive', 'thread/delete'].includes(call.method)),
    };
  }
  const forHost = (host: Host = local) => {
    if (!bridges.has(host.id)) bridges.set(host.id, bridgeFixture(host));
    return bridges.get(host.id)!;
  };
  service = new ThreadTitleService({ getBridge: hostId => {
    const bridge = bridges.get(hostId);
    if (!bridge) throw new Error('Unknown fixture host');
    return bridge.bridge;
  } }, { timeoutMs: 200, cleanupTimeoutMs: 20, ...options });
  const webStart = (id = 'conversation', host: Host = local, metadata: any = {}, runtime: any = {}) => {
    const f = forHost(host);
    const thread = { id, cwd: '/fixture/project', name: null, preview: '', ephemeral: false, ...metadata };
    f.threads.set(id, thread);
    observe(host, { method: 'bridge/thread/changed', params: { threadId: id, method: 'thread/start', changeId: `${id}:created`,
      result: { thread, model: 'session-model', modelProvider: 'session-provider', ...runtime },
      request: { cwd: thread.cwd, model: 'session-model' } } });
    return thread;
  };
  const accepted = (id = 'conversation', host: Host = local, params: any = {}) => {
    observe(host, { method: 'bridge/thread/changed', params: { threadId: id, method: 'turn/start', changeId: `${id}:accepted`,
      result: { turn: { id: `${id}-original-turn`, status: 'inProgress', items: [] } },
      request: { threadId: id, input: textInput('请设计邮件管理系统并提供具体部署方案'), clientUserMessageId: `${id}-client`, ...params } } });
  };
  return { service, forHost, webStart, accepted, observe, internalEvents };
}

test('only an accepted first input in a newly created Web conversation generates and persists a concise canonical title', async () => {
  const f = fixture();
  try {
    const host = f.forHost();
    f.webStart();
    await f.service.drain();
    assert.equal(host.starts().length, 0, 'creating an empty conversation must not consume a model request');
    f.observe(local, { method: 'item/started', params: { threadId: 'conversation', turnId: 'unaccepted-turn', item: {
      id: 'not-confirmed', type: 'userMessage', content: textInput('尚未确认的输入'), status: 'sending',
    } } });
    await f.service.drain();
    assert.equal(host.starts().length, 0);
    f.accepted();
    await f.service.drain();
    assert.equal(host.starts().length, 1);
    assert.deepEqual(host.named().map(call => call.params), [{ threadId: 'conversation', name: '邮件系统的部署方案' }]);
    assert.equal(host.threads.get('conversation').name, '邮件系统的部署方案');
    assert.equal(host.cleanup().length, 1);
    assert.ok(host.cleanup()[0]!.params.threadId.startsWith('title-helper-'));
    assert.ok(!host.calls.some(call => call.method === 'thread/resume'), 'title generation cannot take over the user writer');
  } finally { await f.service.close(); }
});

test('duplicate browser confirmations and later inputs generate only one title for the same conversation', async () => {
  const f = fixture();
  try {
    const host = f.forHost();
    f.webStart(); f.webStart();
    f.accepted(); f.accepted();
    f.observe(local, { method: 'bridge/thread/changed', params: { threadId: 'conversation', method: 'turn/steer', changeId: 'second-browser:steer',
      result: { turnId: 'conversation-original-turn' }, request: { input: textInput('另一个网页确认同一个主题'), clientUserMessageId: 'another-client' } } });
    await f.service.drain();
    f.accepted('conversation', local, { input: textInput('后续问题不能重新命名') });
    await f.service.drain();
    assert.equal(host.starts().length, 1);
    assert.equal(host.named().length, 1);
  } finally { await f.service.close(); }
});

test('the helper uses the original model/provider and an ephemeral readonly configuration with no execution or approval requests', async () => {
  const f = fixture();
  try {
    const host = f.forHost();
    f.webStart(); f.accepted('conversation', local, { model: 'selected-turn-model', cwd: '/fixture/project' });
    await f.service.drain();
    const start = host.starts()[0]!.params;
    assert.equal(start.model, 'selected-turn-model');
    assert.equal(start.modelProvider, 'session-provider');
    assert.equal(start.ephemeral, true);
    assert.equal(start.threadSource, 'thread_title');
    assert.equal(start.approvalPolicy, 'never');
    assert.equal(start.sandbox, 'read-only');
    assert.deepEqual(start.runtimeWorkspaceRoots, []);
    assert.deepEqual(start.dynamicTools, []);
    assert.deepEqual(start.selectedCapabilityRoots, []);
    assert.deepEqual(start.environments, []);
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'hooks', 'memories', 'view_image'])
      assert.equal(start.config[`features.${feature}`], false, `${feature} must be disabled in the helper`);
    assert.equal(start.config.web_search, 'disabled');
    assert.equal(start.config['cloud.skills.enabled'], false);
    assert.equal(start.config['tools.experimental_request_user_input.enabled'], false);
    assert.equal(start.config['tools.update_plan.enabled'], false);
    assert.deepEqual(start.config.mcp_servers, { fixture: { enabled: false }, second: { enabled: false } });
    const turn = host.calls.find(call => call.method === 'turn/start')!.params;
    assert.equal(turn.model, 'selected-turn-model');
    assert.equal(turn.effort, 'low');
    assert.equal(turn.approvalPolicy, 'never');
    assert.equal(turn.sandboxPolicy.type, 'readOnly');
    assert.equal(turn.sandboxPolicy.networkAccess, false);
    assert.equal(turn.outputSchema.additionalProperties, false);
    assert.deepEqual(turn.outputSchema.required, ['title']);
    assert.ok(Buffer.byteLength(turn.input[0].text) <= 960, 'title prompts must remain bounded');
    assert.ok(f.internalEvents.length >= 3);
    assert.ok(f.internalEvents.every(event => event.hidden), 'internal title progress/completion must be excluded from public notifications');
    assert.ok(host.calls.every(call => ['config/read', 'model/list', 'thread/read', 'thread/start', 'turn/start', 'thread/name/set', 'thread/unsubscribe', 'thread/archive', 'thread/delete'].includes(call.method)), 'no tool, filesystem, queue or approval RPC may be invoked');
  } finally { await f.service.close(); }
});

test('effective configuration supplies model/provider only when the new conversation did not return them', async () => {
  const f = fixture();
  try {
    const host = f.forHost();
    f.webStart('conversation', local, {}, { model: undefined, modelProvider: undefined });
    f.accepted(); await f.service.drain();
    assert.equal(host.starts()[0]!.params.model, 'config-model');
    assert.equal(host.starts()[0]!.params.modelProvider, 'config-provider');
    assert.equal(host.named().length, 1);
  } finally { await f.service.close(); }
});

test('a model without low reasoning support retains its native effort instead of receiving an unsupported override', async () => {
  const f = fixture();
  try {
    const host = f.forHost(); host.control.reasoningEfforts = ['high'];
    f.webStart(); f.accepted('conversation', local, { model: 'selected-turn-model' }); await f.service.drain();
    const turn = host.calls.find(call => call.method === 'turn/start')!.params;
    assert.equal(turn.effort, undefined);
    assert.equal(host.named().length, 1);
  } finally { await f.service.close(); }
});

test('unsupported model metadata does not prevent title generation through the original model', async () => {
  const f = fixture();
  try {
    const host = f.forHost(); host.control.failMethod = 'model/list';
    f.webStart(); f.accepted('conversation', local, { model: 'selected-turn-model' }); await f.service.drain();
    const turn = host.calls.find(call => call.method === 'turn/start')!.params;
    assert.equal(turn.model, 'selected-turn-model');
    assert.equal(turn.effort, undefined);
    assert.equal(host.named().length, 1);
  } finally { await f.service.close(); }
});

test('an unexpected effective sandbox fails closed before inference while still releasing the helper', async () => {
  const f = fixture();
  try {
    const host = f.forHost(); host.control.sandboxType = 'dangerFullAccess';
    f.webStart(); f.accepted(); await f.service.drain();
    assert.equal(host.helpers.length, 0);
    assert.equal(host.named().length, 0);
    assert.equal(host.cleanup().length, 1);
  } finally { await f.service.close(); }
});

test('a managed native permission profile remains intact instead of being bypassed by helper sandbox overrides', async () => {
  const f = fixture();
  try {
    const host = f.forHost();
    f.webStart('conversation', local, {}, { activePermissionProfile: { id: 'managed-profile' } });
    f.accepted(); await f.service.drain();
    const start = host.starts()[0]!.params;
    assert.equal(start.permissions, 'managed-profile');
    assert.equal(start.sandbox, undefined);
    assert.equal(start.approvalPolicy, undefined);
    assert.equal(start.config.default_permissions, undefined);
    const turn = host.calls.find(call => call.method === 'turn/start')!.params;
    assert.equal(turn.sandboxPolicy, undefined);
    assert.equal(turn.approvalPolicy, undefined);
    assert.equal(start.config['features.shell_tool'], false);
    assert.equal(host.named().length, 1);
  } finally { await f.service.close(); }
});

test('a desktop-created or already named conversation does not launch an automatic naming helper', async () => {
  const f = fixture();
  try {
    const host = f.forHost();
    host.threads.set('desktop', { id: 'desktop', cwd: '/fixture', name: null });
    f.observe(local, { method: 'thread/started', params: { thread: host.threads.get('desktop') } });
    f.accepted('desktop');
    f.webStart('manual', local, { name: '用户明确指定的名称' });
    f.accepted('manual');
    await f.service.drain();
    assert.equal(host.starts().length, 0);
    assert.equal(host.named().length, 0);
  } finally { await f.service.close(); }
});

test('malformed or failed model output never replaces the preview and always cleans up the temporary thread', async t => {
  for (const output of ['不是 JSON 格式的标题', '{"title":""}', '{"other":"错误的输出结构"}']) {
    await t.test(output, async () => {
      const f = fixture();
      try {
        const host = f.forHost(); host.control.output = output;
        f.webStart(); f.accepted(); await f.service.drain();
        assert.equal(host.named().length, 0);
        assert.equal(host.cleanup().length, 1);
      } finally { await f.service.close(); }
    });
  }
  await t.test('a failed native turn with plausible output', async () => {
    const f = fixture();
    try {
      const host = f.forHost(); host.control.autoComplete = false;
      f.webStart(); f.accepted();
      await until(() => host.helpers.length === 1, 'title helper did not start');
      host.finish(undefined, 'failed'); await f.service.drain();
      assert.equal(host.named().length, 0);
      assert.equal(host.cleanup().length, 1);
    } finally { await f.service.close(); }
  });
});

test('partial deltas and public commentary cannot be saved as the generated title before a successful final output', async () => {
  const f = fixture();
  try {
    const host = f.forHost(); host.control.autoComplete = false;
    f.webStart(); f.accepted();
    await until(() => host.helpers.length === 1, 'title helper did not start');
    const helper = host.helpers[0]!;
    f.observe(local, { method: 'item/agentMessage/delta', params: {
      threadId: helper.threadId, turnId: helper.turnId, itemId: 'partial', delta: '{"title":"尚未完成',
    } });
    f.observe(local, { method: 'item/completed', params: { threadId: helper.threadId, turnId: helper.turnId,
      item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '{"title":"中间说明不能成为标题"}' },
    } });
    await delay(1);
    assert.equal(host.named().length, 0);
    host.finish(); await f.service.drain();
    assert.deepEqual(host.named().map(call => call.params.name), ['邮件系统的部署方案']);
  } finally { await f.service.close(); }
});

test('a title timeout interrupts only its helper turn and releases the temporary conversation', async () => {
  const f = fixture({ timeoutMs: 20 });
  try {
    const host = f.forHost(); host.control.autoComplete = false;
    f.webStart(); f.accepted();
    await until(() => host.helpers.length === 1, 'title helper did not start');
    await delay(40); await f.service.drain();
    assert.equal(host.named().length, 0);
    const interruption = host.calls.find(call => call.method === 'turn/interrupt');
    assert.deepEqual(interruption?.params, { threadId: host.helpers[0]!.threadId, turnId: host.helpers[0]!.turnId });
    assert.equal(host.cleanup().length, 1);
    host.finish(); await f.service.drain();
    assert.equal(host.named().length, 0, 'late completion after timeout cannot save a title');
  } finally { await f.service.close(); }
});

test('configuration or inference failures keep the original conversation usable and do not retry generation on duplicate input', async t => {
  for (const failMethod of ['config/read', 'thread/start', 'turn/start']) await t.test(failMethod, async () => {
    const f = fixture();
    try {
      const host = f.forHost(); host.control.failMethod = failMethod;
      f.webStart(); f.accepted(); await f.service.drain();
      const calls = host.calls.length;
      f.accepted(); await f.service.drain();
      assert.equal(host.calls.length, calls, 'duplicates must not loop failed model requests');
      assert.equal(host.named().length, 0);
      assert.equal(host.threads.get('conversation').name, null);
      if (failMethod === 'turn/start') assert.equal(host.cleanup().length, 1);
    } finally { await f.service.close(); }
  });
});

test('manual naming and destructive conversation changes cancel inference and ignore its late result', async t => {
  for (const method of ['thread/name/set', 'thread/archive', 'thread/delete', 'thread/revert', 'thread/rollback']) await t.test(method, async () => {
    const f = fixture();
    try {
      const host = f.forHost(); host.control.autoComplete = false;
      f.webStart(); f.accepted();
      await until(() => host.helpers.length === 1, 'title helper did not start');
      f.observe(local, { method: 'bridge/thread/changed', params: { threadId: 'conversation', method, result: {}, request: { name: '用户手动名称' } } });
      host.finish(); await f.service.drain();
      assert.equal(host.named().length, 0);
      assert.equal(host.cleanup().length, 1);
    } finally { await f.service.close(); }
  });
});

test('native conversation lifecycle notifications cancel naming even without a Web mutation acknowledgment', async t => {
  for (const method of ['thread/name/updated', 'thread/archived', 'thread/deleted', 'thread/reverted', 'thread/closed']) await t.test(method, async () => {
    const f = fixture();
    try {
      const host = f.forHost(); host.control.autoComplete = false;
      f.webStart(); f.accepted();
      await until(() => host.helpers.length === 1, 'title helper did not start');
      f.observe(local, { method, params: { threadId: 'conversation', threadName: '原生会话名称' } });
      host.finish(); await f.service.drain();
      assert.equal(host.named().length, 0);
      assert.equal(host.cleanup().length, 1);
    } finally { await f.service.close(); }
  });
});

test('a missed rename notification is still protected by the canonical name read before saving', async () => {
  const f = fixture();
  try {
    const host = f.forHost(); host.control.autoComplete = false;
    const thread = f.webStart(); f.accepted();
    await until(() => host.helpers.length === 1, 'title helper did not start');
    thread.name = '原生桌面端已经重命名';
    host.finish(); await f.service.drain();
    assert.equal(host.named().length, 0);
    assert.equal(thread.name, '原生桌面端已经重命名');
    assert.equal(host.cleanup().length, 1);
  } finally { await f.service.close(); }
});

test('a stale final metadata read cannot undo a manual name received while generation is finishing', async () => {
  const f = fixture();
  try {
    const host = f.forHost(); host.control.holdFinalRead = true;
    f.webStart(); f.accepted();
    await until(() => !!host.control.releaseFinalRead, 'final metadata read was not held');
    host.threads.get('conversation').name = '生成结束时手动保存的名称';
    f.observe(local, { method: 'thread/name/updated', params: { threadId: 'conversation', threadName: '生成结束时手动保存的名称' } });
    host.control.releaseFinalRead!(); await f.service.drain();
    assert.equal(host.named().length, 0);
    assert.equal(host.cleanup().length, 1);
  } finally { await f.service.close(); }
});

test('requested manual naming cancels before its native acknowledgment can race the generated title', async () => {
  const f = fixture();
  try {
    const host = f.forHost(); host.control.autoComplete = false;
    f.webStart(); f.accepted();
    await until(() => host.helpers.length === 1, 'title helper did not start');
    f.observe(local, { method: 'bridge/thread/requested', params: { threadId: 'conversation', method: 'thread/name/set' } });
    host.finish(); await f.service.drain();
    assert.equal(host.named().length, 0);
    assert.equal(host.cleanup().length, 1);
  } finally { await f.service.close(); }
});

test('canceling while helper creation is awaiting acknowledgment still releases its returned identity without native notifications', async () => {
  const f = fixture();
  try {
    const host = f.forHost(); host.control.holdThreadStart = true;
    f.webStart(); f.accepted();
    await until(() => !!host.control.releaseThreadStart, 'helper creation did not reach its held acknowledgment');
    f.observe(local, { method: 'bridge/thread/requested', params: { threadId: 'conversation', method: 'thread/delete' } });
    host.control.releaseThreadStart!(); await f.service.drain();
    assert.equal(host.helpers.length, 0, 'a canceled creation must not dispatch title inference');
    assert.equal(host.named().length, 0);
    assert.equal(host.cleanup().length, 1);
    assert.match(host.cleanup()[0]!.params.threadId, /^title-helper-/);
  } finally { await f.service.close(); }
});

test('canceling a pending helper turn acknowledgment interrupts that returned turn even without turn-started events', async () => {
  const f = fixture();
  try {
    const host = f.forHost(); host.control.holdTurnStart = true;
    f.webStart(); f.accepted();
    await until(() => !!host.control.releaseTurnStart, 'helper inference did not reach its held acknowledgment');
    f.observe(local, { method: 'bridge/thread/requested', params: { threadId: 'conversation', method: 'thread/revert' } });
    host.control.releaseTurnStart!(); await f.service.drain();
    assert.equal(host.named().length, 0);
    assert.deepEqual(host.calls.find(call => call.method === 'turn/interrupt')?.params, {
      threadId: host.helpers[0]!.threadId, turnId: host.helpers[0]!.turnId,
    });
    assert.equal(host.cleanup().length, 1);
  } finally { await f.service.close(); }
});

test('an allocation acknowledgment arriving after the total timeout compensates with cleanup and cannot restart generation', async () => {
  const f = fixture({ timeoutMs: 20 });
  try {
    const host = f.forHost(); host.control.holdThreadStart = true;
    f.webStart(); f.accepted();
    await until(() => !!host.control.releaseThreadStart, 'helper creation did not reach its held acknowledgment');
    await delay(40); await f.service.drain();
    assert.equal(f.service.pendingCount, 0);
    assert.equal(host.named().length, 0);
    host.control.releaseThreadStart!();
    await until(() => host.cleanup().length === 1, 'late helper allocation was never released');
    assert.equal(host.helpers.length, 0);
    assert.equal(host.named().length, 0);
  } finally { await f.service.close(); }
});

test('a nonresponsive native cleanup is bounded and cannot permanently occupy a title worker', async () => {
  const f = fixture({ cleanupTimeoutMs: 10 });
  try {
    const host = f.forHost(); host.control.hangCleanup = true;
    f.webStart(); f.accepted(); await f.service.drain();
    assert.equal(host.named().length, 1);
    assert.equal(host.cleanup().length, 1);
    assert.equal(f.service.pendingCount, 0);
  } finally { await f.service.close(); }
});

test('disconnecting a host cancels its running and queued titles without affecting another host', async () => {
  const f = fixture({ maxConcurrentHosts: 2 });
  try {
    const a = f.forHost(local), b = f.forHost(remote);
    a.control.autoComplete = false; b.control.autoComplete = false;
    f.webStart('first', local); f.webStart('second', local); f.webStart('remote', remote);
    f.accepted('first', local); f.accepted('second', local); f.accepted('remote', remote);
    await until(() => a.helpers.length === 1 && b.helpers.length === 1, 'independent hosts did not begin inference');
    f.observe(local, { method: 'bridge/disconnected', params: {} });
    a.finish(); b.finish(); await f.service.drain();
    assert.equal(a.starts().length, 1, 'the canceled host queue must not create another helper');
    assert.equal(a.named().length, 0);
    assert.deepEqual(b.named().map(call => call.params.name), ['邮件系统的部署方案']);
  } finally { await f.service.close(); }
});

test('closing the service cancels running inference and discards queued titles before releasing its helpers', async () => {
  const f = fixture();
  const host = f.forHost(); host.control.autoComplete = false;
  f.webStart('running'); f.webStart('queued');
  f.accepted('running'); f.accepted('queued');
  await until(() => host.helpers.length === 1, 'title helper did not start');
  await f.service.close();
  assert.equal(host.starts().length, 1);
  assert.equal(host.named().length, 0);
  assert.equal(host.cleanup().length, 1);
  assert.equal(f.service.pendingCount, 0);
  host.finish(); await f.service.drain();
  assert.equal(host.named().length, 0);
});

test('a valid Unicode title uses a character budget without splitting supplementary characters', async () => {
  const f = fixture();
  try {
    const host = f.forHost();
    const title = '部署😀'.repeat(12);
    assert.equal([...title].length, 36);
    host.control.output = JSON.stringify({ title });
    f.webStart(); f.accepted(); await f.service.drain();
    assert.equal(host.named().length, 1);
    assert.equal(host.named()[0]!.params.name, title);
  } finally { await f.service.close(); }
});

test('the same thread ID on independent hosts has independent model requests and canonical names', async () => {
  const f = fixture();
  try {
    const a = f.forHost(local), b = f.forHost(remote);
    a.control.output = JSON.stringify({ title: '本机邮件部署' }); b.control.output = JSON.stringify({ title: '远程邮件部署' });
    f.webStart('shared-id', local); f.webStart('shared-id', remote);
    f.accepted('shared-id', local, { model: 'local-model' }); f.accepted('shared-id', remote, { model: 'remote-model' });
    await f.service.drain();
    assert.deepEqual(a.named().map(call => call.params.name), ['本机邮件部署']);
    assert.deepEqual(b.named().map(call => call.params.name), ['远程邮件部署']);
    assert.equal(a.starts()[0]!.params.model, 'local-model');
    assert.equal(b.starts()[0]!.params.model, 'remote-model');
  } finally { await f.service.close(); }
});

test('queued titles obey concurrency limits and cancellation of a queued conversation avoids an unnecessary model request', async () => {
  const f = fixture({ maxConcurrentHosts: 1, maxPending: 8, maxPendingPerHost: 4 });
  try {
    const a = f.forHost(local), b = f.forHost(remote);
    a.control.autoComplete = false; b.control.autoComplete = false;
    f.webStart('first', local); f.webStart('queued', remote);
    f.accepted('first', local); f.accepted('queued', remote);
    await until(() => a.helpers.length === 1, 'first queued title did not start');
    assert.equal(b.starts().length, 0, 'another host must remain queued at the concurrency cap');
    f.observe(remote, { method: 'thread/deleted', params: { threadId: 'queued' } });
    a.finish(); await f.service.drain();
    assert.equal(a.named().length, 1);
    assert.equal(b.starts().length, 0);
    assert.equal(b.named().length, 0);
  } finally { await f.service.close(); }
});

test('pending capacity bounds expensive naming work and declined jobs never replay when capacity becomes available', async () => {
  const f = fixture({ maxConcurrentHosts: 1, maxPending: 2, maxPendingPerHost: 2 });
  try {
    const a = f.forHost(local), b = f.forHost(remote);
    a.control.autoComplete = false;
    f.webStart('active', local); f.webStart('queued', local); f.webStart('over-capacity', remote);
    f.accepted('active', local); f.accepted('queued', local); f.accepted('over-capacity', remote);
    await until(() => a.helpers.length === 1, 'first title did not start');
    assert.equal(f.service.pendingCount, 2);
    assert.equal(b.starts().length, 0);
    a.control.autoComplete = true; a.finish(); await f.service.drain();
    assert.equal(a.starts().length, 2);
    assert.equal(a.named().length, 2);
    assert.equal(b.starts().length, 0);
    f.accepted('over-capacity', remote); await f.service.drain();
    assert.equal(b.starts().length, 0, 'capacity recovery must not replay a declined expensive inference');
    assert.equal(f.service.pendingCount, 0);
  } finally { await f.service.close(); }
});
