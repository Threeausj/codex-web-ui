import { conversationMarkdown } from './conversation-markdown';

export const COMPOSER_PREVIEW_LIMIT = 100_000;

/** Drafts remain plain Markdown. Only an explicitly opened preview is parsed. */
export function composerMarkdownPreview(source: string, hostId: string, cwd: string) {
  const truncated = source.length > COMPOSER_PREVIEW_LIMIT;
  const container = document.createElement('div');
  container.innerHTML = conversationMarkdown(source.slice(0, COMPOSER_PREVIEW_LIMIT), hostId, cwd);
  for (const link of container.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  for (const image of container.querySelectorAll<HTMLImageElement>('img')) {
    // A draft preview is read-only and does not use the conversation lightbox.
    image.removeAttribute('role');
    image.removeAttribute('tabindex');
    image.removeAttribute('aria-label');
    delete image.dataset.conversationImage;
    image.loading = 'lazy';
    image.decoding = 'async';
  }
  return { html: container.innerHTML, truncated };
}
