import type { DisplayItem } from './events'

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
export function editedMessageInput(item: DisplayItem, text: string): any[] {
  const content = Array.isArray(item.content) ? item.content : []
  const preserved = content.filter(input => input.type !== 'text').map(input => JSON.parse(JSON.stringify(input)))
  if (!text.trim() && !preserved.some(input => ['image', 'localImage'].includes(input.type)))
    throw new Error('消息内容不能为空')
  return [{ type: 'text', text, text_elements: [] }, ...preserved]
}
