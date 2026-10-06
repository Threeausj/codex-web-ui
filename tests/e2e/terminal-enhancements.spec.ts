import { test, expect, login, slash } from './fixtures'

test('mobile terminal shortcut keys send exact shell control sequences and Ctrl can latch', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await slash(page, 'terminal')
  await page.getByRole('button', { name: '启动终端', exact: true }).click()
  await expect.poll(() => mock.request('command/exec')?.params.tty).toBe(true)
  for (const [label, text] of [['Ctrl+C', '\u0003'], ['Ctrl+D', '\u0004'], ['Tab', '\t'], ['Esc', '\u001b'], ['↑', '\u001b[A'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C']]) {
    await page.getByRole('button', { name: `终端按键 ${label}`, exact: true }).click()
    await expect.poll(() => mock.request('command/exec/write')?.params.deltaBase64).toBe(Buffer.from(text!).toString('base64'))
  }
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
  await page.keyboard.type('l')
  await expect.poll(() => mock.request('command/exec/write')?.params.deltaBase64).toBe(Buffer.from('\u000c').toString('base64'))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.getByRole('button', { name: '结束终端', exact: true }).click()
})

test('persistent terminal gives an explicit unavailable message without silently starting ordinary PTY', async ({ page, mock }) => {
  await page.route('**/api/terminal-sessions/prepare', route => route.fulfill({ json: { available: false, reason: '目标主机未检测到 tmux' } }))
  await login(page)
  await slash(page, 'terminal')
  await page.getByRole('checkbox', { name: /持久 Shell/ }).check()
  await page.getByRole('button', { name: '启动终端', exact: true }).click()
  await expect(page.locator('.interactive-terminal .inline-error')).toHaveText('目标主机未检测到 tmux')
  expect(mock.request('command/exec')).toBeUndefined()
})

test('explicit tmux terminal attaches through app-server PTY and preserves selected sandbox', async ({ page, mock }) => {
  const command = ['/usr/bin/tmux', 'new-session', '-A', '-s', 'codex-web-test', '-c', '/workspace/demo']
  await page.route('**/api/terminal-sessions/prepare', route => route.fulfill({ json: { available: true, sessionName: 'codex-web-test', command, note: '同一项目复用持久 Shell' } }))
  await login(page)
  await slash(page, 'terminal')
  await page.getByRole('checkbox', { name: /持久 Shell/ }).check()
  await page.getByRole('button', { name: '启动终端', exact: true }).click()
  await expect.poll(() => mock.request('command/exec')?.params.command).toEqual(command)
  expect(mock.request('command/exec')?.params).toMatchObject({ tty: true, cwd: '/workspace/demo', sandboxPolicy: { type: 'workspaceWrite' } })
  await expect(page.locator('.pty-hint')).toHaveText('同一项目复用持久 Shell')
  await page.getByRole('button', { name: '结束终端', exact: true }).click()
})
