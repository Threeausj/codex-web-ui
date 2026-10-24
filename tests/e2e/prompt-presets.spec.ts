import { test, expect, login, setComposerSelection, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';
import type { PromptPreset } from '../../shared/prompt-presets';

const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: '设置', exact: true });
const panel = (page: Page) => settings(page).locator('.presets-embedded');
const slot = (page: Page, n: number) => panel(page).getByRole('button', { name: `预设 ${n}`, exact: true });
const name = (page: Page) => panel(page).getByRole('textbox', { name: '预设名称', exact: true });
const content = (page: Page) => panel(page).getByRole('textbox', { name: '预设内容', exact: true });
const action = (page: Page, label: string) => panel(page).getByRole('button', { name: label, exact: true });
function seed(mock: MockCodex, n = 1, values: Partial<PromptPreset> = {}) {
  mock.promptPresets.presets[n - 1] = { slot: n, name: '代码审查', content: '请审查代码并报告问题。', kind: 'prompt', version: 1, ...values };
  mock.promptPresets.revision = mock.promptPresets.presets.reduce((sum, p) => sum + p.version, 0);
}
function confirm(page: Page) { page.on('dialog', dialog => dialog.accept()); }
async function open(page: Page, n?: number) {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.settings-button').click();
  await settings(page).getByRole('button', { name: '提示词预设', exact: true }).click();
  await expect(name(page)).toBeEnabled();
  if (n) await slot(page, n).click();
}
async function close(page: Page) { await settings(page).getByRole('button', { name: '关闭设置', exact: true }).click(); }
async function fill(page: Page, title: string, text: string, kind = 'prompt') {
  await name(page).fill(title);
  await panel(page).getByRole('combobox', { name: '预设类型', exact: true }).selectOption(kind);
  await content(page).fill(text);
}
async function recall(page: Page, n: number) {
  await input(page).fill(`/${n}`);
  const option = page.getByRole('option').filter({ hasText: `/${n} ·` });
  await expect(option).toBeVisible(); await option.click();
}

test('presets live in settings, save all ten slots and persist exact multiline content across reload', async ({ page, mock }) => {
  confirm(page); await login(page); await open(page, 10);
  await expect(page.locator('.composer .prompt-presets-toggle')).toHaveCount(0);
  await expect(panel(page).locator('[data-preset-slot]')).toHaveCount(10);
  const text = '**审查重点**\n\n检查 $E=mc^2$ 和中文。';
  await fill(page, '发布检查', text); await action(page, '保存预设').click();
  await expect(action(page, '保存预设')).toBeDisabled();
  await name(page).fill('发布前检查'); await action(page, '保存预设').click();
  await expect(slot(page, 10)).toContainText('发布前检查');
  await close(page); await page.reload(); await expect(input(page)).toBeEnabled(); await open(page, 10);
  await expect(content(page)).toHaveValue(text);
  expect(mock.promptPresets.presets[9].version).toBe(2);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('slash recall preserves surrounding draft text, selection and attachments without automatically sending', async ({ page, mock }) => {
  seed(mock, 1, { content: '**审查**\n保留中文和 $x^2$' }); await login(page);
  await input(page).fill('前文 /1 后文');
  await page.locator('.composer input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
  await setComposerSelection(input(page), 5);
  await page.getByRole('option').filter({ hasText: '/1 · 代码审查' }).click();
  await expect(input(page)).toHaveValue('前文 **审查**\n保留中文和 $x^2$ 后文');
  await expect(page.locator('.attachment').filter({ hasText: 'notes.txt' })).toBeVisible();
  expect(mock.request('turn/start')).toBeUndefined();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => JSON.stringify(mock.request('turn/start')?.params.input)).toContain('/test/uploads/notes.txt');
});

test('slash searches preset names and keeps numeric slots separate from skill and builtin commands', async ({ page, mock }) => {
  seed(mock, 1, { name: '发布审查', content: '发布检查内容' }); seed(mock, 10, { name: '性能分析', content: '性能检查内容' });
  await login(page); await input(page).fill('/性能');
  await expect(page.getByRole('option').filter({ hasText: '/10 · 性能分析' })).toBeVisible();
  await expect(page.getByRole('option').filter({ hasText: '/1 · 发布审查' })).toHaveCount(0);
  await input(page).press('Enter'); await expect(input(page)).toHaveValue('性能检查内容');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('/presets opens settings and removes only the menu token', async ({ page }) => {
  await login(page); await input(page).fill('/presets 后文');
  await setComposerSelection(input(page), 8);
  await input(page).press('Enter'); await expect(panel(page)).toBeVisible(); await close(page);
  await expect(input(page)).toHaveValue(' 后文');
});

test('supported command presets execute existing UI actions while unknown commands stay disabled', async ({ page, mock }) => {
  seed(mock, 1, { content: '/settings ', kind: 'command' }); seed(mock, 2, { name: '不支持的命令', content: '/unknown --token=never-run', kind: 'command' });
  await login(page); await input(page).fill('/2');
  await expect(page.getByRole('option').filter({ hasText: '/2 · 不支持的命令' })).toBeDisabled();
  await recall(page, 1); await expect(settings(page)).toBeVisible();
  expect(mock.request('command/exec')).toBeUndefined(); expect(mock.request('turn/start')).toBeUndefined();
});

test('replace and clear require confirmation and retain tombstone versions', async ({ page, mock }) => {
  seed(mock); let approve = false; page.on('dialog', d => approve ? d.accept() : d.dismiss());
  await login(page); await input(page).fill('原草稿'); await open(page);
  await name(page).fill('更名'); await action(page, '保存预设').click();
  expect(mock.presetRequests.filter(r => r.method === 'PUT')).toHaveLength(0);
  approve = true; await action(page, '保存预设').click(); await expect(slot(page, 1)).toContainText('更名');
  approve = false; await action(page, '清空预设').click(); expect(mock.presetRequests.filter(r => r.method === 'DELETE')).toHaveLength(0);
  approve = true; await action(page, '清空预设').click(); await expect(content(page)).toHaveValue('');
  expect(mock.promptPresets.presets[0].version).toBe(3); await close(page); await expect(input(page)).toHaveValue('原草稿');
});

test('failed saves and refreshes retain local edits, allow retry and preserve the chat draft', async ({ page, mock }) => {
  confirm(page); await login(page); await input(page).fill('原始草稿'); await open(page);
  await fill(page, '重试', '失败也保留'); mock.failPresetSaveNext = true; await action(page, '保存预设').click();
  await expect(panel(page).getByRole('alert')).toContainText('模拟预设保存失败'); await expect(content(page)).toHaveValue('失败也保留');
  await action(page, '保存预设').click(); await expect(action(page, '保存预设')).toBeDisabled();
  await page.route(/\/api\/prompt-presets(?:\?|$)/, route => route.fulfill({ status: 503, json: { error: '读取暂时失败' } }));
  await action(page, '刷新预设').click(); await expect(panel(page).getByRole('alert')).toContainText('读取暂时失败');
  await expect(content(page)).toHaveValue('失败也保留'); await close(page); await expect(input(page)).toHaveValue('原始草稿');
});

test('simultaneous browsers preserve conflicting edits until an explicit reload', async ({ page, context, mock }) => {
  confirm(page); seed(mock); await login(page); const second = await context.newPage(); confirm(second); await mock.install(second); await second.goto('/');
  await expect(input(second)).toBeEnabled(); await open(page); await open(second);
  await content(second).fill('另一端的本地修改'); await fill(page, '最新版本', '服务器最新内容'); await action(page, '保存预设').click();
  await expect(slot(second, 1)).toContainText('最新版本'); await expect(content(second)).toHaveValue('另一端的本地修改');
  await action(second, '保存预设').click(); await expect(panel(second).getByRole('alert')).toContainText('其他设备修改');
  await action(second, '重新载入此槽位').click(); await expect(content(second)).toHaveValue('服务器最新内容'); await second.close();
});

test('saving the current draft is explicit and tab/close/Escape all protect unsaved preset edits', async ({ page, mock }) => {
  let approve = false; page.on('dialog', d => approve ? d.accept() : d.dismiss()); await login(page);
  await input(page).fill('# 草稿\n- 审查'); await open(page); await expect(content(page)).toHaveValue('');
  await action(page, '保存当前草稿').click(); await expect(content(page)).toHaveValue('# 草稿\n- 审查');
  await settings(page).getByRole('button', { name: '通用', exact: true }).click(); await expect(panel(page)).toBeVisible();
  await close(page); await expect(panel(page)).toBeVisible(); await content(page).press('Escape'); await expect(panel(page)).toBeVisible();
  approve = true; await action(page, '保存预设').click(); await expect(action(page, '保存预设')).toBeDisabled();
  await close(page); await expect(input(page)).toHaveValue('# 草稿\n- 审查'); expect(mock.request('turn/start')).toBeUndefined();
});

for (const width of [320, 430]) test(`mobile ${width}px settings and slash recall remain usable`, async ({ page, mock }) => {
  confirm(page); seed(mock, 10, { name: '手机预设', content: '手机内容' }); await page.setViewportSize({ width, height: 680 });
  await login(page); await open(page, 10); await expect(content(page)).toHaveValue('手机内容');
  expect(await settings(page).evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await close(page); await recall(page, 10); await expect(input(page)).toHaveValue('手机内容');
});

test('presets are live and global across browsers connected to different hosts', async ({ page, context, mock }) => {
  confirm(page); seed(mock); const remote = new MockCodex();
  mock.hosts.push({ id: 'ssh-presets', name: '远程主机', kind: 'ssh', cwd: '/srv' });
  mock.hostMocks.set('ssh-presets', remote); await login(page);
  const second = await context.newPage(); await mock.install(second); await second.goto('/'); await expect(input(second)).toBeEnabled();
  await second.getByRole('combobox', { name: '新对话主机', exact: true }).selectOption('ssh-presets'); await expect(input(second)).toBeEnabled();
  await open(page); await fill(page, '跨主机同步', '全局内容'); await action(page, '保存预设').click(); await close(page);
  await recall(second, 1); await expect(input(second)).toHaveValue('全局内容'); await second.close();
});

test('recalling a prompt while running waits for an explicit steering action', async ({ page, mock }) => {
  seed(mock, 1, { content: '检查边界' }); mock.holdFinalMessage = true; await login(page);
  await input(page).fill('开始运行'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible(); await recall(page, 1);
  expect(mock.request('turn/steer')).toBeUndefined(); await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await expect.poll(() => mock.request('turn/steer')?.params.input[0]?.text).toBe('检查边界');
});

test('a hanging settings refresh can be closed and a late reply never reopens it', async ({ page, mock }) => {
  seed(mock); await login(page); let release!: () => Promise<void>;
  await page.route(/\/api\/prompt-presets(?:\?|$)/, async route => { await new Promise<void>(resolve => { release = async () => { await route.fulfill({ json: mock.promptPresets }); resolve(); }; }); });
  await page.locator('.settings-button').click(); await settings(page).getByRole('button', { name: '提示词预设', exact: true }).click();
  await expect(panel(page).getByText('正在读取预设…', { exact: true })).toBeVisible(); await close(page); await expect(settings(page)).toHaveCount(0);
  await release(); await expect(settings(page)).toHaveCount(0);
});

test('Android back keeps unsaved preset edits when discard is cancelled and closes settings only after confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let approve = false; page.on('dialog', d => approve ? d.accept() : d.dismiss());
  await login(page); await open(page); await fill(page, '未保存', '返回不能丢失');
  await page.goBack(); await expect(panel(page)).toBeVisible(); await expect(content(page)).toHaveValue('返回不能丢失');
  approve = true; await page.goBack(); await expect(settings(page)).toHaveCount(0);
  await expect(input(page)).toBeEnabled();
});
