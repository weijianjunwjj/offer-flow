<script setup lang="ts">
/**
 * 岗位雷达三阶段步骤条（纯展示 + 事件）。
 *
 * 用途：给用户一条稳定的主线心智——收集岗位 → 审核处理 → 晋升跟踪。
 * 边界：不含路由与业务逻辑；点击某阶段只 emit('navigate', stage)，
 * 由页面用现有路由跳转，保持组件可单测、可复用。
 */
import { computed } from 'vue';

type Stage = 'collect' | 'review' | 'promote';

const props = defineProps<{ current: Stage }>();
const emit = defineEmits<{ (e: 'navigate', stage: Stage): void }>();

const STEPS: { key: Stage; index: number; title: string; desc: string }[] = [
  { key: 'collect', index: 1, title: '收集岗位', desc: '采集当前页并写入草稿库' },
  { key: 'review', index: 2, title: '审核处理', desc: '登记重复与变化、生成建议' },
  { key: 'promote', index: 3, title: '晋升跟踪', desc: '晋升为正式记录并在台账跟踪' },
];

const currentIndex = computed(() => STEPS.find((s) => s.key === props.current)?.index ?? 1);

function stateOf(index: number): 'done' | 'active' | 'todo' {
  if (index < currentIndex.value) return 'done';
  if (index === currentIndex.value) return 'active';
  return 'todo';
}
</script>

<template>
  <nav class="stage-stepper" data-testid="radar-stage-stepper" aria-label="岗位雷达主线">
    <button
      v-for="step in STEPS"
      :key="step.key"
      type="button"
      class="step"
      :class="`is-${stateOf(step.index)}`"
      :data-testid="`radar-stage-${step.key}`"
      :aria-current="step.key === current ? 'step' : undefined"
      @click="emit('navigate', step.key)"
    >
      <span class="dot">{{ stateOf(step.index) === 'done' ? '✓' : step.index }}</span>
      <span class="body">
        <span class="title">{{ step.title }}</span>
        <span class="desc">{{ step.desc }}</span>
      </span>
    </button>
  </nav>
</template>

<style scoped>
.stage-stepper { display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; }
.step {
  display: flex; align-items: center; gap: 10px; flex: 1; min-width: 200px;
  padding: 12px 14px; text-align: left; cursor: pointer;
  border: 1px solid var(--of-line, rgba(15, 23, 42, 0.08)); border-radius: 10px;
  background: #fff; color: var(--of-ink, #0f172a); transition: border-color .15s, box-shadow .15s;
}
.step:hover { border-color: var(--of-brand, #2563eb); }
.dot {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; flex: none; border-radius: 50%; font-size: 13px; font-weight: 700;
  background: rgba(15, 23, 42, 0.06); color: var(--of-ink-2, #475569);
}
.body { display: flex; flex-direction: column; gap: 2px; }
.title { font-weight: 600; font-size: 13px; }
.desc { font-size: 12px; color: var(--of-ink-2, #475569); }
.is-active { border-color: var(--of-brand, #2563eb); box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.12); }
.is-active .dot { background: var(--of-brand, #2563eb); color: #fff; }
/* 已完成：品牌色实心 + ✓，与 active 靠边框/投影区分，避免引入调色板外的绿色 */
.is-done .dot { background: var(--of-brand, #2563eb); color: #fff; opacity: 0.72; }
.is-todo { color: var(--of-ink-2, #475569); }
</style>
