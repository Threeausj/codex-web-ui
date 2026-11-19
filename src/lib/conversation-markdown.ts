import DOMPurify from 'dompurify';
import { isAbsoluteHostPath, isWindowsHostPath, joinHostPath } from '../../shared/host-path';
import { fileLinkLocation, isImagePath, isMarkdownPath, officeFileKind, previewFilePath } from './file-preview';
import { safeConversationImageSource } from './conversation-image-viewer';
import { clearConversationMathCache, createConversationMarkdownParser, plainMessageMath } from './conversation-math';
import { visualizationBlock, type ConversationVisualization } from './conversation-visualization';

const marked = createConversationMarkdownParser();
const assistantMarkdown = createConversationMarkdownParser().use({ extensions: [visualizationBlock] });

function decorateFileLink(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href') || '';
  const location = fileLinkLocation(href === '#' ? anchor.dataset.filePath || href : href);
  if (!location) return;
  const path = location.path;
  const office = officeFileKind(path);
  const kind = /\.pdf$/i.test(path) ? 'pdf'
    : /\.(?:zip|7z|rar|tar|gz|bz2|xz|tgz)$/i.test(path) ? 'archive'
    : office === 'xlsx' || office === 'xls' || /\.csv$/i.test(path) ? 'spreadsheet'
    : office || isMarkdownPath(path) || /\.(?:txt|rtf|html?)$/i.test(path) ? 'document'
    : null;
  if (kind) anchor.dataset.conversationFile = kind;
}

function markImage(image: HTMLImageElement) {
  image.dataset.conversationImage = 'true';
  image.dataset.selectionIgnore = 'true';
  image.setAttribute('role', 'button');
  image.tabIndex = 0;
  image.setAttribute('aria-label', `放大图片 ${image.alt || image.dataset.filePath?.split('/').pop() || '图片'}`);
}

function sanitizeMarkdown(html: string, hostId: string, cwd: string) {
  // Drive paths are not browser URL schemes. Preserve their literal value as
  // data while keeping the normal sanitizer's URL policy unchanged.
  if (/(?:href|src)=["'][a-z]:[\\/]/i.test(html)) {
    const template = document.createElement('template'); template.innerHTML = html;
    for (const element of template.content.querySelectorAll<HTMLAnchorElement | HTMLImageElement>('a[href],img[src]')) {
      const attribute = element.tagName === 'A' ? 'href' : 'src';
      const value = element.getAttribute(attribute) || '';
      if (!isWindowsHostPath(value) || !isAbsoluteHostPath(value)) continue;
      element.dataset.filePath = value;
      if (attribute === 'href') element.setAttribute('href', '#'); else element.removeAttribute('src');
    }
    html = template.innerHTML;
  }
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true, ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'iframe', 'form', 'input'],
  });
  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>('a[href]')) decorateFileLink(anchor);
  for (const image of fragment.querySelectorAll<HTMLImageElement>('img')) {
    const source = image.getAttribute('src') || image.dataset.filePath || '';
    // Host-local assets use the authenticated image endpoint. Relative paths are
    // resolved inside the conversation's workspace, never the website's origin.
    if (/^(?:https?:|data:|blob:)/i.test(source)) {
      if (safeConversationImageSource(source, hostId)) markImage(image);
      continue;
    }
    const path = previewFilePath(source, joinHostPath(cwd || '/', '.conversation.md'), isWindowsHostPath(source) ? source.slice(0, 3) : source.startsWith('/') ? '/' : cwd);
    image.removeAttribute('src');
    if (path && isImagePath(path)) {
      image.src = `/api/hosts/${encodeURIComponent(hostId)}/images?path=${encodeURIComponent(path)}`;
      image.dataset.filePath = path;
      image.loading = 'lazy';
      image.decoding = 'async';
      markImage(image);
    }
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

const cache = new Map<string, { html: string; bytes: number }>();
let cacheBytes = 0;
export function clearConversationMarkdownCache() { cache.clear(); cacheBytes = 0; clearConversationMathCache(); }
function cached(key: string, render: () => string) {
  const previous = cache.get(key);
  if (previous) { cache.delete(key); cache.set(key, previous); return previous.html; }
  const html = render(), bytes = (key.length + html.length) * 2;
  if (bytes <= 256 * 1024) {
    cache.set(key, { html, bytes }); cacheBytes += bytes;
    while (cacheBytes > 8 * 1024 * 1024 || cache.size > 6000) { const oldest = cache.keys().next().value!; cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest); }
  }
  return html;
}
export function conversationMarkdown(text: string, hostId = 'local', cwd = '') {
  return cached(JSON.stringify(['document', hostId, cwd, text]), () => sanitizeMarkdown(marked.parse(text, { async: false }) as string, hostId, cwd));
}
/** User messages stay plain text except for complete, valid math. The generated
 * KaTeX/MathML is sanitized with the same policy as conversation Markdown. */
export function userMessageMath(text: string): string | null {
  if (!/[\$\\]/.test(text)) return null;
  const html = plainMessageMath(text);
  return html === null ? null : cached(JSON.stringify(['user-math', text]), () => sanitizeMarkdown(html, 'local', ''));
}
/** Stable parsed blocks keep completed paragraph DOM intact during streaming.
 * The lexer resolves reference definitions across the entire message first. */
export function conversationMarkdownBlocks(text: string, hostId = 'local', cwd = '') {
  return assistantMarkdown.lexer(text).filter(token => token.type !== 'space').map((token, index) => {
    if (token.type === 'conversationVisualization') {
      return { id: index, visualization: token.visualization as ConversationVisualization };
    }
    const html = cached(JSON.stringify(['block', hostId, cwd, token]), () => sanitizeMarkdown(assistantMarkdown.parser([token]) as string, hostId, cwd));
    return { id: index, html };
  });
}
