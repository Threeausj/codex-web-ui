import type { Page } from '@playwright/test';
import { test, expect, login, MockCodex } from './fixtures';

const remoteId = 'ssh-vertex-memory';
async function setup(page: Page, mock: MockCodex) {
  mock.hosts.push({ id: remoteId, name: 'Vertex 记忆主机', kind: 'ssh', hostname: 'vertex.fixture.invalid' });
  mock.hostMocks.set(remoteId, new MockCodex());
  const value = () => ({ provider: 'official', supportsGcp: true, baseUrl: '', model: 'mock-model-a', hasApiKey: false,
    account: null, connected: true, canChange: true, userAgent: 'codex_cli_rs/0.165.0' });
  const wire = {
    settings: new Map<string, any>([['local', value()], [remoteId, value()]]),
    rpc: [] as { hostId: string; method: string; params?: any }[],
    providers: [] as { hostId: string; body: any }[],
    supported: true,
    summary: '当前会话的记忆摘要：保留项目约定。' as string | null,
    delay: undefined as Promise<void> | undefined,
  };
  await page.route(/\/api\/hosts\/[^/]+\/(?:codex-settings(?:\/provider)?|settings\/rpc|native-capabilities)(?:\?|$)/, async route => {
    const request = route.request(), parts = new URL(request.url()).pathname.split('/');
    const hostId = decodeURIComponent(parts[3]!), endpoint = parts.slice(4).join('/');
    if (endpoint === 'codex-settings') return route.fulfill({ json: wire.settings.get(hostId) });
    if (endpoint === 'codex-settings/provider') {
      const body = request.postDataJSON(); wire.providers.push({ hostId, body });
      const result = { ...wire.settings.get(hostId), provider: body.provider, model: body.model || wire.settings.get(hostId).model, applied: true };
      wire.settings.set(hostId, result);
      return route.fulfill({ json: result });
    }
    if (endpoint === 'native-capabilities') return route.fulfill({ json: { status: wire.supported ? 'known' : 'unknown', methods: wire.supported ? {
      'memory/status': { available: true, params: ['minConsolidatedThreads'], required: [] },
      'thread/memory/read': { available: true, params: ['threadId'], required: ['threadId'] },
    } : {} } });
    const body = request.postDataJSON();
    if (!['memory/status', 'thread/memory/read'].includes(body.method)) return route.fallback();
    wire.rpc.push({ hostId, ...body });
    const result = body.method === 'memory/status' ? { v2ConsolidatedThreads: 25, v2Ready: true } : { summary: wire.summary };
    if (wire.delay) await wire.delay;
    return route.fulfill({ json: result });
  });
  return wire;
}
async function openSettings(page: Page, hostId = 'local') {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.settings-button').click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('combobox', { name: '设置主机', exact: true }).selectOption(hostId);
  await dialog.locator('.settings-nav').getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '保存提供方', exact: true })).toBeEnabled();
  return dialog;
}
async function openThread(page: Page) {
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]').filter({ hasText: '已有测试历史' }).locator('.thread-row').click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
}

test('Vertex AI switches only the chosen host using native GCP without accepting cloud credentials', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  await login(page); await openThread(page);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('主机会话与草稿保持不变');
  const dialog = await openSettings(page, remoteId);
  await dialog.getByRole('button', { name: 'Vertex AI', exact: true }).click();
  await expect(dialog.getByText(/Application Default Credentials/)).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '中转站 API 密钥' })).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Vertex AI 默认模型', exact: true }).fill('gpt-6.1-sol');
  await dialog.getByRole('button', { name: '保存提供方', exact: true }).click();
  await expect(dialog.locator('.settings-success')).toContainText('模型提供方已更新');
  expect(wire.providers).toEqual([{ hostId: remoteId, body: { provider: 'gcp', model: 'gpt-6.1-sol' } }]);
  expect(mock.hostMocks.get(remoteId)!.request('thread/resume')).toBeUndefined();
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(input).toHaveValue('主机会话与草稿保持不变');
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'local');
});

test('unsupported hosts cannot select Vertex AI and all provider buttons fit a mobile settings panel', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const wire = await setup(page, mock); wire.settings.get('local').supportsGcp = false;
  await login(page); const dialog = await openSettings(page);
  await expect(dialog.getByRole('button', { name: 'Vertex AI', exact: true })).toBeDisabled();
  const sizes = await dialog.locator('.codex-provider-options button').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect(); return { width: box.width, height: box.height, left: box.left, right: box.right };
  }));
  expect(sizes).toHaveLength(3);
  for (const box of sizes) { expect(box.height).toBeGreaterThanOrEqual(44); expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(390); }
  expect(wire.providers).toEqual([]);
});

test('memory reads are manual, scoped to the selected host and do not resume another conversation', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  await login(page); await openThread(page);
  const resumeCount = mock.requests.filter(request => request.method === 'thread/resume').length;
  const dialog = await openSettings(page);
  const memory = dialog.getByRole('region', { name: 'Codex 记忆', exact: true });
  expect(wire.rpc).toEqual([]);
  await memory.getByRole('button', { name: '读取记忆状态', exact: true }).click();
  await expect(memory.getByRole('status')).toContainText('已整合 25 条会话 · V2 记忆已就绪');
  await memory.getByRole('button', { name: '查看当前会话记忆', exact: true }).click();
  await expect(memory.locator('pre')).toHaveText(wire.summary!);
  expect(wire.rpc).toEqual([
    { hostId: 'local', method: 'memory/status', params: {} },
    { hostId: 'local', method: 'thread/memory/read', params: { threadId: 'thread-existing' } },
  ]);
  await dialog.getByRole('combobox', { name: '设置主机', exact: true }).selectOption(remoteId);
  await expect(memory.locator('pre')).toHaveCount(0);
  await expect(memory.getByRole('button', { name: '查看当前会话记忆', exact: true })).toBeDisabled();
  await memory.getByRole('button', { name: '读取记忆状态', exact: true }).click();
  await expect(memory.getByRole('status')).toContainText('已整合 25');
  expect(wire.rpc.at(-1)?.hostId).toBe(remoteId);
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(resumeCount);
  expect(mock.hostMocks.get(remoteId)!.request('thread/resume')).toBeUndefined();
});

test('memory capability failures explain unsupported runtimes without sending a speculative RPC', async ({ page, mock }) => {
  const wire = await setup(page, mock); wire.supported = false;
  await login(page); await openThread(page);
  const dialog = await openSettings(page), memory = dialog.getByRole('region', { name: 'Codex 记忆', exact: true });
  await memory.getByRole('button', { name: '查看当前会话记忆', exact: true }).click();
  await expect(memory.getByRole('alert')).toContainText('0.165.0');
  expect(wire.rpc).toEqual([]);
});

test('a memory response from the previous host is discarded after switching settings hosts', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  let release!: () => void; wire.delay = new Promise<void>(resolve => { release = resolve; });
  await login(page); await openThread(page);
  const dialog = await openSettings(page), memory = dialog.getByRole('region', { name: 'Codex 记忆', exact: true });
  await memory.getByRole('button', { name: '查看当前会话记忆', exact: true }).click();
  await expect.poll(() => wire.rpc.length).toBe(1);
  await dialog.getByRole('combobox', { name: '设置主机', exact: true }).selectOption(remoteId);
  release();
  await expect(memory.getByRole('button', { name: '查看当前会话记忆', exact: true })).toBeDisabled();
  await expect(memory.locator('pre')).toHaveCount(0);
  await expect(memory.getByRole('alert')).toHaveCount(0);
});

test('missing memory is shown as an empty state and content is rendered as text', async ({ page, mock }) => {
  const wire = await setup(page, mock); wire.summary = null;
  await login(page); await openThread(page);
  const dialog = await openSettings(page), memory = dialog.getByRole('region', { name: 'Codex 记忆', exact: true });
  await memory.getByRole('button', { name: '查看当前会话记忆', exact: true }).click();
  await expect(memory.getByText(/暂无可读取的记忆摘要/)).toBeVisible();
  wire.summary = '<img src=x onerror="alert(1)">';
  await memory.getByRole('button', { name: '查看当前会话记忆', exact: true }).click();
  await expect(memory.locator('pre')).toHaveText(wire.summary);
  await expect(memory.locator('img')).toHaveCount(0);
});
