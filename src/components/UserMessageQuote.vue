<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { conversationMarkdown } from '../lib/conversation-markdown';
import { collapseUserMessageQuote, userMessageQuotePreview, type UserMessageQuote } from '../lib/user-message-quotes';

const props = defineProps<{ quote: UserMessageQuote; hostId?: string; cwd?: string }>();
const expanded = ref(!collapseUserMessageQuote(props.quote.text));
watch(() => props.quote.text, text => { expanded.value = !collapseUserMessageQuote(text); });
const label = computed(() => props.quote.kind === 'file' ? '引用文件' : '引用对话');
const preview = computed(() => userMessageQuotePreview(props.quote.text));
const html = computed(() => expanded.value ? conversationMarkdown(props.quote.text, props.hostId, props.cwd) : '');
</script>

<template>
  <section class="user-quote" :class="{ 'user-quote-expanded': expanded }" :aria-label="`${label}：${quote.name}`">
    <button type="button" class="user-quote-heading" :aria-label="`${expanded ? '收起引用' : '展开引用'} ${quote.name}`" :aria-expanded="expanded" data-selection-ignore="true" @click="expanded = !expanded">
      <Icon :name="quote.kind === 'file' ? 'FileText' : 'Quote'" :size="15" />
      <span class="user-quote-source"><span class="user-quote-kind">{{ label }}</span><span class="user-quote-name" :title="quote.name">{{ quote.name }}</span></span>
      <span class="user-quote-action">{{ expanded ? '收起' : '展开' }}</span><Icon name="ChevronDown" :size="13" class="user-quote-chevron" />
    </button>
    <div v-if="expanded" class="user-quote-body markdown" v-html="html"></div>
    <button v-else type="button" class="user-quote-preview" :aria-label="`展开引用正文 ${quote.name}`" data-selection-ignore="true" @click="expanded = true"><span>{{ preview }}</span></button>
  </section>
</template>

<style scoped>
.user-quote { min-width: 0; max-width: 100%; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); white-space: normal; overflow: hidden; }
.user-quote-heading { width: 100%; min-height: 35px; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 11px; line-height: 1.4; text-align: left; cursor: pointer; }
.user-quote-heading > svg { flex: none; }
.user-quote-heading:hover, .user-quote-preview:hover { background: var(--hover); }
.user-quote-heading:focus-visible, .user-quote-preview:focus-visible { outline: 2px solid var(--green); outline-offset: -2px; }
.user-quote-source { min-width: 0; flex: 1; display: flex; align-items: baseline; gap: 7px; }
.user-quote-kind { flex: none; font-size: 10px; }
.user-quote-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 12px; font-weight: 500; }
.user-quote-action { flex: none; font-size: 10px; }
.user-quote-chevron { transition: transform .15s; }
.user-quote-expanded .user-quote-chevron { transform: rotate(180deg); }
.user-quote-preview { display: block; width: 100%; padding: 0 10px 10px 33px; border: 0; color: var(--muted); background: transparent; font: inherit; font-size: 12px; line-height: 1.65; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.user-quote-preview > span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.user-quote-body { padding: 0 12px 11px; font-size: 12px; line-height: 1.7; }
.user-quote-body :deep(> :first-child) { margin-top: 0; }
.user-quote-body :deep(p) { margin-bottom: 8px; }
.user-quote-body :deep(ul), .user-quote-body :deep(ol) { margin: 6px 0 8px; padding-left: 20px; }
.user-quote-body :deep(h1), .user-quote-body :deep(h2), .user-quote-body :deep(h3), .user-quote-body :deep(h4) { margin: 12px 0 7px; font-size: 13px; }
.user-quote-body :deep(pre) { margin: 8px 0; padding: 8px 10px; font-size: 11px; border-radius: 7px; }
.user-quote-body :deep(table) { margin: 8px 0; }
.user-quote-body :deep(th), .user-quote-body :deep(td) { min-width: 60px; padding: 5px 8px; }
.user-quote-body :deep(blockquote) { margin: 8px 0; padding: 1px 10px; }
.user-quote-body :deep(.katex-display) { margin: 8px 0; }
@media (max-width: 760px) {
  .user-quote-heading { min-height: 42px; gap: 6px; padding: 9px; }
  .user-quote-source { gap: 5px; }
  .user-quote-kind { font-size: 9px; }
  .user-quote-name { font-size: 12px; }
  .user-quote-preview { padding-left: 30px; }
  .user-quote-body { padding: 0 10px 10px; font-size: 13px; }
}
</style>
