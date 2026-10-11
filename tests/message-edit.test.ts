import test from 'node:test'
import assert from 'node:assert/strict'
import { editableMessage, editedMessageInput, messageEditDraft, uploadedEditAttachments } from '../src/lib/message-edit'
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

test('an edit draft exposes only exact application upload references and retains ordinary attachment-like prose', () => {
  const filePath = '/workspace/demo/.codex-web-uploads/12345678-abcd-4321-9876-123456789abc/0-notes.txt'
  const localPath = '/app/data/uploads/12345678-abcd-4321-9876-123456789abc/1-report.pdf'
  const text = `Correct this\n\n附件文件：${filePath}（notes.txt）\n\n附件文件：${localPath}（report.pdf）`
  const item = { ...user('user', 'turn'), content: [{ type: 'text', text }, { type: 'localImage', path: '/old/image.png' }] }
  const draft = messageEditDraft(item)
  assert.equal(draft.text, 'Correct this')
  assert.deepEqual(draft.attachments.map(attachment => attachment.name), ['image.png', 'notes.txt', 'report.pdf'])
  assert.equal(draft.attachments[0]!.input.path, '/old/image.png')
  const prose = '附件文件：/workspace/notes.txt（notes.txt）\n附件文件：/workspace/uploads/not-a-uuid/0-notes.txt（notes.txt）'
  assert.equal(messageEditDraft(item, prose).text, prose)
  for (const folder of ['.codex-web-uploads', 'uploads']) {
    const rootPath = `/${folder}/12345678-abcd-4321-9876-123456789abc/0-notes.txt`
    assert.equal(messageEditDraft(item, `附件文件：${rootPath}（notes.txt）`).attachments.at(-1)!.path, rootPath)
  }
})

test('editing can replace or remove original images, upload normal files, and preserve structured skill and app context', () => {
  const item = { ...user('user', 'turn'), content: [
    { type: 'text', text: 'Old' },
    { type: 'localImage', path: '/old/image.png' },
    { type: 'image', fileId: 'original' },
    { type: 'skill', name: 'review', path: '/review/SKILL.md' },
    { type: 'mention', name: 'GitHub', path: 'app://github' },
  ] }
  const attachments = uploadedEditAttachments([
    { path: '/new/image.png', name: 'image.png', mime: 'image/png' },
    { path: '/new/notes.txt', name: 'notes.txt', mime: 'text/plain' },
  ])
  assert.deepEqual(editedMessageInput(item, 'New', attachments), [
    { type: 'text', text: 'New\n\n附件文件：/new/notes.txt（notes.txt）', text_elements: [] },
    { type: 'skill', name: 'review', path: '/review/SKILL.md' },
    { type: 'mention', name: 'GitHub', path: 'app://github' },
    { type: 'localImage', path: '/new/image.png' },
  ])
  assert.deepEqual(editedMessageInput(item, 'Text only', []), [
    { type: 'text', text: 'Text only', text_elements: [] },
    { type: 'skill', name: 'review', path: '/review/SKILL.md' },
    { type: 'mention', name: 'GitHub', path: 'app://github' },
  ])
  assert.equal(item.content[1]!.path, '/old/image.png')
})

test('attachment-only edited images and ordinary files are valid while removing the final content is rejected', () => {
  const item = user('user', 'turn')
  const images = uploadedEditAttachments([{ path: '/new/image.png', name: 'image.png', mime: 'image/png' }])
  assert.deepEqual(editedMessageInput(item, '', images), [
    { type: 'text', text: '', text_elements: [] }, { type: 'localImage', path: '/new/image.png' },
  ])
  const files = uploadedEditAttachments([{ path: '/new/notes.txt', name: 'notes.txt', mime: 'text/plain' }])
  assert.deepEqual(editedMessageInput(item, '', files), [{ type: 'text', text: '附件文件：/new/notes.txt（notes.txt）', text_elements: [] }])
  assert.throws(() => editedMessageInput(item, '', []), /不能为空/)
})
