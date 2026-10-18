export type UserMessageQuote = { type: 'quote'; kind: 'conversation' | 'file'; name: string; text: string };
export type UserMessagePart = { type: 'text'; text: string } | UserMessageQuote;

function quoteHeader(line: string) {
  const start = line.lastIndexOf('[引用');
  if (start < 0) return null;
  const prefix = line.slice(0, start);
  // Literal examples inside inline code keep their original presentation.
  if (prefix.includes('`') || /^[ \t]*$/.test(prefix) && /^(?: {4}|\t)/.test(prefix)) return null;
  const match = /^\[引用(对话|文件)[：:][ \t]*(.+)\][ \t]*$/.exec(line.slice(start));
  if (!match || !match[2].trim()) return null;
  return { prefix, kind: match[1] === '文件' ? 'file' as const : 'conversation' as const, name: match[2].trim() };
}

const quoteLine = /^[ \t]{0,3}>[ \t]?/;

/** Presentation only: keep submitted/copy/edit text intact, and recognize the
 * plain-text quotation format produced by formatConversationQuote, including
 * older messages where the header followed the user's instruction directly. */
export function userMessageParts(text: string): UserMessagePart[] {
  if (!text.includes('[引用')) return [{ type: 'text', text }];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const parts: UserMessagePart[] = [];
  let plain: string[] = [], fence: { character: string; length: number } | undefined;
  const flush = () => {
    const body = plain.join('\n').replace(/^\n+|\n+$/g, '');
    if (body) parts.push({ type: 'text', text: body });
    plain = [];
  };
  for (let index = 0; index < lines.length; ++index) {
    const line = lines[index];
    const codeFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (codeFence) {
      const marker = codeFence[1];
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (fence.character === marker[0] && marker.length >= fence.length && !codeFence[2].trim()) fence = undefined;
      plain.push(line);
      continue;
    }
    const header = !fence && quoteHeader(line);
    if (!header || !quoteLine.test(lines[index + 1] || '')) { plain.push(line); continue; }
    const quoted: string[] = [];
    let end = index + 1;
    while (end < lines.length) {
      if (quoteLine.test(lines[end])) { quoted.push(lines[end].replace(quoteLine, '')); ++end; continue; }
      // Historic blockquotes sometimes separated paragraphs with an unmarked
      // blank line. Consume it only when the following paragraph is quoted.
      let next = end;
      while (next < lines.length && !lines[next].trim()) ++next;
      if (next === end || !quoteLine.test(lines[next] || '')) break;
      while (end < next) { quoted.push(''); ++end; }
    }
    const body = quoted.join('\n').replace(/^\n+|\n+$/g, '');
    if (!body.trim()) { plain.push(...lines.slice(index, end)); index = end - 1; continue; }
    if (header.prefix.trim()) plain.push(header.prefix);
    flush();
    parts.push({ type: 'quote', kind: header.kind, name: header.name, text: body });
    index = end - 1;
  }
  if (!parts.length) return [{ type: 'text', text }];
  flush();
  return parts;
}

export function collapseUserMessageQuote(text: string): boolean {
  return text.length > 360 || text.split('\n').length > 4;
}

export function userMessageQuotePreview(text: string): string {
  return text.split('\n').filter(line => line.trim() && !/^\s*(?:`{3,}|~{3,}|\|?[ :|-]+\|[ :|-]*)\s*$/.test(line)).slice(0, 3)
    .map(line => line.replace(/^ {0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '').replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ' · '))
    .join(' ').replace(/\s+/g, ' ').trim().slice(0, 220);
}
