import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { isImagePath, previewFilePath } from './file-preview';

function sanitizeMarkdown(html: string, hostId: string, cwd: string) {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true, ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'iframe', 'form', 'input'],
  });
  for (const image of fragment.querySelectorAll<HTMLImageElement>('img')) {
    const source = image.getAttribute('src') || '';
    // Host-local assets use the authenticated image endpoint. Relative paths are
    // resolved inside the conversation's workspace, never the website's origin.
    if (/^(?:https?:|data:|blob:)/i.test(source)) continue;
    const path = previewFilePath(source, `${cwd || '/'}/.conversation.md`, source.startsWith('/') ? '/' : cwd);
    image.removeAttribute('src');
    if (path && isImagePath(path)) {
      image.src = `/api/hosts/${encodeURIComponent(hostId)}/images?path=${encodeURIComponent(path)}`;
      image.dataset.filePath = path;
      image.loading = 'lazy';
      image.decoding = 'async';
    }
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

const cache = new Map<string, { html: string; bytes: number }>();
let cacheBytes = 0;
export function clearConversationMarkdownCache() { cache.clear(); cacheBytes = 0; }
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
/** Stable parsed blocks keep completed paragraph DOM intact during streaming.
 * The lexer resolves reference definitions across the entire message first. */
export function conversationMarkdownBlocks(text: string, hostId = 'local', cwd = '') {
  return marked.lexer(text).filter(token => token.type !== 'space').map((token, index) => {
    const html = cached(JSON.stringify(['block', hostId, cwd, token]), () => sanitizeMarkdown(marked.parser([token]) as string, hostId, cwd));
    return { id: index, html };
  });
}
