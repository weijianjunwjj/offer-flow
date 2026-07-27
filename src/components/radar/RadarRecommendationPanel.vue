<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NSpin, NTag, NText } from 'naive-ui';
import { ApiError } from '../../api/client';
import {
  radarRecommendationApi,
  type RecommendationBatchView, type RecommendationItem, type BlockedCandidate,
} from '../../api/radarRecommendationApi';

const props = defineProps<{
  /** 推荐 scope：当前可见候选的正式版本集合（去重后送后端）。空则不允许生成。 */
  candidateVersionIds: string[];
  enabled: boolean;
}>();

const batch = ref<RecommendationBatchView | null>(null);
const actionBusy = ref(false);
const errorText = ref('');

/** 迟到响应保护：scope 切换即自增；异步回调只在 gen 未变时写状态。 */
const generation = ref(0);
let disposed = false;

function stale(gen: number): boolean {
  return disposed || gen !== generation.value;
}
function safeMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** 去重且稳定排序的 scope（与后端 batchKey 的去重一致，避免同集合不同顺序产生歧义）。 */
const scope = computed<string[]>(() => [...new Set(props.candidateVersionIds)].sort());
const canGenerate = computed(() => props.enabled && scope.value.length > 0 && !actionBusy.value);

/** 生成/复用批次：防重复点击（actionBusy + scope 空拦截）；迟到响应按 gen 作废。 */
async function generateBatch(): Promise<void> {
  if (!canGenerate.value) return;
  const gen = generation.value;
  actionBusy.value = true;
  errorText.value = '';
  try {
    const result = await radarRecommendationApi.createBatch(scope.value);
    if (stale(gen)) return;
    batch.value = result;
  } catch (error) {
    if (!stale(gen)) errorText.value = safeMessage(error, '生成推荐批次失败');
  } finally {
    if (!stale(gen)) actionBusy.value = false;
  }
}

/** 加载最新批次：取列表首条（后端按 createdAt 倒序）。防重复点击 + 迟到响应保护。 */
async function loadLatest(): Promise<void> {
  if (!props.enabled || actionBusy.value) return;
  const gen = generation.value;
  actionBusy.value = true;
  errorText.value = '';
  try {
    const list = await radarRecommendationApi.listRecentBatches();
    if (stale(gen)) return;
    batch.value = list.length > 0 ? list[0]! : null;
    if (list.length === 0) errorText.value = '暂无历史推荐批次。';
  } catch (error) {
    if (!stale(gen)) errorText.value = safeMessage(error, '加载最新批次失败');
  } finally {
    if (!stale(gen)) actionBusy.value = false;
  }
}

/** scope / enabled 变化：自增 gen 作废迟到响应、清空已展示批次与错误（Candidate 切换清理）。 */
function resetForScope(): void {
  generation.value += 1;
  actionBusy.value = false;
  batch.value = null;
  errorText.value = '';
}

watch(
  () => [scope.value.join(','), props.enabled] as const,
  () => resetForScope(),
  { immediate: true },
);

onBeforeUnmount(() => { disposed = true; });

/** 建议按 priority 升序稳定排序（1 为最高）；后端已保证连续无空洞，这里仅防御性再排。 */
const recommendations = computed<RecommendationItem[]>(() => {
  const items = batch.value?.recommendationSet.recommendations ?? [];
  return [...items].sort((a, b) => a.priority - b.priority);
});
const blocked = computed<BlockedCandidate[]>(() => batch.value?.recommendationSet.blocked ?? []);
const emptyReason = computed(() => batch.value?.recommendationSet.emptyReason ?? null);
const isEmptyBatch = computed(() => batch.value !== null && recommendations.value.length === 0);

const KIND_LABELS: Record<string, string> = { apply_now: '建议立即投递', stretch: '冲刺机会', verify: '核验后再决定' };
const CONFIDENCE_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高' };
const KIND_TAG_TYPE: Record<string, 'success' | 'warning' | 'info'> = { apply_now: 'success', stretch: 'warning', verify: 'info' };
const CONDITION_LABELS: Record<string, string> = {
  verify_before_apply: '投递前先核验', stretch_reach: '需够一够', capability_gap_present: '存在能力差距',
  confidence_capped_missing_baseline: '缺能力基线（置信度受限）', city_or_salary_unconfirmed: '城市/薪资未确认',
};
const BLOCK_REASON_LABELS: Record<string, string> = {
  no_current_analysis: '无当前分析', stale_analysis: '分析已过期', skip_recommended: '分析建议跳过',
  hard_constraint_hit: '命中硬性约束', ignored_unchanged: '已忽略且未变化', applied_pending: '已投递待反馈',
  duplicate_candidate: '重复候选', capacity_exceeded: '超出单批上限',
};
const EMPTY_REASON_LABELS: Record<string, string> = {
  no_candidates_in_scope: '本批没有可评估的候选。',
  no_current_successful_analysis: '所选候选均无当前有效的成功分析，无法形成建议。',
  all_candidates_excluded: '所有候选都被排除，未形成任何建议。',
};
function kindLabel(v: string): string { return KIND_LABELS[v] ?? v; }
function confidenceLabel(v: string): string { return CONFIDENCE_LABELS[v] ?? v; }
function kindTagType(v: string): 'success' | 'warning' | 'info' { return KIND_TAG_TYPE[v] ?? 'info'; }
function conditionLabel(v: string): string { return CONDITION_LABELS[v] ?? v; }
function blockReasonLabel(v: string): string { return BLOCK_REASON_LABELS[v] ?? v; }
function emptyReasonLabel(v: string | null): string {
  return v === null ? '未形成任何建议。' : (EMPTY_REASON_LABELS[v] ?? v);
}
</script>

<template>
  <NCard size="small" class="rec-panel" data-testid="recommendation-panel" title="岗位建议批次">
    <!-- 未开启：仅提示，不显示任何操作 -->
    <NEmpty v-if="!enabled" description="岗位建议功能尚未开启" size="small" data-testid="recommendation-disabled" />

    <template v-else>
      <div class="actions" data-testid="recommendation-actions">
        <NButton type="primary" size="small" :loading="actionBusy" :disabled="!canGenerate"
          data-testid="recommendation-generate" @click="generateBatch">生成推荐批次</NButton>
        <NButton size="small" :disabled="actionBusy" data-testid="recommendation-load-latest" @click="loadLatest">加载最新批次</NButton>
        <NText v-if="scope.length === 0" depth="3" data-testid="recommendation-no-scope">当前没有可评估的候选。</NText>
        <NSpin v-if="actionBusy" size="small" />
      </div>

      <NAlert v-if="errorText" type="error" :title="errorText" class="mb" data-testid="recommendation-error"
        closable @close="errorText = ''" />

      <!-- 有批次：0 条明确显示 emptyReason；1–8 条按优先级展示 -->
      <div v-if="batch" class="result" data-testid="recommendation-result">
        <NAlert v-if="isEmptyBatch" type="info" class="mb" data-testid="recommendation-empty"
          :title="emptyReasonLabel(emptyReason)">
          <NText depth="3" data-testid="recommendation-empty-reason-code">原因码：{{ emptyReason ?? 'none' }}</NText>
        </NAlert>

        <template v-else>
          <NText depth="3" class="count" data-testid="recommendation-count">共 {{ recommendations.length }} 条建议（上限 8）。</NText>
          <div v-for="rec in recommendations" :key="rec.candidateVersionId" class="rec-item"
            :data-testid="`recommendation-item-${rec.priority}`">
            <div class="rec-head">
              <span class="priority" data-testid="recommendation-priority">#{{ rec.priority }}</span>
              <NTag size="small" :type="kindTagType(rec.kind)" data-testid="recommendation-kind">{{ kindLabel(rec.kind) }}</NTag>
              <NTag size="small" data-testid="recommendation-confidence">置信度：{{ confidenceLabel(rec.confidence) }}</NTag>
              <code class="cvid">{{ rec.candidateVersionId }}</code>
            </div>
            <p class="rationale" data-testid="recommendation-rationale">{{ rec.rationale }}</p>
            <div v-if="rec.conditions.length > 0" class="conditions" data-testid="recommendation-conditions">
              <NText depth="3">适用条件：</NText>
              <NTag v-for="c in rec.conditions" :key="c" size="tiny">{{ conditionLabel(c) }}</NTag>
            </div>
            <details v-if="rec.evidenceRefs.length > 0" class="evidence">
              <summary>证据引用（{{ rec.evidenceRefs.length }}）</summary>
              <code v-for="(ref, i) in rec.evidenceRefs" :key="i" class="ekey" :class="ref.polarity"
                :data-testid="`recommendation-evidence-${ref.polarity}`">{{ ref.polarity === 'support' ? '＋' : '－' }} {{ ref.evidenceKey }}</code>
            </details>
          </div>
        </template>

        <!-- 被排除候选：始终展示（即便有建议），逐条给出确定性阻断原因 -->
        <div v-if="blocked.length > 0" class="blocked" data-testid="recommendation-blocked">
          <NText strong>被排除的候选（{{ blocked.length }}）</NText>
          <div v-for="(b, i) in blocked" :key="i" class="blocked-item" :data-testid="`recommendation-blocked-${b.reason}`">
            <NTag size="tiny" type="error">{{ blockReasonLabel(b.reason) }}</NTag>
            <code class="cvid">{{ b.candidateVersionId }}</code>
          </div>
        </div>

        <div class="meta" data-testid="recommendation-meta">
          <NText depth="3">批次 {{ batch.id }} · 状态 {{ batch.status }}</NText>
        </div>
      </div>
    </template>
  </NCard>
</template>

<style scoped>
.rec-panel { margin-top: 12px; font-size: 13px; }
.mb { margin-bottom: 8px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.count { display: block; margin-bottom: 8px; }
.rec-item { padding: 8px 0; border-bottom: 1px dashed var(--of-line, rgba(15, 23, 42, 0.08)); }
.rec-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.priority { font-weight: 600; color: var(--of-brand, #2563eb); }
.rationale { margin: 6px 0; color: var(--of-ink, #0f172a); line-height: 1.5; }
.conditions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 4px; }
.evidence summary { cursor: pointer; color: var(--of-ink-2, #475569); font-size: 12px; }
.cvid { padding: 0 6px; background: rgba(15, 23, 42, 0.05); border-radius: 8px; font-size: 12px; color: var(--of-ink-2, #475569); }
.ekey { display: inline-block; margin: 2px 4px 0 0; padding: 0 8px; background: rgba(15, 23, 42, 0.05); border-radius: 999px; font-size: 12px; }
.ekey.support { color: #15803d; } .ekey.counter { color: #b91c1c; }
.blocked { margin-top: 12px; }
.blocked-item { display: flex; gap: 8px; align-items: center; padding: 3px 0; }
.meta { margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--of-line, rgba(15, 23, 42, 0.08)); }
</style>
