import { test, expect, login } from './fixtures';

test('automation menu saves a timezone schedule and exposes persisted run logs and failure recovery', async ({ page }) => {
  const tasks: any[] = [], runs: any[] = [], actions: string[] = [];
  await page.route('**/api/automations**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/automations' && request.method() === 'GET') return route.fulfill({ json: { tasks, runs, error: '' } });
    if (pathname === '/api/automations' && request.method() === 'POST') {
      const task = { ...request.postDataJSON(), id: 'task-fixture', createdAt: Date.now(), updatedAt: Date.now(), nextAt: null }; tasks.push(task);
      return route.fulfill({ status: 201, json: task });
    }
    if (pathname.endsWith('/run')) {
      actions.push('run'); runs.push({ id: 'run-fixture', automationId: tasks[0].id, spec: tasks[0], phase: 'failed', attempt: 1, createdAt: Date.now(), error: '连接暂时不可用', logs: [{ at: Date.now(), text: '已保留执行记录，未提交原生任务' }] });
      return route.fulfill({ status: 202, json: runs[0] });
    }
    throw new Error('Unexpected automation request');
  });
  await page.route('**/api/automation-runs/*/retry', route => { actions.push('retry'); return route.fulfill({ status: 202, json: {} }); });
  await login(page); await page.getByRole('button', { name: '自动化', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '自动化', exact: true });
  await panel.getByRole('button', { name: '新建自动化' }).click();
  await panel.getByLabel('自动化名称', { exact: true }).fill('每日检查');
  await panel.getByLabel('自动化任务', { exact: true }).fill('检查项目状态，发现问题时说明原因');
  await panel.getByLabel('自动化时区', { exact: true }).fill('Asia/Shanghai');
  await panel.getByLabel('自动化频率', { exact: true }).selectOption('weekly');
  await panel.getByLabel('自动化执行时间', { exact: true }).fill('09:15');
  await panel.getByRole('button', { name: '保存自动化' }).click();
  await expect(panel.getByRole('button', { name: '每日检查', exact: true })).toBeVisible();
  expect(tasks[0]).toMatchObject({ timezone: 'Asia/Shanghai', permission: 'read-only', enabled: false, cadence: { kind: 'weekly', hour: 9, minute: 15, days: [1,2,3,4,5] } });
  await panel.getByRole('button', { name: '立即运行', exact: true }).click();
  await panel.locator('.automation-run > summary').click();
  await expect(panel).toContainText('已保留执行记录，未提交原生任务');
  page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '重新执行', exact: true }).click();
  await expect.poll(() => actions).toEqual(['run', 'retry']);
});

test('automation empty view and edit form fit desktop and phone without oversized blank space or horizontal overflow', async ({ page }) => {
  await page.route('**/api/automations**', route => route.fulfill({ json: { tasks: [], runs: [], error: '' } }));
  await login(page); await page.getByRole('button', { name: '自动化', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '自动化', exact: true });
  await expect(panel.getByText('没有执行记录', { exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect((await panel.boundingBox())!.height).toBeLessThan(page.viewportSize()!.height * 0.8);
  await page.screenshot({ path: '.data/automation-desktop-empty.png' });
  await panel.getByRole('button', { name: '新建自动化', exact: true }).click();
  await expect(panel.getByRole('heading', { name: '新建自动化', exact: true })).toBeVisible();
  const name = await panel.getByLabel('自动化名称', { exact: true }).boundingBox();
  const host = await panel.getByLabel('自动化主机', { exact: true }).boundingBox();
  expect(Math.abs(name!.y - host!.y)).toBeLessThan(2);
  await page.screenshot({ path: '.data/automation-desktop-form.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: '保存自动化', exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole('button', { name: '保存自动化', exact: true })).toBeVisible();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/automation-phone-form.png' });
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await page.screenshot({ path: '.data/automation-phone-empty.png' });
});

test('automation warnings clear after a successful refresh while failed action feedback remains', async ({ page }) => {
  let warning = '自动化等待队列已满';
  await page.route('**/api/automations**', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: '测试中的保存失败' } })
    : route.fulfill({ json: { tasks: [], runs: [], error: warning } }));
  await login(page); await page.clock.install();
  await page.getByRole('button', { name: '自动化', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '自动化', exact: true });
  await expect(panel.getByRole('alert')).toContainText(warning);
  warning = ''; await page.clock.fastForward(5000);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByRole('button', { name: '新建自动化' }).click();
  await panel.getByLabel('自动化名称', { exact: true }).fill('失败反馈');
  await panel.getByLabel('自动化任务', { exact: true }).fill('不提交原生任务');
  await panel.getByRole('button', { name: '保存自动化' }).click();
  await expect(panel.getByRole('alert')).toContainText('测试中的保存失败');
  await page.clock.fastForward(5000);
  await expect(panel.getByRole('alert')).toContainText('测试中的保存失败');
});
