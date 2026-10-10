<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue';
import type { ConversationBookmark } from '../../shared/bookmarks';
import Icon from './Icon.vue';

const props = defineProps<{
  entries: ConversationBookmark[];
  projectName: string;
  loading?: boolean;
  error?: string;
  busyId?: string;
}>();
const emit = defineEmits<{
  close: [];
  open: [entry: ConversationBookmark];
  rename: [entry: ConversationBookmark];
  remove: [entry: ConversationBookmark];
  refresh: [];
}>();
const dialog = ref<HTMLDialogElement>();
const search = ref('');
const titleId = `bookmarks-title-${useId()}`;
const entries = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  if (!needle) return props.entries;
  return props.entries.filter(entry =>
    [entry.name, entry.source.threadName || '', entry.source.text]
      .some(text => text.toLocaleLowerCase().includes(needle)),
  );
});
function time(value: string | number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : '';
}
function close() { if (!props.busyId) emit('close'); }
watch(() => props.projectName, () => { search.value = ''; });
onMounted(() => dialog.value?.showModal());
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="bookmarks-panel" :aria-labelledby="titleId" @cancel.prevent="close">
      <header class="bookmarks-header">
        <div class="bookmarks-heading">
          <Icon name="Bookmark" :size="20" />
          <div><h2 :id="titleId">收藏对话</h2><p>{{ projectName }}</p></div>
        </div>
        <button type="button" class="icon-button" aria-label="关闭收藏对话" :disabled="!!busyId" @click="close"><Icon name="X" :size="19" /></button>
      </header>
      <div class="bookmarks-tools">
        <label class="bookmarks-search"><Icon name="Search" :size="15" /><input v-model="search" type="search" placeholder="搜索收藏…" aria-label="搜索收藏" /></label>
        <button type="button" class="icon-button" aria-label="刷新收藏" :disabled="loading || !!busyId" @click="emit('refresh')"><Icon :name="loading ? 'LoaderCircle' : 'RefreshCw'" :size="17" :class="{ spin: loading }" /></button>
      </div>
      <p v-if="error" class="bookmarks-error" role="alert">{{ error }}</p>
      <div class="bookmarks-content" :aria-busy="loading">
        <p v-if="loading && !entries.length" class="bookmarks-empty" role="status">正在加载收藏…</p>
        <ul v-else-if="entries.length" class="bookmarks-list">
          <li v-for="entry in entries" :key="entry.id" class="bookmark-entry" :class="{ busy: busyId === entry.id }">
            <button type="button" class="bookmark-open" :disabled="!!busyId" :aria-label="`跳转到收藏 ${entry.name}`" @click="emit('open', entry)">
              <span class="bookmark-name">{{ entry.name }}<Icon name="ArrowUpRight" :size="15" /></span>
              <span class="bookmark-excerpt">{{ entry.source.text }}</span>
              <span class="bookmark-meta"><span>{{ entry.source.threadName || '未命名对话' }}</span><time>{{ time(entry.createdAt) }}</time></span>
            </button>
            <div class="bookmark-actions">
              <button type="button" class="icon-button" :disabled="!!busyId" :aria-label="`重命名收藏 ${entry.name}`" title="重命名收藏" @click="emit('rename', entry)"><Icon name="Pencil" :size="15" /></button>
              <button type="button" class="icon-button" :disabled="!!busyId" :aria-label="`取消收藏 ${entry.name}`" title="取消收藏" @click="emit('remove', entry)"><Icon :name="busyId === entry.id ? 'LoaderCircle' : 'Trash2'" :size="15" :class="{ spin: busyId === entry.id }" /></button>
            </div>
          </li>
        </ul>
        <div v-else class="bookmarks-empty"><Icon name="Bookmark" :size="24" /><p>{{ search.trim() ? '没有匹配的收藏' : '此项目还没有收藏' }}</p><span v-if="!search.trim()">选中对话中的文字，点击“收藏”即可保存位置。</span></div>
      </div>
      <footer><span>{{ search.trim() ? `${entries.length} / ${props.entries.length}` : props.entries.length }} 条收藏</span><span>点击收藏可回到原文</span></footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.bookmarks-panel { display: flex; flex-direction: column; width: min(600px, calc(100vw - 28px)); max-height: min(720px, calc(100dvh - 40px)); margin: auto; padding: 0; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); color: var(--text); box-shadow: 0 18px 70px #0003; overflow: hidden; }
.bookmarks-panel:not([open]) { display: none; }
.bookmarks-panel::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
.bookmarks-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 20px 22px 16px; }
.bookmarks-heading { display: flex; align-items: center; gap: 11px; min-width: 0; }
.bookmarks-heading > svg { flex: none; }
.bookmarks-heading > div { min-width: 0; }
h2 { margin: 0; font-size: 17px; line-height: 1.5; font-weight: 600; }
.bookmarks-heading p { overflow: hidden; margin: 3px 0 0; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.bookmarks-tools { display: flex; gap: 9px; align-items: center; padding: 0 22px 16px; border-bottom: 1px solid var(--border); }
.bookmarks-search { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); color: var(--muted); }
.bookmarks-search:focus-within { border-color: var(--green); }
.bookmarks-search svg { flex: none; }
.bookmarks-search input { width: 100%; min-width: 0; padding: 0; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-size: 13px; }
.bookmarks-content { min-height: 130px; overflow-y: auto; overscroll-behavior: contain; }
.bookmarks-list { margin: 0; padding: 8px 12px; list-style: none; }
.bookmark-entry { display: flex; align-items: flex-start; gap: 2px; border-radius: 11px; }
.bookmark-entry:hover { background: var(--hover); }
.bookmark-open { flex: 1; display: flex; flex-direction: column; align-items: stretch; min-width: 0; padding: 13px 10px; border: 0; border-radius: 10px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.bookmark-open:focus-visible, .bookmark-actions button:focus-visible { outline: 2px solid var(--green); outline-offset: -2px; }
.bookmark-name { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.bookmark-name svg { flex: none; margin-top: 3px; color: var(--muted); }
.bookmark-excerpt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; margin-top: 6px; color: var(--muted); font-size: 12px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.bookmark-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 9px; color: var(--muted); font-size: 11px; line-height: 1.5; }
.bookmark-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bookmark-meta time { flex: none; }
.bookmark-actions { display: flex; flex: none; align-items: center; padding: 11px 3px 0 0; }
.bookmark-actions .icon-button { width: 30px; height: 30px; }
.bookmark-open:disabled, .bookmark-actions button:disabled { cursor: default; opacity: .6; }
.bookmarks-error { margin: 12px 22px 0; padding: 9px 11px; border: 1px solid var(--border); border-radius: 9px; color: var(--danger, #b54a40); font-size: 13px; overflow-wrap: anywhere; }
.bookmarks-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 34px 24px; color: var(--muted); text-align: center; font-size: 13px; }
.bookmarks-empty p { margin: 3px 0 0; }
.bookmarks-empty span { font-size: 12px; line-height: 1.6; }
footer { display: flex; justify-content: space-between; gap: 10px; padding: 12px 22px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; }
@media (max-width: 760px) {
  .bookmarks-panel { width: calc(100vw - 20px); max-height: calc(100dvh - 24px); border-radius: 16px; }
  .bookmarks-header { padding: 17px 16px 14px; }
  .bookmarks-tools { padding: 0 16px 14px; }
  .bookmarks-search { min-height: 42px; }
  .bookmarks-search input { font-size: 16px; }
  .bookmarks-list { padding: 6px; }
  .bookmark-actions { flex-direction: column; padding: 8px 2px 0 0; }
  .bookmark-actions .icon-button { width: 38px; height: 38px; }
  .bookmark-open { padding: 12px 10px; }
  .bookmarks-error { margin-left: 16px; margin-right: 16px; }
  footer { padding: 12px 16px; }
}
</style>
