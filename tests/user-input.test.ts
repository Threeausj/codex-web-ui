import test from 'node:test'
import assert from 'node:assert/strict'
import type { ToolRequestUserInputQuestion } from '../shared/protocol/v2/ToolRequestUserInputQuestion'
import { userInputAnswer, userInputAutoResolveAt, userInputAutoResolutionMs, userInputReady, userInputResponse } from '../src/lib/user-input'

const question = (id = 'split', patch: Partial<ToolRequestUserInputQuestion> = {}): ToolRequestUserInputQuestion => ({
  id, header: '划分单位', question: '随机划分按什么单位进行？', isOther: true, isSecret: false,
  options: [
    { label: '按患者随机分组（推荐）', description: '同一患者的图像留在同一集合。' },
    { label: '按图像随机划分', description: '同一患者可能跨集合。' },
  ], ...patch,
})

test('recommended options are never selected or submitted automatically', () => {
  const q = question()
  assert.equal(userInputAnswer(q), null)
  assert.equal(userInputReady([q], {}), false)
  assert.throws(() => userInputResponse([q], {}), /回答全部问题/)
  assert.equal(userInputAnswer(q, { selection: 0 }), '按患者随机分组（推荐）')
})

test('all three questions must have valid answers, with only requested answer ids sent', () => {
  const questions = [question(), question('size'), question('secret', { options: null, isSecret: true })]
  const drafts = { split: { selection: 1 }, size: { selection: 'other' as const, text: '  7:1.5:1.5  ' }, secret: { text: 'token' }, stale: { text: 'not sent' } }
  assert.equal(userInputReady(questions, { ...drafts, secret: { text: '  ' } }), false)
  assert.equal(userInputReady(questions, drafts), true)
  assert.deepEqual(userInputResponse(questions, drafts), { answers: {
    split: { answers: ['按图像随机划分'] }, size: { answers: ['7:1.5:1.5'] }, secret: { answers: ['token'] },
  } })
})

test('switching from free text back to an option sends the selected option only and retains drafts', () => {
  const draft = { selection: 'other' as number | 'other', text: '自定义划分' }
  const q = question()
  assert.equal(userInputAnswer(q, draft), '自定义划分')
  draft.selection = 0
  assert.equal(userInputAnswer(q, draft), '按患者随机分组（推荐）')
  assert.equal(draft.text, '自定义划分')
  assert.deepEqual(userInputResponse([q], { split: draft }), { answers: { split: { answers: ['按患者随机分组（推荐）'] } } })
})

test('unoffered Other, stale option indices and empty free text cannot bypass answer validation', () => {
  const q = question('split', { isOther: false })
  for (const draft of [{ selection: 'other' as const, text: 'invalid' }, { selection: -1 }, { selection: 2 }, { selection: 0.5 }, { text: 'invalid' }])
    assert.equal(userInputAnswer(q, draft), null)
  assert.equal(userInputAnswer(question(), { selection: 'other', text: '\n  ' }), null)
  assert.equal(userInputReady([], {}), false)
  assert.equal(userInputReady([q, q], { split: { selection: 0 } }), false)
})

test('text-only and secret questions use the same response envelope without modifying input', () => {
  const q = question('credential', { options: [], isOther: false, isSecret: true })
  const drafts = { credential: { text: ' sensitive-placeholder ' } }
  assert.deepEqual(userInputResponse([q], drafts), { answers: { credential: { answers: [' sensitive-placeholder '] } } })
  assert.deepEqual(drafts, { credential: { text: ' sensitive-placeholder ' } })
})

test('only valid bridge absolute deadlines start the question countdown', () => {
  const requestedAt = 1_791_542_400_000
  const autoResolveAt = requestedAt + 60_000
  assert.equal(userInputAutoResolveAt({ bridgeUserInputContext: { requestedAt, autoResolveAt } }), autoResolveAt)
  assert.equal(userInputAutoResolveAt({ bridgeUserInputContext: { requestedAt, autoResolveAt: requestedAt } }), requestedAt)
  for (const params of [undefined, null, {}, { autoResolutionMs: 60_000 },
    { bridgeUserInputContext: { requestedAt, autoResolveAt: null } },
    { bridgeUserInputContext: { requestedAt, autoResolveAt: requestedAt - 1 } },
    { bridgeUserInputContext: { requestedAt: -1, autoResolveAt } },
    { bridgeUserInputContext: { requestedAt: String(requestedAt), autoResolveAt } },
    { bridgeUserInputContext: { autoResolveAt } },
    { bridgeUserInputContext: { requestedAt, autoResolveAt: Infinity } },
    { bridgeUserInputContext: { requestedAt, autoResolveAt: Number.MAX_SAFE_INTEGER + 1 } },
  ]) assert.equal(userInputAutoResolveAt(params), null)
})

test('legacy timeout metadata never supplies a new deadline from the current time', () => {
  for (const value of [0, 60_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(userInputAutoResolutionMs({ autoResolutionMs: value }), value)
    assert.equal(userInputAutoResolveAt({ autoResolutionMs: value }), null)
  }
  for (const value of [undefined, null, -1, 0.5, '60000', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(userInputAutoResolutionMs({ autoResolutionMs: value }), null)
})
