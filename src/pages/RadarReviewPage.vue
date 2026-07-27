<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NInput, NModal, NSpace, NSpin, NTag, NText } from 'naive-ui';
import { ApiError } from '../api/client';
import {
  radarReviewApi,
  type CandidateDecisionDetail, type DecisionFeedItem, type RelationDetail, type RelationListItem,
  type RuleEvidenceView, type RelationStatus,
} from '../api/radarReviewApi';
import { features } from '../config/features';
import RadarAnalysisPanel from '../components/radar/RadarAnalysisPanel.vue';
import RadarRecommendationPanel from '../components/radar/RadarRecommendationPanel.vue';

/** V8-4 单岗位分析面板门禁：默认关闭，不随 Radar 开启而自动开启（见 features.ts）。 */
const analysisEnabled = features.radarAnalysisEnabled;
/** V8-5 岗位建议批次面板门禁：独立、默认关闭；flag=false 时完全不渲染，不影响 V8-4。 */
const recommendationsEnabled = features.radarRecommendationsEnabled;

const loading = ref(true);
const busy = ref(false);
const errorText = ref('');
const notice = ref('');
const staleHint = ref('');

/** 状态筛选：默认待处理（suspected + needs_recheck）；已确认相同/不同/全部供重开历史查看。 */
type StatusFilter = 'pending' | 'confirmed_same' | 'confirmed_distinct' | 'all';
const statusFilter = ref<StatusFilter>('pending');
const FILTER_STATUSES: Record<StatusFilter, RelationStatus[] | undefined> = {
  pending: ['suspected_duplicate', 'needs_recheck'],
  confirmed_same: ['confirmed_same'],
  confirmed_distinct: ['confirmed_distinct'],
  all: ['suspected_duplicate', 'needs_recheck', 'confirmed_same', 'confirmed_distinct'],
};

const relations = ref<RelationListItem[]>([]);
const feed = ref<DecisionFeedItem[]>([]);
const selectedRelation = ref<RelationListItem | null>(null);
const relationDetail = ref<RelationDetail | null>(null);
const detailLow = ref<CandidateDecisionDetail | null>(null);
const detailHigh = ref<CandidateDecisionDetail | null>(null);
const evidence = ref<RuleEvidenceView[]>([]);

/** V8-5 推荐 scope：当前可见候选（A/B）的正式版本集合，去重后送推荐面板；无正式版本则为空。 */
const recommendationScope = computed<string[]>(() => {
  const ids = [detailLow.value?.activeCandidateVersionId, detailHigh.value?.activeCandidateVersionId]
    .filter((v): v is string => typeof v === 'string' && v !== '');
  return [...new Set(ids)];
});

// 待确认操作弹窗：所有写操作都必须二次确认 + 填写原因。
type PendingKind = 'confirm-same' | 'confirm-distinct' | 'revert' | 'recheck' | 'override-set' | 'override-revert';
const pending = ref<{ kind: PendingKind; label: string; impact: string; reasonRequired: true; ctx: Record<string, unknown> } | null>(null);
const reasonDraft = ref('');

async function loadRelations(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    relations.value = await radarReviewApi.listRelations(FILTER_STATUSES[statusFilter.value]);
    feed.value = await radarReviewApi.listDecisionFeed();
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function changeFilter(next: StatusFilter): Promise<void> {
  statusFilter.value = next;
  selectedRelation.value = null;
  relationDetail.value = null;
  detailLow.value = null;
  await loadRelations();
}

onMounted(loadRelations);

async function loadEvidenceFor(detail: CandidateDecisionDetail | null): Promise<void> {
  const vid = detail?.activeCandidateVersionId;
  evidence.value = vid == null ? [] : await radarReviewApi.listRuleEvidence(vid);
}

async function selectRelation(rel: RelationListItem): Promise<void> {
  selectedRelation.value = rel;
  staleHint.value = '';
  relationDetail.value = null;
  detailLow.value = null;
  detailHigh.value = null;
  evidence.value = [];
  try {
    // 关系详情（signals + 裁决原因 + 时间 + 审计时间线）：已裁决关系也可重开查看历史。
    relationDetail.value = await radarReviewApi.getRelationDetail(rel.relationId);
    detailLow.value = await radarReviewApi.getCandidateDetail(rel.candidateIdLow);
    detailHigh.value = await radarReviewApi.getCandidateDetail(rel.candidateIdHigh);
    await loadEvidenceFor(detailLow.value);
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '加载详情失败';
  }
}

/** 决策 feed 中带候选的条目：单侧加载详情 + 规则证据（不进入关系裁决）。 */
async function selectFeedCandidate(candidateId: string | null): Promise<void> {
  if (candidateId === null) return;
  selectedRelation.value = null;
  relationDetail.value = null;
  staleHint.value = '';
  detailHigh.value = null;
  evidence.value = [];
  try {
    detailLow.value = await radarReviewApi.getCandidateDetail(candidateId);
    await loadEvidenceFor(detailLow.value);
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '加载详情失败';
  }
}

const showCompare = computed(() => detailLow.value !== null);

function openConfirm(kind: PendingKind, label: string, impact: string, ctx: Record<string, unknown>): void {
  reasonDraft.value = '';
  notice.value = '';
  staleHint.value = '';
  pending.value = { kind, label, impact, reasonRequired: true, ctx };
}

function cancelConfirm(): void {
  pending.value = null;
  reasonDraft.value = '';
}

const canSubmit = computed(() => reasonDraft.value.trim().length > 0 && !busy.value);

async function submitPending(): Promise<void> {
  const p = pending.value;
  if (p === null || reasonDraft.value.trim() === '') return;
  busy.value = true;
  staleHint.value = '';
  try {
    await dispatch(p.kind, p.ctx, reasonDraft.value.trim());
    notice.value = `${p.label}已完成`;
    pending.value = null;
    await loadRelations();
    if (selectedRelation.value !== null) {
      const again = relations.value.find((r) => r.relationId === selectedRelation.value?.relationId);
      if (again !== undefined) {
        await selectRelation(again);
      } else {
        // 关系裁决后不再符合当前筛选：清空详情面板，避免残留旧状态和可点但会 409 的操作按钮。
        selectedRelation.value = null;
        relationDetail.value = null;
        detailLow.value = null;
        detailHigh.value = null;
        evidence.value = [];
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      staleHint.value = '数据已变化，请刷新后重试';
    } else {
      staleHint.value = error instanceof ApiError ? error.message : '操作失败';
    }
    // 保留用户输入的 reasonDraft，不静默失败。
  } finally {
    busy.value = false;
  }
}

async function dispatch(kind: PendingKind, ctx: Record<string, unknown>, reason: string): Promise<void> {
  const relationId = ctx.relationId as string;
  const expected = ctx.expectedCurrentStatus as RelationStatus;
  if (kind === 'confirm-same') return void await radarReviewApi.confirmSame({ relationId, reason, expectedCurrentStatus: expected });
  if (kind === 'confirm-distinct') return void await radarReviewApi.confirmDistinct({ relationId, reason, expectedCurrentStatus: expected });
  if (kind === 'revert') return void await radarReviewApi.revert({ relationId, reason, expectedCurrentStatus: expected });
  if (kind === 'recheck') return void await radarReviewApi.requestRecheck({ relationId, reason, expectedCurrentStatus: expected, evidenceReason: 'new_material_version' });
  if (kind === 'override-set') return void await radarReviewApi.setOverride({ assessmentId: ctx.assessmentId as string, overriddenValue: ctx.value as 'pass' | 'block', reason, expectedOverrideState: ctx.expectedOverrideState as 'none' | 'pass' | 'block' });
  if (kind === 'override-revert') return void await radarReviewApi.revertOverride({ assessmentId: ctx.assessmentId as string, reason, expectedOverrideState: ctx.expectedOverrideState as 'none' | 'pass' | 'block' });
}

function salaryText(s: { salaryMinK: number | null; salaryMaxK: number | null; salaryPeriod: string | null } | null): string {
  if (s === null || s.salaryMinK === null) return '—';
  return `${s.salaryMinK}-${s.salaryMaxK ?? '?'}K/${s.salaryPeriod ?? ''}`;
}

function timeText(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const RELATION_ACTION_LABELS: Record<string, string> = {
  duplicate_confirmed: '确认相同',
  duplicate_rejected: '确认不同',
  duplicate_decision_reverted: '撤销裁决',
  duplicate_recheck_requested: '请求复核',
};
const OVERRIDE_ACTION_LABELS: Record<string, string> = {
  rule_override_set: '设置覆盖',
  rule_override_reverted: '撤销覆盖',
};
const OVERRIDE_STATE_LABELS: Record<string, string> = { none: '默认', pass: '判定通过', block: '坚持阻断' };

/** 关系状态中文化：Tag 显示中文，技术码降级为弱化副文本（不从 DOM 移除，便于排查与既有断言）。 */
const RELATION_STATUS_LABELS: Record<string, string> = {
  suspected_duplicate: '疑似重复',
  needs_recheck: '待重新确认',
  confirmed_same: '已确认相同',
  confirmed_distinct: '已确认不同',
};
/** 决策类型中文化（feed 项 Tag）。 */
const DECISION_TYPE_LABELS: Record<string, string> = {
  new_identity: '新岗位',
  material_change: '实质变化',
  no_change: '无变化',
  snapshot_only: '仅快照',
  extraction_regression: '提取回退',
  ambiguous_change: '变化存疑',
  identity_conflict: '身份冲突',
};
/** 证据状态中文化（结构化/旧标量/损坏）。 */
const EVIDENCE_STATE_LABELS: Record<string, string> = {
  structured: '结构化', legacy_scalar: '旧标量', corrupt: '已损坏',
};
function relationStatusLabel(s: string): string { return RELATION_STATUS_LABELS[s] ?? s; }
function decisionTypeLabel(t: string): string { return DECISION_TYPE_LABELS[t] ?? t; }
function evidenceStateLabel(s: string): string { return EVIDENCE_STATE_LABELS[s] ?? s; }
function relationActionLabel(t: string): string { return RELATION_ACTION_LABELS[t] ?? t; }
function overrideActionLabel(t: string): string { return OVERRIDE_ACTION_LABELS[t] ?? t; }
function overrideStateLabel(s: string): string { return OVERRIDE_STATE_LABELS[s] ?? s; }
function signalValueText(v: string | number | boolean | null): string {
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}
</script>

<template>
  <div class="radar-review">
    <h1>岗位雷达 · 人工评审工作台</h1>
    <NAlert v-if="errorText" type="error" :title="errorText" data-testid="review-error" />
    <NAlert v-if="notice" type="success" :title="notice" data-testid="review-notice" closable @close="notice = ''" />
    <NSpin :show="loading">
      <div class="review-grid">
        <!-- 区域 1：待处理关系 -->
        <NCard title="待处理关系（疑似重复 / 待重新确认）" size="small" class="col">
          <NSpace size="small" class="filter-bar" data-testid="status-filter">
            <NButton size="tiny" :type="statusFilter === 'pending' ? 'primary' : 'default'" data-testid="filter-pending" @click="changeFilter('pending')">待处理</NButton>
            <NButton size="tiny" :type="statusFilter === 'confirmed_same' ? 'primary' : 'default'" data-testid="filter-confirmed_same" @click="changeFilter('confirmed_same')">已确认相同</NButton>
            <NButton size="tiny" :type="statusFilter === 'confirmed_distinct' ? 'primary' : 'default'" data-testid="filter-confirmed_distinct" @click="changeFilter('confirmed_distinct')">已确认不同</NButton>
            <NButton size="tiny" :type="statusFilter === 'all' ? 'primary' : 'default'" data-testid="filter-all" @click="changeFilter('all')">全部</NButton>
          </NSpace>
          <NEmpty v-if="relations.length === 0" description="该筛选下暂无关系" data-testid="relations-empty" />
          <ul v-else class="relation-list scroll-pane" data-testid="relation-list">
            <li v-for="rel in relations" :key="rel.relationId">
              <NButton
                text
                :type="selectedRelation?.relationId === rel.relationId ? 'primary' : 'default'"
                :data-testid="`relation-${rel.relationId}`"
                @click="selectRelation(rel)"
              >
                <NTag size="small" :type="rel.status === 'needs_recheck' ? 'warning' : 'info'">{{ relationStatusLabel(rel.status) }}</NTag>
                {{ rel.lowSummary.company ?? '?' }} × {{ rel.highSummary.company ?? '?' }}
              </NButton>
              <!-- 技术码降级：保留在 DOM 供排查，视觉弱化为次要副文本 -->
              <span class="tech-code">{{ rel.status }}</span>
            </li>
          </ul>
        </NCard>

        <!-- 区域：决策审阅 feed（含阻断信息） -->
        <NCard title="决策审阅（变化 / 阻断）" size="small" class="col">
          <NEmpty v-if="feed.length === 0" description="暂无决策记录" />
          <ul v-else class="feed-list scroll-pane" data-testid="decision-feed">
            <li v-for="f in feed" :key="f.snapshotId" :data-testid="`feed-${f.decisionType}`">
              <NButton text :disabled="f.candidateId === null" :data-testid="`feed-open-${f.snapshotId}`" @click="selectFeedCandidate(f.candidateId)">
                <NTag size="small" :type="f.analysisEligible ? 'success' : 'error'">{{ decisionTypeLabel(f.decisionType) }}</NTag>
                <NText depth="3">{{ f.summary?.company ?? '（无候选）' }}</NText>
              </NButton>
              <!-- 技术码降级：保留 decisionType 原码供排查（e2e testid 亦依赖该码） -->
              <span class="tech-code">{{ f.decisionType }}</span>
              <div v-if="f.conflictReason" class="reason" data-testid="feed-conflict-reason">
                冲突原因：{{ f.conflictReason }}
              </div>
              <div v-if="f.blockingIssues.length > 0" class="reason">阻断：{{ f.blockingIssues.join('；') }}</div>
              <div v-if="f.needsConfirmation.length > 0" class="reason">待确认字段：{{ f.needsConfirmation.join('、') }}</div>
              <div v-if="f.changedFieldPaths.length > 0" class="reason">变化字段：{{ f.changedFieldPaths.join('、') }}</div>
            </li>
          </ul>
        </NCard>
      </div>

      <!-- V8-5 岗位建议批次：置于候选对比区顶部、先于候选详情，避免埋在长页面底部。
           未选关系时也渲染（显示「请先选择一组岗位」引导）；仅在能力开启时渲染，flag=false 完全不影响 V8-4。 -->
      <RadarRecommendationPanel
        v-if="recommendationsEnabled"
        :candidate-version-ids="recommendationScope"
        :enabled="recommendationsEnabled"
        :has-selection="showCompare"
        class="mt primary-zone"
        data-testid="recommendation-panel-review"
      />

      <!-- 区域 2/3/4：候选对比 + 变化摘要 + 阻断信息（选中关系后展开） -->
      <NCard v-if="showCompare" title="候选对比" size="small" class="mt" data-testid="candidate-compare">
        <div class="compare">
          <!-- 候选 A/B 两张等宽卡：结构对称，便于左右逐字段比对 -->
          <div v-for="(d, side) in { low: detailLow, high: detailHigh }" :key="side"
            class="cand-card" :data-testid="`candidate-card-${side}`">
            <div class="cand-head">
              <NText strong>{{ side === 'low' ? '候选 A' : '候选 B' }}</NText>
              <NTag v-if="d" size="small" :type="d.analysisEligible ? 'success' : 'error'">
                {{ decisionTypeLabel(d.decisionType) }}
              </NTag>
            </div>
            <template v-if="d">
              <div class="field-row"><span>公司</span><span>{{ d.currentVersion?.company ?? '—' }}</span></div>
              <div class="field-row"><span>岗位</span><span>{{ d.currentVersion?.role ?? '—' }}</span></div>
              <div class="field-row"><span>城市</span><span>{{ d.currentVersion?.city ?? '—' }}</span></div>
              <div class="field-row"><span>薪资</span><span>{{ salaryText(d.currentVersion) }}</span></div>
              <div class="field-row"><span>学历</span><span>{{ d.currentVersion?.educationRequirement ?? '—' }}</span></div>
              <div class="field-row"><span>经验</span><span>{{ d.currentVersion?.experienceRequirement ?? '—' }}</span></div>
              <div class="field-row"><span>JD</span><span>{{ d.currentVersion?.jdExcerpt ?? '—' }}</span></div>
              <div class="field-row"><span>来源</span><span>{{ d.currentVersion?.normalizedSourceUrl ?? '—' }}</span></div>
              <!-- 内部版本号弱化：保留可查，视觉降级 -->
              <div class="field-row tech-row"><span>当前版本</span><span class="tech-code">{{ d.activeCandidateVersionId ?? '—' }}</span></div>
              <!-- 决策类型中文 Tag 已上移至卡头；此处仅保留技术码（弱化） -->
              <div class="tech-code">{{ d.decisionType }}</div>
              <div v-if="d.conflictReason" class="reason">冲突原因：{{ d.conflictReason }}</div>
              <div v-for="cf in d.changedFields" :key="cf.fieldPath" class="reason" data-testid="changed-field">
                {{ cf.fieldPath }}：{{ cf.before ?? '∅' }} → {{ cf.after ?? '∅' }}（{{ cf.classification }}：{{ cf.reason }}）
              </div>
              <!-- V8-4 单岗位分析：仅在能力开启且该侧有当前正式版本时展示；每侧独立，避免双候选歧义 -->
              <RadarAnalysisPanel
                v-if="analysisEnabled && d.activeCandidateVersionId"
                :candidate-id="d.candidateId"
                :candidate-version-id="d.activeCandidateVersionId"
                :enabled="analysisEnabled"
                :data-testid="`analysis-panel-${side}`"
              />
            </template>
          </div>
        </div>

        <!-- 区域：疑似重复信号 + 裁决历史（仅关系场景） -->
        <div v-if="relationDetail" class="mt" data-testid="relation-detail">
          <NText strong>疑似重复信号</NText>
          <NEmpty v-if="relationDetail.signals.state === 'empty'" description="该关系无结构化信号" size="small" data-testid="signals-empty" />
          <NAlert v-else-if="relationDetail.signals.state === 'corrupt'" type="warning" size="small" data-testid="signals-corrupt"
            :title="`信号数据损坏：${relationDetail.signals.corruptReason ?? '未知原因'}`" />
          <ul v-else class="signal-list" data-testid="signals-list">
            <li v-for="(sig, i) in relationDetail.signals.signals" :key="i" class="signal-item" :data-testid="`signal-${sig.signalType}`">
              <NTag size="small" type="info" class="tech-code">{{ sig.signalType }}</NTag>
              <span class="signal-field">{{ sig.field }}</span>
              <span class="signal-vals">A：{{ signalValueText(sig.candidateAValue) }} ｜ B：{{ signalValueText(sig.candidateBValue) }}</span>
              <NText v-if="sig.strength !== null" depth="3">强度 {{ sig.strength }}</NText>
              <div class="reason">{{ sig.explanation }}</div>
            </li>
          </ul>
          <div class="reason" data-testid="relation-meta">
            当前状态：{{ relationStatusLabel(relationDetail.status) }}
            <span class="tech-code">{{ relationDetail.status }}</span>
            ｜ 原因码：{{ relationDetail.reasonCode ?? '—' }}
            ｜ 首次检测：{{ timeText(relationDetail.firstDetectedAt) }}
            ｜ 最近检测：{{ timeText(relationDetail.lastDetectedAt) }}
            ｜ 裁决时间：{{ timeText(relationDetail.decidedAt) }}
          </div>
          <div v-if="relationDetail.decisionReason" class="reason" data-testid="relation-decision-reason">
            用户裁决原因：{{ relationDetail.decisionReason }}
          </div>
          <div class="mt">
            <NText strong>裁决审计时间线</NText>
            <NEmpty v-if="relationDetail.auditTimeline.length === 0" description="尚无裁决记录" size="small" data-testid="relation-audit-empty" />
            <ul v-else class="audit-list" data-testid="relation-audit-timeline">
              <li v-for="a in relationDetail.auditTimeline" :key="a.actionId" class="audit-item" :data-testid="`relation-audit-${a.actionType}`">
                <NTag size="small">{{ relationActionLabel(a.actionType) }}</NTag>
                <span>{{ timeText(a.occurredAt) }}</span>
                <span>→ {{ a.resultingStatus }}</span>
                <span v-if="a.evidenceReason">（证据：{{ a.evidenceReason }}）</span>
                <span v-if="a.reason" class="reason">原因：{{ a.reason }}</span>
                <NTag v-if="a.reverted" size="tiny" type="warning">已被后续撤销</NTag>
              </li>
            </ul>
          </div>
        </div>

        <!-- 区域 5：规则证据 -->
        <div class="mt">
          <NText strong>规则证据（候选 A 当前版本）</NText>
          <NEmpty v-if="evidence.length === 0" description="无规则证据" size="small" />
          <div v-for="e in evidence" :key="e.assessmentId" class="evidence-item" :data-testid="`evidence-${e.evidenceState}`">
            <NSpace align="center" size="small">
              <NTag size="small">{{ e.ruleKey }}</NTag>
              <NTag size="small" :type="e.evidenceState === 'corrupt' ? 'error' : e.evidenceState === 'legacy_scalar' ? 'warning' : 'default'">{{ evidenceStateLabel(e.evidenceState) }}</NTag>
              <NTag size="small" :type="e.overrideState === 'none' ? 'default' : 'info'">覆盖：{{ overrideStateLabel(e.overrideState) }}</NTag>
              <NText v-if="e.outcome" depth="3" class="tech-code">outcome={{ e.outcome }}</NText>
            </NSpace>
            <div v-if="e.evidenceState === 'structured'" class="reason">
              字段 {{ e.matchedFieldPath }} · 原值 {{ e.rawValue }} · 规范化 {{ e.normalizedValue }} · 置信度 {{ e.confidence }}
            </div>
            <div v-if="e.excerpt" class="reason">摘要：{{ e.excerpt }}</div>
            <div v-if="e.explanation" class="reason">说明：{{ e.explanation }}</div>
            <div v-if="e.corruptReason" class="reason">损坏原因：{{ e.corruptReason }}</div>
            <!-- 原始规则评估只读标识 + 不可变说明（由只读 API 提供，非仅 UI 文案）。
                 内部 ID/哈希默认折叠：降低视觉噪音，但仍在 DOM 中可查（不改变可访问文本）。 -->
            <details class="tech-details">
              <summary class="tech-summary">内部标识与证据哈希</summary>
              <div class="reason" :data-testid="`evidence-original-${e.assessmentId}`">
                原评估 {{ e.assessmentId }} · 结果 {{ e.originalResult }}
                <span v-if="e.evidenceHashShort"> · 证据哈希 {{ e.evidenceHashShort }}</span>
              </div>
            </details>
            <div class="immutable-note" :data-testid="`evidence-immutable-${e.assessmentId}`">
              原始规则评估未被覆盖操作修改（覆盖仅追加审计事件）。
            </div>
            <!-- 覆盖审计时间线（append-only，升序） -->
            <div v-if="e.overrideAudit.length > 0" class="mt" :data-testid="`override-audit-${e.assessmentId}`">
              <NText depth="3">覆盖审计：</NText>
              <ul class="audit-list">
                <li v-for="oa in e.overrideAudit" :key="oa.actionId" class="audit-item" :data-testid="`override-audit-${oa.actionType}-${oa.actionId}`">
                  <NTag size="tiny">{{ overrideActionLabel(oa.actionType) }}</NTag>
                  <span>{{ timeText(oa.occurredAt) }}</span>
                  <span>{{ overrideStateLabel(oa.previousOverrideState) }} → {{ overrideStateLabel(oa.resultingOverrideState) }}</span>
                  <span v-if="oa.reason" class="reason">原因：{{ oa.reason }}</span>
                </li>
              </ul>
            </div>
            <NSpace size="small" class="mt">
              <NButton v-if="e.overrideState === 'none'" size="tiny" :disabled="busy" :data-testid="`override-set-${e.assessmentId}`"
                @click="openConfirm('override-set', '设置规则覆盖（通过）', '将新增一条覆盖审计事件，不修改原始规则评估', { assessmentId: e.assessmentId, value: 'pass', expectedOverrideState: e.overrideState })">设为通过</NButton>
              <NButton v-else size="tiny" :disabled="busy" :data-testid="`override-revert-${e.assessmentId}`"
                @click="openConfirm('override-revert', '撤销规则覆盖', '将新增一条撤销审计事件，恢复规则默认判定', { assessmentId: e.assessmentId, expectedOverrideState: e.overrideState })">撤销覆盖</NButton>
            </NSpace>
          </div>
        </div>

        <!-- 区域 6：人工操作（仅关系裁决场景；feed 单候选查看不含裁决） -->
        <div v-if="selectedRelation" class="mt">
          <p class="merge-note" data-testid="merge-note">
            提示：“确认相同”只记录两个候选被人工判断为同一岗位，不会立即删除、合并或迁移历史数据。
          </p>
          <NSpace>
            <NButton :disabled="busy" data-testid="btn-confirm-same"
              @click="openConfirm('confirm-same', '确认相同', '仅登记为同一岗位（不物理合并/不删除/不迁移历史）', { relationId: selectedRelation.relationId, expectedCurrentStatus: selectedRelation.status })">确认相同</NButton>
            <NButton :disabled="busy" data-testid="btn-confirm-distinct"
              @click="openConfirm('confirm-distinct', '确认不同', '登记为不同岗位，之后相同信号不再进入待处理', { relationId: selectedRelation.relationId, expectedCurrentStatus: selectedRelation.status })">确认不同</NButton>
            <NButton :disabled="busy" data-testid="btn-revert"
              @click="openConfirm('revert', '撤销裁决', '撤销当前裁决并追加新审计，关系回到待处理', { relationId: selectedRelation.relationId, expectedCurrentStatus: selectedRelation.status })">撤销</NButton>
            <NButton :disabled="busy" data-testid="btn-recheck"
              @click="openConfirm('recheck', '请求重新确认', '基于新实质证据请求重新确认', { relationId: selectedRelation.relationId, expectedCurrentStatus: selectedRelation.status })">重新确认</NButton>
          </NSpace>
        </div>
      </NCard>
    </NSpin>

    <!-- 二次确认弹窗：显示影响 + 必填原因 + 409 提示 -->
    <NModal :show="pending !== null" :mask-closable="false" preset="dialog" :title="pending?.label" data-testid="confirm-modal" @update:show="(v: boolean) => { if (!v) cancelConfirm(); }">
      <template v-if="pending">
        <p>{{ pending.impact }}</p>
        <NInput v-model:value="reasonDraft" type="textarea" placeholder="请填写操作原因（必填）" :autosize="{ minRows: 2 }" data-testid="reason-input" />
        <NAlert v-if="staleHint" type="warning" :title="staleHint" class="mt" data-testid="stale-hint" />
      </template>
      <template #action>
        <NButton :disabled="busy" @click="cancelConfirm">取消</NButton>
        <NButton type="primary" :disabled="!canSubmit" :loading="busy" data-testid="confirm-submit" @click="submitPending">确认提交</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
/* 决策工作台：更宽的主内容区，让候选 A/B 与建议卡片有足够横向空间 */
.radar-review { padding: 16px; max-width: 1520px; margin: 0 auto; }
.review-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.col { min-width: 0; }
/* 顶部两列限高 + 内部滚动：长列表不再把主决策区推到屏幕外 */
.scroll-pane { max-height: 300px; overflow-y: auto; }
/* 候选 A/B 等宽卡：min-width 0 防止长 URL 撑破栅格 */
.compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.cand-card {
  min-width: 0; padding: 12px; border: 1px solid var(--of-line, rgba(15, 23, 42, 0.08));
  border-radius: 10px; background: var(--of-card, #ffffff);
}
.cand-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.relation-list, .feed-list { list-style: none; padding: 0; margin: 0; }
.relation-list li, .feed-list li { padding: 6px 0; border-bottom: 1px solid var(--of-line, rgba(15, 23, 42, 0.08)); }
.reason { font-size: 12px; color: var(--of-ink-2, #475569); margin-top: 2px; }
.field-row { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; padding: 2px 0; }
.field-row > span:first-child { color: var(--of-ink-2, #475569); flex: 0 0 auto; }
.field-row > span:last-child { min-width: 0; overflow-wrap: anywhere; text-align: right; }
/* 内部 ID / 版本号 / 技术码统一弱化 */
/* 技术码弱化靠颜色（muted）而非缩到 ramp 之外的字号：12px 是 DESIGN.md 的最小步进 */
.tech-code { font-size: 12px; color: var(--of-muted, #94a3b8); overflow-wrap: anywhere; margin-left: 6px; }
.tech-row .tech-code, .cand-card > .tech-code { margin-left: 0; }
.tech-row > span:last-child { text-align: right; }
.tech-details { margin-top: 4px; }
.tech-summary { cursor: pointer; font-size: 12px; color: var(--of-muted, #94a3b8); }
.evidence-item {
  border: 1px solid var(--of-line, rgba(15, 23, 42, 0.08));
  border-radius: 10px; padding: 8px; margin-bottom: 8px;
}
.merge-note { color: #92400e; font-size: 12px; margin: 8px 0; }
.mt { margin-top: 12px; }
/* 主决策区：靠版面位置（列表之下、候选详情之上）与卡片标题建立层级，不加装饰性标边 */
.primary-zone { border-radius: 10px; }
.filter-bar { margin-bottom: 8px; }
.signal-list, .audit-list { list-style: none; padding: 0; margin: 4px 0; }
.signal-item, .audit-item {
  padding: 4px 0; border-bottom: 1px dashed var(--of-line, rgba(15, 23, 42, 0.08));
  font-size: 13px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
}
.signal-field { font-weight: 600; }
.signal-vals { color: var(--of-ink-2, #475569); }
.immutable-note { font-size: 12px; color: #166534; margin-top: 2px; }
</style>
