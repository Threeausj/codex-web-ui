import { test, expect, login, slash, MockCodex } from './fixtures';

const shellRequests = (mock: MockCodex) => mock.requests.filter(request => request.method === 'command/exec' && request.params.tty);
const output = (mock: MockCodex, processId: string, text: string) => mock.emit('command/exec/outputDelta', {
  processId, stream: 'stdout', deltaBase64: Buffer.from(text).toString('base64'), capReached: false,
});
const visibleText = (page: any) => page.locator('.xterm-rows').innerText();

for (const width of [1440, 390]) {
  test(`${width}px terminal tabs create independent shells, retain inactive output and close exactly one`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await slash(page, 'terminal');
    await expect.poll(() => shellRequests(mock).length).toBe(1);
    const first = shellRequests(mock)[0].params.processId;
    await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    await expect.poll(() => shellRequests(mock).length).toBe(2);
    const second = shellRequests(mock)[1].params.processId;
    await expect(page.getByRole('tab', { name: '终端 2', exact: true })).toHaveAttribute('aria-selected', 'true');
    output(mock, first, '\r\nFIRST HIDDEN OUTPUT\r\n');
    output(mock, second, '\r\nSECOND VISIBLE OUTPUT\r\n');
    await expect.poll(() => visibleText(page)).toContain('SECOND VISIBLE OUTPUT');
    expect(await visibleText(page)).not.toContain('FIRST HIDDEN OUTPUT');
    await page.getByRole('tab', { name: '终端 1', exact: true }).click();
    await expect.poll(() => visibleText(page)).toContain('FIRST HIDDEN OUTPUT');
    expect(await visibleText(page)).not.toContain('SECOND VISIBLE OUTPUT');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Tab');
    await expect.poll(() => mock.request('command/exec/write')?.params).toMatchObject({ processId: first, deltaBase64: 'CQ==' });
    await page.getByRole('button', { name: '关闭终端 2', exact: true }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);
    expect(mock.requests.filter(request => request.method === 'command/exec/terminate').map(request => request.params.processId)).toEqual([second]);
    await expect(page.locator('.pty-toolbar')).toContainText('Shell 正在运行');
    await page.getByRole('button', { name: '终端按键 Tab', exact: true }).click();
    await expect.poll(() => mock.request('command/exec/write')?.params.processId).toBe(first);
    await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
    output(mock, first, '\r\nWHILE WORKSPACE HIDDEN\r\n');
    await page.locator('.workspace-tabs').getByRole('button', { name: '终端', exact: true }).click();
    await expect.poll(() => visibleText(page)).toContain('WHILE WORKSPACE HIDDEN');
    await page.getByRole('button', { name: '关闭工作区', exact: true }).click();
    output(mock, first, '\r\nAFTER PANEL CLOSE\r\n');
    await slash(page, 'terminal');
    await expect.poll(() => visibleText(page)).toContain('AFTER PANEL CLOSE');
    expect(shellRequests(mock)).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `.data/terminal-tabs-${width}.png` });
  });
}

test('closing the selected terminal attaches the remaining shell and never writes to the closed PID', async ({ page, mock }) => {
  await login(page);
  await slash(page, 'terminal');
  await expect.poll(() => shellRequests(mock).length).toBe(1);
  const first = shellRequests(mock)[0].params.processId;
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect.poll(() => shellRequests(mock).length).toBe(2);
  const second = shellRequests(mock)[1].params.processId;
  output(mock, first, '\r\nSURVIVING SHELL\r\n');
  await page.getByRole('button', { name: '关闭终端 2', exact: true }).click();
  await expect(page.getByRole('tab', { name: '终端 1', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => visibleText(page)).toContain('SURVIVING SHELL');
  await page.getByRole('button', { name: '终端按键 Ctrl+C', exact: true }).click();
  await expect.poll(() => mock.request('command/exec/write')?.params).toMatchObject({ processId: first, deltaBase64: 'Aw==' });
  expect(mock.request('command/exec/terminate')?.params.processId).toBe(second);
});

test('switching tabs mid UTF-8 chunk does not corrupt a background terminal codepoint', async ({ page, mock }) => {
  await login(page);
  await slash(page, 'terminal');
  await expect.poll(() => shellRequests(mock).length).toBe(1);
  const first = shellRequests(mock)[0].params.processId;
  const bytes = Buffer.from('完');
  mock.emit('command/exec/outputDelta', { processId: first, stream: 'stdout', deltaBase64: bytes.subarray(0, 2).toString('base64') });
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect.poll(() => shellRequests(mock).length).toBe(2);
  mock.emit('command/exec/outputDelta', { processId: first, stream: 'stdout', deltaBase64: bytes.subarray(2).toString('base64') });
  await page.getByRole('tab', { name: '终端 1', exact: true }).click();
  await expect.poll(() => visibleText(page)).toContain('完');
  expect(await visibleText(page)).not.toContain('�');
});

test('host-local terminal tabs and output restore without spawning duplicate shells', async ({ page, mock }) => {
  const remote = new MockCodex();
  mock.hosts.push({ id: 'ssh-test', name: '终端远程主机', kind: 'ssh', hostname: 'server.invalid', cwd: '/workspace/demo' });
  mock.projects.push({ ...mock.projects[0], id: 'remote-project', hostId: 'ssh-test', name: 'Remote Project' });
  mock.hostMocks.set('ssh-test', remote);
  await login(page);
  await slash(page, 'terminal');
  await expect.poll(() => shellRequests(mock).length).toBe(1);
  const first = shellRequests(mock)[0].params.processId;
  output(mock, first, '\r\nLOCAL PRIVATE TERMINAL\r\n');
  await page.getByRole('button', { name: '关闭工作区', exact: true }).click();
  await page.getByRole('combobox', { name: '新对话主机', exact: true }).selectOption('ssh-test');
  await slash(page, 'terminal');
  await expect.poll(() => shellRequests(remote).length).toBe(1);
  const remoteId = shellRequests(remote)[0].params.processId;
  output(remote, remoteId, '\r\nREMOTE PRIVATE TERMINAL\r\n');
  await expect.poll(() => visibleText(page)).toContain('REMOTE PRIVATE TERMINAL');
  expect(await visibleText(page)).not.toContain('LOCAL PRIVATE TERMINAL');
  await page.getByRole('button', { name: '关闭工作区', exact: true }).click();
  await page.getByRole('combobox', { name: '新对话主机', exact: true }).selectOption('local');
  await slash(page, 'terminal');
  expect(shellRequests(mock)).toHaveLength(1);
  expect(await visibleText(page)).not.toContain('REMOTE PRIVATE TERMINAL');
  await page.getByRole('button', { name: '终端按键 Tab', exact: true }).click();
  await expect.poll(() => mock.request('command/exec/write')?.params.processId).toBe(first);
});

test('a delayed clipboard read never pastes into a different terminal', async ({ page, mock }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: () => new Promise<string>(resolve => { (window as any).finishTerminalPaste = resolve; }),
    } });
  });
  await login(page);
  await slash(page, 'terminal');
  await expect.poll(() => shellRequests(mock).length).toBe(1);
  await page.getByRole('button', { name: '粘贴到终端', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishTerminalPaste)).toBe('function');
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect.poll(() => shellRequests(mock).length).toBe(2);
  await page.evaluate(() => (window as any).finishTerminalPaste('do not send this'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(mock.request('command/exec/write')).toBeUndefined();
});

test('a shell awaiting its bridge acknowledgement cannot start another shell', async ({ page, mock }) => {
  let release: (() => void) | undefined;
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'command/exec' && request.params.tty && !release) {
      release = () => receive(socket, request);
      return;
    }
    return receive(socket, request);
  };
  await login(page);
  await slash(page, 'terminal');
  await expect.poll(() => typeof release).toBe('function');
  await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeDisabled();
  expect(shellRequests(mock)).toHaveLength(0);
  release!();
  await expect.poll(() => shellRequests(mock).length).toBe(1);
  await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeEnabled();
});
