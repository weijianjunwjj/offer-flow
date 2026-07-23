<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NInput, NModal, NSpace, NSpin, NTag, NText } from 'naive-ui';
import { ApiError } from '../api/client';
import {
  radarReviewApi,
  type CandidateDecisionDetail, type DecisionFeedItem, type RelationListItem,
  type RuleEvidenceView, type RelationStatus,
} from '../api/radarReviewApi';

const loading = ref(true);
const busy = ref(false);
const errorText = ref('');
const notice = ref('');
const staleHint = ref('');

const relations = ref<RelationListItem[]>([]);
const feed = ref<DecisionFeedItem[]>([]);
const selectedRelation = ref<RelationListItem | null>(null);
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
    relations.value = await radarReviewApi.listRelations();
    feed.value = await radarReviewApi.listDecisionFeed();
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(loadRelations);

async function selectRelation(rel: RelationListItem): Promise<void> {
  selectedRelation.value = rel;
  staleHint.value = '';
  detailLow.value = null;
  detailHigh.value = null;
  evidence.value = [];
  try {
    detailLow.value = await radarReviewApi.getCandidateDetail(rel.candidateIdLow);
    detailHigh.value = await radarReviewApi.getCandidateDetail(rel.candidateIdHigh);
    const vid = detailLow.value?.activeCandidateVersionId;
    if (vid != null) evidence.value = await radarReviewApi.listRuleEvidence(vid);
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '加载详情失败';
  }
}

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
          <NEmpty v-if="relations.length === 0" description="暂无待处理关系" data-testid="relations-empty" />
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
              <NTag size="small" :type="f.analysisEligible ? 'success' : 'error'">{{ f.decisionType }}</NTag>
              <NText depth="3">{{ f.summary?.company ?? '（无候选）' }}</NText>
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
      <NCard v-if="selectedRelation" title="候选对比" size="small" class="mt" data-testid="candidate-compare">
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
            <NSpace size="small" class="mt">
              <NButton v-if="e.overrideState === 'none'" size="tiny" :disabled="busy" :data-testid="`override-set-${e.assessmentId}`"
                @click="openConfirm('override-set', '设置规则覆盖（通过）', '将新增一条覆盖审计事件，不修改原始规则评估', { assessmentId: e.assessmentId, value: 'pass', expectedOverrideState: e.overrideState })">设为通过</NButton>
              <NButton v-else size="tiny" :disabled="busy" :data-testid="`override-revert-${e.assessmentId}`"
                @click="openConfirm('override-revert', '撤销规则覆盖', '将新增一条撤销审计事件，恢复规则默认判定', { assessmentId: e.assessmentId, expectedOverrideState: e.overrideState })">撤销覆盖</NButton>
            </NSpace>
          </div>
        </div>

        <!-- 区域 6：人工操作 -->
        <div class="mt">
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
</style>
