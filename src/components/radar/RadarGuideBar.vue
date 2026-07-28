<script setup lang="ts">
/**
 * 页面三问引导条（纯展示）。
 *
 * 用途：每个雷达页面顶部固定回答三个问题——这是做什么 / 现在做什么 /
 * 完成后去哪，降低"我在哪、下一步是什么"的认知负担。
 * 边界：无逻辑、无路由，只渲染传入文案。
 */
defineProps<{
  /** 这是做什么：本页职责一句话。 */
  what: string;
  /** 现在做什么：用户此刻该做的一步。 */
  now: string;
  /** 完成后去哪：完成本页后主线的下一站。 */
  next: string;
}>();
</script>

<template>
  <section class="guide-bar" data-testid="radar-guide-bar">
    <div class="item" data-testid="radar-guide-what">
      <span class="label">这是做什么</span>
      <span class="text">{{ what }}</span>
    </div>
    <div class="item" data-testid="radar-guide-now">
      <span class="label">现在做什么</span>
      <span class="text">{{ now }}</span>
    </div>
    <div class="item" data-testid="radar-guide-next">
      <span class="label">完成后去哪</span>
      <span class="text">{{ next }}</span>
    </div>
  </section>
</template>

<style scoped>
.guide-bar {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
  padding: 14px 16px; border: 1px solid var(--of-line, rgba(15, 23, 42, 0.08));
  border-radius: 10px; background: var(--of-bg, #f6f8fc);
}
.item { display: flex; flex-direction: column; gap: 4px; }
.label { font-size: 12px; font-weight: 700; letter-spacing: .04em; color: var(--of-brand, #2563eb); }
.text { font-size: 13px; color: var(--of-ink, #0f172a); line-height: 1.5; }
@media (max-width: 860px) { .guide-bar { grid-template-columns: 1fr; } }
</style>
