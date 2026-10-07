<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{
  title: string;
  points: { at: number; values: (number | null)[] }[];
  labels: string[];
  percent?: boolean;
}>();
const palette = ['#2587eb', '#8b6be8'];
const ceiling = computed(() => props.percent ? 100 : Math.max(1,
  ...props.points.flatMap(point => point.values.filter((value): value is number => value != null && Number.isFinite(value))),
) * 1.15);
function unit(value: number) {
  if (props.percent) return Math.round(value) + '%';
  if (value >= 1048576) return (value / 1048576).toFixed(1) + ' MiB/s';
  if (value >= 1024) return (value / 1024).toFixed(1) + ' KiB/s';
  return Math.round(value) + ' B/s';
}
const lines = computed(() => props.labels.map((_, series) => {
  let pen = false;
  const first = props.points[0]?.at ?? 0;
  const duration = Math.max(1, (props.points.at(-1)?.at ?? first) - first);
  return props.points.map(point => {
    const value = point.values[series];
    if (value == null || !Number.isFinite(value)) { pen = false; return ''; }
    const x = 75 + Math.min(1, Math.max(0, (point.at - first) / duration)) * 500;
    const y = 155 - Math.min(ceiling.value, Math.max(0, value)) * 135 / ceiling.value;
    const command = pen ? 'L' : 'M'; pen = true;
    return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}));
const latest = computed(() => props.points.at(-1));
const summary = computed(() => props.labels.map((label, index) =>
  `${label} ${latest.value?.values[index] == null ? '等待采样' : unit(latest.value.values[index]!)}`,
).join('，'));
const time = (at?: number) => at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
</script>

<template>
  <div class="resource-chart">
    <div class="chart-legend"><span v-for="(label, index) in labels" :key="label"><i :style="{ background: palette[index] }" />{{ label }}</span></div>
    <svg viewBox="0 0 600 185" role="img" :aria-label="`${title}趋势：${summary}`">
      <g v-for="fraction in [0, .25, .5, .75, 1]" :key="fraction">
        <line x1="75" x2="575" :y1="155 - fraction * 135" :y2="155 - fraction * 135" class="chart-grid" />
        <text x="65" :y="159 - fraction * 135" text-anchor="end">{{ unit(ceiling * fraction) }}</text>
      </g>
      <path v-for="(line, index) in lines" :key="index" :d="line" :stroke="palette[index]" fill="none" stroke-width="2.5" />
      <circle v-if="points.length === 1" v-for="(value, index) in points[0].values" :key="index" v-show="value != null" cx="75" :cy="155 - (value || 0) * 135 / ceiling" r="3" :fill="palette[index]" />
      <text x="75" y="180">{{ time(points[0]?.at) }}</text>
      <text x="575" y="180" text-anchor="end">{{ points.length > 1 ? time(latest?.at) : '' }}</text>
    </svg>
  </div>
</template>

<style scoped>
.resource-chart { min-width: 0; }
.chart-legend { display: flex; justify-content: center; gap: 16px; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
.chart-legend span { display: flex; align-items: center; gap: 6px; }
.chart-legend i { width: 14px; height: 3px; border-radius: 2px; }
svg { display: block; width: 100%; height: auto; min-height: 115px; }
svg text { fill: var(--muted); font-size: 11px; font-family: inherit; }
.chart-grid { stroke: var(--border); stroke-width: 1; }
</style>
