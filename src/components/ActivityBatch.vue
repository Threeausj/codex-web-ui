<script setup lang="ts">
import { historyDisclosures } from "../lib/history-disclosures";
import { computed, ref, watch } from 'vue';
import ChatItem from './ChatItem.vue';
import Icon from './Icon.vue';
import { activityBatchSummary } from '../lib/activity-presentation';
import type { DisplayItem } from '../lib/events';

const props = defineProps<{ items: DisplayItem[]; hostId?: string; threadId?: string; cwd?: string; busy?: boolean }>();
const emit = defineEmits<{ openFile: [path: string, line?: number]; error: [message: string] }>();
const disclosures = historyDisclosures();
const identity = props.items[0]?.id || '';
const expanded = ref(disclosures?.batches.has(identity) || false);
watch(expanded, value => { if (value) disclosures?.batches.add(identity); else disclosures?.batches.delete(identity); });
const summary = computed(() => activityBatchSummary(props.items));
</script>

<template>
  <details class="activity-batch" :open="expanded" @toggle="expanded = ($event.currentTarget as HTMLDetailsElement).open" :class="{ 'activity-batch-failed': summary.failed }">
    <summary>
      <Icon :name="summary.running ? 'LoaderCircle' : 'ListChecks'" :size="16" :class="{ spin: summary.running }" />
      <span class="activity-batch-label">{{ summary.label }}</span>
      <span v-if="summary.status" class="activity-batch-status" aria-live="polite">{{ summary.status }}</span>
      <Icon name="ChevronDown" :size="13" />
    </summary>
    <div v-if="expanded" class="activity-batch-items">
      <ChatItem v-for="item in items" :key="item.id" :item="item" :host-id="hostId" :thread-id="threadId" :cwd="cwd" :busy="busy" collapse-tools @open-file="(path, line) => emit('openFile', path, line)" @error="emit('error', $event)" />
    </div>
  </details>
</template>

<style scoped>
.activity-batch { min-width: 0; margin: 4px 0; color: var(--muted); }
.activity-batch > summary { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 0; list-style: none; cursor: pointer; font-size: 12px; line-height: 1.6; }
.activity-batch > summary::-webkit-details-marker { display: none; }
.activity-batch > summary > svg { flex-shrink: 0; }
.activity-batch > summary:hover { color: var(--text); }
.activity-batch-label { min-width: 0; overflow-wrap: anywhere; }
.activity-batch-status { margin-left: auto; font-size: 10px; white-space: nowrap; }
.activity-batch-failed .activity-batch-status { color: var(--red); }
.activity-batch > summary > svg:last-child { transition: transform .15s; }
.activity-batch[open] > summary > svg:last-child { transform: rotate(180deg); }
.activity-batch-items { min-width: 0; margin: 2px 0 8px 24px; }
@media (max-width: 760px) {
  .activity-batch > summary { min-height: 40px; flex-wrap: wrap; row-gap: 0; }
  .activity-batch-label { flex: 1; }
  .activity-batch-status { order: 1; flex-basis: calc(100% - 24px); margin-left: 24px; }
  .activity-batch-items { margin-left: 12px; }
}
</style>
