<script setup lang="ts">
/**
 * 单一主行动卡（每页只呈现一个主 CTA）。
 *
 * 用途：把"下一步做什么"收敛成一张卡、一个主按钮，避免用户在多个同权
 * 按钮间犹豫。支持纯引导（无 cta 时只显示标题与说明，不给按钮）。
 * 边界：无路由、无业务逻辑；点击只 emit('act')，由页面决定跳转/滚动。
 */
withDefaults(defineProps<{
  /** 主标题：此刻最该做的一件事。 */
  title: string;
  /** 补充说明：为什么是这一步（可选）。 */
  hint?: string;
  /** 主按钮文案；为空表示纯引导、不渲染按钮。 */
  cta?: string;
  /** 是否禁用主按钮（如前置条件未满足）。 */
  disabled?: boolean;
  /** 语气：primary 强调主推进，subtle 用于收尾/完成态。 */
  tone?: 'primary' | 'subtle';
}>(), { hint: '', cta: '', disabled: false, tone: 'primary' });

import { NButton } from 'naive-ui';

const emit = defineEmits<{ (e: 'act'): void }>();
</script>

<template>
  <section class="next-action" :class="`tone-${tone}`" data-testid="radar-next-action">
    <div class="copy">
      <p class="title" data-testid="radar-next-action-title">{{ title }}</p>
      <p v-if="hint" class="hint" data-testid="radar-next-action-hint">{{ hint }}</p>
    </div>
    <NButton
      v-if="cta"
      type="primary"
      :disabled="disabled"
      data-testid="radar-next-action-cta"
      @click="emit('act')"
    >
      {{ cta }}
    </NButton>
  </section>
</template>

<style scoped>
.next-action {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 16px 18px; border-radius: 10px;
  border: 1px solid var(--of-line, rgba(15, 23, 42, 0.08));
}
.tone-primary { background: linear-gradient(135deg, #fff, #f0f7ff); border-color: rgba(37, 99, 235, 0.25); }
.tone-subtle { background: var(--of-bg, #f6f8fc); }
.copy { display: flex; flex-direction: column; gap: 4px; }
.title { margin: 0; font-size: 16px; font-weight: 600; color: var(--of-ink, #0f172a); }
.hint { margin: 0; font-size: 13px; color: var(--of-ink-2, #475569); line-height: 1.5; }
@media (max-width: 860px) { .next-action { flex-direction: column; align-items: stretch; } }
</style>
