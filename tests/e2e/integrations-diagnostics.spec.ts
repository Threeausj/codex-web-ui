import type { Page } from '@playwright/test';
import { test, expect, login } from './fixtures';

const methods = {
  'skills/config/write': { available: true, params: ['path', 'name', 'enabled'], required: ['enabled'] },
  'mcpServer/oauth/login': { available: true, params: ['name', 'threadId'], required: ['name'] },
  'config/mcpServer/reload': { available: true, params: [], required: [] },
  'mcpServerStatus/list': { available: true, params: ['threadId', 'limit', 'cursor'], required: [] },
};
async function open(page: Page, section = '技能与集成') {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.settings-button').click();
  await page.locator('.settings-nav').getByRole('button', { name: section, exact: true }).click();
}
function inventory(mock: any) {
  const fixture = { enabled: true, authStatus: 'notLoggedIn', runtimeStatus: 'authenticationRequired', holds: null as null | (() => void), holdLogin: false };
  const original = mock.receive.bind(mock);
  mock.receive = (socket: any, request: any) => {
    if (['skills/list', 'skills/config/write', 'mcpServerStatus/list', 'mcpServer/oauth/login', 'config/mcpServer/reload'].includes(request.method)) {
      mock.requests.push(request);
      const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }));
      if (request.method === 'skills/list') return reply({ data: [{ cwd: '/workspace/demo', skills: [{ name: 'Fixture skill', path: '/workspace/demo/.codex/skills/fixture/SKILL.md', description: 'A configurable fixture skill', enabled: fixture.enabled }] }], errors: [] });
      if (request.method === 'skills/config/write') { fixture.enabled = request.params.enabled; return reply({ effectiveEnabled: fixture.enabled }); }
      if (request.method === 'mcpServerStatus/list') return reply({ data: [{ name: 'Fixture MCP', authStatus: fixture.authStatus, runtimeStatus: fixture.runtimeStatus, tools: { 'fixture-tool': {} }, resources: [], resourceTemplates: [], toolsError: null }], nextCursor: null });
      if (request.method === 'mcpServer/oauth/login') {
        const finish = () => reply({ authorizationUrl: 'https://identity.example.com/authorize?state=fixture' });
        if (fixture.holdLogin) { fixture.holds = finish; return; }
        return finish();
      }
      return reply({});
    }
    return original(socket, request);
  };
  return fixture;
}

test('skills enable and disable through confirmed native request fields and refresh the inventory', async ({ page, mock }) => {
  inventory(mock as any);
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: { status: 'known', checkedAt: Date.now(), methods } }));
  await login(page); await open(page);
  await page.getByRole('button', { name: '禁用技能 Fixture skill', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Fixture skill已禁用');
  expect(mock.request('skills/config/write')!.params).toEqual({ path: '/workspace/demo/.codex/skills/fixture/SKILL.md', enabled: false });
  await page.getByRole('button', { name: '启用技能 Fixture skill', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Fixture skill已启用');
  expect(mock.request('skills/config/write')!.params.enabled).toBe(true);
});

test('MCP login is an explicit link flow and reload uses the native parameterless request', async ({ page, mock }) => {
  const fixture = inventory(mock as any);
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: { status: 'known', checkedAt: Date.now(), methods } }));
  await login(page); await open(page);
  await expect(page.getByText('需要登录 · 未登录 · 1 个工具', { exact: true })).toBeVisible();
  expect(mock.request('mcpServer/oauth/login')).toBeUndefined();
  expect(mock.request('config/mcpServer/reload')).toBeUndefined();
  await page.getByRole('button', { name: '登录 MCP Fixture MCP', exact: true }).click();
  const link = page.getByRole('link', { name: '在浏览器授权 Fixture MCP', exact: true });
  await expect(link).toHaveAttribute('href', 'https://identity.example.com/authorize?state=fixture');
  await expect(link).toHaveAttribute('target', '_blank');
  expect(mock.request('mcpServer/oauth/login')!.params).toEqual({ name: 'Fixture MCP' });
  fixture.authStatus = 'oAuth'; fixture.runtimeStatus = 'connected';
  await page.getByRole('button', { name: '刷新集成', exact: true }).click();
  await expect(page.getByText('已连接 · OAuth 已登录 · 1 个工具', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新加载 MCP', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('MCP 配置已重新加载');
  expect(mock.request('config/mcpServer/reload')!.params).toBeUndefined();
});

test('unknown host schemas hide mutating controls while keeping integration inventory readable', async ({ page, mock }) => {
  inventory(mock as any);
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: { status: 'unknown', checkedAt: Date.now(), methods: {} } }));
  await login(page); await open(page);
  await expect(page.getByText('Fixture skill', { exact: true })).toBeVisible();
  await expect(page.getByText('暂时无法确认主机原生协议。清单仍可查看，更新 Codex 后可刷新操作能力。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '禁用技能 Fixture skill', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '登录 MCP Fixture MCP', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新加载 MCP', exact: true })).toHaveCount(0);
  expect(mock.request('skills/config/write')).toBeUndefined(); expect(mock.request('mcpServer/oauth/login')).toBeUndefined();
});

test('every integration mutation rechecks capabilities and cannot use a stale schema after a CLI change', async ({ page, mock }) => {
  inventory(mock as any); let known = true;
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: { status: known ? 'known' : 'unknown', checkedAt: Date.now(), methods: known ? methods : {} } }));
  await login(page); await open(page);
  const button = page.getByRole('button', { name: '禁用技能 Fixture skill', exact: true }); await expect(button).toBeEnabled();
  known = false; await button.click();
  await expect(page.getByRole('alert')).toContainText('当前主机协议未确认支持此操作');
  expect(mock.request('skills/config/write')).toBeUndefined();
});

test('closing integration settings discards a late OAuth link and keeps the main conversation intact', async ({ page, mock }) => {
  const fixture = inventory(mock as any); fixture.holdLogin = true;
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: { status: 'known', checkedAt: Date.now(), methods } }));
  await login(page); await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('Main unsent draft'); await open(page);
  await page.getByRole('button', { name: '登录 MCP Fixture MCP', exact: true }).click();
  await expect.poll(() => !!fixture.holds).toBe(true);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click(); fixture.holds!();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('Main unsent draft');
  await open(page); await expect(page.getByRole('link', { name: '在浏览器授权 Fixture MCP', exact: true })).toHaveCount(0);
});

test('connection diagnostics load only after expansion and stay compact at phone width', async ({ page }) => {
  let reads = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/hosts/*/diagnostics*', route => { reads++; return route.fulfill({ json: { hostId: 'local', sampledAt: Date.now(), runtime: { connected: true, paused: false, userAgent: 'codex/fixture', engineId: 'isolated-fixture-engine', connectionMode: 'spawn', reconnectCount: 2, lastConnectedAt: Date.now(), lastDisconnectedAt: null, lastProtocolError: { at: Date.now(), code: -32601, category: 'unsupportedMethod', method: 'fixture/unsupported' }, cachedEvents: { count: 5, capacity: 4096, firstSequence: 10, lastSequence: 14, bytes: 1024, ttlMs: 300000 } } } }); });
  await login(page); await open(page, '连接');
  expect(reads).toBe(0);
  await page.getByRole('button', { name: '连接诊断 · 本机', exact: true }).click();
  await expect(page.getByText('codex/fixture', { exact: true })).toBeVisible();
  await expect(page.getByText('5 / 4096 条 · 1 KiB · 保留 5 分钟', { exact: true })).toBeVisible();
  await expect(page.getByText(/原生 CLI 不支持此方法/)).toBeVisible();
  expect(reads).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('proxy and CLI version mismatches explain why actions are hidden while diagnostics remain readable', async ({ page, mock }) => {
  inventory(mock as any); let reason = 'proxy_runtime';
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: { status: 'unknown', checkedAt: Date.now(), checkedCliVersion: '0.160.1', reason, methods: {} } }));
  await page.route('**/api/hosts/*/diagnostics*', route => route.fulfill({ json: { hostId: 'local', sampledAt: Date.now(), capabilityNotice: 'proxy_runtime', runtime: { connected: true, paused: false, connectionMode: 'proxy', userAgent: 'codex_web/0.160.1 (Fixture)', engineId: 'proxy-fixture', reconnectCount: 0, cachedEvents: { count: 0, capacity: 4096, bytes: 0, ttlMs: 300000 } } } }));
  await login(page); await open(page);
  await expect(page.getByText('当前连接使用原生代理，无法用本机 CLI 协议确认代理进程的版本。原生操作暂不显示，请使用直接连接并刷新。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '禁用技能 Fixture skill', exact: true })).toHaveCount(0);
  reason = 'runtime_version_mismatch'; await page.getByRole('button', { name: '刷新集成', exact: true }).click();
  await expect(page.getByText('安装的 Codex 已更新，但当前连接仍使用旧版本。重新连接 Web Codex 后可刷新操作能力。', { exact: true })).toBeVisible();
  await page.locator('.settings-nav').getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '连接诊断 · 本机', exact: true }).click();
  await expect(page.getByText('当前连接为原生代理，本机 CLI 协议不能证明代理进程版本，因此未推断新原生操作的支持情况。', { exact: true })).toBeVisible();
  await expect(page.getByText('codex_web/0.160.1 (Fixture)', { exact: true })).toBeVisible();
});
