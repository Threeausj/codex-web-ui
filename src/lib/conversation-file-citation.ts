import type { TokenizerAndRendererExtension } from 'marked';
import { hostBasename, isAbsoluteHostPath } from '../../shared/host-path';
import { fileLinkLocation } from './file-preview';

const directive = ':codex-file-citation';
const opening = /^:codex-file-citation(?:\[([^\]\r\n]*)\])?\{[ \t]*/;

function lineNumber(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const line = Number(value);
  return Number.isSafeInteger(line) ? line : undefined;
}

export const conversationFileCitation: TokenizerAndRendererExtension = {
  name: 'conversationFileCitation',
  level: 'inline',
  start: text => text.indexOf(directive),
  tokenizer(text) {
    if (!text.startsWith(directive) || this.lexer.state.inLink) return;
    const source = text.slice(0, 16_384);
    const prefix = opening.exec(source);
    if (!prefix) return;
    const attributes = new Map<string, string>();
    const attribute = /([a-z_][\w-]*)[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'{}]+))[ \t]*/iy;
    attribute.lastIndex = prefix[0].length;
    let end = attribute.lastIndex;
    while (source[end] !== '}') {
      const match = attribute.exec(source);
      if (!match || attributes.has(match[1])) return;
      attributes.set(match[1], match[2] ?? match[3] ?? match[4]);
      end = attribute.lastIndex;
    }
    const path = attributes.get('path');
    if (!isAbsoluteHostPath(path) || path.startsWith('//')) return;
    const line = lineNumber(attributes.get('line_range_start'));
    const lastLine = lineNumber(attributes.get('line_range_end'));
    return {
      type: 'conversationFileCitation', raw: source.slice(0, end + 1), path, line, lastLine,
      label: prefix[1]?.trim() || hostBasename(path) || path,
    };
  },
  renderer(token) {
    const link = document.createElement('a');
    link.setAttribute('href', '#');
    link.dataset.conversationCitation = token.path;
    if (token.line) link.dataset.citationLine = String(token.line);
    link.title = token.path;
    const range = token.line ? ':' + token.line + (token.lastLine > token.line ? '–' + token.lastLine : '') : '';
    link.textContent = token.label + range;
    return link.outerHTML;
  },
};

export function conversationFileLocation(anchor: HTMLAnchorElement) {
  const path = anchor.dataset.conversationCitation;
  if (isAbsoluteHostPath(path) && !path.startsWith('//'))
    return { path, line: lineNumber(anchor.dataset.citationLine) };
  const href = anchor.getAttribute('href') || '';
  return fileLinkLocation(href === '#' ? anchor.dataset.filePath || href : href);
}
