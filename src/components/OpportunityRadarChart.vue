<script setup lang="ts">
// Task 8：6 维机会雷达图（原生 SVG，不引入任何图表库 / 见 DEC-017）。
// 纯展示组件：输入一个 OpportunityRadar（每维 0-100），渲染雷达多边形 + 轴标签。
// 值域钳制到 0-100，空 / 异常数据不报错（按 0 处理）。
// 增强（SVG only）：入场动画 / Hover 高亮 + tooltip / 低分维度预警 / 刻度 + 80 分达标参考环。
import { computed, ref } from 'vue';
import type { OpportunityRadar } from '../storage';

const props = defineProps<{ radar: OpportunityRadar }>();

const CX = 140;
const CY = 132;
const R = 96;

/** 低于此分视为短板，顶点 / 标签标红预警 */
const LOW_THRESHOLD = 60;
/** 达标参考线（分），在雷达上画一圈虚线环 */
const GOAL = 80;

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
const goalPolygon = ringPoints(GOAL / 100);
const axisEnds = computed(() => axes.map((_, i) => polar(1, i)));

// 沿竖直（向上）轴标注刻度 25 / 50 / 75 / 100。
const scaleMarks = [0.25, 0.5, 0.75, 1].map((ratio) => ({
  x: CX + 6,
  y: CY - R * ratio,
  label: String(Math.round(ratio * 100)),
}));

const valuePoints = computed(() =>
  axes.map((a, i) => {
    const v = clamp(props.radar[a.key]);
    const p = polar(v / 100, i);
    return { ...p, value: Math.round(v), low: v < LOW_THRESHOLD };
  }),
);
const dataPolygon = computed(() => valuePoints.value.map((p) => `${p.x},${p.y}`).join(' '));
const labels = computed(() =>
  axes.map((a, i) => {
    const p = polar(1.22, i);
    const value = Math.round(clamp(props.radar[a.key]));
    return { ...p, label: a.label, value, low: value < LOW_THRESHOLD };
  }),
);

// Hover 交互：记录当前高亮的维度索引。
const hovered = ref<number | null>(null);

// 顶点透明热区（便于悬停命中）。
const hitPoints = computed(() => axes.map((_, i) => polar(1, i)));

const tooltip = computed(() => {
  if (hovered.value === null) return null;
  const i = hovered.value;
  const vp = valuePoints.value[i];
  const text = `${axes[i].label} ${vp.value}`;
  const width = text.length * 9 + 16;
  // 默认放在顶点上方，靠边时夹紧到 viewBox 内。
  let x = vp.x - width / 2;
  x = Math.max(2, Math.min(280 - width - 2, x));
  let y = vp.y - 34;
  if (y < 2) y = vp.y + 12;
  return { x, y, width, height: 22, text, low: vp.low, anchorX: vp.x };
});
</script>

<template>
  <svg
    class="radar-svg"
    viewBox="0 0 280 264"
    role="img"
    aria-label="6 维机会雷达"
    @mouseleave="hovered = null"
  >
    <defs>
      <linearGradient id="ofRadarFill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(37,99,235,0.28)" />
        <stop offset="100%" stop-color="rgba(14,165,233,0.16)" />
      </linearGradient>
    </defs>

    <!-- 背景网格环 + 轴 -->
    <polygon v-for="(p, i) in rings" :key="'ring' + i" :points="p" class="radar-ring" />
    <line
      v-for="(e, i) in axisEnds"
      :key="'axis' + i"
      :x1="CX"
      :y1="CY"
      :x2="e.x"
      :y2="e.y"
      class="radar-axis"
      :class="{ active: hovered === i }"
    />

    <!-- 80 分达标参考环 -->
    <polygon :points="goalPolygon" class="radar-goal" />

    <!-- 刻度数字 -->
    <text
      v-for="(m, i) in scaleMarks"
      :key="'scale' + i"
      :x="m.x"
      :y="m.y"
      class="radar-scale"
      dominant-baseline="middle"
    >
      {{ m.label }}
    </text>

    <!-- 数据区（入场动画作用于此组） -->
    <g class="radar-data">
      <polygon :points="dataPolygon" class="radar-area" />
      <circle
        v-for="(v, i) in valuePoints"
        :key="'dot' + i"
        :cx="v.x"
        :cy="v.y"
        :r="hovered === i ? 5 : 3.5"
        class="radar-dot"
        :class="{ low: v.low, active: hovered === i }"
      />
    </g>

    <!-- 维度标签 + 数值 -->
    <text
      v-for="(l, i) in labels"
      :key="'label' + i"
      :x="l.x"
      :y="l.y"
      class="radar-label"
      :class="{ low: l.low, active: hovered === i }"
      text-anchor="middle"
    >
      {{ l.label }} {{ l.value }}
    </text>

    <!-- 透明热区：悬停高亮对应维度 -->
    <circle
      v-for="(h, i) in hitPoints"
      :key="'hit' + i"
      :cx="h.x"
      :cy="h.y"
      r="18"
      class="radar-hit"
      @mouseenter="hovered = i"
    />

    <!-- Tooltip -->
    <g v-if="tooltip" class="radar-tip" pointer-events="none">
      <rect
        :x="tooltip.x"
        :y="tooltip.y"
        :width="tooltip.width"
        :height="tooltip.height"
        rx="6"
        class="radar-tip-bg"
        :class="{ low: tooltip.low }"
      />
      <text
        :x="tooltip.x + tooltip.width / 2"
        :y="tooltip.y + tooltip.height / 2 + 1"
        class="radar-tip-text"
        text-anchor="middle"
        dominant-baseline="middle"
      >
        {{ tooltip.text }}
      </text>
    </g>
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
  transition: stroke 0.15s ease;
}
.radar-axis.active {
  stroke: rgba(37, 99, 235, 0.5);
}
.radar-goal {
  fill: none;
  stroke: #f59e0b;
  stroke-width: 1.2;
  stroke-dasharray: 4 4;
  opacity: 0.7;
}
.radar-scale {
  font-size: 8px;
  fill: #94a3b8;
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
  transition: r 0.12s ease;
}
.radar-dot.low {
  stroke: #ef4444;
}
.radar-dot.active {
  fill: #2563eb;
}
.radar-dot.low.active {
  fill: #ef4444;
}
.radar-label {
  font-size: 10px;
  fill: #475569;
  transition: fill 0.15s ease, font-weight 0.15s ease;
}
.radar-label.low {
  fill: #ef4444;
}
.radar-label.active {
  font-weight: 700;
}
.radar-hit {
  fill: transparent;
  cursor: pointer;
}
.radar-tip-bg {
  fill: rgba(15, 23, 42, 0.9);
}
.radar-tip-bg.low {
  fill: rgba(185, 28, 28, 0.92);
}
.radar-tip-text {
  fill: #fff;
  font-size: 11px;
  font-weight: 600;
}

/* 入场动画：数据区从中心生长 + 淡入 */
.radar-data {
  transform-box: view-box;
  transform-origin: 140px 132px;
  animation: radarGrow 0.5s cubic-bezier(0.2, 0.7, 0.2, 1) both;
}
@keyframes radarGrow {
  from {
    transform: scale(0.3);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .radar-data {
    animation: none;
  }
}
</style>
