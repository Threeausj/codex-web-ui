import { computed } from 'vue';
import type { DisplayItem } from './events';
import { conversationBlocks, turnPresentation } from './presentation';

export function useConversationView(items: () => DisplayItem[], turns: () => any[]) {
  const groups = computed(() => conversationBlocks(items(), turns()).map(block =>
    computed(() => block.kind === 'message' ? block : { ...block, ...turnPresentation(block.items) })));
  return computed(() => groups.value.map(group => group.value));
}
