import type { Page } from '@playwright/test'
import { test, expect, login, send, type MockCodex } from './fixtures'

const threadId = 'thread-existing'
const scope = { title: '此次处理什么范围？', options: ['当前项目（推荐）', '所有项目'] }

async function open(page: Page) {
  if (page.viewportSize()!.width < 700) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click()
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
}
function ask(mock: MockCodex, questions = [scope], id = 'async-choice', turnId = 'turn-history', text = '需要确认处理范围') {
  const item = { id, type: 'agentMessage', phase: 'commentary', delivery: 'async', text, questions }
  const turn = mock.turns.get(threadId)!.find(turn => turn.id === turnId)!
  turn.items.push(item)
  mock.emit('item/completed', { threadId, turnId, item })
  return item
}
function card(page: Page, id = 'async-choice') { return page.locator(`[data-async-question-id="${id}"]`) }
function replyEnvelope(itemId: string, answers: { question: string; answer: string }[]) {
  return `<send_user_message_question_reply>\n${JSON.stringify(answers.map((answer, index) => ({ questionItemId: JSON.stringify(['request_user_input_async', itemId, index]), ...answer })))}\n</send_user_message_question_reply>`
}

test('native asynchronous commentary produces visible choices and reminders without converting prose lists', async ({ page, mock }) => {
  await login(page); await open(page)
  mock.emit('item/completed', { threadId, turnId: 'turn-history', item: { id: 'plain-options', type: 'agentMessage', text: '选择执行范围？\n- 项目 A\n- 项目 B', phase: 'final_answer' } })
  await expect(page.locator('.async-question-card')).toHaveCount(0)
  ask(mock)
  const question = card(page)
  await expect(question).toBeVisible()
  await expect(question).toContainText(scope.title)
  await expect(question.locator('input:checked')).toHaveCount(0)
  await expect(question.getByRole('button', { name: '提交选择', exact: true })).toBeDisabled()
  await expect(question).not.toContainText('倒计时')
  expect(await question.evaluate(element => !element.closest('.turn-activity-content'))).toBe(true)
  await expect(page.locator('.choice-reminder')).toContainText('1 个问题等待你的选择')
  await expect(page).toHaveTitle(/1 待选择/)
  await page.locator('.choice-reminder').getByRole('button', { name: '查看问题' }).click()
  await expect(question).toBeInViewport()
})

test('an explicit async answer uses native reply input once and preserves the main composer draft', async ({ page, mock }) => {
  await login(page); await open(page); ask(mock)
  const composer = page.getByRole('textbox', { name: '消息输入框' })
  await composer.fill('这个草稿留给下一条独立指令')
  const question = card(page)
  await question.getByRole('radio', { name: /当前项目/ }).check()
  await question.getByRole('button', { name: '提交选择', exact: true }).evaluate(element => {
    ;(element as HTMLButtonElement).click(); (element as HTMLButtonElement).click()
  })
  await expect(question).toContainText('回答已发送')
  await expect(page.locator('.choice-reminder')).toHaveCount(0)
  await expect(page).not.toHaveTitle(/待选择/)
  await expect(composer).toHaveValue('这个草稿留给下一条独立指令')
  expect(mock.asyncAnswers).toHaveLength(1)
  expect(mock.asyncAnswers[0]).toMatchObject({ threadId, itemId: 'async-choice', body: { turnId: 'turn-history', answers: [scope.options[0]] } })
  const rawReply = mock.request('turn/start')?.params.input[0].text as string
  expect(rawReply).toMatch(/^<send_user_message_question_reply>[\s\S]+<\/send_user_message_question_reply>$/)
  expect(JSON.parse(rawReply.slice('<send_user_message_question_reply>'.length, -'</send_user_message_question_reply>'.length))).toEqual([
    { questionItemId: JSON.stringify(['request_user_input_async', 'async-choice', 0]), question: scope.title, answer: scope.options[0] },
  ])
  expect(mock.responses).toHaveLength(0)
  await expect(page.locator('.user-bubble').last()).toContainText(scope.options[0])
  await expect(page.locator('.user-bubble').last()).not.toContainText('send_user_message_question_reply')
  await expect(page.locator('.user-bubble').last()).not.toContainText('request_user_input_async')
})

test('multi-question async forms require every answer and support Other and free text without inventing timing', async ({ page, mock }) => {
  await login(page); await open(page)
  ask(mock, [scope, { title: '还有哪些约束？', options: null } as any], 'async-choice', 'turn-history', '')
  const question = card(page)
  await expect(question).toBeVisible()
  await expect(page.locator('.agent-message').filter({ has: question }).locator('.thinking-line')).toHaveCount(0)
  await question.getByRole('radio', { name: '其他', exact: true }).check()
  await question.getByRole('textbox', { name: `${scope.title}：其他回答`, exact: true }).fill('只检查两个子目录')
  await expect(question.getByRole('button', { name: '提交选择' })).toBeDisabled()
  await question.getByRole('textbox', { name: '还有哪些约束？', exact: true }).fill('保留所有训练进程')
  await expect(question).toContainText('已回答 2/2')
  await question.getByRole('button', { name: '提交选择' }).click()
  await expect(question).toContainText('回答已发送')
  expect(mock.asyncAnswers[0]?.body.answers).toEqual(['只检查两个子目录', '保留所有训练进程'])
})

test('a rejected async answer retains selection and typed text for an explicit retry', async ({ page, mock }) => {
  await login(page); await open(page); ask(mock)
  mock.failAsyncAnswerNext = true
  const question = card(page)
  await question.getByRole('radio', { name: '其他', exact: true }).check()
  const answer = question.getByRole('textbox', { name: `${scope.title}：其他回答`, exact: true })
  await answer.fill('按目录分批处理')
  await question.getByRole('button', { name: '提交选择' }).click()
  await expect(question.getByRole('alert')).toContainText('模拟回答被拒绝')
  await expect(answer).toHaveValue('按目录分批处理')
  await expect(question.getByRole('radio', { name: '其他', exact: true })).toBeChecked()
  await expect(question.getByRole('button', { name: '提交选择' })).toBeEnabled()
  await question.getByRole('button', { name: '提交选择' }).click()
  await expect(question).toContainText('回答已发送')
  expect(mock.asyncAnswers).toHaveLength(2)
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
})

test('an async answer during running work steers the existing turn without interrupting it', async ({ page, mock }) => {
  await login(page); await open(page)
  const turn = { id: 'async-running-turn', status: 'inProgress', items: [], startedAt: 1791200000, completedAt: null }
  mock.turns.get(threadId)!.push(turn)
  mock.emit('turn/started', { threadId, turn })
  ask(mock, [scope], 'async-choice', turn.id)
  const question = card(page)
  await question.getByRole('radio', { name: /所有项目/ }).check()
  await expect(question.getByRole('button', { name: '提交选择' })).toBeEnabled()
  await question.getByRole('button', { name: '提交选择' }).click()
  await expect(question).toContainText('回答已发送')
  expect(mock.request('turn/steer')?.params).toMatchObject({ threadId, expectedTurnId: turn.id })
  expect(mock.requests.filter(request => ['turn/start', 'turn/interrupt'].includes(request.method!))).toHaveLength(0)
})

test('answering from another browser removes the async reminder and refresh keeps the question answered', async ({ page, mock }) => {
  await login(page); await open(page); ask(mock)
  const answer = { id: 'another-browser-answer', type: 'userMessage', content: [{ type: 'text', text: replyEnvelope('async-choice', [{ question: scope.title, answer: '所有项目' }]) }] }
  mock.turns.get(threadId)![0].items.push(answer)
  mock.emit('item/completed', { threadId, turnId: 'turn-history', item: answer })
  await expect(card(page)).toContainText('回答已发送')
  await expect(page.locator('.choice-reminder')).toHaveCount(0)
  await page.reload()
  await expect(card(page)).toContainText('回答已发送')
  await expect(page.locator('.choice-reminder')).toHaveCount(0)
  expect(mock.asyncAnswers).toHaveLength(0)
})

test('async options and free input stay usable on narrow dark phone screens', async ({ page, mock }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await login(page); await open(page)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  ask(mock)
  const question = card(page)
  const first = question.getByRole('radio', { name: /当前项目/ })
  await first.focus(); await first.press('Space'); await expect(first).toBeChecked()
  await question.getByRole('radio', { name: '其他', exact: true }).check()
  const input = question.getByRole('textbox', { name: `${scope.title}：其他回答`, exact: true })
  await input.fill('手机填写的选择')
  expect(await input.evaluate(element => getComputedStyle(element).fontSize)).toBe('16px')
  expect(await question.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth
  })).toBe(true)
  expect(await question.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgb(255, 255, 255)')
  await expect(question.getByRole('button', { name: '提交选择' })).toBeEnabled()
  await page.screenshot({ path: '.data/async-question-mobile.png', fullPage: false })
})

test('old pending async forms retain their drafts when a large conversation scrolls away', async ({ page, mock }) => {
  const turns = mock.turns.get(threadId)!
  for (let index = 0; index < 90; index++) turns.push({ id: `long-turn-${index}`, status: 'completed', items: [
    { id: `long-user-${index}`, type: 'userMessage', content: [{ type: 'text', text: `历史消息 ${index}` }] },
    { id: `long-answer-${index}`, type: 'agentMessage', phase: 'final_answer', text: `历史回答 ${index}\n\n${'内容保持可读。'.repeat(30)}` },
  ] })
  await login(page)
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click()
  await expect(page.locator('.agent-message').filter({ hasText: '历史回答 89' })).toBeVisible()
  ask(mock)
  const question = card(page)
  await question.getByRole('radio', { name: '其他', exact: true }).check()
  const answer = question.getByRole('textbox', { name: `${scope.title}：其他回答`, exact: true })
  await answer.fill('滚动前的回答草稿')
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(answer).toHaveValue('滚动前的回答草稿')
  await page.locator('.choice-reminder').getByRole('button', { name: '查看问题' }).click()
  await expect(question).toBeInViewport()
  await expect(answer).toHaveValue('滚动前的回答草稿')
})

test('changed native question metadata resets an open selection instead of silently reusing its option index', async ({ page, mock }) => {
  await login(page); await open(page); ask(mock)
  const question = card(page)
  await question.getByRole('radio', { name: /当前项目/ }).check()
  mock.emit('item/completed', { threadId, turnId: 'turn-history', item: {
    id: 'async-choice', type: 'agentMessage', phase: 'commentary', delivery: 'async', text: '范围已更新',
    questions: [{ title: '请选择新的处理范围？', options: ['目录一', '目录二'] }],
  } })
  await expect(question).toContainText('请选择新的处理范围？')
  await expect(question.locator('input:checked')).toHaveCount(0)
  await expect(question.getByRole('button', { name: '提交选择' })).toBeDisabled()
  expect(mock.asyncAnswers).toHaveLength(0)
})

test('an uncertain async answer locks submission until synchronized native input confirms it', async ({ page, mock }) => {
  await login(page); await open(page); ask(mock)
  let submissions = 0
  await page.route('**/api/threads/*/*/async-questions/*/answer', async route => {
    submissions++
    await route.fulfill({ status: 409, json: { error: '发送结果待确认，请同步对话后检查', code: 'async_answer_uncertain' } })
  })
  const question = card(page)
  await question.getByRole('radio', { name: /当前项目/ }).check()
  await question.getByRole('button', { name: '提交选择' }).click()
  await expect(question).toContainText('发送结果待确认，请同步对话后检查')
  await expect(question.getByRole('button', { name: '提交选择' })).toBeDisabled()
  await expect(question.getByRole('radio', { name: /当前项目/ })).toBeDisabled()
  expect(submissions).toBe(1)
  const answer = { id: 'uncertain-accepted-answer', type: 'userMessage', content: [{ type: 'text', text: replyEnvelope('async-choice', [{ question: scope.title, answer: scope.options[0] }]) }] }
  mock.turns.get(threadId)![0].items.push(answer)
  mock.emit('item/completed', { threadId, turnId: 'turn-history', item: answer })
  await expect(question).toContainText('回答已发送')
  await expect(page.locator('.choice-reminder')).toHaveCount(0)
  expect(submissions).toBe(1)
})

test('a pending async choice in another conversation stays discoverable without answering in the current thread', async ({ page, mock }) => {
  mock.threads.push({ ...mock.threads[0], id: 'thread-second', name: '第二个问题测试对话' })
  mock.turns.set('thread-second', [{ id: 'second-turn', status: 'completed', items: [{ id: 'second-answer', type: 'agentMessage', text: '这是另一个独立对话' }] }])
  await login(page); await open(page); ask(mock)
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '第二个问题测试对话' }).first().click()
  await expect(page.getByText('这是另一个独立对话', { exact: true })).toBeVisible()
  await expect(page.locator('.choice-reminder')).toHaveCount(0)
  await expect(page).toHaveTitle(/1 待选择/)
  await expect(page.locator('.other-requests-banner')).toContainText('等待选择或确认')
  await page.locator('.other-requests-banner').click()
  const question = card(page)
  await expect(question).toBeVisible()
  await question.getByRole('radio', { name: /当前项目/ }).check()
  await question.getByRole('button', { name: '提交选择' }).click()
  await expect(question).toContainText('回答已发送')
  expect(mock.asyncAnswers[0]?.threadId).toBe(threadId)
  expect(mock.request('turn/start')?.params.threadId).toBe(threadId)
  await expect(page.locator('.other-requests-banner')).toHaveCount(0)
})

test('reloading an uncertain async answer restores its durable receipt and prevents duplicate submission', async ({ page, mock }) => {
  await login(page); await open(page); ask(mock)
  let submissions = 0
  await page.route('**/api/threads/*/*/async-questions/*/answer', async route => {
    submissions++
    await route.fulfill({ status: 409, json: { error: '回答可能已接收', code: 'async_answer_uncertain' } })
  })
  const question = card(page)
  await question.getByRole('radio', { name: /当前项目/ }).check()
  await question.getByRole('button', { name: '提交选择' }).click()
  await expect(question.getByRole('button', { name: '提交选择' })).toBeDisabled()
  await page.reload()
  await expect(card(page)).toContainText('发送结果待确认，请同步对话后检查')
  await expect(card(page).getByRole('button', { name: '提交选择' })).toBeDisabled()
  await expect(card(page).getByRole('radio', { name: /当前项目/ })).toBeDisabled()
  expect(submissions).toBe(1)
  expect(mock.requests.filter(request => ['turn/start', 'turn/steer'].includes(request.method!))).toHaveLength(0)
})

test('a durable receipt write failure keeps the selected answer and does not dispatch an async answer', async ({ page, mock }) => {
  await login(page); await open(page); ask(mock)
  const question = card(page)
  await question.getByRole('radio', { name: '其他', exact: true }).check()
  const answer = question.getByRole('textbox', { name: `${scope.title}：其他回答`, exact: true })
  await answer.fill('即使存储失败也保留这一条回答')
  await page.evaluate(() => {
    const nativePut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'records' && typeof value?.key === 'string' && value.key.includes('async-question-answer')) {
        this.transaction.abort()
        return {} as IDBRequest<IDBValidKey>
      }
      return nativePut.call(this, value, key)
    }
  })
  await question.getByRole('button', { name: '提交选择' }).click()
  await expect(question.getByRole('alert')).toContainText('存储')
  await expect(answer).toHaveValue('即使存储失败也保留这一条回答')
  await expect(question.getByRole('radio', { name: '其他', exact: true })).toBeChecked()
  await expect(question.getByRole('button', { name: '提交选择' })).toBeEnabled()
  expect(mock.asyncAnswers).toHaveLength(0)
  expect(mock.requests.filter(request => ['turn/start', 'turn/steer'].includes(request.method!))).toHaveLength(0)
})

test('an unreadable private receipt cannot result in sending an unverified async answer', async ({ page, mock }) => {
  await login(page); await open(page)
  await page.evaluate(() => {
    const nativeGet = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'records' && typeof key === 'string' && key.includes('async-question-answer'))
        throw new DOMException('Mock private receipt read denied', 'SecurityError')
      return nativeGet.call(this, key)
    }
  })
  ask(mock)
  const question = card(page)
  await expect(question).toContainText('发送结果待确认，请同步对话后检查')
  await expect(question.getByRole('radio', { name: /当前项目/ })).toBeDisabled()
  await expect(question.getByRole('button', { name: '提交选择' })).toBeDisabled()
  expect(mock.asyncAnswers).toHaveLength(0)
  expect(mock.requests.filter(request => ['turn/start', 'turn/steer'].includes(request.method!))).toHaveLength(0)
})

test('restored private receipt reads allow a synchronized unanswered form to submit exactly once', async ({ page, mock }) => {
  await login(page); await open(page)
  await page.evaluate(() => {
    const nativeGet = IDBObjectStore.prototype.get
    const state = window as unknown as { failQuestionReceiptRead: boolean }
    state.failQuestionReceiptRead = true
    IDBObjectStore.prototype.get = function (key) {
      if (state.failQuestionReceiptRead && this.name === 'records' && typeof key === 'string' && key.includes('async-question-answer'))
        throw new DOMException('Mock private receipt read denied', 'SecurityError')
      return nativeGet.call(this, key)
    }
  })
  ask(mock)
  await expect(card(page).getByRole('radio', { name: /当前项目/ })).toBeDisabled()
  expect(mock.asyncAnswers).toHaveLength(0)
  await page.evaluate(() => { (window as unknown as { failQuestionReceiptRead: boolean }).failQuestionReceiptRead = false })
  const resumes = mock.requests.filter(request => request.method === 'thread/read' || request.method === 'thread/resume').length
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click()
  await expect.poll(() => mock.requests.filter(request => request.method === 'thread/read' || request.method === 'thread/resume').length).toBeGreaterThan(resumes)
  await expect(card(page)).not.toContainText('发送结果待确认')
  await expect(card(page).getByRole('radio', { name: /当前项目/ })).toBeEnabled()
  await card(page).getByRole('radio', { name: /当前项目/ }).check()
  await card(page).getByRole('button', { name: '提交选择' }).click()
  await expect(card(page)).toContainText('回答已发送')
  expect(mock.asyncAnswers).toHaveLength(1)
  expect(mock.request('turn/start')?.params.threadId).toBe(threadId)
})

test('reload reconciles an uncertain async reply through read-only status when summary history omits its input', async ({ page, mock }) => {
  await login(page); await open(page); ask(mock)
  let submissions = 0
  await page.route('**/api/threads/*/*/async-questions/*/answer', async route => {
    submissions++
    await route.fulfill({ status: 409, json: { error: '回答可能已接收', code: 'async_answer_uncertain' } })
  })
  await card(page).getByRole('radio', { name: /当前项目/ }).check()
  await card(page).getByRole('button', { name: '提交选择' }).click()
  await expect(card(page).getByRole('button', { name: '提交选择' })).toBeDisabled()
  // The native steering input is intentionally absent from the summary page;
  // the targeted read confirms it without ever resending the answer.
  mock.asyncStatusOverride = true
  await page.reload()
  await expect(card(page)).toContainText('回答已发送')
  await expect(page.locator('.choice-reminder')).toHaveCount(0)
  expect(mock.asyncStatusRequests).toContainEqual({ hostId: 'local', threadId, itemId: 'async-choice', turnId: 'turn-history' })
  expect(submissions).toBe(1)
  expect(mock.requests.filter(request => ['turn/start', 'turn/steer'].includes(request.method!))).toHaveLength(0)
})

test('an accepted async HTTP acknowledgement arriving after completion does not revive the old running turn', async ({ page, mock }) => {
  await login(page); await open(page)
  const item = ask(mock)
  let accept: (() => Promise<void>) | undefined
  const turn = { id: 'late-http-turn', status: 'inProgress', items: [], startedAt: 1791200000, completedAt: null }
  await page.route('**/api/threads/*/*/async-questions/*/answer', async route => {
    const input = [{ type: 'text', text: replyEnvelope(item.id, [{ question: scope.title, answer: scope.options[0] }]), text_elements: [] }]
    accept = () => route.fulfill({ json: { accepted: true, input, clientUserMessageId: 'late-http-user', turn } })
    mock.emit('turn/started', { threadId, turn })
  })
  await card(page).getByRole('radio', { name: /当前项目/ }).check()
  await card(page).getByRole('button', { name: '提交选择' }).click()
  await expect.poll(() => !!accept).toBe(true)
  await expect(page.getByRole('button', { name: /停止|暂停/ }).first()).toBeVisible()
  mock.emit('turn/completed', { threadId, turn: { ...turn, status: 'completed', completedAt: 1791200001, durationMs: 1000 } })
  await accept!()
  await expect(card(page)).toContainText('回答已发送')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  const block = page.locator('[data-turn-id="late-http-turn"]')
  await expect(block).not.toContainText('正在处理…')
})

test('a delayed async HTTP acknowledgement cannot replace the current next turn when Stop is pressed', async ({ page, mock }) => {
  await login(page); await open(page)
  const item = ask(mock)
  let accept: (() => Promise<void>) | undefined
  const old = { id: 'old-http-turn', status: 'inProgress', items: [], startedAt: 1791200000, completedAt: null }
  const next = { id: 'next-live-turn', status: 'inProgress', items: [], startedAt: 1791200002, completedAt: null }
  await page.route('**/api/threads/*/*/async-questions/*/answer', async route => {
    const input = [{ type: 'text', text: replyEnvelope(item.id, [{ question: scope.title, answer: scope.options[0] }]), text_elements: [] }]
    accept = () => route.fulfill({ json: { accepted: true, input, clientUserMessageId: 'late-next-user', turn: old } })
    mock.emit('turn/started', { threadId, turn: old })
  })
  await card(page).getByRole('radio', { name: /当前项目/ }).check()
  await card(page).getByRole('button', { name: '提交选择' }).click()
  await expect.poll(() => !!accept).toBe(true)
  mock.emit('turn/completed', { threadId, turn: { ...old, status: 'completed', completedAt: 1791200001 } })
  mock.turns.get(threadId)!.push(next)
  mock.emit('turn/started', { threadId, turn: next })
  await accept!()
  await expect(card(page)).toContainText('回答已发送')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect.poll(() => mock.request('turn/interrupt')?.params.turnId).toBe(next.id)
})
