<script setup lang="ts">
// Task 8：6 维机会雷达图（原生 SVG，不引入任何图表库）。
// 纯展示组件：输入一个 OpportunityRadar（每维 0-100），渲染雷达多边形 + 轴标签。
// 值域钳制到 0-100，空 / 异常数据不报错（按 0 处理）。
import { computed } from 'vue';
import type { OpportunityRadar } from '../storage';

const props = defineProps<{ radar: OpportunityRadar }>();

const CX = 140;
const CY = 132;
const R = 96;

const axes: { key: keyof OpportunityRadar; label: string }[] = [
  { key: 'salaryScore', label: '薪资' },
  { key: 'growthScore', label: '成长' },
  { key: 'matchScore', label: '匹配' },
  { key: 'riskControlScore', label: '风险可控' },
  { key: 'commuteScore', label: '通勤' },
  { key: 'stabilityScore', label: '稳定' },
];

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function polar(ratio: number, i: number): { x: number; y: number } {
  const angle = ((-90 + i * 60) * Math.PI) / 180;
  return { x: CX + R * ratio * Math.cos(angle), y: CY + R * ratio * Math.sin(angle) };
}

function ringPoints(ratio: number): string {
  return axes.map((_, i) => { const p = polar(ratio, i); return `${p.x},${p.y}`; }).join(' ');
}

const rings = [0.25, 0.5, 0.75, 1].map(ringPoints);
const axisEnds = computed(() => axes.map((_, i) => polar(1, i)));
const valuePoints = computed(() =>
  axes.map((a, i) => {
    const v = clamp(props.radar[a.key]);
    const p = polar(v / 100, i);
    return { ...p, value: Math.round(v) };
  }),
);
const dataPolygon = computed(() => valuePoints.value.map((p) => `${p.x},${p.y}`).join(' '));
const labels = computed(() =>
  axes.map((a, i) => {
    const p = polar(1.22, i);
    return { ...p, label: a.label, value: Math.round(clamp(props.radar[a.key])) };
  }),
);
</script>

<template>
  <svg class="radar-svg" viewBox="0 0 280 264" role="img" aria-label="6 维机会雷达">
    <defs>
      <linearGradient id="ofRadarFill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(37,99,235,0.28)" />
        <stop offset="100%" stop-color="rgba(14,165,233,0.16)" />
      </linearGradient>
    </defs>
    <polygon v-for="(p, i) in rings" :key="'ring' + i" :points="p" class="radar-ring" />
    <line
      v-for="(e, i) in axisEnds"
      :key="'axis' + i"
      :x1="CX"
      :y1="CY"
      :x2="e.x"
      :y2="e.y"
      class="radar-axis"
    />
    <polygon :points="dataPolygon" class="radar-area" />
    <circle
      v-for="(v, i) in valuePoints"
      :key="'dot' + i"
      :cx="v.x"
      :cy="v.y"
      r="3.5"
      class="radar-dot"
    />
    <text
      v-for="(l, i) in labels"
      :key="'label' + i"
      :x="l.x"
      :y="l.y"
      class="radar-label"
      text-anchor="middle"
    >
      {{ l.label }} {{ l.value }}
    </text>
  </svg>
</template>

<style scoped>
.radar-svg {
  width: 100%;
  max-width: 300px;
  height: auto;
}
.radar-ring {
  fill: none;
  stroke: rgba(15, 23, 42, 0.08);
}
.radar-axis {
  stroke: rgba(15, 23, 42, 0.08);
}
.radar-area {
  fill: url(#ofRadarFill);
  stroke: #2563eb;
  stroke-width: 2;
}
.radar-dot {
  fill: #fff;
  stroke: #2563eb;
  stroke-width: 2;
}
.radar-label {
  font-size: 10px;
  fill: #475569;
}
</style>
