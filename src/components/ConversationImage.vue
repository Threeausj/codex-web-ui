<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from './Icon.vue';
const props = defineProps<{ path: string; hostId: string }>();
const emit = defineEmits<{ openFile: [path: string] }>();
const failed = ref(false);
const name = computed(() => props.path.split('/').pop() || '图片');
const src = computed(() => `/api/hosts/${encodeURIComponent(props.hostId)}/images?${new URLSearchParams({ path: props.path })}`);
watch(src, () => { failed.value = false; });
</script>
<template>
  <button class="conversation-image" :class="{ 'image-unavailable': failed }" :aria-label="`查看图片 ${name}`" :title="failed ? '图片无法加载，点击在工作区查看' : name" @click="emit('openFile', path)">
    <img v-if="!failed" :key="src" :src="src" :alt="name" loading="lazy" decoding="async" @error="failed = true" />
    <span v-else><Icon name="Image" :size="16" />{{ name }} · 图片无法加载<Icon name="Eye" :size="14" /></span>
  </button>
</template>
<style scoped>
.conversation-image { display: block; max-width: 100%; border-radius: 10px; overflow: hidden; }
.conversation-image img { display: block; max-width: min(360px, 100%); max-height: 260px; object-fit: contain; border: 1px solid var(--border); border-radius: 10px; }
.image-unavailable { padding: 8px 10px; background: var(--soft); color: var(--muted); font-size: 12px; }
.image-unavailable span { display: flex; align-items: center; gap: 6px; }
</style>
