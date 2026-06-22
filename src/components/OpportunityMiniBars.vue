<script setup lang="ts">
// 机会分迷你 6 维条（原生 SVG，不引图表库 / 延续 DEC-017）。
// 极小尺寸的 6 根竖条，暗示「为什么是这个机会分」。纯展示，空 / 异常数据按 0 处理、不报错。
import { computed } from 'vue';
import type { OpportunityRadar } from '../storage';

const props = defineProps<{ radar: OpportunityRadar }>();

// 顺序与雷达轴一致：薪资 / 成长 / 匹配 / 风险可控 / 通勤 / 稳定。
const keys: (keyof OpportunityRadar)[] = [
  'salaryScore',
  'growthScore',
  'matchScore',
  'riskControlScore',
  'commuteScore',
  'stabilityScore',
];

const W = 62;
const H = 20;
const GAP = 3;
const BAR = (W - GAP * (keys.length - 1)) / keys.length;

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

const bars = computed(() =>
  keys.map((k, i) => {
    const v = clamp(props.radar[k]);
    const h = Math.max(1, (v / 100) * H);
    return { x: i * (BAR + GAP), y: H - h, w: BAR, h, low: v < 60 };
  }),
);
</script>

<template>
  <svg
    class="mini-bars"
    :viewBox="`0 0 ${W} ${H}`"
    :width="W"
    :height="H"
    role="img"
    aria-label="机会分 6 维构成"
  >
    <rect
      v-for="(b, i) in bars"
      :key="i"
      :x="b.x"
      :y="b.y"
      :width="b.w"
      :height="b.h"
      rx="1"
      class="mini-bar"
      :class="{ low: b.low }"
    />
  </svg>
</template>

<style scoped>
.mini-bars {
  display: block;
}
.mini-bar {
  fill: var(--of-brand, #2563eb);
  opacity: 0.85;
}
.mini-bar.low {
  fill: #f59e0b;
  opacity: 0.9;
}
</style>
