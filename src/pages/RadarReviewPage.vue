<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NInput, NModal, NSpace, NSpin, NTag, NText } from 'naive-ui';
import { ApiError } from '../api/client';
import {
  radarReviewApi,
  type CandidateDecisionDetail, type DecisionFeedItem, type RelationDetail, type RelationListItem,
  type RuleEvidenceView, type RelationStatus,
} from '../api/radarReviewApi';

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
      if (again !== undefined) await selectRelation(again);
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
          <ul v-else class="relation-list" data-testid="relation-list">
            <li v-for="rel in relations" :key="rel.relationId">
              <NButton
                text
                :type="selectedRelation?.relationId === rel.relationId ? 'primary' : 'default'"
                :data-testid="`relation-${rel.relationId}`"
                @click="selectRelation(rel)"
              >
                <NTag size="small" :type="rel.status === 'needs_recheck' ? 'warning' : 'info'">{{ rel.status }}</NTag>
                {{ rel.lowSummary.company ?? '?' }} × {{ rel.highSummary.company ?? '?' }}
              </NButton>
            </li>
          </ul>
        </NCard>

        <!-- 区域：决策审阅 feed（含阻断信息） -->
        <NCard title="决策审阅（变化 / 阻断）" size="small" class="col">
          <NEmpty v-if="feed.length === 0" description="暂无决策记录" />
          <ul v-else class="feed-list" data-testid="decision-feed">
            <li v-for="f in feed" :key="f.snapshotId" :data-testid="`feed-${f.decisionType}`">
              <NButton text :disabled="f.candidateId === null" :data-testid="`feed-open-${f.snapshotId}`" @click="selectFeedCandidate(f.candidateId)">
                <NTag size="small" :type="f.analysisEligible ? 'success' : 'error'">{{ f.decisionType }}</NTag>
                <NText depth="3">{{ f.summary?.company ?? '（无候选）' }}</NText>
              </NButton>
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

      <!-- 区域 2/3/4：候选对比 + 变化摘要 + 阻断信息（选中关系后展开） -->
      <NCard v-if="showCompare" title="候选对比" size="small" class="mt" data-testid="candidate-compare">
        <div class="compare">
          <div v-for="(d, side) in { low: detailLow, high: detailHigh }" :key="side">
            <NText strong>{{ side === 'low' ? '候选 A' : '候选 B' }}</NText>
            <template v-if="d">
              <div class="field-row"><span>公司</span><span>{{ d.currentVersion?.company ?? '—' }}</span></div>
              <div class="field-row"><span>岗位</span><span>{{ d.currentVersion?.role ?? '—' }}</span></div>
              <div class="field-row"><span>城市</span><span>{{ d.currentVersion?.city ?? '—' }}</span></div>
              <div class="field-row"><span>薪资</span><span>{{ salaryText(d.currentVersion) }}</span></div>
              <div class="field-row"><span>学历</span><span>{{ d.currentVersion?.educationRequirement ?? '—' }}</span></div>
              <div class="field-row"><span>经验</span><span>{{ d.currentVersion?.experienceRequirement ?? '—' }}</span></div>
              <div class="field-row"><span>JD</span><span>{{ d.currentVersion?.jdExcerpt ?? '—' }}</span></div>
              <div class="field-row"><span>来源</span><span>{{ d.currentVersion?.normalizedSourceUrl ?? '—' }}</span></div>
              <div class="field-row"><span>当前版本</span><span>{{ d.activeCandidateVersionId ?? '—' }}</span></div>
              <NTag size="small" :type="d.analysisEligible ? 'success' : 'error'">{{ d.decisionType }}</NTag>
              <div v-if="d.conflictReason" class="reason">冲突原因：{{ d.conflictReason }}</div>
              <div v-for="cf in d.changedFields" :key="cf.fieldPath" class="reason" data-testid="changed-field">
                {{ cf.fieldPath }}：{{ cf.before ?? '∅' }} → {{ cf.after ?? '∅' }}（{{ cf.classification }}：{{ cf.reason }}）
              </div>
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
              <NTag size="small" type="info">{{ sig.signalType }}</NTag>
              <span class="signal-field">{{ sig.field }}</span>
              <span class="signal-vals">A：{{ signalValueText(sig.candidateAValue) }} ｜ B：{{ signalValueText(sig.candidateBValue) }}</span>
              <NText v-if="sig.strength !== null" depth="3">强度 {{ sig.strength }}</NText>
              <div class="reason">{{ sig.explanation }}</div>
            </li>
          </ul>
          <div class="reason" data-testid="relation-meta">
            当前状态：{{ relationDetail.status }} ｜ 原因码：{{ relationDetail.reasonCode ?? '—' }}
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
              <NTag size="small" :type="e.evidenceState === 'corrupt' ? 'error' : e.evidenceState === 'legacy_scalar' ? 'warning' : 'default'">{{ e.evidenceState }}</NTag>
              <NTag size="small" :type="e.overrideState === 'none' ? 'default' : 'info'">覆盖：{{ e.overrideState }}</NTag>
              <NText v-if="e.outcome" depth="3">outcome={{ e.outcome }}</NText>
            </NSpace>
            <div v-if="e.evidenceState === 'structured'" class="reason">
              字段 {{ e.matchedFieldPath }} · 原值 {{ e.rawValue }} · 规范化 {{ e.normalizedValue }} · 置信度 {{ e.confidence }}
            </div>
            <div v-if="e.excerpt" class="reason">摘要：{{ e.excerpt }}</div>
            <div v-if="e.explanation" class="reason">说明：{{ e.explanation }}</div>
            <div v-if="e.corruptReason" class="reason">损坏原因：{{ e.corruptReason }}</div>
            <!-- 原始规则评估只读标识 + 不可变说明（由只读 API 提供，非仅 UI 文案） -->
            <div class="reason" :data-testid="`evidence-original-${e.assessmentId}`">
              原评估 {{ e.assessmentId }} · 结果 {{ e.originalResult }}
              <span v-if="e.evidenceHashShort"> · 证据哈希 {{ e.evidenceHashShort }}</span>
            </div>
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
.radar-review { padding: 16px; max-width: 1200px; margin: 0 auto; }
.review-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.col { min-width: 0; }
.compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.relation-list, .feed-list { list-style: none; padding: 0; margin: 0; }
.relation-list li, .feed-list li { padding: 6px 0; border-bottom: 1px solid #eee; }
.reason { font-size: 12px; color: #666; margin-top: 2px; }
.field-row { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; padding: 2px 0; }
.evidence-item { border: 1px solid #eee; border-radius: 6px; padding: 8px; margin-bottom: 8px; }
.merge-note { color: #b06a00; font-size: 12px; margin: 8px 0; }
.mt { margin-top: 12px; }
.filter-bar { margin-bottom: 8px; }
.signal-list, .audit-list { list-style: none; padding: 0; margin: 4px 0; }
.signal-item, .audit-item { padding: 4px 0; border-bottom: 1px dashed #eee; font-size: 13px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.signal-field { font-weight: 600; }
.signal-vals { color: #444; }
.immutable-note { font-size: 12px; color: #2a7; margin-top: 2px; }
</style>
