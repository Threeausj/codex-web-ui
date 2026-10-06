import { test, expect, login, send, type MockCodex } from './fixtures'

function ask(mock: MockCodex, threadId: string, id = 'reminder-choice') {
  for (const socket of mock.sockets) socket.send(JSON.stringify({
    id, method: 'item/tool/requestUserInput', params: {
      threadId, turnId: 'choice-turn', itemId: 'choice-item', isBlocking: false,
      questions: [{ id: 'choice', header: '范围', question: '选择哪种范围？', isOther: false, isSecret: false,
        options: [{ label: '当前项目', description: '只处理当前工作区。' }, { label: '全部项目', description: '包含其他项目。' }] }],
    },
  }))
}

test('an unanswered choice stays visible above the conversation and clears its page-title reminder after submission', async ({ page, mock }) => {
  await login(page)
  await send(page, '产生选择请求')
  await expect(page.locator('.agent-message')).toContainText('流式回复完成')
  const threadId = mock.request('turn/start')!.params.threadId
  ask(mock, threadId)
  ask(mock, threadId)
  const banner = page.locator('.choice-reminder')
  await expect(banner).toContainText('1 个问题等待你的选择')
  await expect(page).toHaveTitle(/1 待选择/)
  await banner.getByRole('button', { name: '查看问题', exact: true }).click()
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card).toBeInViewport()
  await card.getByRole('radio', { name: /当前项目/ }).check()
  await card.getByRole('button', { name: '提交选择', exact: true }).click()
  await expect(banner).toHaveCount(0)
  await expect(page).not.toHaveTitle(/待选择/)
  expect(mock.responses.filter(response => response.id === 'reminder-choice')).toHaveLength(1)
})

test('a choice in another conversation can be reached from its reminder without responding on the wrong thread', async ({ page, mock }) => {
  await login(page)
  await send(page, '当前对话暂时不需要选择')
  await expect(page.locator('.agent-message')).toContainText('流式回复完成')
  ask(mock, 'thread-existing')
  await expect(page.locator('.choice-reminder')).toHaveCount(0)
  await expect(page).toHaveTitle(/待选择/)
  const banner = page.locator('.other-requests-banner')
  await expect(banner).toContainText('等待选择或确认')
  await banner.click()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
  await expect(page.locator('.choice-reminder')).toContainText('1 个问题等待你的选择')
  await page.getByRole('region', { name: 'Codex 需要你的选择' }).getByRole('radio', { name: /当前项目/ }).check()
  await page.getByRole('button', { name: '提交选择', exact: true }).click()
  expect(mock.responses.find(response => response.id === 'reminder-choice')?.result).toEqual({ answers: { choice: { answers: ['当前项目'] } } })
})

test('a server-resolved or expired choice clears the reminder without sending an answer', async ({ page, mock }) => {
  await login(page)
  await page.locator('[data-section="recent"] .thread-row').first().click()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
  ask(mock, 'thread-existing')
  await expect(page.locator('.choice-reminder')).toBeVisible()
  mock.emit('serverRequest/resolved', { threadId: 'thread-existing', requestId: 'reminder-choice' })
  await expect(page.locator('.choice-reminder')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Codex 需要你的选择' })).toHaveCount(0)
  await expect(page).not.toHaveTitle(/待选择/)
  expect(mock.responses).toHaveLength(0)
})
