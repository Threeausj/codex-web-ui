import type { Page } from '@playwright/test'
import { test, expect, login, type MockCodex } from './fixtures'

const question = {
  id: 'scope', header: '执行范围', question: '此次处理什么范围？', isOther: true, isSecret: false,
  options: [
    { label: '当前项目（推荐）', description: '仅处理当前工作区。' },
    { label: '所有项目', description: '处理全部工作区。' },
  ],
}

async function prepare(page: Page) {
  await login(page)
  await page.locator('[data-section="recent"] .thread-row').first().click()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
  // Keep loading/reconnect duration from consuming the exact countdown values
  // asserted below; only explicit clock advances should spend this budget.
  await page.clock.install({ time: new Date('2026-10-09T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-09T00:01:00Z'))
  return page.evaluate(() => Date.now())
}

function request(mock: MockCodex, requestedAt: number, autoResolutionMs: number | null, patch: Record<string, unknown> = {}) {
  const message = {
    id: 'timed-question', method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-existing', turnId: 'question-turn', itemId: 'question-item',
      isBlocking: true, questions: [question], autoResolutionMs,
      bridgeUserInputContext: { requestedAt, autoResolveAt: autoResolutionMs === null ? null : requestedAt + autoResolutionMs },
      ...patch,
    },
  }
  mock.sockets.at(-1)!.send(JSON.stringify(message))
  return message
}

test('timed questions count down without selecting recommended answers or submitting on expiry', async ({ page, mock }) => {
  const requestedAt = await prepare(page)
  request(mock, requestedAt, 65_000)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card.getByRole('timer')).toHaveText('剩余 1 分 05 秒')
  await expect(card).toContainText('到时未提交的回答将跳过，Codex 可继续处理。')
  await expect(card.locator('input[type="radio"]:checked')).toHaveCount(0)
  await page.clock.fastForward(65_001)
  await expect(card.getByText('回答时限已到，等待服务器跳过…', { exact: true })).toBeVisible()
  await expect(card.getByRole('radio', { name: /当前项目/ })).toBeDisabled()
  await expect(card.getByRole('button', { name: '提交选择', exact: true })).toBeDisabled()
  expect(mock.responses.filter(response => response.id === 'timed-question')).toHaveLength(0)
})

test('a reconnected question retains its original absolute deadline instead of restarting the budget', async ({ page, mock }) => {
  const requestedAt = await prepare(page)
  const message = request(mock, requestedAt, 60_000)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card.getByRole('timer')).toHaveText('剩余 1 分 00 秒')
  await page.clock.fastForward(20_000)
  await page.reload()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
  mock.sockets.at(-1)!.send(JSON.stringify({ method: 'bridge/status', params: {
    connected: true, hostId: 'local', mode: 'spawn', pendingRequests: [message], clientId: 'fixture-client',
  } }))
  await expect(card.getByRole('timer')).toHaveText('剩余 40 秒')
  await page.clock.fastForward(40_001)
  await expect(card.getByRole('button', { name: '提交选择', exact: true })).toBeDisabled()
  await expect(card).toContainText('回答时限已到')
  expect(mock.responses.filter(response => response.id === 'timed-question')).toHaveLength(0)
})

test('untimed blocking and nonblocking questions remain available without a countdown', async ({ page, mock }) => {
  const requestedAt = await prepare(page)
  request(mock, requestedAt, null)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card).toContainText('等待你的回答后继续')
  await expect(card.getByRole('timer')).toHaveCount(0)
  await page.clock.fastForward(120_000)
  await expect(card.getByRole('radio', { name: /当前项目/ })).toBeEnabled()
  mock.emit('serverRequest/resolved', { requestId: 'timed-question' })
  await expect(card).toHaveCount(0)
  request(mock, requestedAt, null, { isBlocking: false })
  await expect(card).toContainText('Codex 可继续运行，回答后会补充给它')
  await expect(card.getByRole('timer')).toHaveCount(0)
})

test('only an explicit submission sends a selected answer before the deadline', async ({ page, mock }) => {
  const requestedAt = await prepare(page)
  request(mock, requestedAt, 60_000, { isBlocking: false })
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card).toContainText('Codex 可继续运行，请在时限内补充回答')
  await card.getByRole('radio', { name: /所有项目/ }).check()
  expect(mock.responses.filter(response => response.id === 'timed-question')).toHaveLength(0)
  await card.getByRole('button', { name: '提交选择', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(mock.responses.filter(response => response.id === 'timed-question')).toEqual([
    { id: 'timed-question', result: { answers: { scope: { answers: ['所有项目'] } } } },
  ])
})

test('an unsubmitted complete draft remains local on expiry until the server resolves the request', async ({ page, mock }) => {
  const requestedAt = await prepare(page)
  request(mock, requestedAt, 10_000)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await card.getByRole('radio', { name: /其他/ }).check()
  const answer = card.getByRole('textbox', { name: '执行范围：其他回答', exact: true })
  await answer.fill('这个草稿尚未确认')
  await expect(card.getByRole('button', { name: '提交选择', exact: true })).toBeEnabled()
  await page.clock.fastForward(10_001)
  await expect(answer).toBeDisabled()
  await expect(card).toContainText('未提交的回答不会发送')
  expect(mock.responses.filter(response => response.id === 'timed-question')).toHaveLength(0)
  mock.emit('serverRequest/resolved', { requestId: 'timed-question', threadId: 'thread-existing' })
  await expect(card).toHaveCount(0)
  await expect(page.locator('.choice-reminder')).toHaveCount(0)
  expect(mock.responses.filter(response => response.id === 'timed-question')).toHaveLength(0)
})

test('returning to the foreground checks the absolute deadline even when interval callbacks were suspended', async ({ page, mock }) => {
  const requestedAt = await prepare(page)
  request(mock, requestedAt, 10_000)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card.getByRole('timer')).toHaveText('剩余 10 秒')
  await page.clock.setSystemTime(requestedAt + 20_000)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(card).toContainText('回答时限已到')
  await expect(card.getByRole('radio', { name: /当前项目/ })).toBeDisabled()
  expect(mock.responses.filter(response => response.id === 'timed-question')).toHaveLength(0)
})

test('old servers get an upgrade hint without starting a new timer from the browser mount time', async ({ page, mock }) => {
  const requestedAt = await prepare(page)
  request(mock, requestedAt, 10_000, { bridgeUserInputContext: undefined })
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card).toContainText('请更新 Web 服务端以显示倒计时')
  await expect(card.getByRole('timer')).toHaveCount(0)
  await page.clock.fastForward(20_000)
  await expect(card.getByRole('radio', { name: /当前项目/ })).toBeEnabled()
  expect(mock.responses.filter(response => response.id === 'timed-question')).toHaveLength(0)
})

test('timed choice cards fit narrow mobile screens in dark mode', async ({ page, mock }) => {
  const requestedAt = await prepare(page)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  request(mock, requestedAt, 60_000)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card.getByRole('timer')).toBeVisible()
  expect(await card.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth
  })).toBe(true)
})
