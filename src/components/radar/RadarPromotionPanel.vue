<script setup lang="ts">
/**
 * V8-6 晋升面板：预览 → 用户确认 → 执行。
 *
 * Human-in-the-loop 硬约束：
 * - 预览与执行是两次独立的用户动作，绝不把"预览成功"当成确认；
 * - 没有任何自动晋升路径：不 watch 触发、不在挂载时调用、不串行自动执行；
 * - 确认按钮只在已有预览计划时可用，用户看到的就是即将发生的事。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NSelect, NSpin, NTag, NText } from 'naive-ui';
import { ApiError } from '../../api/client';
import {
  radarPromotionApi,
  type PromotionDepth, type PromotionPlanView, type PromotionTrigger, type PromotionView,
} from '../../api/radarPromotionApi';

const props = withDefaults(defineProps<{
  /** 要晋升的候选正式版本 id；为空则面板只显示引导。 */
  candidateVersionId: string | null;
  enabled: boolean;
}>(), { enabled: true });

const plan = ref<PromotionPlanView | null>(null);
const promoted = ref<PromotionView | null>(null);
const actionBusy = ref(false);
const errorText = ref('');

const trigger = ref<PromotionTrigger>('hr_replied');
const requestedDepth = ref<PromotionDepth>('feedback');

/** 迟到响应保护：候选切换即自增；异步回调只在 gen 未变时写状态。 */
const generation = ref(0);
let disposed = false;

function stale(gen: number): boolean {
  return disposed || gen !== generation.value;
}
function safeMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

const canPreview = computed(() => (
  props.enabled && props.candidateVersionId !== null && !actionBusy.value
));
/** 确认只在已有预览计划、且尚未晋升时可用——强制"先看后做"。 */
const canConfirm = computed(() => (
  canPreview.value && plan.value !== null && promoted.value === null
));

async function previewPlan(): Promise<void> {
  if (!canPreview.value || props.candidateVersionId === null) return;
  const gen = generation.value;
  actionBusy.value = true;
  errorText.value = '';
  try {
    const result = await radarPromotionApi.preview(props.candidateVersionId, {
      trigger: trigger.value, requestedDepth: requestedDepth.value,
    });
    if (stale(gen)) return;
    plan.value = result.plan;
  } catch (error) {
    if (!stale(gen)) { plan.value = null; errorText.value = safeMessage(error, '预览晋升计划失败'); }
  } finally {
    if (!stale(gen)) actionBusy.value = false;
  }
}

/** 执行晋升。只由确认按钮触发，绝不自动调用。 */
async function confirmPromote(): Promise<void> {
  if (!canConfirm.value || props.candidateVersionId === null) return;
  const gen = generation.value;
  actionBusy.value = true;
  errorText.value = '';
  try {
    const result = await radarPromotionApi.promote(props.candidateVersionId, {
      trigger: trigger.value, requestedDepth: requestedDepth.value,
    });
    if (stale(gen)) return;
    promoted.value = result.promotion;
    plan.value = result.plan;
  } catch (error) {
    if (!stale(gen)) errorText.value = safeMessage(error, '晋升失败');
  } finally {
    if (!stale(gen)) actionBusy.value = false;
  }
}

/** 候选切换：作废迟到响应并清空计划/结果，避免把上一个候选的计划展示给下一个。 */
function resetForCandidate(): void {
  generation.value += 1;
  actionBusy.value = false;
  plan.value = null;
  promoted.value = null;
  errorText.value = '';
}

watch(() => [props.candidateVersionId, props.enabled] as const, () => resetForCandidate(), { immediate: true });

/** 改触发原因/深度即作废旧计划：避免用户按 A 预览、却按 B 确认。 */
watch(() => [trigger.value, requestedDepth.value] as const, () => {
  if (promoted.value === null) { plan.value = null; }
});

onBeforeUnmount(() => { disposed = true; });

/** 触发原因选项。刻意不含 no_response：无回复不构成晋升依据，后端也会拒绝。 */
const TRIGGER_OPTIONS = [
  { label: 'HR 已回复', value: 'hr_replied' },
  { label: '已交换联系方式', value: 'contact_exchanged' },
  { label: '已约面试', value: 'interview_scheduled' },
  { label: '已明确被拒', value: 'explicit_rejection' },
  { label: '我要正式跟进（无外部反馈）', value: 'user_explicit_request' },
  { label: '仅标记为重点关注', value: 'user_priority' },
];
const DEPTH_OPTIONS = [
  { label: '仅建岗位', value: 'job_only' },
  { label: '建岗位 + 投递', value: 'application' },
  { label: '建岗位 + 投递 + 反馈事件', value: 'feedback' },
];

const DEPTH_LABELS: Record<string, string> = {
  job_only: '仅岗位', application: '岗位 + 投递', feedback: '岗位 + 投递 + 反馈事件',
};
const MODE_LABELS: Record<string, string> = { link: '关联既有', create: '新建', none: '不涉及' };
const MODE_TAG_TYPE: Record<string, 'success' | 'info' | 'default'> = {
  link: 'info', create: 'success', none: 'default',
};
/** 钳制原因：把内部原因码翻译成用户能据此判断的说明。 */
const CLAMP_LABELS: Record<string, string> = {
  trigger_forbids_application: '该触发原因不足以创建投递，已降到仅建岗位。',
  trigger_forbids_feedback: '该触发原因没有外部反馈证据，不代写反馈事件。',
  already_promoted: '此候选已晋升过，确认不会再建一份正式记录。',
  missing_application_for_feedback: '缺少可挂载的投递，无法追加反馈事件。',
};
const EVENT_LABELS: Record<string, string> = {
  hr_replied: 'HR 已回复', hr_contacted: 'HR 主动联系',
  interview_scheduled: '已约面试', rejected: '已被拒',
};
function depthLabel(v: string): string { return DEPTH_LABELS[v] ?? v; }
function modeLabel(v: string): string { return MODE_LABELS[v] ?? v; }
function modeTagType(v: string): 'success' | 'info' | 'default' { return MODE_TAG_TYPE[v] ?? 'default'; }
function clampLabel(v: string): string { return CLAMP_LABELS[v] ?? v; }
function eventLabel(v: string | null): string { return v === null ? '不涉及' : (EVENT_LABELS[v] ?? v); }

/** 深度被钳制 = 实际与请求不一致，需要显著提示而非埋在原因列表里。 */
const wasClamped = computed(() => (
  plan.value !== null && plan.value.effectiveDepth !== plan.value.requestedDepth
));
</script>

<template>
  <NCard size="small" class="promo-panel" data-testid="promotion-panel" title="晋升为正式记录">
    <NEmpty v-if="!enabled" description="晋升功能尚未开启" size="small" data-testid="promotion-disabled" />
    <NEmpty v-else-if="candidateVersionId === null" description="请先选择一个岗位建议"
      size="small" data-testid="promotion-needs-candidate" />

    <template v-else>
      <div class="form" data-testid="promotion-form">
        <label class="field">
          <NText depth="3">触发原因</NText>
          <NSelect v-model:value="trigger" size="small" :options="TRIGGER_OPTIONS"
            :disabled="actionBusy" data-testid="promotion-trigger" />
        </label>
        <label class="field">
          <NText depth="3">请求深度</NText>
          <NSelect v-model:value="requestedDepth" size="small" :options="DEPTH_OPTIONS"
            :disabled="actionBusy" data-testid="promotion-depth" />
        </label>
      </div>

      <div class="actions" data-testid="promotion-actions">
        <NButton size="small" :loading="actionBusy" :disabled="!canPreview"
          data-testid="promotion-preview" @click="previewPlan">预览晋升计划</NButton>
        <!-- 确认是独立的第二次用户动作：无预览不可点，绝无一键自动晋升 -->
        <NButton type="primary" size="small" :disabled="!canConfirm"
          data-testid="promotion-confirm" @click="confirmPromote">确认晋升</NButton>
        <NSpin v-if="actionBusy" size="small" />
      </div>

      <NAlert v-if="errorText" type="error" :title="errorText" class="mb"
        closable data-testid="promotion-error" @close="errorText = ''" />

      <div v-if="plan" class="plan" data-testid="promotion-plan">
        <NAlert v-if="wasClamped" type="warning" class="mb" data-testid="promotion-clamped"
          :title="`请求 ${depthLabel(plan.requestedDepth)}，实际将执行 ${depthLabel(plan.effectiveDepth)}`" />

        <div class="depths">
          <NText depth="3">请求深度：</NText>
          <NTag size="small" data-testid="promotion-requested-depth">{{ depthLabel(plan.requestedDepth) }}</NTag>
          <NText depth="3">实际深度：</NText>
          <NTag size="small" type="primary" data-testid="promotion-effective-depth">{{ depthLabel(plan.effectiveDepth) }}</NTag>
        </div>

        <div class="objects" data-testid="promotion-objects">
          <div class="obj-row" data-testid="promotion-object-job">
            <NText>岗位</NText>
            <NTag size="small" :type="modeTagType(plan.jobMode)">{{ modeLabel(plan.jobMode) }}</NTag>
            <code v-if="plan.linkedJobId" class="oid">{{ plan.linkedJobId }}</code>
          </div>
          <div class="obj-row" data-testid="promotion-object-application">
            <NText>投递</NText>
            <NTag size="small" :type="modeTagType(plan.applicationMode)">{{ modeLabel(plan.applicationMode) }}</NTag>
            <code v-if="plan.linkedApplicationId" class="oid">{{ plan.linkedApplicationId }}</code>
          </div>
          <div class="obj-row" data-testid="promotion-object-feedback">
            <NText>反馈事件</NText>
            <NTag size="small" :type="modeTagType(plan.feedbackMode)">{{ modeLabel(plan.feedbackMode) }}</NTag>
            <NTag v-if="plan.feedbackEventType" size="tiny" data-testid="promotion-event-type">{{ eventLabel(plan.feedbackEventType) }}</NTag>
          </div>
        </div>

        <div v-if="plan.clampReasons.length > 0" class="clamps" data-testid="promotion-clamp-reasons">
          <NText depth="3">说明：</NText>
          <p v-for="r in plan.clampReasons" :key="r" class="clamp-item" :data-testid="`promotion-clamp-${r}`">
            {{ clampLabel(r) }}
          </p>
        </div>
      </div>

      <!-- 晋升成功：给出正式对象 ID 供用户回溯 -->
      <NAlert v-if="promoted" type="success" class="result" title="已晋升为正式记录" data-testid="promotion-result">
        <div class="ids">
          <div data-testid="promotion-result-job">岗位 ID：<code class="oid">{{ promoted.jobId }}</code></div>
          <div v-if="promoted.applicationId" data-testid="promotion-result-application">
            投递 ID：<code class="oid">{{ promoted.applicationId }}</code>
          </div>
          <div v-if="promoted.feedbackEventId" data-testid="promotion-result-feedback">
            反馈事件 ID：<code class="oid">{{ promoted.feedbackEventId }}</code>
          </div>
          <div data-testid="promotion-result-id">晋升记录 ID：<code class="oid">{{ promoted.id }}</code></div>
        </div>
      </NAlert>
    </template>
  </NCard>
</template>

<style scoped>
.promo-panel { margin-top: 12px; font-size: 13px; }
.mb { margin-bottom: 8px; }
.form { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 220px; flex: 1; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
/* 计划区：确认前的决策依据，给足边界与留白 */
.plan {
  padding: 14px 16px; margin-bottom: 10px;
  border: 1px solid var(--of-line, rgba(15, 23, 42, 0.08)); border-radius: 10px;
}
.depths { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.objects { display: flex; flex-direction: column; gap: 6px; }
.obj-row { display: flex; gap: 8px; align-items: center; }
.clamps { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--of-line, rgba(15, 23, 42, 0.08)); }
.clamp-item { margin: 4px 0; color: var(--of-ink-2, #475569); line-height: 1.6; }
.result { margin-top: 4px; }
.ids { display: flex; flex-direction: column; gap: 4px; }
/* 正式对象 ID：可复制回溯，但弱化为辅助信息 */
.oid { padding: 0 6px; background: rgba(15, 23, 42, 0.05); border-radius: 8px; font-size: 12px; color: var(--of-ink-2, #475569); }
</style>
