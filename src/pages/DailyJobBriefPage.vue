<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NEmpty, NSpin, NTag, NText,
} from 'naive-ui';
import { ApiError } from '../api/client';
import {
  dailyJobBriefApi,
  type DailyJobBrief,
  type DailyJobBriefDiscoveryItem,
  type DailyJobBriefRecommendationItem,
} from '../api/dailyJobBriefApi';
import type { RecommendationBatchView } from '../api/radarRecommendationApi';

/**
 * OfferFlow v0.9 — 每日求职简报页（T042）。
 *
 * 回答「今天 OfferFlow 给我找到了什么？」，而不是「浏览数据库里的 DailyJobBrief row」。
 *
 * 只调用 T041 已封板的只读端点（/today + /:id），绝不触发 Pipeline / 生成推荐 / 直连 DB。
 * today 的 product-day 完全以后端 /today 返回的 briefDate 为真源，不用浏览器 local date 重算。
 * 推荐批次与 discovery 都是最终 Brief projection：本页不按 sourceRunIds 自行重新合并。
 */

const briefDate = ref('');
const briefs = ref<DailyJobBrief[]>([]);
const selectedBriefId = ref<string | null>(null);
const detail = ref<{
  recommendationBatch: RecommendationBatchView | null;
  recommendationItems: DailyJobBriefRecommendationItem[];
  discoveryItems: DailyJobBriefDiscoveryItem[];
} | null>(null);
const loading = ref(true);
const errorText = ref('');
const capabilityUnavailable = ref(false);

/** 当前选中的简报（多简报时由 selector 决定，默认取第一份）。 */
const todayBrief = computed<DailyJobBrief | null>(() => (
  briefs.value.find((brief) => brief.id === selectedBriefId.value) ?? null
));
const multipleBriefs = computed(() => briefs.value.length > 1);

function briefPlanLabel(brief: DailyJobBrief): string {
  return brief.searchPlan?.name ?? '未命名计划';
}

async function loadDetail(): Promise<void> {
  const id = selectedBriefId.value;
  if (id === null) {
    detail.value = null;
    return;
  }
  const result = await dailyJobBriefApi.get(id);
  detail.value = {
    recommendationBatch: result.recommendationBatch,
    recommendationItems: result.recommendationItems,
    discoveryItems: result.discoveryItems,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  capabilityUnavailable.value = false;
  try {
    const today = await dailyJobBriefApi.today();
    briefDate.value = today.briefDate;
    briefs.value = today.briefs;
    selectedBriefId.value = today.briefs[0]?.id ?? null;
    await loadDetail();
  } catch (error) {
    briefs.value = [];
    selectedBriefId.value = null;
    detail.value = null;
    if (error instanceof ApiError && error.status === 404) {
      capabilityUnavailable.value = true;
      errorText.value = '每日求职简报能力当前未启用。';
    } else {
      errorText.value = error instanceof ApiError ? error.message : '加载每日求职简报失败';
    }
  } finally {
    loading.value = false;
  }
}

/** 切换简报：加载该简报自己的详情，不跨简报混合推荐/discovery。 */
async function selectBrief(id: string): Promise<void> {
  if (selectedBriefId.value === id) return;
  selectedBriefId.value = id;
  try {
    errorText.value = '';
    await loadDetail();
  } catch (error) {
    detail.value = null;
    errorText.value = error instanceof ApiError ? error.message : '加载简报详情失败';
  }
}

onMounted(() => {
  void load();
});

const recommendations = computed<DailyJobBriefRecommendationItem[]>(() => {
  const items = detail.value?.recommendationItems ?? [];
  return [...items].sort((a, b) => a.priority - b.priority);
});
const blocked = computed(() => detail.value?.recommendationBatch?.recommendationSet.blocked ?? []);
const discoveryItems = computed(() => detail.value?.discoveryItems ?? []);
const recommendationSetEmptyReason = computed(() => detail.value?.recommendationBatch?.recommendationSet.emptyReason ?? null);
const hasRecommendations = computed(() => recommendations.value.length > 0);
const hasDiscovery = computed(() => discoveryItems.value.length > 0);

// ── 文案映射 ─────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  GENERATING: '生成中', READY: '就绪', IN_REVIEW: '评审中', COMPLETED: '已完成', FAILED: '失败',
};
const STATUS_TAG_TYPE: Record<string, 'default' | 'success' | 'warning' | 'info' | 'error'> = {
  GENERATING: 'info', READY: 'success', IN_REVIEW: 'warning', COMPLETED: 'default', FAILED: 'error',
};
const KIND_LABELS: Record<string, string> = { apply_now: '建议立即投递', stretch: '冲刺机会', verify: '核验后再决定' };
const KIND_TAG_TYPE: Record<string, 'success' | 'warning' | 'info'> = { apply_now: 'success', stretch: 'warning', verify: 'info' };
const CONFIDENCE_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高' };
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
  no_candidates_in_scope: '今天没有进入评估范围的候选岗位。',
  no_current_successful_analysis: '候选岗位均无当前有效的成功分析，无法形成建议。',
  all_candidates_excluded: '候选岗位都被排除，未形成任何建议。',
};
const EVIDENCE_LEVEL_LABELS: Record<string, string> = {
  SEARCH_EVIDENCE: '搜索证据（信息不足）', MANUAL_REVIEW_REQUIRED: '需人工确认', FULL_EVIDENCE: '完整证据',
};
const EVIDENCE_LEVEL_TAG_TYPE: Record<string, 'default' | 'warning' | 'success'> = {
  SEARCH_EVIDENCE: 'warning', MANUAL_REVIEW_REQUIRED: 'default', FULL_EVIDENCE: 'success',
};

function statusLabel(v: string): string { return STATUS_LABELS[v] ?? v; }
function statusTagType(v: string): 'default' | 'success' | 'warning' | 'info' | 'error' { return STATUS_TAG_TYPE[v] ?? 'default'; }
function kindLabel(v: string): string { return KIND_LABELS[v] ?? v; }
function kindTagType(v: string): 'success' | 'warning' | 'info' { return KIND_TAG_TYPE[v] ?? 'info'; }
function confidenceLabel(v: string): string { return CONFIDENCE_LABELS[v] ?? v; }
function conditionLabel(v: string): string { return CONDITION_LABELS[v] ?? v; }
function blockReasonLabel(v: string): string { return BLOCK_REASON_LABELS[v] ?? v; }
function evidenceLevelLabel(v: string): string { return EVIDENCE_LEVEL_LABELS[v] ?? v; }
function evidenceLevelTagType(v: string): 'default' | 'warning' | 'success' { return EVIDENCE_LEVEL_TAG_TYPE[v] ?? 'default'; }
function emptyReasonLabel(v: string | null, fallback: string): string {
  return v === null ? fallback : (EMPTY_REASON_LABELS[v] ?? v);
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 只有合法 http(s) 绝对 URL 才可作为外链；空值、非法 scheme（javascript:/data:/相对路径等）
 * 一律返回 undefined。绝不构造猜测 URL，也不对后端原文做归一化改写。
 */
function safeSourceUrl(url: string | null): string | undefined {
  if (url === null) return undefined;
  const trimmed = url.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}
</script>

<template>
  <main class="daily-job-brief-page" data-testid="daily-job-brief-page">
    <header class="hero">
      <div>
        <div class="eyebrow">OfferFlow v0.9 · 每日主动求职</div>
        <h1>每日求职简报</h1>
        <p>今天 OfferFlow 给我找到了什么——正式推荐岗位、待人工确认的发现，以及今日搜索覆盖情况。</p>
      </div>
      <n-button v-if="!capabilityUnavailable && !loading" data-testid="refresh" @click="load">刷新</n-button>
    </header>

    <n-alert
      v-if="capabilityUnavailable"
      type="warning"
      class="block"
      data-testid="capability-unavailable"
    >
      每日求职简报能力当前未启用。请在服务端启用 OFFERFLOW_DAILY_SEARCH_PLAN 后刷新页面。
    </n-alert>
    <n-alert
      v-else-if="errorText"
      type="error"
      closable
      class="block"
      data-testid="page-error"
      @close="errorText = ''"
    >
      {{ errorText }}
    </n-alert>

    <n-spin :show="loading" data-testid="loading">
      <!-- A：今日简报不存在 -->
      <n-empty
        v-if="!loading && todayBrief === null"
        description="今天还没有生成每日求职简报"
        class="block"
        data-testid="no-brief"
      >
        <template #extra>
          <n-text depth="3">前往「每日求职计划」配置并运行搜索后，简报会在完成后生成。</n-text>
        </template>
      </n-empty>

      <template v-else-if="todayBrief !== null">
        <!-- 今日状态 + provenance 最小摘要 -->
        <n-card size="small" class="block" data-testid="brief-today">
          <template #header>
            <n-space align="center">
              <n-text strong data-testid="brief-date">{{ briefDate }}</n-text>
              <n-tag size="small" :type="statusTagType(todayBrief.status)" data-testid="brief-status">
                {{ statusLabel(todayBrief.status) }}
              </n-tag>
            </n-space>
          </template>
          <n-space vertical size="small">
            <n-text depth="3" data-testid="source-run-count">今日运行 {{ todayBrief.sourceRunIds.length }} 次</n-text>
            <n-text v-if="todayBrief.generatedAt > 0" depth="3">生成时间 {{ formatTime(todayBrief.generatedAt) }}</n-text>
            <n-text v-if="todayBrief.costSummaryJson === null" depth="3" data-testid="cost-null">成本统计尚未计算。</n-text>
            <n-text v-else depth="3" data-testid="cost-summary">成本：{{ todayBrief.costSummaryJson.actualSearchCredits ?? '—' }}</n-text>
          </n-space>
        </n-card>

        <!-- 多简报 selector：同一 product day 有多份简报（多计划版本）时提供可见切换 -->
        <div v-if="multipleBriefs" class="block" data-testid="brief-selector">
          <n-text depth="3" class="selector-label">今日有多份简报，选择要查看的计划：</n-text>
          <div class="brief-tabs">
            <n-button
              v-for="b in briefs"
              :key="b.id"
              size="small"
              :type="b.id === selectedBriefId ? 'primary' : 'default'"
              :data-testid="`brief-selector-${b.id}`"
              @click="selectBrief(b.id)"
            >{{ briefPlanLabel(b) }}</n-button>
          </div>
        </div>

        <!-- 搜索覆盖情况 -->
        <n-card size="small" class="block" title="今日搜索覆盖" data-testid="coverage">
          <n-text depth="3">
            完成查询 {{ todayBrief.coverage.queriesCompleted }} 次
            <template v-if="todayBrief.coverage.queriesFailed > 0">，失败 {{ todayBrief.coverage.queriesFailed }} 次</template>
          </n-text>
          <n-text v-if="todayBrief.coverage.queryResults.length > 0" depth="3" class="coverage-meta" data-testid="coverage-query-results">
            · 覆盖 {{ todayBrief.coverage.queryResults.length }} 个查询
          </n-text>
        </n-card>

        <!-- 正式推荐（0–8 条，唯一正式推荐集合） -->
        <n-card size="small" class="block" title="正式推荐岗位" data-testid="recommendation-section">
          <template v-if="hasRecommendations">
            <n-text depth="3" class="count" data-testid="recommendation-count">
              共 {{ recommendations.length }} 条推荐（上限 8）。
            </n-text>
            <div
              v-for="rec in recommendations"
              :key="rec.candidateVersionId"
              class="rec-item"
              :data-testid="`recommendation-item-${rec.priority}`"
            >
              <div class="rec-head">
                <span class="priority" data-testid="recommendation-priority">#{{ rec.priority }}</span>
                <n-text strong class="rec-title" data-testid="recommendation-title">{{ rec.title ?? '未命名岗位' }}</n-text>
                <n-tag size="small" :type="kindTagType(rec.kind)" data-testid="recommendation-kind">{{ kindLabel(rec.kind) }}</n-tag>
                <n-tag size="small" data-testid="recommendation-confidence">置信度：{{ confidenceLabel(rec.confidence) }}</n-tag>
                <n-tag size="small" :type="evidenceLevelTagType(rec.evidenceLevel)" data-testid="recommendation-evidence-level">
                  {{ evidenceLevelLabel(rec.evidenceLevel) }}
                </n-tag>
              </div>
              <p class="rationale">
                <n-text depth="2" data-testid="recommendation-company">{{ rec.company ?? '未知公司' }}</n-text>
                <template v-if="rec.city"> · <n-text depth="2">{{ rec.city }}</n-text></template>
                <template v-if="rec.sourceDomain"> · <n-text depth="3">{{ rec.sourceDomain }}</n-text></template>
              </p>
              <p class="rationale" data-testid="recommendation-rationale">{{ rec.rationale }}</p>
              <div v-if="rec.conditions.length > 0" class="conditions" data-testid="recommendation-conditions">
                <n-text depth="3">适用条件：</n-text>
                <n-tag v-for="c in rec.conditions" :key="c" size="tiny">{{ conditionLabel(c) }}</n-tag>
              </div>
              <details v-if="rec.evidenceRefs.length > 0" class="evidence">
                <summary>证据引用（{{ rec.evidenceRefs.length }}）</summary>
                <code
                  v-for="(ref, i) in rec.evidenceRefs"
                  :key="i"
                  class="ekey"
                  :class="ref.polarity"
                  :data-testid="`recommendation-evidence-${ref.polarity}`"
                >{{ ref.polarity === 'support' ? '＋' : '－' }} {{ ref.evidenceKey }}</code>
              </details>
              <p v-if="safeSourceUrl(rec.sourceUrl)" class="source-url">
                <a
                  :href="safeSourceUrl(rec.sourceUrl)"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="recommendation-source-link"
                >查看岗位来源<span class="ext-ico" aria-hidden="true">↗</span></a>
              </p>
            </div>

            <!-- 被排除候选：确定性阻断原因 -->
            <div v-if="blocked.length > 0" class="blocked" data-testid="recommendation-blocked">
              <n-text strong>被排除的候选（{{ blocked.length }}）</n-text>
              <div v-for="(b, i) in blocked" :key="i" class="blocked-item">
                <n-tag size="tiny" type="error">{{ blockReasonLabel(b.reason) }}</n-tag>
              </div>
            </div>
          </template>

          <!-- 推荐 0 条：区分「有 discovery」与「完全空批」 -->
          <template v-else>
            <n-alert
              v-if="hasDiscovery"
              type="info"
              data-testid="recommendation-empty"
              :title="emptyReasonLabel(recommendationSetEmptyReason, '今天没有形成正式推荐。')"
            />
            <n-alert
              v-else
              type="info"
              data-testid="fully-empty"
              :title="emptyReasonLabel(todayBrief.emptyReason, '今天没有推荐，也没有新发现。')"
            />
          </template>
        </n-card>

        <!-- Discovery / 待人工确认岗位（supplementary，视觉层级低于正式推荐） -->
        <n-card
          v-if="hasDiscovery"
          size="small"
          class="block"
          title="其他发现 / 待确认"
          data-testid="discovery-section"
        >
          <n-text depth="3" class="count" data-testid="discovery-count">共 {{ discoveryItems.length }} 条发现，尚未进入正式推荐。</n-text>
          <div
            v-for="item in discoveryItems"
            :key="item.candidateVersionId"
            class="rec-item discovery-item"
            :data-testid="`discovery-item-${item.candidateId}`"
          >
            <div class="rec-head">
              <a
                v-if="safeSourceUrl(item.sourceUrl)"
                :href="safeSourceUrl(item.sourceUrl)"
                target="_blank"
                rel="noopener noreferrer"
                class="discovery-title-link"
                data-testid="discovery-title-link"
              >
                <span class="rec-title" data-testid="discovery-title">{{ item.title ?? '未命名岗位' }}</span>
                <span class="ext-ico" aria-hidden="true">↗</span>
              </a>
              <n-text v-else strong data-testid="discovery-title">{{ item.title ?? '未命名岗位' }}</n-text>
              <n-tag size="small" :type="evidenceLevelTagType(item.evidenceLevel)" data-testid="discovery-evidence-level">
                {{ evidenceLevelLabel(item.evidenceLevel) }}
              </n-tag>
            </div>
            <p class="rationale">
              <n-text depth="2" data-testid="discovery-company">{{ item.company ?? '未知公司' }}</n-text>
              <template v-if="item.city"> · <n-text depth="2">{{ item.city }}</n-text></template>
              <template v-if="item.sourceDomain"> · <n-text depth="3">{{ item.sourceDomain }}</n-text></template>
            </p>
            <p v-if="item.sourceUrl" class="source-url">
              <a
                v-if="safeSourceUrl(item.sourceUrl)"
                :href="safeSourceUrl(item.sourceUrl)"
                target="_blank"
                rel="noopener noreferrer"
                class="source-url-link"
                data-testid="discovery-source-link"
              >{{ item.sourceUrl }}<span class="ext-ico" aria-hidden="true">↗</span></a>
              <n-text v-else depth="3" data-testid="discovery-source-url">来源：{{ item.sourceUrl }}</n-text>
            </p>
          </div>
        </n-card>
      </template>
    </n-spin>
  </main>
</template>

<style scoped>
.daily-job-brief-page { display: flex; flex-direction: column; gap: 16px; padding-bottom: 56px; }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 28px; border: 1px solid var(--of-line, #e2e8f0); border-radius: var(--of-radius, 16px); background: linear-gradient(135deg, #fff, #f0f7ff); box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.hero h1 { margin: 4px 0 8px; font-size: 30px; }
.hero p { max-width: 760px; margin: 0; color: var(--of-ink-2, #475569); }
.eyebrow { color: var(--of-brand, #2563eb); font-weight: 700; font-size: 12px; letter-spacing: .08em; }
.block { margin-top: 16px; }
.count { display: block; margin-bottom: 8px; }
.coverage-meta { display: block; margin-top: 2px; }
.selector-label { display: block; margin-bottom: 8px; }
.brief-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.rec-item { padding: 14px 16px; margin-bottom: 10px; border: 1px solid var(--of-line, rgba(15, 23, 42, 0.08)); border-radius: 10px; }
.rec-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.priority { font-weight: 600; color: var(--of-brand, #2563eb); }
.rationale { margin: 8px 0; color: var(--of-ink, #0f172a); line-height: 1.6; font-size: 13px; }
.conditions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 4px; }
.evidence summary { cursor: pointer; color: var(--of-ink-2, #475569); font-size: 12px; }
.ekey { display: inline-block; margin: 2px 4px 0 0; padding: 0 8px; background: rgba(15, 23, 42, 0.05); border-radius: 999px; font-size: 12px; }
.ekey.support { color: #15803d; } .ekey.counter { color: #b91c1c; }
.blocked { margin-top: 12px; }
.blocked-item { display: flex; gap: 8px; align-items: center; padding: 3px 0; }
.discovery-item { opacity: 0.92; }
.rec-title { font-weight: 600; }
.discovery-title-link { display: inline-flex; align-items: center; gap: 4px; color: var(--of-ink, #0f172a); text-decoration: none; }
.discovery-title-link:hover { color: var(--of-brand, #2563eb); text-decoration: underline; }
.source-url { margin: 4px 0 0; font-size: 12px; word-break: break-all; }
.source-url-link { color: var(--of-brand, #2563eb); text-decoration: none; }
.source-url-link:hover { text-decoration: underline; }
.ext-ico { font-size: 12px; line-height: 1; opacity: 0.75; }
@media (max-width: 860px) { .hero { align-items: flex-start; flex-direction: column; } }
</style>
