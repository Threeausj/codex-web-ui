import type { TokenizerAndRendererExtension } from 'marked';
import { isAbsoluteHostPath } from '../../shared/host-path';
import { escapeMathText } from './conversation-math';

export type ConversationVisualization = { path: string; title?: string };

const markerLine = /^ {0,3}\uE200visualize\uE202([^\r\n\uE201]{1,8192})\uE201[ \t]*(?:\n|$)/;

export const visualizationBlock: TokenizerAndRendererExtension = {
  name: 'conversationVisualization',
  level: 'block',
  start(source) {
    return /(?:^|\n) {0,3}\uE200visualize\uE202/.exec(source)?.index;
  },
  tokenizer(source) {
    const match = markerLine.exec(source);
    if (!match) return;
    let value: unknown;
    try { value = JSON.parse(match[1]!); }
    catch { return; }
    if (!value || typeof value !== 'object' || !('path' in value) ||
        !isAbsoluteHostPath(value.path) || value.path.length > 4096 || !/\.html?$/i.test(value.path)) return;
    const title = 'title' in value && typeof value.title === 'string' ? value.title.trim().slice(0, 250) : undefined;
    const visualization: ConversationVisualization = { path: value.path, title };
    return { type: 'conversationVisualization', raw: match[0], visualization };
  },
  // Nested Markdown and quoted messages retain the source reference as text.
  renderer(token) { return '<p>' + escapeMathText(token.raw.trim()) + '</p>\n'; },
};
