import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { isImagePath, previewFilePath } from './file-preview';

export function conversationMarkdown(text: string, hostId = 'local', cwd = '') {
  const fragment = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
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
