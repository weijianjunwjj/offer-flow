<script setup lang="ts">
/**
 * RC-11 单条晋升来源链（只读展示）：候选版本 → 触发原因 → 推荐批次（成员推断）→ 正式对象。
 *
 * 忠实呈现服务端状态，绝不臆测：
 * - 触发原因未留痕 → 「未记录」；动作行缺失 → 「动作记录缺失」；已撤销 → 「已撤销，但正式事实链路保留」；
 * - 推荐批次显式标注「按候选版本成员关系推断」，展示 wasSelected，禁止表述为确定因果；
 * - 纯展示组件：不提供删除 / 修改 / 自动修复任何按钮。
 */
import { NTag, NText } from 'naive-ui';
import type { PromotionOriginTrace } from '../../api/radarPromotionTraceApi';

defineProps<{ origin: PromotionOriginTrace; testid?: string }>();

const DEPTH_LABELS: Record<string, string> = {
  job_only: '仅岗位', application: '岗位 + 投递', feedback: '岗位 + 投递 + 反馈事件',
};
const ACTION_LABELS: Record<string, string> = {
  saved: '收藏', unsaved: '取消收藏', ignored: '忽略', ignore_reverted: '撤销忽略',
  marked_priority: '标记优先', priority_reverted: '撤销优先',
  marked_applied_pending: '标记已投待反馈', applied_pending_reverted: '撤销已投待反馈',
};
const depthLabel = (v: string): string => DEPTH_LABELS[v] ?? v;
const actionLabel = (v: string): string => ACTION_LABELS[v] ?? v;
</script>

<template>
  <div class="origin" :data-testid="testid ?? 'promotion-origin'">
    <div class="line">
      <NText depth="3">晋升记录</NText>
      <code class="oid" data-testid="origin-promotion-id">{{ origin.promotionId }}</code>
      <NTag size="small" type="primary">{{ depthLabel(origin.promotionType) }}</NTag>
    </div>

    <!-- 候选版本：晋升所依据的 Radar 标准化事实锚点 -->
    <div class="line" data-testid="origin-candidate-version">
      <NText depth="3">候选版本</NText>
      <template v-if="origin.candidateVersion.status === 'resolved'">
        <code class="oid">{{ origin.candidateVersion.candidateVersionId }}</code>
        <NTag size="tiny">v{{ origin.candidateVersion.versionNo }}</NTag>
        <NText depth="3" class="muted">来源 {{ origin.candidateVersion.originType }}</NText>
      </template>
      <NTag v-else size="small" type="error" data-testid="origin-candidate-missing">候选版本记录缺失</NTag>
    </div>

    <!-- 触发原因：只存 trigger_action_id，忠实呈现四态 -->
    <div class="line" data-testid="origin-trigger">
      <NText depth="3">触发原因</NText>
      <NTag v-if="origin.trigger.status === 'not_recorded'" size="small" data-testid="origin-trigger-not-recorded">未记录</NTag>
      <NTag v-else-if="origin.trigger.status === 'action_missing'" size="small" type="error"
        data-testid="origin-trigger-missing">动作记录缺失</NTag>
      <template v-else>
        <NTag size="small" type="info">{{ actionLabel(origin.trigger.actionType) }}</NTag>
        <NText v-if="origin.trigger.reasonText" depth="3" class="muted">「{{ origin.trigger.reasonText }}」</NText>
        <NTag v-if="origin.trigger.reverted" size="tiny" type="warning" data-testid="origin-trigger-reverted">
          已撤销，但正式事实链路保留
        </NTag>
      </template>
    </div>

    <!-- 推荐批次：成员关系推断，绝不表述为确定因果 -->
    <div class="line batches" data-testid="origin-batches">
      <NText depth="3">推荐批次</NText>
      <NTag v-if="origin.recommendationBatches.status === 'no_batch'" size="small"
        data-testid="origin-batches-none">无（该候选版本未进入任何批次 scope）</NTag>
      <template v-else>
        <NText depth="3" class="muted infer" data-testid="origin-batches-inferred">按候选版本成员关系推断（非确定因果）</NText>
        <div v-for="b in origin.recommendationBatches.batches" :key="b.batchId" class="batch-row"
          :data-testid="`origin-batch-${b.batchId}`">
          <code class="oid">{{ b.batchKey }}</code>
          <NTag size="tiny" :type="b.wasSelected ? 'success' : 'default'"
            :data-testid="`origin-batch-selected-${b.batchId}`">
            {{ b.wasSelected ? '进入建议' : '仅在 scope 内' }}
          </NTag>
        </div>
      </template>
    </div>

    <!-- 正向对应的正式对象 -->
    <div class="line objects" data-testid="origin-objects">
      <NText depth="3">正式对象</NText>
      <span>岗位 <code class="oid">{{ origin.jobId }}</code></span>
      <span v-if="origin.applicationId">投递 <code class="oid">{{ origin.applicationId }}</code></span>
      <span v-if="origin.feedbackEventId">反馈事件 <code class="oid">{{ origin.feedbackEventId }}</code></span>
    </div>
  </div>
</template>

<style scoped>
.origin { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; }
.line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; }
.line > .n-text:first-child { flex: 0 0 72px; }
.muted { color: var(--of-ink-2, #475569); }
.infer { font-style: italic; }
.batches, .objects { align-items: flex-start; }
.batch-row { display: flex; gap: 6px; align-items: center; }
.objects span { display: inline-flex; gap: 4px; align-items: center; }
.oid { padding: 0 6px; background: rgba(15, 23, 42, 0.05); border-radius: 8px; font-size: 12px; color: var(--of-ink-2, #475569); overflow-wrap: anywhere; }
</style>
