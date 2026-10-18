import { test, expect, login, slash, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

/** Exercise the browser's real WebSocket handler without launching any shell. */
async function terminalBridge(page: Page, mock: MockCodex) {
  const engineId = 'terminal-output-compat-engine';
  const events: any[] = [];
  const processes = new Map<string, any>();
  let sequence = 0;
  const nativeReceive = (mock as any).receive.bind(mock);
  const latest = () => mock.sockets.at(-1)!;
  const status = (socket = latest(), replayComplete = false) => socket.send(JSON.stringify({
    method: 'bridge/status', params: { connected: true, hostId: 'local', mode: 'spawn',
      engineId, eventSequence: sequence, replayComplete, pendingRequests: [], activeProcesses: [...processes.values()] },
  }));
  const remember = (method: string, params: any) => {
    const event = { method, params, bridgeEventSequence: ++sequence };
    events.push(event);
    return event;
  };
  await page.routeWebSocket(/\/api\/rpc(?:\?|$)/, socket => {
    mock.sockets.push(socket);
    const cursor = new URL(socket.url()).searchParams.get('afterSequence');
    const replay = cursor !== null;
    if (replay) for (const event of events) if (event.bridgeEventSequence > Number(cursor)) socket.send(JSON.stringify(event));
    socket.onMessage(raw => {
      const request = JSON.parse(raw.toString());
      if (request.method === 'command/exec') {
        mock.requests.push(request);
        const { processId, tty, cwd } = request.params;
        processes.set(processId, { processId, tty, cwd, startedAt: Date.now(), lastOutput: '', pendingOutputBase64: {} });
        status(socket);
      } else if (request.method === 'bridge/ping') {
        mock.requests.push(request);
        socket.send(JSON.stringify({ id: request.id, result: { connected: true, engineId, eventSequence: sequence, loadedThreadIds: [] } }));
      } else nativeReceive(socket, request);
    });
    status(socket, replay);
  });
  return {
    processes,
    status,
    emit(method: string, params: any) { latest().send(JSON.stringify(remember(method, params))); },
    miss(method: string, params: any) { remember(method, params); },
    socket: latest,
  };
}

const visibleText = (page: Page) => page.locator('.xterm-rows').innerText();
const shellRequests = (mock: MockCodex) => mock.requests.filter(request => request.method === 'command/exec');

test('an initially unselected restored terminal decodes its pending snapshot without starting a shell', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const bridge = await terminalBridge(page, mock);
  const processId = 'web-pty-initial-snapshot', character = Buffer.from('好');
  bridge.processes.set(processId, { processId, tty: true, cwd: '/workspace/demo', startedAt: Date.now(),
    lastOutput: 'INITIAL RESTORE ', pendingOutputBase64: { stdout: character.subarray(0, 2).toString('base64') } });
  await login(page);
  await slash(page, 'terminal');
  await expect.poll(() => visibleText(page)).toContain('INITIAL RESTORE');
  bridge.emit('command/exec/outputDelta', { processId, stream: 'stdout', deltaBase64: character.subarray(2).toString('base64') });
  await expect.poll(() => visibleText(page)).toContain('INITIAL RESTORE 好');
  expect(await visibleText(page)).not.toContain('�');
  expect(shellRequests(mock)).toHaveLength(0);
});

for (const width of [1440, 390]) {
  test(`${width}px terminal reconnect restores a UTF-8 snapshot before receiving Chinese and emoji suffixes`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 900 });
    const bridge = await terminalBridge(page, mock);
    await login(page);
    await slash(page, 'terminal');
    await expect.poll(() => shellRequests(mock).length).toBe(1);
    const processId = shellRequests(mock)[0].params.processId;
    const chinese = Buffer.from('完'), emoji = Buffer.from('🚀');
    const process = bridge.processes.get(processId)!;
    process.lastOutput = 'RECOVERED SNAPSHOT ';
    process.pendingOutputBase64 = { stdout: chinese.subarray(0, 2).toString('base64'), stderr: emoji.subarray(0, 3).toString('base64') };
    await bridge.socket().close({ code: 1006, reason: 'Isolated terminal reconnect fixture' });
    await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2);
    await expect.poll(() => visibleText(page)).toContain('RECOVERED SNAPSHOT');
    bridge.emit('command/exec/outputDelta', { processId, stream: 'stdout', deltaBase64: chinese.subarray(2).toString('base64') });
    bridge.emit('command/exec/outputDelta', { processId, stream: 'stderr', deltaBase64: emoji.subarray(3).toString('base64') });
    await expect.poll(() => visibleText(page)).toContain('完🚀');
    const text = await visibleText(page);
    expect(text).not.toContain('�');
    expect(text.match(/RECOVERED SNAPSHOT/g)).toHaveLength(1);
    expect(text.match(/完/g)).toHaveLength(1);
    expect(text.match(/🚀/g)).toHaveLength(1);
    expect(shellRequests(mock)).toHaveLength(1);
    await expect(page.locator('.pty-toolbar')).toContainText('Shell 正在运行');
  });
}

test('terminal completion flushes its tail and buffered result once even when completion repeats', async ({ page, mock }) => {
  const bridge = await terminalBridge(page, mock);
  await login(page);
  await slash(page, 'terminal');
  await expect.poll(() => shellRequests(mock).length).toBe(1);
  const processId = shellRequests(mock)[0].params.processId;
  bridge.emit('command/exec/outputDelta', { processId, stream: 'stdout', deltaBase64: Buffer.concat([Buffer.from('STREAMED '), Buffer.from([0xe4, 0xbd])]).toString('base64') });
  await expect.poll(() => visibleText(page)).toContain('STREAMED');
  const completion = { processId, outputTail: '�', result: { exitCode: 7, stdout: 'BUFFERED_STDOUT\r\n', stderr: 'BUFFERED_STDERR\r\n' } };
  bridge.processes.delete(processId);
  bridge.emit('bridge/terminal/completed', completion);
  await expect.poll(() => visibleText(page)).toContain('BUFFERED_STDERR');
  // A different sequence rules out event-cursor de-duplication masking the
  // per-process completion guard in the client.
  bridge.emit('bridge/terminal/completed', completion);
  bridge.status();
  await expect(page.getByRole('button', { name: '启动终端', exact: true })).toBeEnabled();
  const text = await visibleText(page);
  for (const value of ['STREAMED', '�', 'BUFFERED_STDOUT', 'BUFFERED_STDERR', '[进程退出 7]']) expect(text.split(value).length - 1).toBe(1);
  expect(shellRequests(mock)).toHaveLength(1);
});

test('terminal reconnect replays the last chunk and completed buffered output in chronological order', async ({ page, mock }) => {
  const bridge = await terminalBridge(page, mock);
  await login(page);
  await slash(page, 'terminal');
  await expect.poll(() => shellRequests(mock).length).toBe(1);
  const processId = shellRequests(mock)[0].params.processId;
  bridge.emit('command/exec/outputDelta', { processId, stream: 'stdout', deltaBase64: Buffer.from('BEFORE DISCONNECT\r\n').toString('base64') });
  await expect.poll(() => visibleText(page)).toContain('BEFORE DISCONNECT');
  await bridge.socket().close({ code: 1006, reason: 'Isolated fixture misses final output' });
  bridge.miss('command/exec/outputDelta', { processId, stream: 'stdout', deltaBase64: Buffer.from('LAST STREAMED CHUNK\r\n').toString('base64') });
  bridge.processes.delete(processId);
  bridge.miss('bridge/terminal/completed', { processId, outputTail: '', result: { exitCode: 0, stdout: 'FINAL BUFFERED RESULT\r\n', stderr: '' } });
  await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2);
  await expect.poll(() => visibleText(page)).toContain('FINAL BUFFERED RESULT');
  const text = await visibleText(page);
  expect(text.indexOf('BEFORE DISCONNECT')).toBeLessThan(text.indexOf('LAST STREAMED CHUNK'));
  expect(text.indexOf('LAST STREAMED CHUNK')).toBeLessThan(text.indexOf('[进程退出 0]'));
  expect(text.indexOf('[进程退出 0]')).toBeLessThan(text.indexOf('FINAL BUFFERED RESULT'));
  for (const value of ['BEFORE DISCONNECT', 'LAST STREAMED CHUNK', '[进程退出 0]', 'FINAL BUFFERED RESULT']) expect(text.split(value).length - 1).toBe(1);
  expect(shellRequests(mock)).toHaveLength(1);
  await expect(page.getByRole('button', { name: '启动终端', exact: true })).toBeEnabled();
});
