<script setup lang="ts">
import { computed } from 'vue';
import UserMessageQuote from './UserMessageQuote.vue';
import { userMessageMath } from '../lib/conversation-markdown';
import { userMessageParts } from '../lib/user-message-quotes';

const props = defineProps<{ text: string; hostId?: string; cwd?: string }>();
const parts = computed(() => userMessageParts(props.text).map(part => part.type === 'text' ? { ...part, math: userMessageMath(part.text) } : part));
const hasQuotes = computed(() => parts.value.some(part => part.type === 'quote'));
</script>

<template>
  <div class="user-bubble" :class="{ 'user-bubble-quotes': hasQuotes }">
    <template v-for="(part, index) in parts" :key="index">
      <UserMessageQuote v-if="part.type === 'quote'" :quote="part" :host-id="hostId" :cwd="cwd" />
      <div v-else-if="part.math !== null" class="user-message-text message-math" v-html="part.math"></div>
      <div v-else class="user-message-text">{{ part.text }}</div>
    </template>
  </div>
</template>

<style scoped>
.user-message-text { white-space: pre-wrap; }
.user-bubble-quotes { display: flex; flex-direction: column; gap: 10px; min-width: 0; width: min(85%, 650px); padding: 10px; }
.user-bubble-quotes > .user-message-text { padding: 0 4px; }
@media (max-width: 760px) {
  .user-bubble-quotes { width: 92%; gap: 9px; padding: 9px; }
}
</style>
