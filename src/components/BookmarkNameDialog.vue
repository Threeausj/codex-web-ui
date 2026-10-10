<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{
  mode: 'add' | 'rename';
  initialName: string;
  excerpt?: string;
  busy?: boolean;
  error?: string;
}>();
const emit = defineEmits<{ close: []; save: [name: string] }>();
const dialog = ref<HTMLDialogElement>();
const input = ref<HTMLInputElement>();
const name = ref(props.initialName);
const titleId = `bookmark-name-title-${useId()}`;
const inputId = `bookmark-name-input-${useId()}`;
const valid = computed(() => !!name.value.trim() && name.value.trim().length <= 160);
function close() { if (!props.busy) emit('close'); }
function save() { if (!props.busy && valid.value) emit('save', name.value.trim()); }
watch(() => props.initialName, value => { name.value = value; });
onMounted(async () => {
  dialog.value?.showModal();
  await nextTick();
  input.value?.focus();
  input.value?.select();
});
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="bookmark-name-dialog" :aria-labelledby="titleId" @cancel.prevent="close">
      <form @submit.prevent="save">
        <header><h2 :id="titleId"><Icon name="Bookmark" :size="19" />{{ mode === 'add' ? '收藏对话' : '重命名收藏' }}</h2><button type="button" class="icon-button" :disabled="busy" aria-label="关闭收藏名称编辑" @click="close"><Icon name="X" :size="18" /></button></header>
        <label :for="inputId">收藏名称</label>
        <input :id="inputId" ref="input" v-model="name" class="bookmark-name-input" aria-label="收藏名称" placeholder="为这段对话起个名字" maxlength="160" required :disabled="busy" autofocus />
        <p v-if="excerpt" class="bookmark-name-excerpt">{{ excerpt }}</p>
        <p v-if="error" class="bookmark-name-error" role="alert">{{ error }}</p>
        <footer><button type="button" class="button button-secondary" :disabled="busy" @click="close">取消</button><button type="submit" class="button button-primary" :disabled="busy || !valid">{{ busy ? '保存中…' : mode === 'add' ? '收藏' : '保存名称' }}</button></footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.bookmark-name-dialog { width: min(430px, calc(100vw - 28px)); max-height: calc(100dvh - 32px); margin: auto; padding: 22px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); color: var(--text); box-shadow: 0 18px 70px #0003; overflow-y: auto; }
.bookmark-name-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 17px; font-weight: 600; }
label { display: block; margin-bottom: 8px; font-size: 13px; }
.bookmark-name-input { width: 100%; padding: 11px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text); font: inherit; font-size: 14px; }
.bookmark-name-input:focus { outline: 2px solid var(--green); outline-offset: -1px; }
.bookmark-name-excerpt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; margin: 16px 0 0; padding-left: 10px; border-left: 2px solid var(--border); color: var(--muted); font-size: 12px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.bookmark-name-error { margin: 15px 0 0; color: var(--danger, #b54a40); font-size: 13px; overflow-wrap: anywhere; }
footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
@media (max-width: 760px) { .bookmark-name-dialog { padding: 20px 18px; } .bookmark-name-input { font-size: 16px; } footer .button { min-height: 42px; } }
</style>
