<script setup lang="ts">
import { ref } from 'vue'
import Icon from './Icon.vue'
import { clipboardFiles } from '../lib/clipboard'
import type { MessageEditAttachment } from '../lib/message-edit'

const props = defineProps<{ attachments: MessageEditAttachment[]; disabled?: boolean; uploading?: boolean }>()
const emit = defineEmits<{ upload: [files: File[], clipboard: boolean]; remove: [index: number] }>()
const input = ref<HTMLInputElement>()
const dropping = ref(false)
function upload(files: FileList | File[] | null, clipboard = false) {
  if (!files?.length || props.disabled || props.uploading) return
  emit('upload', Array.from(files), clipboard)
}
function paste(event: ClipboardEvent) {
  const files = clipboardFiles(event.clipboardData)
  if (!files.length) return
  if (!event.clipboardData?.getData('text/plain')) event.preventDefault()
  upload(files, true)
}
function drop(event: DragEvent) {
  dropping.value = false
  upload(event.dataTransfer?.files ?? null)
}
</script>

<template>
  <div class="edit-attachment-area" :class="{ dropping }" @paste="paste" @dragover.prevent="dropping = !disabled && !uploading" @dragleave="dropping = false" @drop.prevent="drop">
    <div v-if="attachments.length" class="edit-attachments" aria-label="编辑消息附件">
      <div v-for="(attachment, index) in attachments" :key="attachment.id" class="edit-attachment">
        <img v-if="attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" />
        <Icon v-else :name="attachment.input ? 'Image' : 'FileText'" :size="19" />
        <span :title="attachment.name">{{ attachment.name }}</span>
        <button type="button" class="icon-button" :disabled="disabled || uploading" :aria-label="`移除编辑附件 ${attachment.name}`" @click="emit('remove', index)"><Icon name="X" :size="14" /></button>
      </div>
    </div>
    <slot />
    <div class="edit-attachment-toolbar">
      <input ref="input" class="sr-only" type="file" multiple aria-label="上传编辑附件" :disabled="disabled || uploading" @change="upload(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''" />
      <button type="button" class="button button-small button-secondary" :disabled="disabled || uploading" @click="input?.click()"><Icon :name="uploading ? 'LoaderCircle' : 'Paperclip'" :size="15" :class="{ spin: uploading }" />{{ uploading ? '正在上传…' : '添加文件或图片' }}</button>
      <span>支持粘贴或拖入附件</span>
    </div>
  </div>
</template>

<style scoped>
.edit-attachment-area { border-radius: 8px; }
.edit-attachment-area.dropping { outline: 2px dashed var(--green); outline-offset: 3px; }
.edit-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.edit-attachment { display: flex; align-items: center; gap: 7px; min-width: 0; max-width: 100%; padding: 5px 7px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); font-size: 12px; }
.edit-attachment > img { width: 34px; height: 34px; object-fit: cover; border-radius: 5px; }
.edit-attachment > span { min-width: 0; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.edit-attachment .icon-button { flex-shrink: 0; width: 27px; height: 27px; }
.edit-attachment-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.edit-attachment-toolbar > span { font-size: 11px; color: var(--muted); }
@media (max-width: 760px) { .edit-attachment-toolbar .button { min-height: 36px; } .edit-attachment > span { max-width: 170px; } }
</style>
