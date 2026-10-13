<script setup lang="ts">
import { ref, useId } from 'vue';
import Icon from './Icon.vue';
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ copy: [format: 'link' | 'markdown' | 'cwd'] }>();
const open = ref(false);
const id = `thread-copy-${useId()}`;
function choose(format: 'link' | 'markdown' | 'cwd') { open.value = false; emit('copy', format); }
</script>
<template>
  <div class="thread-copy-menu" @keydown.esc.stop="open = false">
    <button :disabled="disabled" :aria-expanded="open" :aria-controls="id" @click="open = !open">
      <Icon name="Copy" :size="14" />复制<Icon class="copy-chevron" :name="open ? 'ChevronDown' : 'ChevronRight'" :size="14" />
    </button>
    <div v-if="open" :id="id" class="thread-copy-options" role="group" aria-label="复制对话">
      <button :disabled="disabled" @click="choose('link')"><Icon name="Link" :size="14" />复制深度链接</button>
      <button :disabled="disabled" @click="choose('markdown')"><Icon name="FileText" :size="14" />复制为 Markdown</button>
      <button :disabled="disabled" @click="choose('cwd')"><Icon name="Folder" :size="14" />复制工作目录</button>
    </div>
  </div>
</template>
<style scoped>
.copy-chevron { margin-left: auto; }
.thread-copy-options { margin: 3px 0 5px 13px; padding-left: 4px; border-left: 1px solid var(--border); }
</style>
