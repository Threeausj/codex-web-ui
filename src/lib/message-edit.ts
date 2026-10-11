import type { DisplayItem } from './events'

export type MessageEditAttachment = {
  id: string
  name: string
  path?: string
  mime?: string
  size?: number
  previewUrl?: string
  input?: any
}
export type MessageEditSession = {
  itemId: string
  draft: string
  attachments: MessageEditAttachment[]
  error: string
  saving: boolean
  uploading: number
}

/** Recognize only the upload reference emitted by this application, including
 * its UUID directory and indexed filename. Ordinary prose stays editable text. */
export function messageEditDraft(item: DisplayItem, text?: string): { text: string; attachments: MessageEditAttachment[] } {
  const content = Array.isArray(item.content) ? item.content : []
  const attachments: MessageEditAttachment[] = content.flatMap((input: any, index: number) => {
    if (!['image', 'localImage'].includes(input.type)) return []
    return [{ id: `original-image-${index}`, name: input.path?.split('/').pop() || (input.fileId ? '原图片附件' : '图片'),
      path: input.path, mime: 'image/*', input: JSON.parse(JSON.stringify(input)) }]
  })
  const raw = text ?? content.filter((input: any) => input.type === 'text').map((input: any) => input.text).join('\n')
  const lines = raw.split('\n')
  const kept = lines.filter(line => {
    const match = /^附件文件：(\/(?:[^\r\n]*\/)?(?:\.codex-web-uploads|uploads)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\d+-[^\r\n]+)（([^\r\n]+)）$/i.exec(line)
    if (!match || !match[1]!.split('/').pop()?.endsWith(`-${match[2]}`)) return true
    attachments.push({ id: `original-file-${attachments.length}`, name: match[2]!, path: match[1]! })
    return false
  })
  return { text: kept.join('\n').trimEnd(), attachments }
}

export function uploadedEditAttachments(files: any[]): MessageEditAttachment[] {
  return files.map((file, index) => ({ ...file, id: `uploaded-${file.path}-${index}`,
    ...(file.mime?.startsWith('image/') ? { input: { type: 'localImage', path: file.path } } : {}) }))
}

export function releaseEditAttachments(attachments: MessageEditAttachment[]) {
  for (const attachment of attachments)
    if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
}

/** Revert removes a whole turn, so an appended steering message is not independently editable. */
export function editableMessage(items: DisplayItem[], turns: any[], thread: any, blocked = false): DisplayItem | null {
  if (blocked || !thread || thread.ephemeral || thread.canAcceptDirectInput === false ||
    (thread.historyMode && thread.historyMode !== 'paginated')) return null
  const item = items.filter(item => item.type === 'userMessage').at(-1)
  const turn = turns.at(-1)
  if (!item?.turnId || !turn || item.turnId !== turn.id ||
    !['completed', 'failed', 'interrupted'].includes(turn.status) ||
    ['sending', 'unconfirmed'].includes(item.status)) return null
  if (items.filter(entry => entry.type === 'userMessage' && entry.turnId === turn.id).length !== 1) return null
  return item
}

/** Retain attachments and structured selections; edited text cannot retain old offset annotations. */
export function editedMessageInput(item: DisplayItem, text: string, attachments?: MessageEditAttachment[]): any[] {
  const content = Array.isArray(item.content) ? item.content : []
  const preserved = content.filter(input => input.type !== 'text' &&
    (attachments === undefined || !['image', 'localImage'].includes(input.type))).map(input => JSON.parse(JSON.stringify(input)))
  if (attachments !== undefined) {
    const files: string[] = []
    for (const attachment of attachments) {
      if (attachment.input && ['image', 'localImage'].includes(attachment.input.type)) preserved.push(JSON.parse(JSON.stringify(attachment.input)))
      else if (attachment.path && attachment.name) files.push(`附件文件：${attachment.path}（${attachment.name}）`)
    }
    text = [text, ...files].filter(Boolean).join('\n\n')
  }
  if (!text.trim() && !preserved.some(input => ['image', 'localImage'].includes(input.type)))
    throw new Error('消息内容不能为空')
  return [{ type: 'text', text, text_elements: [] }, ...preserved]
}
