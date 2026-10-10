/** Reproducible screenshots of the real UI using public, synthetic wire data.
 * No backend, host credentials, filesystem, or model requests are used. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { createServer, loadConfigFromFile } from 'vite';
import { MockCodex, expect } from '../tests/e2e/fixtures';

const output = path.resolve('docs/images');
const only = process.argv.find(argument => argument.startsWith('--only='))?.slice('--only='.length);
if (only && only !== 'bookmarks') throw new Error(`Unknown screenshot group: ${only}`);
const cwd = '/workspace/demo';
const at = Date.parse('2026-10-08T04:00:00Z');
const second = at / 1000;
const readme = '# Codex Web UI\n\n在浏览器中连接你的开发工作站，完成对话、文件编辑与任务检查。\n\n## 开发流程\n\n1. 选择主机与项目\n2. 描述任务，确认权限\n3. 检查变更并运行测试\n\n```sh\nnpm install\nnpm run dev\nnpm test\n```\n\n## 设计原则\n\n- 手机与桌面使用同一份会话\n- 私人历史与公开应用资源分开缓存\n- 提交结果未知时先核对，避免重复执行\n';
const source = 'export interface Project {\n  id: string;\n  name: string;\n  path: string;\n}\n\nexport function displayName(\n  project: Project,\n): string {\n  return project.name.trim()\n    || "未命名项目";\n}\n';
const changes = [
  { path: `${cwd}/src/Home.vue`, kind: 'update', diff: '@@ -1,3 +1,5 @@\n <template>\n-  <h1>Welcome</h1>\n+  <h1>今天，想构建什么？</h1>\n+  <p>选择项目，与 Codex 一起把想法变成现实。</p>\n+  <button>开始对话</button>\n </template>' },
  { path: `${cwd}/src/styles.css`, kind: 'update', diff: '@@ -1 +1,4 @@\n-body { background: white; }\n+body { background: var(--surface); }\n+@media (max-width: 720px) {\n+  .page { padding: 16px; }\n+}' },
  { path: `${cwd}/README.md`, kind: 'update', diff: '@@ -1 +1,3 @@\n # Codex Web UI\n+\n+支持桌面、手机与深色模式。' },
];
const tasks = [
  { id: 'demo-daily', name: '每日代码巡检', prompt: '只读检查 Git 状态与测试结果，汇总需要处理的问题。', hostId: 'local', cwd, model: '', effort: 'high', permission: 'read-only', timezone: 'Asia/Shanghai', cadence: { kind: 'daily', hour: 9, minute: 0 }, enabled: true, maxRetries: 1, createdAt: at, updatedAt: at, nextAt: at + 21 * 3600000 },
  { id: 'demo-weekly', name: '每周依赖检查', prompt: '检查依赖更新与公开漏洞，提供修改建议。', hostId: 'local', cwd, model: '', effort: 'medium', permission: 'read-only', timezone: 'Asia/Shanghai', cadence: { kind: 'weekly', days: [1, 3, 5], hour: 10, minute: 0 }, enabled: true, maxRetries: 2, createdAt: at, updatedAt: at, nextAt: at + 22 * 3600000 },
];
const runs = [
  { id: 'demo-completed', automationId: tasks[0].id, spec: tasks[0], phase: 'completed', attempt: 1, threadId: 'daily-review', scheduledAt: at - 3 * 3600000, createdAt: at - 3 * 3600000, updatedAt: at - 3 * 3600000 + 42000, logs: [{ at: at - 3 * 3600000, text: '执行已持久化入队' }, { at: at - 3 * 3600000 + 1000, text: '会话已创建，正在提交任务' }, { at: at - 3 * 3600000 + 42000, text: '任务执行完成：工作区干净，测试通过' }] },
  { id: 'demo-failed', automationId: tasks[1].id, spec: tasks[1], phase: 'failed', attempt: 1, scheduledAt: at - 2 * 3600000, createdAt: at - 2 * 3600000, updatedAt: at - 2 * 3600000, error: '连接暂时不可用；未提交原生任务，可安全重试。', logs: [{ at: at - 2 * 3600000, text: '已保留执行记录，等待恢复连接' }] },
];

function demo() {
  const mock = new MockCodex();
  mock.authenticated = true;
  mock.config.model = 'codex-demo';
  mock.hosts = [{ id: 'local', kind: 'local', name: '开发工作站' }];
  mock.projects[0].name = 'Codex Web UI';
  mock.projects[0].source = 'web';
  mock.threads = ['构建项目首页', '排查连接恢复', '每日代码巡检'].map((name, index) => ({ ...mock.threads[0], id: ['thread-existing', 'connection-review', 'daily-review'][index], name, preview: name, createdAt: second - index * 3600, updatedAt: second - index * 3600 }));
  mock.turns.set('thread-existing', [{ id: 'demo-turn', status: 'completed', itemsView: 'full', startedAt: second - 60, completedAt: second, durationMs: 60000, items: [
    { id: 'demo-user', type: 'userMessage', content: [{ type: 'text', text: '为项目添加清晰的首页，并兼容手机和深色模式。', text_elements: [] }] },
    { id: 'demo-commentary', type: 'agentMessage', phase: 'commentary', text: '我会检查现有布局，调整首页和手机输入区，再验证浅色与深色主题。' },
    { id: 'read-home', type: 'commandExecution', command: 'cat src/Home.vue', commandActions: [{ type: 'read', name: 'Home.vue', path: `${cwd}/src/Home.vue` }], status: 'completed', aggregatedOutput: '<template>...</template>', exitCode: 0 },
    { id: 'read-styles', type: 'commandExecution', command: 'cat src/styles.css', commandActions: [{ type: 'read', name: 'styles.css', path: `${cwd}/src/styles.css` }], status: 'completed', aggregatedOutput: ':root { ... }', exitCode: 0 },
    { id: 'demo-changes', type: 'fileChange', status: 'completed', changes },
    { id: 'demo-test', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'All tests passed.', exitCode: 0 },
    { id: 'demo-answer', type: 'agentMessage', phase: 'final_answer', text: '首页已更新，并完成手机与深色模式适配。\n\n- **更清晰的入口**：项目、主机和对话集中展示。\n- **更紧凑的对话**：连续操作默认折叠，回复保持直接可读。\n- **更方便的编辑**：源码与 Markdown 预览可切换，文件标签保留草稿。\n\n| 检查 | 结果 |\n| --- | --- |\n| 手机布局 | 通过 |\n| 浅色 / 深色主题 | 通过 |\n| 构建与测试 | 通过 |\n\n可以在右侧工作区查看变更，也可以继续提出修改。' },
  ] }]);
  mock.bookmarks = [
    { name: '手机布局检查清单', text: '手机输入工具栏保持对齐，侧滑返回先关闭侧栏，再返回对话。', threadId: 'connection-review', threadName: '排查连接恢复' },
    { name: '每日巡检重点', text: '只读检查 Git 状态与测试结果，保留执行记录，失败后可以重试。', threadId: 'daily-review', threadName: '每日代码巡检' },
  ].map((entry, index) => ({ id: `00000000-0000-4000-8000-00000000000${index + 1}`, hostId: 'local', projectPath: cwd,
    name: entry.name, source: { threadId: entry.threadId, threadName: entry.threadName, turnId: `bookmark-demo-turn-${index}`, itemId: `bookmark-demo-answer-${index}`, text: entry.text },
    createdAt: at - (index + 1) * 3600000, updatedAt: at - (index + 1) * 3600000,
  }));
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    const reply = (result: unknown) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'model/list') return reply({ data: [{ id: 'codex-demo', model: 'codex-demo', displayName: 'Codex 模型', hidden: false, isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '中' }, { reasoningEffort: 'high', description: '高' }] }], nextCursor: null });
    if (request.method === 'config/read') return reply({ config: { ...mock.config, model: 'codex-demo', model_reasoning_effort: 'high' }, origins: {}, layers: [] });
    if (request.method === 'fs/readDirectory') return reply({ entries: ['README.md', 'project.ts'].map(fileName => ({ fileName, isDirectory: false })) });
    if (request.method === 'fs/getMetadata') return reply({ isDirectory: request.params.path === cwd, isFile: request.params.path !== cwd, isSymlink: false, createdAtMs: at, modifiedAtMs: at });
    if (request.method === 'fs/readFile') return reply({ dataBase64: Buffer.from(request.params.path.endsWith('.ts') ? source : readme).toString('base64') });
    return receive(socket, request);
  };
  return mock;
}

const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' });
if (!loaded) throw new Error('Vite configuration not found');
const { proxy: _proxy, ...serverOptions } = loaded.config.server || {};
const server = await createServer({ ...loaded.config, configFile: false, server: { ...serverOptions, host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const origin = server.resolvedUrls?.local[0];
if (!origin) { await server.close(); throw new Error('Screenshot server did not start'); }
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch();
const failures: string[] = [];
try {
  async function open(theme = 'light', mobile = false) {
    const context = await browser.newContext({ baseURL: origin, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: mobile ? { width: 430, height: 932 } : { width: 1440, height: 1000 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, colorScheme: theme === 'dark' ? 'dark' : 'light' });
    const page = await context.newPage();
    await page.clock.install({ time: at + 60000 });
    page.on('pageerror', error => failures.push(error.message));
    // Never follow links or images to external services, even if fixtures change.
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(origin!).origin ? route.continue() : route.abort());
    await page.addInitScript(value => { localStorage.setItem('codex.theme', value); }, theme);
    const mock = demo(); await mock.install(page);
    await page.route('**/api/automations**', route => {
      if (route.request().method() !== 'GET') throw new Error('Screenshots must not change automation data');
      return route.fulfill({ json: { tasks, runs, error: '' } });
    });
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
    if (mobile) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '构建项目首页' }).click();
    await expect(page.getByText('首页已更新，并完成手机与深色模式适配。', { exact: false }).first()).toBeVisible();
    mock.emit('thread/tokenUsage/updated', { threadId: 'thread-existing', tokenUsage: { last: { totalTokens: 48000 }, total: { totalTokens: 68000 }, modelContextWindow: 200000 } });
    return { context, page, mock };
  }
  async function capture(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled', ...(clip ? { clip } : {}) });
    process.stdout.write(`Captured docs/images/${name}.png\n`);
  }
  async function captureRegion(page: Page, name: string, selectors: string[], padding = 36) {
    const boxes = await Promise.all(selectors.map(selector => page.locator(selector).boundingBox()));
    if (boxes.some(box => !box)) throw new Error(`Screenshot region is missing: ${name}`);
    const viewport = page.viewportSize()!;
    const x = Math.max(0, Math.floor(Math.min(...boxes.map(box => box!.x)) - padding));
    const y = Math.max(0, Math.floor(Math.min(...boxes.map(box => box!.y)) - padding));
    const right = Math.min(viewport.width, Math.ceil(Math.max(...boxes.map(box => box!.x + box!.width)) + padding));
    const bottom = Math.min(viewport.height, Math.ceil(Math.max(...boxes.map(box => box!.y + box!.height)) + padding));
    await capture(page, name, { x, y, width: right - x, height: bottom - y });
  }
  if (!only) {
  const desktop = await open();
  await desktop.page.locator('.turn-activity > summary').click();
  await capture(desktop.page, 'desktop-chat');
  await desktop.page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await desktop.page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await desktop.page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await desktop.page.getByRole('button', { name: '返回文件列表', exact: true }).click();
  await desktop.page.locator('.file-tree-row').filter({ hasText: 'project.ts' }).click();
  await expect(desktop.page.locator('.cm-lineNumbers')).toBeVisible();
  await capture(desktop.page, 'workspace-editor');
  await desktop.context.close();

  const dark = await open('dark');
  await dark.page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await dark.page.locator('.workspace-tabs').getByRole('button', { name: /^变更/ }).click();
  await expect(dark.page.locator('.change-card')).toHaveCount(3);
  await dark.page.locator('.change-card').first().locator('summary').click();
  await capture(dark.page, 'dark-changes');
  await dark.context.close();

  const resources = await open();
  let count = 0;
  await resources.page.route(/\/api\/hosts\/local\/resources(?:\?|$)/, route => {
    const usage = 43 + Math.sin(++count * 0.6) * 13;
    return route.fulfill({ json: { hostId: 'local', sampledAt: at + count * 4000, scope: 'host', cpu: { usagePercent: usage, load: [2.88, 2.30, 1.84], cores: 16 }, memory: { usedBytes: 12.4 * 2 ** 30, totalBytes: 32 * 2 ** 30, usagePercent: 38.75 + Math.sin(count * 0.4) }, network: { rxBytesPerSecond: (240 + count * 15) * 1024, txBytesPerSecond: (120 + Math.sin(count) * 30) * 1024 }, disk: { readBytesPerSecond: (300 + Math.sin(count * 0.4) * 150) * 1024, writeBytesPerSecond: (8 + Math.sin(count * 0.4) * 2) * 2 ** 20 }, gpus: { available: true, devices: [{ index: 0, name: 'NVIDIA GeForce RTX 4090', utilizationPercent: 73, memoryUsedBytes: 9.2 * 2 ** 30, memoryTotalBytes: 24 * 2 ** 30, temperatureC: 61, powerWatts: 212 }] }, runtime: { paused: false, connected: true, managed: true, mode: 'spawn', loadedThreadCount: 2, activeThreadCount: 0, activeProcesses: [], processes: [{ pid: 4200, role: 'app-server', local: true }], threads: resources.mock.threads.slice(0, 2).map(thread => ({ id: thread.id, name: thread.name, pid: 4200, loaded: true, active: false, released: false })) } } });
  });
  await resources.page.locator('.resources-button').click();
  await expect(resources.page.getByRole('dialog', { name: '资源管理', exact: true })).toContainText('NVIDIA');
  for (let i = 0; i < 12; i++) {
    const before = count; await resources.page.clock.runFor(4000);
    await expect.poll(() => count).toBeGreaterThan(before);
  }
  await capture(resources.page, 'resources');
  await resources.page.locator('.resource-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(resources.page.getByRole('button', { name: '关闭会话 构建项目首页', exact: true })).toBeVisible();
  await capture(resources.page, 'resources-runtime');
  await resources.context.close();

  const automation = await open();
  await automation.page.getByRole('button', { name: '自动化', exact: true }).click();
  await expect(automation.page.getByRole('dialog', { name: '自动化', exact: true })).toContainText('每日代码巡检');
  await automation.page.locator('.automation-run').first().locator('summary').click();
  await capture(automation.page, 'automations');
  await automation.context.close();

  const mobile = await open('light', true);
  await capture(mobile.page, 'mobile-chat');
  await mobile.context.close();
  }

  const bookmarks = await open();
  const page = bookmarks.page;
  const answer = page.locator('[data-selection-item-id="demo-answer"]');
  const selected = answer.locator('li').nth(1);
  await selected.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await selected.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const toolbar = page.getByRole('toolbar', { name: '所选对话内容', exact: true });
  await expect(toolbar.getByRole('button', { name: '收藏', exact: true })).toBeVisible();
  await captureRegion(page, 'bookmarks-selection', ['[data-selection-item-id="demo-answer"]', '.conversation-selection-toolbar'], 20);
  await toolbar.getByRole('button', { name: '收藏', exact: true }).click();
  await expect(page.locator('.bookmark-name-dialog')).toBeVisible();
  await page.getByRole('textbox', { name: '收藏名称', exact: true }).fill('紧凑对话的设计原则');
  await captureRegion(page, 'bookmarks-name', ['.bookmark-name-dialog']);
  await page.locator('.bookmark-name-dialog').getByRole('button', { name: '收藏', exact: true }).click();
  await expect(page.locator('.bookmark-name-dialog')).toHaveCount(0);
  await expect.poll(() => bookmarks.mock.bookmarks.length).toBe(3);
  await page.getByRole('button', { name: 'Codex Web UI 项目操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '收藏对话', exact: true }).click();
  await expect(page.locator('.bookmarks-panel')).toBeVisible();
  await expect(page.locator('.bookmark-entry')).toHaveCount(3);
  await expect(page.getByRole('searchbox', { name: '搜索收藏', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重命名收藏 紧凑对话的设计原则', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '跳转到收藏 紧凑对话的设计原则', exact: true })).toBeVisible();
  await captureRegion(page, 'bookmarks-list', ['.bookmarks-panel']);
  if (bookmarks.mock.requests.some(request => ['turn/start', 'turn/steer', 'thread/delete', 'thread/revert'].includes(request.method || '')))
    throw new Error('Bookmark screenshots must not run a model or modify conversations');
  await bookmarks.context.close();
  if (failures.length) throw new Error(`UI errors: ${failures.join('; ')}`);
} finally { await browser.close(); await server.close(); }
