import { test, expect, login, slash, editSource } from './fixtures';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=', 'base64');

test('external changes preserve the browser draft and require an explicit conflict resolution', async ({ page, mock }) => {
  let disk = '# Original';
  let writes = 0;
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'fs/readFile' && request.params.path.endsWith('README.md')) return socket.send(JSON.stringify({ id: request.id, result: { dataBase64: Buffer.from(disk).toString('base64') } }));
    if (request.method === 'fs/writeFile') { writes++; disk = Buffer.from(request.params.dataBase64, 'base64').toString(); return socket.send(JSON.stringify({ id: request.id, result: {} })); }
    return receive(socket, request);
  };
  await login(page); await slash(page, 'terminal');
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await page.locator('.file-view-switch').getByRole('button', { name: '源码', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'README.md 文件内容' });
  await editSource(page, 'README.md 文件内容', '# My draft');
  disk = '# Codex changed this';
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const conflict = page.getByRole('alert', { name: '文件保存冲突' });
  await expect(conflict).toContainText('# Codex changed this');
  await expect(conflict).toContainText('# My draft');
  await expect(editor).toHaveText('# My draft'); expect(writes).toBe(0);
  await conflict.getByRole('button', { name: '保留草稿并手动合并' }).click();
  await editSource(page, 'README.md 文件内容', '# Codex changed this\n# My merged draft');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => writes).toBe(1); expect(disk).toContain('My merged draft');
});

test('assistant absolute and relative images stay bound to the source host and sanitize unsafe references', async ({ page, mock }) => {
  const requests: string[] = [];
  await page.route('**/api/hosts/*/images?*', route => {
    requests.push(route.request().url()); return route.fulfill({ contentType: 'image/png', body: png });
  });
  mock.turns.get('thread-existing')![0].items[1].text = '![Absolute](/workspace/demo/result.png)\n\n![Relative](assets/result%20two.png)\n\n![Unsafe](//evil.invalid/image.png)';
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  for (const name of ['Absolute', 'Relative']) {
    const image = page.getByRole('img', { name, exact: true });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  }
  expect(requests.map(value => new URL(value).pathname)).toEqual(['/api/hosts/local/images', '/api/hosts/local/images']);
  expect(requests.map(value => new URL(value).searchParams.get('path'))).toEqual(['/workspace/demo/result.png', '/workspace/demo/assets/result two.png']);
  await expect(page.getByRole('img', { name: 'Unsafe' })).not.toHaveAttribute('src', /evil/);
});

test('closed activity does not mount large tool output and every repeated file patch remains inspectable', async ({ page, mock }) => {
  const items = mock.turns.get('thread-existing')![0].items;
  const diff = '@@ -1 +1,10001 @@\n context\n' + Array.from({ length: 10000 }, (_, index) => `+line${index}`).join('\n');
  items.splice(1, 0, ...Array.from({ length: 100 }, (_, index) => ({ id: `cmd-${index}`, type: 'commandExecution', command: `echo ${index}`, aggregatedOutput: 'Large output\n'.repeat(100), status: 'completed', exitCode: 0 })),
    { id: 'change-first', type: 'fileChange', changes: [{ path: '/workspace/demo/large.ts', kind: 'update', diff }] },
    { id: 'change-second', type: 'fileChange', changes: [{ path: '/workspace/demo/large.ts', kind: 'update', diff: '@@ -1 +1,2 @@\n context\n+another' }] });
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator('.tool-item')).toHaveCount(0);
  const closedNodes = await page.locator('.conversation-turn').evaluate(element => element.querySelectorAll('*').length);
  expect(closedNodes).toBeLessThan(100);
  await test.info().attach('collapsed-dom-measurement', { body: JSON.stringify({ commands: 100, diffLines: 10000, closedTurnNodes: closedNodes }), contentType: 'application/json' });
  await page.locator('.turn-activity > summary').click();
  await expect(page.locator('.activity-batch')).toHaveCount(1);
  await expect(page.locator('.tool-item')).toHaveCount(0);
  await page.locator('.activity-batch > summary').click();
  await expect(page.locator('.tool-item')).toHaveCount(102);
  await expect(page.locator('.diff-code')).toHaveCount(0);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.locator('.workspace-tabs').getByRole('button', { name: /^变更/ }).click();
  const card = page.locator('.change-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.diff-count-add')).toHaveText('+10001');
  await expect(card.locator('.diff-code')).toHaveCount(0);
  await card.locator('summary').click();
  await expect(card.locator('.change-patches > section')).toHaveCount(2);
  await expect(card.locator('.diff-code').last()).toContainText('+another');
});

test('native model service tiers and live account windows use host data and keep tiers scoped to the selected conversation', async ({ page, mock }) => {
  await page.route('**/api/hosts/local/native-capabilities?*', route => route.fulfill({ json: { status: 'known', methods: {
    'thread/settings/update': { available: true, params: ['threadId', 'serviceTier'], required: ['threadId'] },
    'thread/start': { available: true, params: ['serviceTier'], required: [] },
    'turn/start': { available: true, params: ['threadId', 'input', 'serviceTier'], required: ['threadId', 'input'] },
  } } }));
  let used = 35;
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    const reply = (result: any) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'model/list') return reply({ data: [{ id: 'model-a', model: 'mock-model-a', displayName: 'Mock model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Native only' }] }], nextCursor: null });
    if (request.method === 'account/rateLimits/read') return reply({ rateLimits: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1900000000 } }, ordinaryUsageAllowed: true });
    if (request.method === 'thread/settings/update') return reply({});
    return receive(socket, request);
  };
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  const tier = page.getByRole('combobox', { name: '模型服务层级' });
  await expect(tier).toBeVisible(); await tier.selectOption('fast');
  await expect.poll(() => mock.request('thread/settings/update')?.params).toMatchObject({ threadId: 'thread-existing', serviceTier: 'fast' });
  await page.getByLabel('查看账户使用额度', { exact: true }).click();
  await expect(page.locator('.account-usage-popover')).toContainText('已用 35%');
  used = 73; mock.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 73 } } });
  await expect(page.locator('.account-usage-popover')).toContainText('已用 73%');
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('沿用服务层级');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.serviceTier).toBe('fast');
});

test('quota events invalidate an older pending read and trigger one follow-up without stale display', async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock); let reads = 0; let finish: (() => void) | undefined;
  const result = (usedPercent: number) => ({ rateLimits: { primary: { usedPercent, windowDurationMins: 300, resetsAt: 1900000000 } }, ordinaryUsageAllowed: true });
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'account/rateLimits/read') return receive(socket, request);
    reads++;
    if (reads === 1) { finish = () => socket.send(JSON.stringify({ id: request.id, result: result(55) })); return; }
    return socket.send(JSON.stringify({ id: request.id, result: result(95) }));
  };
  await login(page); await expect.poll(() => !!finish).toBe(true);
  mock.emit('account/rateLimits/updated', result(95)); finish!();
  await expect.poll(() => reads).toBe(2);
  await page.getByLabel('查看账户使用额度', { exact: true }).click();
  await expect(page.locator('.account-usage-popover')).toContainText('已用 95%');
  await expect(page.locator('.account-usage-popover')).not.toContainText('已用 55%');
});

test('an account restriction stays visible even with no quota windows or model service tiers', async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => request.method === 'account/rateLimits/read'
    ? socket.send(JSON.stringify({ id: request.id, result: { ordinaryUsageAllowed: false, rateLimits: { primary: null, secondary: null } } })) : receive(socket, request);
  await login(page); await expect(page.getByRole('status').filter({ hasText: '常规额度已受限' })).toBeVisible();
  await expect(page.getByLabel('查看账户使用额度', { exact: true })).toHaveCount(0);
});

test('late saves of a different file cannot replace the editor or unlock another pending save', async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  const pending = new Map<string, () => void>();
  mock.turns.get('thread-existing')![0].items.at(-1).text = '[打开另一个文件](/workspace/demo/index.html)';
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'fs/writeFile') {
      pending.set(request.params.path, () => socket.send(JSON.stringify({ id: request.id, result: {} })));
      return;
    }
    return receive(socket, request);
  };
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await slash(page, 'terminal');
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await page.locator('.file-view-switch').getByRole('button', { name: '源码', exact: true }).click();
  await editSource(page, 'README.md 文件内容', '# First save');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => pending.has('/workspace/demo/README.md')).toBe(true);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('link', { name: '打开另一个文件', exact: true }).click();
  const second = page.getByRole('textbox', { name: 'index.html 文件内容' });
  await expect(second).toHaveText('<h1>Demo preview</h1>');
  await editSource(page, 'index.html 文件内容', '<h1>Second save</h1>');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => pending.has('/workspace/demo/index.html')).toBe(true);
  const firstFinished = page.waitForResponse(response => response.url().includes('/files') && response.request().method() === 'POST' && !!response.request().postData()?.includes('/workspace/demo/README.md'));
  pending.get('/workspace/demo/README.md')!(); await firstFinished;
  await expect(second).toHaveText('<h1>Second save</h1>');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  pending.get('/workspace/demo/index.html')!();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await editSource(page, 'index.html 文件内容', '<h1>New draft</h1>');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
});
