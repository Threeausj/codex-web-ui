import { test, expect, login, setComposerSelection, readComposerSource, type MockCodex } from './fixtures'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

/** Native capability and mode responses only; never reach a user's runtime. */
function modesWire(mock: MockCodex, supported = true) {
  const original = (mock as any).receive.bind(mock)
  const control = { holdModeUpdate: false, releaseModeUpdate: undefined as (() => void) | undefined }
  let goal: any = null
  ;(mock as any).receive = (socket: any, request: any) => {
    const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }))
    const unsupported = () => socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Method not found' } }))
    switch (request.method) {
      case 'collaborationMode/list':
        mock.requests.push(request)
        return reply({ data: supported ? [{ mode: 'default', name: 'Default' }, { mode: 'plan', name: 'Plan' }] : [{ mode: 'default', name: 'Default' }] })
      case 'thread/goal/get':
        mock.requests.push(request)
        return supported ? reply({ goal }) : unsupported()
      case 'thread/goal/set':
        mock.requests.push(request)
        goal = { threadId: request.params.threadId, objective: request.params.objective || goal?.objective || '',
          status: request.params.status || 'active', tokenBudget: request.params.tokenBudget ?? null,
          tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1791200000, updatedAt: 1791200001 }
        return reply({ goal })
      case 'fuzzyFileSearch':
        // This test explicitly filters to a mode token. The generic fixture
        // always returns README, even for 'plan', so a delayed search could
        // select an unrelated file instead of exercising disabled modes.
        if (['plan', 'goal'].includes(request.params.query)) { mock.requests.push(request); return reply({ files: [] }) }
        return original(socket, request)
      case 'thread/settings/update':
        mock.requests.push(request)
        if (control.holdModeUpdate) { control.releaseModeUpdate = () => reply({}); return }
        return reply({})
      default: return original(socket, request)
    }
  }
  return control
}

const option = (page: any, name: string) => page.getByRole('listbox', { name: '模式与项目文件' }).getByRole('option').filter({ hasText: name })

test('mobile taps select Plan, Goal and Default without a hardware keyboard or submitting the draft', async ({ page, mock }) => {
  modesWire(mock)
  await login(page)
  const input = page.getByRole('textbox', { name: '消息输入框' })
  await input.fill('保留尚未发送的手机草稿 ')
  await page.getByRole('button', { name: '选择模式或引用项目文件', exact: true }).tap()
  await option(page, 'Plan 模式').tap()
  await expect(page.locator('.mode-token')).toContainText('Plan 模式')
  await expect(input).toHaveValue('保留尚未发送的手机草稿 ')
  await expect(input).toBeFocused()
  await page.getByRole('button', { name: '选择模式或引用项目文件', exact: true }).tap()
  await option(page, 'Goal 模式').tap()
  await expect(page.locator('.mode-token')).toContainText('Goal 模式')
  await expect(input).toHaveValue('保留尚未发送的手机草稿 ')
  await page.getByRole('button', { name: '选择模式或引用项目文件', exact: true }).tap()
  await option(page, '默认模式').tap()
  await expect(page.locator('.mode-token')).toHaveCount(0)
  await expect(input).toHaveValue('保留尚未发送的手机草稿 ')
  expect(mock.request('turn/start')).toBeUndefined()
  expect(mock.request('thread/goal/set')).toBeUndefined()
})

test('a soft keyboard leaves the mode menu scrollable and touch-selectable while preserving input focus', async ({ page, mock }) => {
  modesWire(mock)
  await login(page)
  const input = page.getByRole('textbox', { name: '消息输入框' })
  await input.fill('触摸选择时保持键盘和草稿 ')
  await input.tap()
  await page.setViewportSize({ width: 390, height: 430 })
  await page.getByRole('button', { name: '选择模式或引用项目文件', exact: true }).tap()
  const picker = page.getByRole('listbox', { name: '模式与项目文件' })
  await expect(picker).toBeVisible()
  await expect(picker.locator('.picker-touch-hint')).toBeVisible()
  await expect(picker.locator('.picker-keyboard-hint')).not.toBeVisible()
  const bounds = await picker.boundingBox()
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await option(page, 'Goal 模式').tap()
  await expect(page.locator('.mode-token')).toContainText('Goal 模式')
  await expect(input).toHaveValue('触摸选择时保持键盘和草稿 ')
  await expect(input).toBeFocused()
  expect(mock.request('turn/start')).toBeUndefined()
})

test('a delayed native mode response removes the original picker token after a mobile caret movement', async ({ page, mock }) => {
  const control = modesWire(mock)
  await login(page)
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).tap()
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: '已有测试历史' }).first().tap()
  const input = page.getByRole('textbox', { name: '消息输入框' })
  await expect(input).toBeEnabled()
  await input.fill('请用 @plan 修改代码')
  await setComposerSelection(input, 8)
  control.holdModeUpdate = true
  await option(page, 'Plan 模式').tap()
  await expect.poll(() => typeof control.releaseModeUpdate).toBe('function')
  await setComposerSelection(input, (await readComposerSource(input)).length)
  control.releaseModeUpdate?.()
  await expect(input).toHaveValue('请用  修改代码')
  await expect(page.locator('.mode-token')).toContainText('Plan 模式')
  expect(mock.request('turn/start')).toBeUndefined()
})

test('mobile mode menu can close by touch without discarding a typed draft', async ({ page, mock }) => {
  modesWire(mock)
  await login(page)
  const input = page.getByRole('textbox', { name: '消息输入框' })
  await input.fill('关闭菜单也保留草稿 @')
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.getByRole('button', { name: '关闭选择菜单', exact: true }).tap()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(input).toHaveValue('关闭菜单也保留草稿 @')
  await expect(input).toBeFocused()
  expect(mock.request('thread/settings/update')).toBeUndefined()
})

test('busy mobile tasks apply the same mode restriction to tapping and keyboard confirmation and unlock after completion', async ({ page, mock }) => {
  modesWire(mock)
  mock.holdFinalMessage = true
  await login(page)
  const input = page.getByRole('textbox', { name: '消息输入框' })
  await input.fill('正在运行的任务')
  await page.getByRole('button', { name: '发送消息', exact: true }).tap()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await input.fill('继续保留草稿 ')
  await page.getByRole('button', { name: '选择模式或引用项目文件', exact: true }).tap()
  for (const name of ['默认模式', 'Plan 模式', 'Goal 模式']) await expect(option(page, name)).toBeDisabled()
  await expect(page.getByRole('listbox')).toContainText('任务运行中，结束或停止后切换')
  const plan = await option(page, 'Plan 模式').boundingBox()
  await page.touchscreen.tap(plan!.x + plan!.width / 2, plan!.y + plan!.height / 2)
  // Filter out file rows before testing Enter; files remain valid during a turn.
  await input.fill('继续保留草稿 @plan')
  await input.press('ArrowDown')
  await input.press('Enter')
  expect(mock.request('thread/settings/update')).toBeUndefined()
  expect(mock.request('thread/goal/set')).toBeUndefined()
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
  mock.finishStream()
  await expect(option(page, 'Plan 模式')).toBeEnabled()
  await option(page, 'Plan 模式').tap()
  await expect(page.locator('.mode-token')).toContainText('Plan 模式')
  await expect(input).toHaveValue('继续保留草稿 ')
  expect(mock.request('thread/settings/update')?.params.collaborationMode.mode).toBe('plan')
})

test('unsupported native modes remain unavailable on touch while Default and file references stay usable', async ({ page, mock }) => {
  modesWire(mock, false)
  await login(page)
  await page.getByRole('button', { name: '选择模式或引用项目文件', exact: true }).tap()
  await expect(option(page, 'Plan 模式')).toBeDisabled()
  await expect(option(page, 'Goal 模式')).toBeDisabled()
  await expect(page.getByRole('listbox')).toContainText('当前 Codex 版本未提供 Plan 模式')
  await expect(page.getByRole('listbox')).toContainText('当前 Codex 版本未提供 Goal 模式')
  await expect(option(page, '默认模式')).toBeEnabled()
  await expect(option(page, 'README.md')).toBeEnabled()
  await option(page, '默认模式').tap()
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('')
  expect(mock.request('thread/settings/update')).toBeUndefined()
  expect(mock.request('thread/goal/set')).toBeUndefined()
})
