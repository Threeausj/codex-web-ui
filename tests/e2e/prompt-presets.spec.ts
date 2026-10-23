import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';
import type { PromptPreset } from '../../shared/prompt-presets';

const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const panel = (page: Page) => page.getByRole('dialog', { name: '提示词预设', exact: true });
const slot = (page: Page, number: number) => panel(page).getByRole('button', { name: `预设 ${number}`, exact: true });
const action = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });
const name = (page: Page) => panel(page).getByRole('textbox', { name: '预设名称', exact: true });
const content = (page: Page) => panel(page).getByRole('textbox', { name: '预设内容', exact: true });
function seed(mock: MockCodex, number = 1, values: Partial<PromptPreset> = {}) {
  mock.promptPresets.presets[number - 1] = { slot: number, name: '代码审查', content: '请审查代码并报告问题。', kind: 'prompt', version: 1, ...values };
  mock.promptPresets.revision = mock.promptPresets.presets.reduce((sum, preset) => sum + preset.version, 0);
}
async function open(page: Page, number?: number) {
  await page.getByRole('button', { name: '提示词预设', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(name(page)).toBeEnabled();
  if (number) await slot(page, number).click();
}
async function form(page: Page, presetName: string, text: string, kind = 'prompt') {
  await name(page).fill(presetName);
  await panel(page).getByRole('combobox', { name: '预设类型', exact: true }).selectOption(kind);
  await content(page).fill(text);
}
function confirm(page: Page) { page.on('dialog', dialog => dialog.accept()); }

test('ten slots save, rename and reload a multiline preset without sending a model request', async ({ page, mock }) => {
  confirm(page);
  await login(page);
  await open(page);
  await expect(panel(page).locator('[data-preset-slot]')).toHaveCount(10);
  await slot(page, 10).click();
  const text = '请审查当前改动。\n\n- 先检查错误\n- 保留中文与 $E=mc^2$';
  await form(page, '发布前审查', text);
  await action(page, '保存预设').click();
  await expect(action(page, '保存预设')).toBeDisabled();
  expect(mock.promptPresets.presets[9]).toMatchObject({ name: '发布前审查', content: text, version: 1 });
  await name(page).fill('最终代码审查');
  await action(page, '保存预设').click();
  await expect(slot(page, 10)).toContainText('最终代码审查');
  expect(mock.presetRequests.filter(request => request.method === 'PUT').map(request => request.body.expectedVersion)).toEqual([0, 1]);
  await action(page, '关闭提示词预设').click();
  await page.reload();
  await expect(input(page)).toBeEnabled();
  await open(page, 10);
  await expect(name(page)).toHaveValue('最终代码审查');
  await expect(content(page)).toHaveValue(text);
  await page.screenshot({ path: '.data/prompt-presets-desktop.png' });
  expect(mock.request('turn/start')).toBeUndefined();
});

test('inserting a preset preserves selected draft text, attachments and literal Markdown until explicit send', async ({ page, mock }) => {
  confirm(page);
  const preset = '**审查重点**\n\n检查 $x^2$ 与中文路径。';
  seed(mock, 1, { content: preset });
  await login(page);
  await input(page).fill('前文 后文');
  await page.locator('.composer input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
  await expect(page.locator('.attachment').filter({ hasText: 'notes.txt' })).toBeVisible();
  await input(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 3));
  await open(page, 1);
  await action(page, '填入输入框').click();
  await expect(panel(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue(`前文 ${preset}\n\n后文`);
  await expect(input(page)).toBeFocused();
  await expect(page.locator('.attachment').filter({ hasText: 'notes.txt' })).toBeVisible();
  expect(mock.request('turn/start')).toBeUndefined();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.input.some((item: any) => item.type === 'text' && item.text.includes(preset))).toBe(true);
  expect(JSON.stringify(mock.request('turn/start')?.params.input)).toContain('/test/uploads/notes.txt');
});

test('/presets opens by keyboard and removes only its command token from the surrounding draft', async ({ page, mock }) => {
  confirm(page);
  await login(page);
  await input(page).fill('/presets 后文');
  await input(page).evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(8, 8);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.getByRole('listbox', { name: '对话指令' })).toBeVisible();
  await input(page).press('Enter');
  await expect(panel(page)).toBeVisible();
  await action(page, '关闭提示词预设').click();
  await expect(input(page)).toHaveValue(' 后文');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('supported command presets open existing tools and unsupported commands never become shell or model input', async ({ page, mock }) => {
  confirm(page);
  seed(mock, 1, { name: '设置', content: '/settings', kind: 'command' });
  seed(mock, 2, { name: '外部 CLI 命令', content: '/unknown --token=do-not-run', kind: 'command' });
  await login(page);
  await input(page).fill('保留命令执行前的草稿');
  await open(page, 2);
  await expect(action(page, '执行命令')).toBeDisabled();
  await expect(panel(page)).toContainText('当前网页版尚不支持此命令');
  await slot(page, 1).click();
  await action(page, '执行命令').click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('设置');
  expect(mock.request('command/exec')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
  expect(mock.presetRequests.filter(request => request.method !== 'GET')).toHaveLength(0);
});

test('replace and clear require confirmation, clear retains its version, and the composer draft survives', async ({ page, mock }) => {
  seed(mock);
  let approve = true;
  const confirmations: string[] = [];
  page.on('dialog', async dialog => { confirmations.push(dialog.message()); if (approve) await dialog.accept(); else await dialog.dismiss(); });
  await login(page);
  await input(page).fill('不能丢掉的原始消息');
  await open(page, 1);
  await name(page).fill('修改后的预设');
  approve = false;
  await action(page, '保存预设').click();
  expect(mock.presetRequests.filter(request => request.method === 'PUT')).toHaveLength(0);
  approve = true;
  await action(page, '保存预设').click();
  await expect(slot(page, 1)).toContainText('修改后的预设');
  approve = false;
  await action(page, '清空预设').click();
  expect(mock.presetRequests.filter(request => request.method === 'DELETE')).toHaveLength(0);
  approve = true;
  await action(page, '清空预设').click();
  await expect(content(page)).toHaveValue('');
  expect(mock.promptPresets.presets[0]).toMatchObject({ name: '', content: '', kind: 'prompt', version: 3 });
  await action(page, '关闭提示词预设').click();
  await expect(input(page)).toHaveValue('不能丢掉的原始消息');
  expect(confirmations.some(text => text.includes('替换预设'))).toBe(true);
  expect(confirmations.some(text => text.includes('清空预设'))).toBe(true);
});

test('HTTP save failures retain the edited preset and composer draft for a successful retry', async ({ page, mock }) => {
  confirm(page);
  await login(page);
  await input(page).fill('原始草稿');
  await open(page);
  await form(page, '网络重试', '保存失败不能丢失编辑');
  mock.failPresetSaveNext = true;
  await action(page, '保存预设').click();
  await expect(panel(page).getByRole('alert')).toContainText('模拟预设保存失败');
  await expect(name(page)).toHaveValue('网络重试');
  await expect(content(page)).toHaveValue('保存失败不能丢失编辑');
  await action(page, '保存预设').click();
  await expect(action(page, '保存预设')).toBeDisabled();
  await action(page, '关闭提示词预设').click();
  await expect(input(page)).toHaveValue('原始草稿');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('another browser changing the same slot produces a CAS conflict and preserves local edits until explicit reload', async ({ page, context, mock }) => {
  confirm(page);
  seed(mock);
  await login(page);
  const second = await context.newPage();
  confirm(second);
  await mock.install(second);
  await second.goto('/');
  await expect(input(second)).toBeEnabled();
  await open(page, 1);
  await open(second, 1);
  await content(second).fill('第二个浏览器未保存的编辑');
  await form(page, '第一个浏览器的新版本', '已在其他浏览器保存');
  await action(page, '保存预设').click();
  await expect(slot(second, 1)).toContainText('第一个浏览器的新版本');
  await expect(content(second)).toHaveValue('第二个浏览器未保存的编辑');
  await action(second, '保存预设').click();
  await expect(panel(second).getByRole('alert')).toContainText('预设已在其他设备修改');
  await expect(content(second)).toHaveValue('第二个浏览器未保存的编辑');
  expect(mock.promptPresets.presets[0].content).toBe('已在其他浏览器保存');
  await action(second, '重新载入此槽位').click();
  await expect(content(second)).toHaveValue('已在其他浏览器保存');
  await expect(action(second, '保存预设')).toBeDisabled();
  await second.close();
});

test('global presets update live across two browsers connected to different hosts', async ({ page, context, mock }) => {
  confirm(page);
  seed(mock);
  const remote = new MockCodex();
  mock.hosts.push({ id: 'ssh-presets', name: '预设远程主机', kind: 'ssh', cwd: '/srv' });
  mock.projects.push({ id: 'remote-presets', name: '远程项目', path: '/srv/demo', hostId: 'ssh-presets', source: 'web' });
  mock.hostMocks.set('ssh-presets', remote);
  await login(page);
  const second = await context.newPage();
  await mock.install(second);
  await second.goto('/');
  await expect(input(second)).toBeEnabled();
  await second.getByRole('combobox', { name: '新对话主机', exact: true }).selectOption('ssh-presets');
  await expect(input(second)).toBeEnabled();
  await open(second, 1);
  await open(page, 1);
  await form(page, '跨主机同步', '所有主机共享同一份常用提示词');
  await action(page, '保存预设').click();
  await expect(name(second)).toHaveValue('跨主机同步');
  await expect(content(second)).toHaveValue('所有主机共享同一份常用提示词');
  await action(second, '填入输入框').click();
  await expect(input(second)).toHaveValue('所有主机共享同一份常用提示词');
  expect(remote.request('turn/start')).toBeUndefined();
  await second.close();
});

for (const width of [320, 430]) {
  test(`mobile ${width}px preset dialog stays in the viewport with the keyboard open and supports touch-size controls`, async ({ page, mock }) => {
    confirm(page);
    seed(mock, 10, { name: '手机选择', content: '手机上也能选择第十个预设' });
    await page.setViewportSize({ width, height: 430 });
    await login(page);
    await open(page);
    await slot(page, 10).click();
    await expect(content(page)).toHaveValue('手机上也能选择第十个预设');
    const bounds = await panel(page).boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(431);
    expect(await panel(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await action(page, '填入输入框').click();
    await expect(input(page)).toHaveValue('手机上也能选择第十个预设');
    expect(mock.request('turn/start')).toBeUndefined();
  });
}

test('presets remain usable during an active response and send only through explicit steering', async ({ page, mock }) => {
  confirm(page);
  seed(mock, 1, { content: '继续执行时先检查边界情况' });
  mock.holdFinalMessage = true;
  await login(page);
  await input(page).fill('开始运行');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await open(page, 1);
  await action(page, '填入输入框').click();
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  expect(mock.request('turn/steer')).toBeUndefined();
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await expect.poll(() => mock.request('turn/steer')?.params.input[0]?.text).toBe('继续执行时先检查边界情况');
});

test('a delayed refresh cannot overwrite a newer live snapshot and Escape preserves a pending composer draft', async ({ page, mock }) => {
  confirm(page);
  seed(mock);
  await login(page);
  let release!: () => Promise<void>;
  const stale = structuredClone(mock.promptPresets);
  await page.route(/\/api\/prompt-presets(?:\?|$)/, async route => {
    await new Promise<void>(resolve => { release = async () => { await route.fulfill({ json: stale }); resolve(); }; });
  });
  await page.getByRole('button', { name: '提示词预设', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => typeof release).toBe('function');
  seed(mock, 1, { name: '新的同步版本', content: '保持最新版本', version: 2 });
  mock.promptPresets.revision = 2;
  mock.emit('bridge/prompt-presets/changed', mock.promptPresets);
  await release();
  await expect(name(page)).toHaveValue('新的同步版本');
  await expect(content(page)).toHaveValue('保持最新版本');
  await panel(page).press('Escape');
  await expect(panel(page)).toHaveCount(0);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('saving the current draft is explicit and retains its Markdown and unsent composer text', async ({ page, mock }) => {
  confirm(page);
  await login(page);
  const draft = '# 常用任务\n\n- 审查当前项目\n- 用中文总结';
  await input(page).fill(draft);
  await open(page);
  await expect(content(page)).toHaveValue('');
  await action(page, '保存当前草稿').click();
  await expect(content(page)).toHaveValue(draft);
  await name(page).fill('当前草稿模板');
  await action(page, '保存预设').click();
  await expect(action(page, '保存预设')).toBeDisabled();
  await action(page, '关闭提示词预设').click();
  await expect(input(page)).toHaveValue(draft);
  expect(mock.promptPresets.presets[0].content).toBe(draft);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('slot numbers and arrow keys navigate the list while typed digits and newlines remain editor content', async ({ page, mock }) => {
  confirm(page);
  await login(page);
  await open(page);
  await slot(page, 1).focus();
  await page.keyboard.press('0');
  await expect(slot(page, 10)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(slot(page, 1)).toHaveAttribute('aria-pressed', 'true');
  await content(page).fill('1234567890\n保留多行');
  await content(page).press('End');
  await content(page).press('Enter');
  await page.keyboard.insertText('第二行 10');
  await expect(content(page)).toHaveValue('1234567890\n保留多行\n第二行 10');
  await expect(slot(page, 1)).toHaveAttribute('aria-pressed', 'true');
  expect(mock.presetRequests.filter(request => request.method !== 'GET')).toHaveLength(0);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a failed preset refresh keeps the last loaded slots and can retry without touching the conversation', async ({ page, mock }) => {
  confirm(page);
  seed(mock);
  await login(page);
  let fail = true;
  await page.route(/\/api\/prompt-presets(?:\?|$)/, async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { error: '预设服务暂不可用' } }); }
    else await route.fallback();
  });
  await input(page).fill('尚未提交的草稿');
  await open(page);
  await expect(panel(page).getByRole('alert')).toContainText('预设服务暂不可用');
  await expect(content(page)).toHaveValue('请审查代码并报告问题。');
  await action(page, '刷新预设').click();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await expect(name(page)).toHaveValue('代码审查');
  await action(page, '关闭提示词预设').click();
  await expect(input(page)).toHaveValue('尚未提交的草稿');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a phone soft-keyboard visual viewport bounds the dialog instead of the taller layout viewport', async ({ page, mock }) => {
  confirm(page);
  seed(mock, 10, { name: '键盘可视区', content: '键盘展开后仍可使用预设' });
  await page.setViewportSize({ width: 430, height: 900 });
  await login(page);
  await open(page, 10);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => 400 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--app-height'))).toBe('400px');
  const bounds = await panel(page).boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(400);
  await action(page, '填入输入框').scrollIntoViewIfNeeded();
  const button = await action(page, '填入输入框').boundingBox();
  expect(button!.y + button!.height).toBeLessThanOrEqual(400);
  await page.screenshot({ path: '.data/prompt-presets-mobile-keyboard.png' });
  await action(page, '填入输入框').click();
  await expect(input(page)).toHaveValue('键盘展开后仍可使用预设');
});

test('an unanswered refresh can be closed immediately and a late response does not reopen the dialog', async ({ page, mock }) => {
  confirm(page);
  seed(mock);
  await login(page);
  await input(page).fill('等待预设期间仍保留草稿');
  let release!: () => Promise<void>;
  await page.route(/\/api\/prompt-presets(?:\?|$)/, async route => {
    await new Promise<void>(resolve => { release = async () => { await route.fulfill({ json: mock.promptPresets }); resolve(); }; });
  });
  await page.getByRole('button', { name: '提示词预设', exact: true }).click();
  await expect(panel(page).getByText('正在读取预设…', { exact: true })).toBeVisible();
  await expect.poll(() => typeof release).toBe('function');
  await action(page, '关闭提示词预设').click();
  await expect(panel(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue('等待预设期间仍保留草稿');
  await release();
  await expect(panel(page)).toHaveCount(0);
  expect(mock.presetRequests.filter(request => request.method !== 'GET')).toHaveLength(0);
});

test('a matching remote save cannot acknowledge a rejected local mutation or silently advance its CAS version', async ({ page, mock }) => {
  confirm(page);
  seed(mock);
  await login(page);
  let release!: () => Promise<void>;
  await page.route('**/api/prompt-presets/1', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await new Promise<void>(resolve => { release = async () => { await route.fulfill({ status: 409,
      json: { error: '预设已在其他设备修改，请刷新后重试', code: 'PRESET_CONFLICT' } }); resolve(); }; });
  });
  await open(page, 1);
  await form(page, '同时编辑', '其他浏览器碰巧保存相同的内容');
  await action(page, '保存预设').click();
  await expect.poll(() => typeof release).toBe('function');
  seed(mock, 1, { name: '同时编辑', content: '其他浏览器碰巧保存相同的内容', version: 2 });
  mock.emit('bridge/prompt-presets/changed', mock.promptPresets);
  await release();
  await expect(panel(page).getByRole('alert')).toContainText('预设已在其他设备修改');
  await expect(action(page, '保存预设')).toBeEnabled();
  await expect(action(page, '重新载入此槽位')).toBeVisible();
  await expect(content(page)).toHaveValue('其他浏览器碰巧保存相同的内容');
  await action(page, '重新载入此槽位').click();
  await expect(action(page, '保存预设')).toBeDisabled();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});
