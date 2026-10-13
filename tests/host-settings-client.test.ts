import test from 'node:test';
import assert from 'node:assert/strict';
import { useHostSettings } from '../src/lib/host-settings.js';

function fixture() {
  const main: any = { authenticated: true, hostId: 'local', connected: true, projectPath: '/current', hosts: [{ id: 'local' }, { id: 'remote', cwd: '/remote' }], preferences: {}, runtimeInformation: {}, runtimeReconnectingHostId: '' };
  const identity = { authenticationGeneration: 1, engineId: 'main-engine' };
  const calls: { url: string; input?: any }[] = [];
  const changes: string[] = [];
  const http = async (url: string, options: RequestInit = {}) => {
    const input = options.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ url, input });
    if (url.endsWith('/runtime/information')) return { checkedAt: Date.now(), runtime: { connected: true, engineId: `engine-${url}`, paused: false }, models: [{ model: 'new-model' }] };
    if (input?.method === 'config/read') return { config: { model: url.includes('remote') ? 'remote-model' : 'local-model' }, layers: [] };
    if (input?.method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.test' } };
    if (input?.method === 'configRequirements/read') return { requirements: { allowedSandboxModes: ['read-only'] } };
    if (input?.method === 'permissionProfile/list') return { data: [] };
    return { data: [] };
  };
  return { main, identity, calls, changes, api: useHostSettings(main, http, () => identity, id => changes.push(id)) };
}

test('settings for another host use scoped HTTP without changing the current writer or configuration', async () => {
  const { api, main, calls } = fixture();
  const remote = api.hostSettings('remote');
  await remote.api.readConfig();
  assert.equal(remote.state.config.config.model, 'remote-model');
  assert.equal(remote.state.projectPath, '/remote');
  assert.equal(main.hostId, 'local');
  assert.equal(main.config, undefined);
  assert.ok(calls.every(call => call.url.startsWith('/hosts/remote/')));
  assert.deepEqual(calls.find(call => call.input?.method === 'config/read')?.input.params, { includeLayers: true, cwd: '/remote' });
  main.preferences = { defaultPermission: 'read-only' };
  assert.deepEqual(remote.state.preferences, main.preferences);
});

test('parallel reads coalesce while mutations and official login retain their explicitly selected host', async () => {
  const { api, calls, changes } = fixture();
  const remote = api.hostSettings('remote');
  await Promise.all([remote.api.readConfig(), remote.api.readConfig()]);
  assert.equal(calls.filter(call => call.input?.method === 'config/read').length, 1);
  await remote.api.rpc('config/batchWrite', { edits: [] });
  assert.deepEqual(changes, ['remote']);
  await api.updateHostCodexProvider('remote', { provider: 'gateway', baseUrl: 'https://fixture.test/v1', apiKey: 'fixture-key' });
  await api.loginHostCodexAccount('remote', { type: 'deviceAuth' });
  await api.cancelHostCodexLogin('remote', 'fixture-login');
  assert.ok(calls.every(call => call.url.startsWith('/hosts/remote/')));
  assert.deepEqual(calls.at(-1)?.input, { loginId: 'fixture-login' });
});

test('a delayed metadata read cannot repopulate private state after logout or a new authentication generation', async () => {
  const { main, identity } = fixture();
  let resolve!: (value: any) => void;
  const api = useHostSettings(main, () => new Promise(done => { resolve = done; }), () => identity, () => {});
  const remote = api.hostSettings('remote');
  remote.state.account = { type: 'chatgpt' };
  const pending = api.refreshRuntimeInformation('remote');
  identity.authenticationGeneration++;
  main.authenticated = false;
  api.resetHostSettings();
  resolve({ runtime: { connected: true }, models: [{ model: 'secret-model' }] });
  await assert.rejects(pending, /登录状态/);
  assert.equal(remote.state.account, null);
  assert.deepEqual(main.runtimeInformation, {});
  assert.equal(main.runtimeReconnectingHostId, '');
});

test('reading a disconnected or released host never creates a native runtime or writes configuration', async () => {
  const { main, identity } = fixture();
  const calls: string[] = [];
  const api = useHostSettings(main, async url => { calls.push(url); return { runtime: { connected: false, paused: true }, models: [] }; }, () => identity, () => {});
  const remote = api.hostSettings('remote');
  await remote.api.readConfig();
  assert.equal(remote.state.runtimePaused, true);
  assert.equal(remote.state.config, null);
  assert.deepEqual(calls, ['/hosts/remote/runtime/information']);
});

test('a new engine gets its own metadata read and rejects the late previous-engine response', async () => {
  const { main, identity } = fixture();
  const replies: ((value: any) => void)[] = [];
  const api = useHostSettings(main, () => new Promise(resolve => replies.push(resolve)), () => identity, () => {});
  const previous = api.refreshRuntimeInformation('remote');
  api.invalidateHostSettings('remote');
  const next = api.refreshRuntimeInformation('remote');
  assert.equal(replies.length, 2);
  replies[1]({ runtime: { connected: true, engineId: 'new' }, models: [{ model: 'new-model' }] });
  await next;
  replies[0]({ runtime: { connected: true, engineId: 'old' }, models: [{ model: 'old-model' }] });
  await assert.rejects(previous, /连接或配置已变化/);
  assert.equal(main.runtimeInformation.remote.runtime.engineId, 'new');
  assert.equal(api.hostSettings('remote').state.models[0].model, 'new-model');
});

test('late configuration from before a reconnect cannot overwrite freshly read settings', async () => {
  const { main, identity } = fixture();
  let oldConfig!: (value: any) => void;
  let configReads = 0;
  const api = useHostSettings(main, async (_url, options = {}) => {
    if (!options.body) return { runtime: { connected: true, engineId: `engine-${configReads}` }, models: [] };
    const { method } = JSON.parse(String(options.body));
    if (method === 'config/read') {
      if (++configReads === 1) return new Promise(resolve => { oldConfig = resolve; });
      return { config: { model: 'new-model' } };
    }
    return { data: [] };
  }, () => identity, () => {});
  const remote = api.hostSettings('remote');
  const previous = remote.api.readConfig();
  while (!oldConfig) await new Promise(resolve => setImmediate(resolve));
  api.invalidateHostSettings('remote');
  await remote.api.readConfig();
  oldConfig({ config: { model: 'old-model' } });
  await previous;
  assert.equal(remote.state.config.config.model, 'new-model');
  assert.equal(remote.state.loading, false);
  assert.equal(configReads, 2);
});

test('integration batches cannot restore completed private reads when logout occurs before the last response', async () => {
  const { main, identity } = fixture();
  let last!: (value: any) => void;
  const api = useHostSettings(main, async (_url, options = {}) => {
    const { method } = JSON.parse(String(options.body));
    if (method === 'mcpServerStatus/list') return new Promise(resolve => { last = resolve; });
    return { data: [{ id: 'private-app-or-skill' }] };
  }, () => identity, () => {});
  const remote = api.hostSettings('remote');
  const pending = remote.api.loadIntegrations();
  await new Promise(resolve => setImmediate(resolve));
  identity.authenticationGeneration++;
  main.authenticated = false;
  api.resetHostSettings();
  last({ data: [{ name: 'private-mcp-server' }] });
  await pending;
  assert.deepEqual(remote.state.apps, []);
  assert.deepEqual(remote.state.skills, []);
  assert.deepEqual(remote.state.mcpServers, []);
  assert.deepEqual(remote.state.integrationErrors, []);
});
