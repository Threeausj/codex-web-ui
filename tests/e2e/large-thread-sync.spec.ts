import { test, expect, login, type MockCodex } from './fixtures'
import type { Page } from '@playwright/test'

const threadId = 'thread-existing'
async function installBridge(page: Page, mock: MockCodex, options: { replay?: boolean; loaded?: boolean } = {}) {
  let sequence = 0
  const events: any[] = []
  const receive = (mock as any).receive.bind(mock)
  const control = { holdHistory: false, held: [] as (() => void)[] }
  const engineId = 'large-history-engine'
  await page.routeWebSocket(/\/api\/rpc(?:\?|$)/, socket => {
    mock.sockets.push(socket)
    const cursor = Number(new URL(socket.url()).searchParams.get('afterSequence') ?? -1)
    const replay = options.replay === true && cursor >= 0
    if (replay) for (const message of events) if (message.bridgeEventSequence > cursor) socket.send(JSON.stringify(message))
    socket.onMessage(raw => {
      const request = JSON.parse(raw.toString())
      if (request.method === 'bridge/ping') {
        mock.requests.push(request)
        socket.send(JSON.stringify({ id: request.id, result: { connected: true, engineId, eventSequence: sequence,
          loadedThreadIds: options.loaded === false ? [] : [threadId] } }))
      } else if (request.method === 'thread/turns/list' && control.holdHistory) {
        mock.requests.push(request)
        control.held.push(() => socket.send(JSON.stringify({ id: request.id, result: {
          data: [...mock.turns.get(threadId)!].reverse(), nextCursor: null,
        } })))
      } else receive(socket, request)
    })
    socket.send(JSON.stringify({ method: 'bridge/status', params: { connected: true, engineId, eventSequence: sequence,
      replayComplete: replay, pendingRequests: [] } }))
  })
  return { control, miss(message: any) { events.push({ ...message, bridgeEventSequence: ++sequence }) } }
}
async function open(page: Page) {
  await login(page)
  await page.locator('[data-section="recent"] .thread-row').first().click()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
}

test('complete replay rejoins a large conversation without downloading its 16 MiB history again', async ({ page, mock }) => {
  mock.turns.get(threadId)![0].items.push({ id: 'large-tool-output', type: 'commandExecution', command: 'history fixture',
    aggregatedOutput: 'x'.repeat(16 * 1024 * 1024), status: 'completed', exitCode: 0 })
  const bridge = await installBridge(page, mock, { replay: true })
  await open(page)
  const histories = mock.requests.filter(request => request.method === 'thread/turns/list').length
  const resumes = mock.requests.filter(request => request.method === 'thread/resume').length
  const draft = page.getByRole('textbox', { name: '消息输入框' })
  await draft.fill('大对话重连保留草稿')
  await mock.sockets[0]!.close({ code: 1006, reason: 'Fixture disconnect' })
  bridge.miss({ method: 'item/completed', params: { threadId, turnId: mock.turns.get(threadId)![0].id,
    item: { id: 'missed-live-answer', type: 'agentMessage', text: '事件补齐后的最新消息' } } })
  await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2)
  await expect(page.getByText('事件补齐后的最新消息', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
  expect(mock.requests.filter(request => request.method === 'thread/turns/list')).toHaveLength(histories)
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(resumes)
  await expect(draft).toHaveValue('大对话重连保留草稿')
  expect(mock.request('turn/start')).toBeUndefined()
  expect(mock.request('turn/steer')).toBeUndefined()
})

test('an unavailable replay reads fresh history once while retaining the original native writer', async ({ page, mock }) => {
  await installBridge(page, mock)
  await open(page)
  const histories = mock.requests.filter(request => request.method === 'thread/turns/list').length
  const resumes = mock.requests.filter(request => request.method === 'thread/resume').length
  mock.turns.get(threadId)!.push({ id: 'missed-history-turn', status: 'completed', items: [
    { id: 'missed-history-answer', type: 'agentMessage', text: '补齐窗口之外的历史' },
  ] })
  await mock.sockets[0]!.close({ code: 1006, reason: 'Fixture disconnect' })
  await expect(page.getByText('补齐窗口之外的历史', { exact: true })).toBeVisible({ timeout: 12000 })
  expect(mock.requests.filter(request => request.method === 'thread/turns/list')).toHaveLength(histories + 1)
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(resumes)
  expect(mock.request('turn/start')).toBeUndefined()
})

test('complete event replay cannot certify a writer that the bridge has already released', async ({ page, mock }) => {
  await installBridge(page, mock, { replay: true, loaded: false })
  await open(page)
  const resumes = mock.requests.filter(request => request.method === 'thread/resume').length
  await mock.sockets[0]!.close({ code: 1006, reason: 'Fixture disconnect' })
  await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2)
  await expect.poll(() => mock.requests.filter(request => request.method === 'thread/resume').length).toBe(resumes + 1)
  expect(mock.request('turn/start')).toBeUndefined()
})

test('repeated selection shares one outstanding history read and a dropped old read cannot leave a stale error', async ({ page, mock }) => {
  const bridge = await installBridge(page, mock)
  await open(page)
  const before = mock.requests.filter(request => request.method === 'thread/turns/list').length
  bridge.control.holdHistory = true
  const row = page.locator('[data-section="recent"] .thread-row').first()
  await row.click(); await expect.poll(() => bridge.control.held.length).toBe(1)
  await row.click(); await row.click()
  expect(bridge.control.held).toHaveLength(1)
  bridge.control.holdHistory = false
  await mock.sockets[0]!.close({ code: 1006, reason: 'Fixture disconnect during history read' })
  await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2)
  await page.getByRole('textbox', { name: '消息输入框' }).fill('恢复后直接继续')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
  await expect(page.getByText(/连接已断开，服务端可能已接收/)).toHaveCount(0)
  expect(mock.requests.filter(request => request.method === 'thread/turns/list')).toHaveLength(before + 2)
  expect(mock.request('turn/start')).toBeUndefined()
})

test('a lost mutation response still confirms native history even when missed events were completely replayed', async ({ page, mock }) => {
  await installBridge(page, mock, { replay: true })
  await open(page)
  mock.holdTurnStartResponse = true
  await page.getByRole('textbox', { name: '消息输入框' }).fill('仅提交一次的断线请求')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(1)
  const historiesBeforeDisconnect = mock.requests.filter(request => request.method === 'thread/turns/list').length
  await mock.sockets[0]!.close({ code: 1006, reason: 'Lost accepted response' })
  await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2)
  await expect.poll(() => mock.requests.filter(request => request.method === 'thread/turns/list').length).toBe(historiesBeforeDisconnect + 1)
  await expect(page.getByText('仅提交一次的断线请求', { exact: true })).toHaveCount(1)
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
  expect(mock.request('turn/steer')).toBeUndefined()
})

test('a revert replayed before connected status waits for fresh history instead of certifying an empty view', async ({ page, mock }) => {
  const removed = { id: 'replayed-reverted-turn', status: 'completed', items: [
    { id: 'replayed-reverted-answer', type: 'agentMessage', text: '断线期间应移除的旧回复' },
  ] }
  mock.turns.get(threadId)!.push(removed)
  const bridge = await installBridge(page, mock, { replay: true })
  await open(page)
  await expect(page.getByText('断线期间应移除的旧回复', { exact: true })).toBeVisible()
  const input = page.getByRole('textbox', { name: '消息输入框' })
  await input.fill('回退同步前不能发送')
  await mock.sockets[0]!.close({ code: 1006, reason: 'Fixture disconnect before remote revert' })
  mock.turns.set(threadId, mock.turns.get(threadId)!.filter(turn => turn.id !== removed.id))
  bridge.control.holdHistory = true
  bridge.miss({ method: 'thread/reverted', params: { threadId } })
  bridge.miss({ method: 'bridge/thread/changed', params: { threadId, method: 'thread/revert', changeId: 'remote-revert',
    result: { thread: { ...mock.threads[0], turns: [] } }, request: { beforeTurnId: removed.id } } })
  await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2)
  await expect.poll(() => bridge.control.held.length).toBe(1)
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
  bridge.control.held[0]!()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
  await expect(page.getByText('断线期间应移除的旧回复', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
  await expect(input).toHaveValue('回退同步前不能发送')
  expect(mock.request('turn/start')).toBeUndefined()
})
