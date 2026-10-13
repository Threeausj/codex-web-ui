import type { Page } from '@playwright/test'
import { test, expect, login, MockCodex } from './fixtures'

const remoteId = 'metadata-race-remote'
async function nativeMetadataFixture(page: Page, mock: MockCodex) {
  const remote = new MockCodex()
  remote.config.model = 'remote-specific-model'
  mock.hosts.push({ id: remoteId, kind: 'ssh', name: 'Metadata Remote', hostname: 'fixture.invalid' })
  mock.hostMocks.set(remoteId, remote)
  let engine = 'metadata-before', reconnected = false, configReads = 0
  let held: (() => void) | undefined
  const receive = (mock as any).receive.bind(mock)
  ;(mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'bridge/ping') {
      mock.requests.push(request)
      socket.send(JSON.stringify({ id: request.id, result: { connected: true, paused: false, engineId: engine, loadedThreadIds: [], eventSequence: 0 } }))
      return
    }
    if (reconnected && request.method === 'config/read' && ++configReads === 2) {
      mock.requests.push(request)
      // Snapshot before releasing this response: a different host's settings
      // must never inherit this old response's model or reasoning default.
      const config = { ...mock.config, model_reasoning_effort: 'medium' }
      held = () => { try { socket.send(JSON.stringify({ id: request.id, result: { config, layers: [], origins: {} } })) } catch { /* A logged-out socket is already closed. */ } }
      return
    }
    receive(socket, request)
  }
  await page.route('**/api/hosts/local/runtime/information*', route => route.fulfill({ json: {
    checkedAt: Date.now(), runtime: { connected: true, paused: false, managed: true, engineId: engine },
    models: ['mock-model-a', 'mock-model-b'].map(model => ({ id: model, model, hidden: false })),
    config: { model: mock.config.model, model_context_window: 500000 }, canReconnect: true,
  } }))
  await page.route('**/api/hosts/local/runtime/reconnect', route => {
    reconnected = true; engine = 'metadata-after'
    mock.emit('bridge/status', { connected: true, paused: false, engineId: engine, pendingRequests: [], eventSequence: 0 })
    return route.fulfill({ json: { ok: true, runtime: { connected: true, paused: false, engineId: engine } } })
  })
  await login(page)
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]').filter({ hasText: '已有测试历史' }).locator('.thread-row').click()
  await expect(page.locator('.agent-message')).toContainText('历史保持可读')
  mock.emit('bridge/status', { connected: true, paused: false, engineId: engine, pendingRequests: [], eventSequence: 0 })
  await page.getByRole('combobox', { name: '选择模型', exact: true }).selectOption('mock-model-b')
  await page.getByRole('combobox', { name: '推理强度', exact: true }).selectOption('high')
  await page.getByRole('combobox', { name: '选择权限', exact: true }).selectOption('read-only')
  await page.evaluate(async () => {
    const modulePath = '/src/lib/useCodex.ts'
    const { useCodex } = await import(modulePath)
    const api = useCodex()
    ;(window as any).metadataApi = api
    ;(window as any).metadataOutcome = null
    void api.reconnectRuntime('local').then(
      () => { (window as any).metadataOutcome = 'success' },
      (error: Error) => { (window as any).metadataOutcome = error.message },
    )
  })
  return { remote, waitForHeld: () => expect.poll(async () => {
    const outcome = await page.evaluate(() => (window as any).metadataOutcome)
    if (outcome !== null) throw new Error(`Metadata fixture completed before its held read: ${outcome}; config reads: ${configReads}`)
    return !!held
  }).toBe(true), release: () => { held?.(); held = undefined } }
}

test('a reconnect metadata response arriving after a host switch cannot restore the previous host choices or models', async ({ page, mock }) => {
  const fixture = await nativeMetadataFixture(page, mock)
  await fixture.waitForHeld()
  await page.evaluate(async id => {
    const api = (window as any).metadataApi
    await api.setHost(id)
    api.state.model = 'remote-specific-model'; api.state.effort = 'medium'; api.state.permission = 'workspace-write'
  }, remoteId)
  fixture.release()
  await expect.poll(() => page.evaluate(() => (window as any).metadataOutcome)).toBe('success')
  expect(await page.evaluate(() => {
    const state = (window as any).metadataApi.state
    return { hostId: state.hostId, model: state.model, effort: state.effort, permission: state.permission }
  })).toEqual({ hostId: remoteId, model: 'remote-specific-model', effort: 'medium', permission: 'workspace-write' })
})

test('a reconnect metadata response arriving after selecting another thread does not overwrite its choices', async ({ page, mock }) => {
  const fixture = await nativeMetadataFixture(page, mock)
  await fixture.waitForHeld()
  mock.threads.push({ ...mock.threads[0]!, id: 'metadata-other-thread', name: '另一个会话', preview: '另一个会话' })
  mock.turns.set('metadata-other-thread', [])
  await page.evaluate(() => {
    const api = (window as any).metadataApi
    ;(window as any).metadataSwitch = api.selectThread('metadata-other-thread')
    api.state.model = 'mock-model-a'; api.state.effort = 'medium'; api.state.permission = 'workspace-write'
  })
  fixture.release()
  await page.evaluate(() => (window as any).metadataSwitch)
  await expect.poll(() => page.evaluate(() => (window as any).metadataOutcome)).toBe('success')
  expect(await page.evaluate(() => {
    const state = (window as any).metadataApi.state
    return { threadId: state.activeThread.id, model: state.model, effort: state.effort, permission: state.permission }
  })).toEqual({ threadId: 'metadata-other-thread', model: 'mock-model-a', effort: 'medium', permission: 'workspace-write' })
})

test('logging out while a reconnect metadata read is pending rejects that operation and leaves private state cleared', async ({ page, mock }) => {
  const fixture = await nativeMetadataFixture(page, mock)
  await fixture.waitForHeld()
  await page.evaluate(() => (window as any).metadataApi.logout())
  fixture.release()
  await expect.poll(() => page.evaluate(() => (window as any).metadataOutcome)).not.toBeNull()
  expect(await page.evaluate(() => {
    const state = (window as any).metadataApi.state
    return { authenticated: state.authenticated, activeThread: state.activeThread, items: state.items, runtimeInformation: state.runtimeInformation }
  })).toEqual({ authenticated: false, activeThread: null, items: [], runtimeInformation: {} })
  expect(await page.evaluate(() => (window as any).metadataOutcome)).not.toBe('success')
})
