import test from 'node:test'
import assert from 'node:assert/strict'
import { editableMessage, editedMessageInput } from '../src/lib/message-edit'
import type { DisplayItem } from '../src/lib/events'

const thread = { id: 'thread', historyMode: 'paginated', ephemeral: false, canAcceptDirectInput: true }
const user = (id: string, turnId: string): DisplayItem => ({
  id, turnId, type: 'userMessage', content: [{ type: 'text', text: id, text_elements: [] }],
})

test('editing targets only the latest persisted user turn and keeps earlier replies outside the replacement', () => {
  const old = user('old-user', 'old-turn')
  const latest = user('latest-user', 'latest-turn')
  const items = [old, { id: 'old-answer', type: 'agentMessage', turnId: 'old-turn' }, latest,
    { id: 'latest-answer', type: 'agentMessage', turnId: 'latest-turn' }]
  const turns = [{ id: 'old-turn', status: 'completed' }, { id: 'latest-turn', status: 'completed' }]
  assert.equal(editableMessage(items, turns, thread), latest)
  assert.equal(editableMessage(items, [...turns, { id: 'shell-turn', status: 'completed' }], thread), null)
  assert.equal(editableMessage([old], turns, thread), null)
})

test('failed and interrupted prompts can be corrected after their work settles', () => {
  const message = user('user', 'turn')
  for (const status of ['failed', 'interrupted'])
    assert.equal(editableMessage([message], [{ id: 'turn', status }], thread), message)
  for (const status of ['inProgress', 'running', undefined])
    assert.equal(editableMessage([message], [{ id: 'turn', status }], thread), null)
})

test('unconfirmed sends and an edit blocked by connection or navigation cannot remove history', () => {
  const message = user('user', 'turn')
  const turns = [{ id: 'turn', status: 'completed' }]
  assert.equal(editableMessage([message], turns, thread, true), null)
  for (const status of ['sending', 'unconfirmed'])
    assert.equal(editableMessage([{ ...message, status }], turns, thread), null)
  assert.equal(editableMessage([{ ...message, turnId: undefined }], turns, thread), null)
  assert.equal(editableMessage([message], [], thread), null)
})

test('a steering message never causes the original input from the same turn to be silently removed', () => {
  const initial = user('initial', 'turn')
  const steering = user('steering', 'turn')
  assert.equal(editableMessage([initial, steering], [{ id: 'turn', status: 'completed' }], thread), null)
})

test('nonpersistent, legacy and agent-controlled threads do not offer an unsupported revert', () => {
  const message = user('user', 'turn')
  const turns = [{ id: 'turn', status: 'completed' }]
  for (const incompatible of [null, { ...thread, ephemeral: true }, { ...thread, historyMode: 'legacy' },
    { ...thread, canAcceptDirectInput: false }])
    assert.equal(editableMessage([message], turns, incompatible), null)
})

test('edited text preserves uploaded and remote images, file IDs, skills and app selections', () => {
  const selections = [
    { type: 'localImage', path: '/workspace/upload.png', detail: 'original' },
    { type: 'image', url: 'https://example.test/reference.png' },
    { type: 'image', fileId: 'file-reference', detail: 'high' },
    { type: 'skill', name: 'review', path: '/workspace/skills/review/SKILL.md' },
    { type: 'mention', name: 'GitHub', path: 'app://github' },
  ]
  const message = { ...user('user', 'turn'), content: [
    { type: 'text', text: 'old input', text_elements: [{ byte_range: { start: 0, end: 3 }, placeholder: 'old' }] },
    ...selections,
  ] }
  const text = '修改后的问题\n\n附件文件：/workspace/uploads/notes.md（notes.md）'
  const input = editedMessageInput(message, text)
  assert.deepEqual(input, [{ type: 'text', text, text_elements: [] }, ...selections])
  assert.deepEqual(message.content[0].text_elements, [{ byte_range: { start: 0, end: 3 }, placeholder: 'old' }])
  input[1].path = '/different/image.png'
  assert.equal(message.content[1].path, '/workspace/upload.png')
})

test('replacing multiple text chunks yields one edited text without replaying the old prompt', () => {
  const message = { ...user('user', 'turn'), content: [
    { type: 'text', text: 'first old segment', text_elements: [] },
    { type: 'localImage', path: '/workspace/image.png' },
    { type: 'text', text: 'second old segment', text_elements: [] },
  ] }
  assert.deepEqual(editedMessageInput(message, 'corrected'), [
    { type: 'text', text: 'corrected', text_elements: [] },
    { type: 'localImage', path: '/workspace/image.png' },
  ])
})

test('empty text is rejected before revert unless an existing image remains as model input', () => {
  const message = user('user', 'turn')
  assert.throws(() => editedMessageInput(message, ' \n '), /不能为空/)
  assert.throws(() => editedMessageInput({ ...message, content: [{ type: 'skill', name: 'review', path: '/review' }] }, ''), /不能为空/)
  for (const image of [{ type: 'localImage', path: '/image.png' }, { type: 'image', fileId: 'file-image' }])
    assert.deepEqual(editedMessageInput({ ...message, content: [image] }, ''), [
      { type: 'text', text: '', text_elements: [] }, image,
    ])
})
