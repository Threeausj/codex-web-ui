import type { Page } from '@playwright/test'
import type { ToolRequestUserInputQuestion } from '../../shared/protocol/v2/ToolRequestUserInputQuestion'
import { test, expect, login, send, type MockCodex } from './fixtures'

const split: ToolRequestUserInputQuestion = {
  id: 'split', header: '划分单位', question: 'V5.5 的随机划分按什么单位进行？', isOther: true, isSecret: false,
  options: [
    { label: '按患者随机分组（推荐）', description: '同一患者的所有 MRI 留在同一集合。' },
    { label: '按图像随机划分', description: '图像数严格按比例分配，同一患者可能跨集合。' },
  ],
}

async function prepare(page: Page, mock: MockCodex) {
  await login(page)
  await send(page, '请确认随机划分方式')
  await expect(page.locator('.agent-message')).toContainText('流式回复完成')
  return mock.request('turn/start')!.params.threadId as string
}

function choiceRequest(mock: MockCodex, threadId: string, questions: ToolRequestUserInputQuestion[] = [split], isBlocking = true, id = 'choice-request') {
  for (const socket of mock.sockets) socket.send(JSON.stringify({
    id, method: 'item/tool/requestUserInput', params: {
      threadId, turnId: 'choice-turn', itemId: 'choice-item', questions, isBlocking, autoResolutionMs: null,
    },
  }))
}

test('structured choices show explanations without automatically choosing or treating prose as a form', async ({ page, mock }) => {
  const threadId = await prepare(page, mock)
  mock.emit('item/completed', { threadId, turnId: 'choice-turn', item: {
    id: 'plain-options', type: 'agentMessage', text: '随机划分按什么单位进行？\n\n- 按患者随机分组（推荐）\n- 按图像随机划分',
  } })
  await expect(page.getByText('随机划分按什么单位进行？', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Codex 需要你的选择' })).toHaveCount(0)
  choiceRequest(mock, threadId)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card.getByText('划分单位', { exact: true })).toBeVisible()
  await expect(card.getByText('同一患者的所有 MRI 留在同一集合。', { exact: true })).toBeVisible()
  await expect(card.getByText('等待你的回答后继续', { exact: true })).toBeVisible()
  await expect(card.locator('input[type="radio"]:checked')).toHaveCount(0)
  await expect(card.getByRole('button', { name: '提交选择', exact: true })).toBeDisabled()
  await card.getByRole('radio', { name: /按患者随机分组/ }).check()
  await expect(card.locator('.question-option.selected')).toContainText('按患者随机分组')
  await card.getByRole('button', { name: '提交选择', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(mock.responses.filter(response => response.id === 'choice-request')).toEqual([
    { id: 'choice-request', result: { answers: { split: { answers: ['按患者随机分组（推荐）'] } } } },
  ])
})

test('all three questions require an answer and Other remains a separate explicit selection', async ({ page, mock }) => {
  const threadId = await prepare(page, mock)
  choiceRequest(mock, threadId, [split,
    { ...split, id: 'ratio', header: '划分比例', question: '划分比例使用什么？', options: [
      { label: '7:1.5:1.5', description: '训练、验证、测试。' }, { label: '8:1:1', description: '更多训练图像。' },
    ] },
    { ...split, id: 'notes', header: '备注', question: '请补充划分约束', options: null, isOther: false },
  ])
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  const fields = card.locator('fieldset')
  await fields.nth(0).getByRole('radio', { name: /按图像随机划分/ }).check()
  await fields.nth(1).getByRole('radio', { name: /其他/ }).check()
  await expect(card.getByRole('button', { name: '提交选择', exact: true })).toBeDisabled()
  await card.getByRole('textbox', { name: '划分比例：其他回答', exact: true }).fill('  6:2:2  ')
  await expect(card.getByText('已回答 2/3', { exact: true })).toBeVisible()
  await card.getByRole('textbox', { name: '请补充划分约束', exact: true }).fill('  同一患者不能跨集合  ')
  await expect(card.getByText('已回答 3/3', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: '提交选择', exact: true }).click()
  expect(mock.responses.find(response => response.id === 'choice-request')?.result).toEqual({ answers: {
    split: { answers: ['按图像随机划分'] }, ratio: { answers: ['6:2:2'] }, notes: { answers: ['同一患者不能跨集合'] },
  } })
})

test('a failed send retains selected options and free text for one explicit retry', async ({ page, mock }) => {
  const threadId = await prepare(page, mock)
  choiceRequest(mock, threadId)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await card.getByRole('radio', { name: /其他/ }).check()
  await card.getByRole('textbox', { name: '划分单位：其他回答', exact: true }).fill('按医院分组')
  await page.evaluate(() => {
    const nativeSend = WebSocket.prototype.send
    WebSocket.prototype.send = function (data) {
      const message = typeof data === 'string' ? JSON.parse(data) : null
      if (message?.id === 'choice-request') {
        WebSocket.prototype.send = nativeSend
        throw new Error('模拟发送失败')
      }
      return nativeSend.call(this, data)
    }
  })
  await card.getByRole('button', { name: '提交选择', exact: true }).click()
  await expect(card.getByRole('alert')).toContainText('模拟发送失败')
  await expect(card.getByRole('radio', { name: /其他/ })).toBeChecked()
  await expect(card.getByRole('textbox', { name: '划分单位：其他回答', exact: true })).toHaveValue('按医院分组')
  expect(mock.responses.filter(response => response.id === 'choice-request')).toHaveLength(0)
  await card.getByRole('button', { name: '提交选择', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(mock.responses.filter(response => response.id === 'choice-request')).toHaveLength(1)
})

test('secret answers use password inputs, preserve exact values and do not persist in browser drafts', async ({ page, mock }) => {
  const threadId = await prepare(page, mock)
  choiceRequest(mock, threadId, [{ ...split, id: 'secret', header: '凭据', question: '输入测试凭据', options: null, isSecret: true, isOther: false }])
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  const input = card.getByLabel('输入测试凭据', { exact: true })
  await expect(input).toHaveAttribute('type', 'password')
  await expect(input).toHaveAttribute('autocomplete', 'new-password')
  await input.fill(' mock-secret-placeholder ')
  await expect(card).not.toContainText('mock-secret-placeholder')
  await card.getByRole('button', { name: '提交选择', exact: true }).click()
  expect(mock.responses.find(response => response.id === 'choice-request')?.result).toEqual({ answers: { secret: { answers: [' mock-secret-placeholder '] } } })
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('mock-secret-placeholder')
})

test('nonblocking input says Codex can continue and a rapid double activation sends only once', async ({ page, mock }) => {
  const threadId = await prepare(page, mock)
  choiceRequest(mock, threadId, [split], false)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  await expect(card.getByText('Codex 可继续运行，回答后会补充给它', { exact: true })).toBeVisible()
  await card.getByRole('radio', { name: /按患者随机分组/ }).check()
  await card.getByRole('button', { name: '提交选择', exact: true }).evaluate(button => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(card).toHaveCount(0)
  expect(mock.responses.filter(response => response.id === 'choice-request')).toHaveLength(1)
})

test('choice cards remain usable in a narrow dark screen with keyboard selection', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const threadId = await prepare(page, mock)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  choiceRequest(mock, threadId)
  const card = page.getByRole('region', { name: 'Codex 需要你的选择' })
  const first = card.getByRole('radio', { name: /按患者随机分组/ })
  await first.focus()
  await first.press('Space')
  await expect(first).toBeChecked()
  await expect(card.getByRole('button', { name: '提交选择', exact: true })).toBeEnabled()
  expect(await card.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth
  })).toBe(true)
  const colors = await card.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, text: getComputedStyle(element).color }))
  expect(colors.background).not.toBe('rgb(255, 255, 255)')
  expect(colors.text).not.toBe('rgb(36, 37, 35)')
})
