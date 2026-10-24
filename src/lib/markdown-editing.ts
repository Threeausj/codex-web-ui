export type MarkdownSelection = { start: number; end: number };
export type MarkdownEdit = { text: string; selection: MarkdownSelection; handled: boolean };
export type MarkdownFormat = 'bold' | 'italic' | 'code' | 'link';

function range(text: string, selection: MarkdownSelection): MarkdownSelection {
  const bound = (value: number) => Number.isFinite(value) ? Math.min(text.length, Math.max(0, Math.trunc(value))) : text.length;
  const a = bound(selection.start), b = bound(selection.end);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
function result(text: string, start: number, end = start, handled = true): MarkdownEdit {
  return { text, selection: { start, end }, handled };
}
function replace(text: string, start: number, end: number, value: string, selectionStart: number, selectionEnd = selectionStart) {
  return result(text.slice(0, start) + value + text.slice(end), selectionStart, selectionEnd);
}
function starCount(text: string, position: number, direction: -1 | 1) {
  let count = 0;
  for (let i = direction === -1 ? position - 1 : position; text[i] === '*'; i += direction) count++;
  return count;
}
function surrounded(text: string, start: number, end: number, marker: string) {
  if (text.slice(start - marker.length, start) !== marker || text.slice(end, end + marker.length) !== marker) return false;
  // One star in a two-star delimiter is bold, not an active italic wrapper.
  return marker !== '*' || starCount(text, start, -1) % 2 === 1 && starCount(text, end, 1) % 2 === 1;
}
function toggleMarker(text: string, selection: MarkdownSelection, marker: string): MarkdownEdit {
  let { start, end } = range(text, selection);
  const selected = text.slice(start, end);
  if (selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker) &&
      (marker !== '*' || starCount(selected, 0, 1) % 2 === 1 && starCount(selected, selected.length, -1) % 2 === 1)) {
    const value = selected.slice(marker.length, -marker.length);
    return replace(text, start, end, value, start, start + value.length);
  }
  if (start >= marker.length && surrounded(text, start, end, marker)) {
    return replace(text, start - marker.length, end + marker.length, selected, start - marker.length, end - marker.length);
  }
  // Keep surrounding spaces outside emphasis so CommonMark renders the style.
  const leading = selected.match(/^[ \t]*/)?.[0].length || 0;
  const trailing = selected.slice(leading).match(/[ \t]*$/)?.[0].length || 0;
  start += leading; end -= trailing;
  const value = text.slice(start, end);
  return replace(text, start, end, marker + value + marker, start + marker.length, end + marker.length);
}
function toggleCode(text: string, selection: MarkdownSelection): MarkdownEdit {
  const { start, end } = range(text, selection), value = text.slice(start, end);
  // Selecting the full code span or only its content both toggle it off.
  const opening = value.match(/^`+/)?.[0], closing = value.match(/`+$/)?.[0];
  if (opening && opening === closing && value.length >= opening.length * 2 &&
      !(value.slice(opening.length, -opening.length).match(/`+/g) || []).some(run => run.length === opening.length)) {
    let content = value.slice(opening.length, -opening.length);
    if (content.startsWith(' ') && content.endsWith(' ') && content.trim()) content = content.slice(1, -1);
    return replace(text, start, end, content, start, start + content.length);
  }
  const before = text.slice(0, start).match(/`+$/)?.[0], after = text.slice(end).match(/^`+/)?.[0];
  if (before && before === after && !(value.includes('\n') && !value.trim()))
    return replace(text, start - before.length, end + after.length, value, start - before.length, end - before.length);
  const longest = (value.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const marker = '`'.repeat(longest + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return replace(text, start, end, marker + padding + value + padding + marker, start + marker.length + padding.length, end + marker.length + padding.length);
}
function toggleLink(text: string, selection: MarkdownSelection): MarkdownEdit {
  const { start, end } = range(text, selection), value = text.slice(start, end);
  const selected = /^\[([^\]\n]*)\]\(([^\n]*)\)$/.exec(value);
  if (selected) return replace(text, start, end, selected[1]!, start, start + selected[1]!.length);
  const target = /^\]\([^\n)]*\)/.exec(text.slice(end));
  if (start > 0 && text[start - 1] === '[' && target)
    return replace(text, start - 1, end + target[0].length, value, start - 1, end - 1);
  const label = value || '链接文字', inserted = `[${label}](https://)`;
  const cursor = value ? start + label.length + 3 : start + 1;
  return replace(text, start, end, inserted, cursor, cursor + (value ? 'https://'.length : label.length));
}

/** Plain Markdown remains the authoritative draft; offsets use UTF-16 like
 * textarea selectionStart and CodeMirror's document positions. */
export function formatMarkdown(text: string, selection: MarkdownSelection, format: MarkdownFormat): MarkdownEdit {
  if (format === 'link') return toggleLink(text, selection);
  if (format === 'code') return toggleCode(text, selection);
  return toggleMarker(text, selection, format === 'bold' ? '**' : '*');
}

function quotePrefix(line: string) { return line.match(/^[ \t]*(?:>[ \t]*)+/)?.[0] || ''; }
function insideFence(text: string, end: number) {
  let fence: { character: string; length: number; indent: number } | undefined;
  for (const raw of text.slice(0, end).split('\n')) {
    let line = raw.slice(quotePrefix(raw).length), indent = 0;
    if (fence) {
      const spaces = line.match(/^[ \t]*/)?.[0].length || 0;
      line = line.slice(Math.min(fence.indent, spaces));
    } else {
      // Fences can start inside a list item; subsequent lines use its content
      // indentation rather than repeating the item's list marker.
      const list = /^[ \t]*(?:[-+*]|[0-9]{1,9}[.)])[ \t]+/.exec(line);
      if (list) { indent = list[0].length; line = line.slice(indent); }
    }
    const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1]!, tail = match[2]!;
    if (fence) {
      if (marker[0] === fence.character && marker.length >= fence.length && !tail.trim()) fence = undefined;
    } else if (marker[0] !== '`' || !tail.includes('`')) fence = { character: marker[0]!, length: marker.length, indent };
  }
  return !!fence;
}

/** Whether the caret is inside an open Markdown fenced code block. The
 * composer uses this to insert a literal newline instead of sending a draft. */
export function isMarkdownCodeAt(text: string, position: number): boolean {
  const end = Number.isFinite(position) ? Math.min(text.length, Math.max(0, Math.trunc(position))) : text.length;
  return insideFence(text, end);
}

/** Continue explicit list/quote markup on Enter, or remove an empty marker.
 * Non-markup and fenced code return handled:false so the caller can keep its
 * own send/newline policy. Shift/Mod Enter should be routed by the caller. */
export function continueMarkdown(text: string, selection: MarkdownSelection): MarkdownEdit {
  const { start, end } = range(text, selection);
  const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline < 0 ? text.length : text[newline - 1] === '\r' ? newline - 1 : newline;
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const unchanged = () => result(text, start, end, false);
  if (text.slice(start, end).includes('\n') || isMarkdownCodeAt(text, start)) return unchanged();
  const line = text.slice(lineStart, lineEnd), quote = quotePrefix(line), rest = line.slice(quote.length);
  const list = /^([ \t]*)([-+*]|([0-9]{1,9})([.)]))([ \t]+)/.exec(rest);
  if (!list && !quote) return unchanged();
  const indentation = list?.[1] || '';
  const markerLength = quote.length + (list?.[0].length || 0);
  const task = list && /^\[([ xX])\](?:[ \t]+|$)/.exec(line.slice(markerLength));
  const contentStart = lineStart + markerLength + (task?.[0].length || 0);
  if (start < contentStart) return replace(text, start, end, lineBreak, start + lineBreak.length);
  if (!line.slice(contentStart - lineStart).trim()) {
    // An empty list leaves its containing quote/indentation. A second Enter
    // exits the innermost quote instead of discarding every surrounding level.
    const remaining = list ? quote + indentation : quote.replace(/>[ \t]*$/, '');
    return replace(text, lineStart, lineEnd, remaining, lineStart + remaining.length);
  }
  let prefix = quote;
  if (list) {
    const number = list[3];
    const marker = number ? String(Math.min(999999999, Number(number) + 1)).padStart(number.length, '0') + list[4] : list[2];
    prefix += indentation + marker + list[5] + (task ? '[ ] ' : '');
  }
  return replace(text, start, end, lineBreak + prefix, start + lineBreak.length + prefix.length);
}
