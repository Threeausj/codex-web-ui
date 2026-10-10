import { inject, provide, shallowRef } from 'vue';
import type { InjectionKey } from 'vue';

export type ConversationImagePreview = {
  src: string;
  name: string;
  hostId: string;
  threadId?: string;
};

export function conversationImageUrl(path: string, hostId: string) {
  return `/api/hosts/${encodeURIComponent(hostId)}/images?${new URLSearchParams({ path })}`;
}

/** Reuse an already displayed image; never route arbitrary URLs through the server. */
export function safeConversationImageSource(src: string, hostId: string, origin = typeof window === 'undefined' ? undefined : window.location.origin) {
  if (!src || /[\u0000-\u001f\u007f]/.test(src)) return false;
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(src)) return true;
  if (/^(?:https?:|blob:)/i.test(src)) {
    try {
      const url = new URL(src);
      if (url.origin === origin && url.pathname.startsWith('/api/')) return safeConversationImageSource(`${url.pathname}${url.search}`, hostId, origin);
      return ['http:', 'https:', 'blob:'].includes(url.protocol);
    } catch { return false; }
  }
  try {
    const endpoint = `/api/hosts/${encodeURIComponent(hostId)}/images`;
    const parsed = new URL(src, 'https://conversation.invalid');
    return src.startsWith(`${endpoint}?`) && parsed.pathname === endpoint &&
      parsed.searchParams.getAll('path').length === 1 && !!parsed.searchParams.get('path') &&
      [...parsed.searchParams.keys()].every(key => key === 'path');
  } catch { return false; }
}

export function createConversationImageViewer() {
  const image = shallowRef<ConversationImagePreview | null>(null);
  return {
    image,
    open(input: ConversationImagePreview) {
      if (!safeConversationImageSource(input.src, input.hostId)) return false;
      image.value = { ...input, name: input.name || '图片' };
      return true;
    },
    close() { image.value = null; },
  };
}

type ConversationImageViewer = ReturnType<typeof createConversationImageViewer>;
const key: InjectionKey<ConversationImageViewer> = Symbol('conversation-image-viewer');
export function provideConversationImageViewer() {
  const viewer = createConversationImageViewer();
  provide(key, viewer);
  return viewer;
}
export function conversationImageViewer() { return inject(key, null); }
