<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NCollapse, NCollapseItem, NEmpty, NInput,
  NList, NListItem, NModal, NSpace, NSpin, NTabPane, NTabs, NTag, NText,
  NTimeline, NTimelineItem,
} from 'naive-ui';
import {
  buildDeterministicStrategyDraft,
  cloneStrategyDraft,
  createEmptyStrategyDraft,
  type StrategyProposal,
  type StrategyProposalDraft,
  type StrategyView,
} from '../domain/strategy-window';
import {
  STRATEGY_ACTION_TYPE_LABELS,
  STRATEGY_ALLOCATION_DIMENSION_LABELS,
  STRATEGY_CITY_LABELS,
  STRATEGY_DECISION_GATE_STATUS_LABELS,
  STRATEGY_DECISION_GATE_TYPE_LABELS,
  STRATEGY_EVIDENCE_LEVEL_LABELS,
  STRATEGY_JOB_FAMILY_LABELS,
  STRATEGY_WINDOW_TYPE_LABELS,
} from '../domain/presentation/strategyWindowLabels';
import { strategyWindowApi } from '../api/strategyWindowApi';
import { ApiError, ApiNetworkError } from '../api/client';
import { features } from '../config/features';

type DraftEditorMode = { kind: 'manual' } | { kind: 'modify'; proposalId: string };

const view = ref<StrategyView | null>(null);
const loading = ref(true);
const busy = ref(false);
const generating = ref(false);
const errorText = ref('');
const notice = ref('');
const activeTab = ref<'window' | 'boundaries' | 'overview' | 'actions' | 'experiments' | 'review' | 'versions'>('window');
const highlightedProposalId = ref<string | null>(null);

const draftEditorMode = ref<DraftEditorMode | null>(null);
const draftSeed = ref<StrategyProposalDraft>(createEmptyStrategyDraft());
const showDraftEditor = computed({
  get: () => draftEditorMode.value !== null,
  set: (v) => { if (!v) draftEditorMode.value = null; },
});

const evidenceLevelTagType: Record<string, 'success' | 'info' | 'warning'> = {
  supported: 'success', directional: 'info', insufficient: 'warning',
};
const state = computed(() => view.value?.state ?? null);
const activeVersion = computed(() => view.value?.activeVersion ?? null);
const currentWindow = computed(() => view.value?.currentWindow ?? null);
const inputReady = computed(() => view.value?.inputReady ?? false);
const pendingProposals = computed(() => state.value?.proposals.filter((p) => p.status === 'proposed') ?? []);
const versions = computed(() => [...(state.value?.versions ?? [])].sort((a, b) => b.version - a.version));

function expectedVersion(): number { return state.value?.stateVersion ?? 0; }
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function actionLabel(actionType: string): string {
  return STRATEGY_ACTION_TYPE_LABELS[actionType as keyof typeof STRATEGY_ACTION_TYPE_LABELS] ?? actionType;
}
function gateTypeLabel(gateType: string): string {
  return STRATEGY_DECISION_GATE_TYPE_LABELS[gateType as keyof typeof STRATEGY_DECISION_GATE_TYPE_LABELS] ?? gateType;
}
function gateStatusLabel(status: string): string {
  return STRATEGY_DECISION_GATE_STATUS_LABELS[status as keyof typeof STRATEGY_DECISION_GATE_STATUS_LABELS] ?? status;
}
function allocationKeyLabel(key: string): string {
  return STRATEGY_CITY_LABELS[key] ?? STRATEGY_JOB_FAMILY_LABELS[key] ?? key;
}
function dimensionLabel(dimension: string): string {
  return STRATEGY_ALLOCATION_DIMENSION_LABELS[dimension as keyof typeof STRATEGY_ALLOCATION_DIMENSION_LABELS] ?? dimension;
}
function windowTypeLabel(windowType: string): string {
  return STRATEGY_WINDOW_TYPE_LABELS[windowType as keyof typeof STRATEGY_WINDOW_TYPE_LABELS] ?? windowType;
}
function evidenceLevelLabel(level: string): string {
  return STRATEGY_EVIDENCE_LEVEL_LABELS[level as keyof typeof STRATEGY_EVIDENCE_LEVEL_LABELS] ?? level;
}
function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function describeError(error: unknown): string {
  if (error instanceof ApiNetworkError) {
    if (features.g5SandboxEnabled) {
      return 'G5 隔离环境后端未启动或已退出，请重新启动 dev:g5-sandbox。';
    }
    return '网络请求失败，请检查后端服务是否可用';
  }
  if (error instanceof ApiError) {
    const code = (error.body as { code?: string } | undefined)?.code;
    if (code === 'STRATEGY_INPUT_NOT_READY') return '尚无已验收的 G4 市场位置正式版本，请先在 G4 建立并激活正式版本后再生成策略';
    if (code === 'STRATEGY_AI_UNAVAILABLE') return 'AI 服务尚未配置或暂不可用，可改用手工建立求职策略提案';
    if (code === 'STRATEGY_AI_OUTPUT_INVALID') return 'AI 未能生成符合安全约束的策略，可重试或改用手工建立求职策略提案';
    if (code === 'STRATEGY_INPUT_STALE') return '正式输入数据已发生变化，该提案已失效，请刷新后重新生成';
    if (code === 'STRATEGY_WINDOW_EXPIRED') return '当前策略窗口已到期，请基于最新输入重新生成提案';
    if (code === 'STRATEGY_ACTION_BLOCKED') return '策略中包含当前窗口不允许的行动，已阻止保存';
    if (code === 'STRATEGY_ALLOCATION_INVALID') return '样本分配比例不合法（同一维度需合计 100，且无证据时须标注探索性）';
    if (code === 'STRATEGY_EVIDENCE_REFERENCE_INVALID') return '策略引用了无效证据，已阻止保存';
    if (code === 'STRATEGY_PROPOSAL_ALREADY_EXISTS') return '相同输入已有待审核的 AI 生成提案，请先处理该提案';
    if (code === 'STRATEGY_NO_EFFECTIVE_CHANGE') return '该提案与当前正式策略没有有效变化';
    return error.message;
  }
  return '操作失败，请稍后重试';
}

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    view.value = await strategyWindowApi.get();
  } catch (error) {
    errorText.value = describeError(error);
  } finally {
    loading.value = false;
  }
}

async function run(action: () => Promise<StrategyView>, success: string): Promise<boolean> {
  busy.value = true;
  errorText.value = '';
  notice.value = '';
  try {
    view.value = await action();
    notice.value = success;
    return true;
  } catch (error) {
    errorText.value = describeError(error);
    return false;
  } finally {
    busy.value = false;
  }
}

onMounted(load);

async function generateProposal(): Promise<void> {
  if (generating.value || busy.value) return;
  generating.value = true;
  errorText.value = '';
  notice.value = '';
  try {
    const before = new Set((state.value?.proposals ?? []).map((p) => p.id));
    view.value = await strategyWindowApi.generateProposal({
      idempotencyKey: newKey(),
      expectedStateVersion: expectedVersion(),
    });
    if (view.value.reused) {
      notice.value = '相同输入已有待审核的 AI 策略提案，已自动打开该提案';
      const existing = (state.value?.proposals ?? [])
        .filter((p) => p.generatedBy === 'ai' && p.status === 'proposed')
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      highlightedProposalId.value = existing?.id ?? null;
    } else {
      notice.value = '已生成待审核的 AI 求职策略提案，请审核后确认';
      const created = (state.value?.proposals ?? []).find((p) => !before.has(p.id) && p.generatedBy === 'ai');
      highlightedProposalId.value = created?.id ?? null;
    }
    activeTab.value = 'review';
  } catch (error) {
    errorText.value = describeError(error);
  } finally {
    generating.value = false;
  }
}

function openManualDraft(): void {
  const window = currentWindow.value;
  if (window === null) {
    errorText.value = '尚无可用策略窗口，请先在 G4 建立并激活正式市场位置版本';
    return;
  }
  draftSeed.value = buildDeterministicStrategyDraft(window, { createId: newKey });
  draftEditorMode.value = { kind: 'manual' };
}

function openModifyProposal(proposal: StrategyProposal): void {
  draftSeed.value = cloneStrategyDraft(proposal.payload);
  draftEditorMode.value = { kind: 'modify', proposalId: proposal.id };
}

async function submitDraft(): Promise<void> {
  const mode = draftEditorMode.value;
  if (mode === null) return;
  const payload = cloneStrategyDraft(draftSeed.value);
  const ok = mode.kind === 'manual'
    ? await run(() => strategyWindowApi.createManualProposal({
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), payload,
    }), '已建立手工求职策略提案，请审核后确认')
    : await run(() => strategyWindowApi.acceptProposal(mode.proposalId, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(),
      decisionNote: '用户修改草案后确认为正式策略版本', modifiedPayload: payload,
    }), '已保存修改并激活新的正式求职策略版本');
  if (ok) draftEditorMode.value = null;
}

async function acceptProposal(proposal: StrategyProposal): Promise<void> {
  await run(() => strategyWindowApi.acceptProposal(proposal.id, {
    idempotencyKey: newKey(), expectedStateVersion: expectedVersion(),
    decisionNote: '用户接受并激活为正式策略版本',
  }), '已接受提案并激活为正式求职策略版本');
}
async function rejectProposal(proposal: StrategyProposal): Promise<void> {
  await run(() => strategyWindowApi.rejectProposal(proposal.id, {
    idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户拒绝该提案',
  }), '已拒绝该提案');
}
async function deferProposal(proposal: StrategyProposal): Promise<void> {
  await run(() => strategyWindowApi.deferProposal(proposal.id, {
    idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户稍后处理',
  }), '已将该提案标记为稍后处理');
}
async function activateVersion(id: string): Promise<void> {
  await run(() => strategyWindowApi.activateVersion(id, {
    idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), confirmed: true,
  }), '已切换正式求职策略版本');
}

const draftUncertaintiesText = computed({
  get: () => draftSeed.value.uncertainties.join('\n'),
  set: (v: string) => {
    draftSeed.value = { ...draftSeed.value, uncertainties: v.split('\n').map((s) => s.trim()).filter((s) => s !== '') };
  },
});
</script>

<template>
  <main class="sw-page" data-testid="sw-page">
    <section class="hero">
      <div class="hero-text">
        <p class="eyebrow">OfferFlow v0.7 · G5</p>
        <h1>求职策略</h1>
        <p class="lede">
          基于已验证的能力、匹配度、市场反馈与证据充分性，给出受门禁约束、可审核、可撤销的阶段性求职策略。
        </p>
        <p class="disclaimer" data-testid="sw-ai-disclosure">
          规则引擎决定边界，AI 只在边界内生成叙述性策略，用户决定是否接受，系统不会自动执行投递、联系、降薪、迁移或放弃方向，也不会自动成为正式结论。
        </p>
      </div>
      <NSpace vertical>
        <NButton
          type="primary"
          data-testid="sw-ai-generate"
          :loading="generating"
          :disabled="loading || busy || !inputReady"
          @click="generateProposal"
        >AI 生成求职策略提案</NButton>
        <NButton
          data-testid="sw-manual-draft"
          :loading="busy"
          :disabled="loading || generating || !inputReady"
          @click="openManualDraft"
        >手工建立策略提案</NButton>
      </NSpace>
    </section>

    <NAlert
      v-if="!loading && !inputReady"
      type="warning"
      data-testid="sw-input-not-ready"
      :bordered="true"
      style="margin-bottom: 12px;"
    >
      尚无已验收的 G4 市场位置正式版本，无法生成求职策略窗口。请先在“市场位置画像”中建立并激活正式版本。
    </NAlert>
    <NAlert
      v-if="!loading && inputReady && !view?.llmConfigured"
      type="info"
      data-testid="sw-ai-not-configured"
      :bordered="true"
      style="margin-bottom: 12px;"
    >
      AI 服务尚未配置，可改用“手工建立策略提案”。
    </NAlert>
    <NAlert
      v-if="errorText"
      type="error"
      closable
      data-testid="sw-error"
      style="margin-bottom: 12px;"
      @close="errorText = ''"
    >{{ errorText }}</NAlert>
    <NAlert
      v-if="notice"
      type="success"
      closable
      data-testid="sw-notice"
      style="margin-bottom: 12px;"
      @close="notice = ''"
    >{{ notice }}</NAlert>

    <NSpin :show="loading">
      <NCard data-testid="sw-active-status" style="margin-bottom: 12px;">
        <template v-if="activeVersion">
          <NSpace align="center">
            <NText strong>正式策略 V{{ activeVersion.version }}</NText>
            <NTag :type="evidenceLevelTagType[activeVersion.window.evidenceLevel] ?? 'default'" size="small">
              {{ windowTypeLabel(activeVersion.window.windowType) }}
            </NTag>
            <NText depth="3">{{ activeVersion.payload.headline }}</NText>
          </NSpace>
        </template>
        <NText v-else depth="3">尚未确认任何正式求职策略版本；下方展示的当前窗口与提案仍需人工接受后才生效。</NText>
      </NCard>

      <NTabs v-model:value="activeTab" type="line" animated>
        <!-- 1. 当前策略窗口 -->
        <NTabPane name="window" tab="当前策略窗口">
          <NCard v-if="currentWindow" data-testid="sw-current-window">
            <NSpace vertical size="small">
              <NSpace align="center">
                <NTag :type="evidenceLevelTagType[currentWindow.evidenceLevel] ?? 'default'">
                  {{ windowTypeLabel(currentWindow.windowType) }}
                </NTag>
                <NText>当前证据等级：{{ evidenceLevelLabel(currentWindow.evidenceLevel) }}</NText>
              </NSpace>
              <NText depth="3">窗口开始：{{ formatDate(currentWindow.startsAt) }}</NText>
              <NText depth="3">复盘时间：{{ formatDate(currentWindow.reviewAt) }}</NText>
              <NText depth="3">到期时间：{{ formatDate(currentWindow.expiresAt) }}</NText>
              <NText depth="3">数据截止：{{ formatDate(currentWindow.dataCutoffAt) }}</NText>
              <NText strong>复盘触发条件</NText>
              <ul>
                <li v-for="(trigger, i) in currentWindow.reviewTriggers" :key="`rt-${i}`">{{ trigger }}</li>
              </ul>
              <NText strong>决策门快照（系统计算，AI 不可更改）</NText>
              <NSpace>
                <NTag
                  v-for="gate in currentWindow.decisionGateSnapshot"
                  :key="gate.gateType"
                  size="small"
                  :type="evidenceLevelTagType[currentWindow.evidenceLevel] ?? 'default'"
                >
                  {{ gateTypeLabel(gate.gateType) }}：{{ gateStatusLabel(gate.status) }}
                </NTag>
              </NSpace>
              <NText strong>输入版本</NText>
              <NText depth="3">
                岗位匹配：{{ currentWindow.sourceVersionIds.jobMatchProfileVersionId ?? '无' }}；
                能力基线：{{ currentWindow.sourceVersionIds.capabilityBaselineVersionId ?? '无' }}；
                市场位置：{{ currentWindow.sourceVersionIds.marketPositionVersionId ?? '无' }}
              </NText>
            </NSpace>
          </NCard>
          <NEmpty v-else description="当前无可用策略窗口" data-testid="sw-current-window-empty" />
        </NTabPane>

        <!-- 2. 三类边界 -->
        <NTabPane name="boundaries" tab="三类边界">
          <div v-if="currentWindow" data-testid="sw-boundaries">
            <NCard title="现在可以做" data-testid="sw-can-do" style="margin-bottom: 8px;">
              <NSpace>
                <NTag v-for="t in currentWindow.allowedActionTypes" :key="t" type="success" size="small">
                  {{ actionLabel(t) }}
                </NTag>
              </NSpace>
            </NCard>
            <NCard title="只能观察或实验" data-testid="sw-observe-only" style="margin-bottom: 8px;">
              <NSpace v-if="currentWindow.observeOnlyActionTypes.length > 0">
                <NTag v-for="t in currentWindow.observeOnlyActionTypes" :key="t" type="info" size="small">
                  {{ actionLabel(t) }}
                </NTag>
              </NSpace>
              <NText v-else depth="3">当前窗口暂无仅供观察的行动</NText>
            </NCard>
            <NCard title="当前不能做" data-testid="sw-cannot-do">
              <NSpace vertical size="small">
                <NSpace v-if="currentWindow.blockedActionTypes.length > 0">
                  <NTag v-for="t in currentWindow.blockedActionTypes" :key="t" type="warning" size="small">
                    {{ actionLabel(t) }}
                  </NTag>
                </NSpace>
                <ul>
                  <li>不得直接降薪或给出降薪结论</li>
                  <li>不得放弃任何城市或职业方向</li>
                  <li>不得直接搬迁或辞职</li>
                  <li>不得自动投递、联系或跟进招聘方</li>
                  <li>不得预测 Offer 概率或成功率</li>
                </ul>
              </NSpace>
            </NCard>
          </div>
          <NEmpty v-else description="当前无可用策略窗口" />
        </NTabPane>

        <!-- 3. 策略总览 -->
        <NTabPane name="overview" tab="策略总览">
          <NCard v-if="activeVersion" data-testid="sw-overview">
            <NSpace vertical size="small">
              <NText strong>{{ activeVersion.payload.objective }}</NText>
              <NText depth="3">策略周期：{{ activeVersion.payload.horizonDays }} 天</NText>
              <div v-for="plan in activeVersion.payload.allocationPlans" :key="plan.dimension">
                <NText strong>{{ dimensionLabel(plan.dimension) }}投入比例</NText>
                <NText depth="3">（{{ plan.note }}）</NText>
                <ul>
                  <li v-for="entry in plan.entries" :key="entry.key">
                    {{ allocationKeyLabel(entry.key) }}：{{ entry.share }}%
                    <NTag v-if="entry.exploratory" size="tiny" type="warning">探索性</NTag>
                  </li>
                </ul>
              </div>
              <NText strong>样本目标</NText>
              <ul><li v-for="(t, i) in activeVersion.payload.evidenceTargets" :key="`et-${i}`">{{ t }}</li></ul>
              <NText strong>停止条件</NText>
              <ul><li v-for="(t, i) in activeVersion.payload.stopConditions" :key="`sc-${i}`">{{ t }}</li></ul>
              <NText strong>下一次复盘条件</NText>
              <ul><li v-for="(t, i) in activeVersion.payload.reviewTriggers" :key="`rt2-${i}`">{{ t }}</li></ul>
            </NSpace>
          </NCard>
          <NEmpty v-else description="尚未确认正式策略版本，接受提案后展示策略总览" data-testid="sw-overview-empty" />
        </NTabPane>

        <!-- 4. 行动清单 -->
        <NTabPane name="actions" tab="行动清单">
          <div v-if="activeVersion && activeVersion.payload.actions.length > 0" data-testid="sw-actions">
            <NCard
              v-for="(action, index) in activeVersion.payload.actions"
              :key="action.id"
              :data-testid="`sw-action-${index}`"
              size="small"
              style="margin-bottom: 8px;"
            >
              <NSpace vertical size="small">
                <NSpace align="center">
                  <NText strong>{{ action.title }}</NText>
                  <NTag size="small">{{ actionLabel(action.actionType) }}</NTag>
                  <NTag size="small" :type="action.reversible ? 'success' : 'warning'">
                    {{ action.reversible ? '可逆' : '不可逆' }}
                  </NTag>
                </NSpace>
                <NText depth="3">为什么：{{ action.rationale }}</NText>
                <NText depth="3">适用范围：{{ action.city ? (STRATEGY_CITY_LABELS[action.city] ?? action.city) : '全局' }}</NText>
                <NText depth="3">目标数量：{{ action.targetCount }}；复盘：{{ formatDate(action.reviewAt) }}</NText>
                <NText depth="3">成功信号：{{ action.successSignals.join('；') }}</NText>
                <NText depth="3">失败信号：{{ action.failureSignals.join('；') }}</NText>
                <NText depth="3">停止条件：{{ action.stopConditions.join('；') }}</NText>
                <NText depth="3" v-if="action.sourceDecisionGate">
                  证据来源门：{{ gateTypeLabel(action.sourceDecisionGate) }}
                </NText>
              </NSpace>
            </NCard>
          </div>
          <NEmpty v-else description="尚未确认正式策略版本，接受提案后展示行动清单" data-testid="sw-actions-empty" />
        </NTabPane>

        <!-- 5. 实验计划 -->
        <NTabPane name="experiments" tab="实验计划">
          <div v-if="activeVersion && activeVersion.payload.experiments.length > 0" data-testid="sw-experiments">
            <NCard
              v-for="exp in activeVersion.payload.experiments"
              :key="exp.id"
              size="small"
              style="margin-bottom: 8px;"
            >
              <NSpace vertical size="small">
                <NText strong>{{ exp.title }}</NText>
                <NText depth="3">单一变量：{{ exp.variable }}</NText>
                <NText depth="3">A 版本：{{ exp.variantA }}</NText>
                <NText depth="3">B 版本：{{ exp.variantB }}</NText>
                <NText depth="3">样本目标：{{ exp.sampleTarget }}</NText>
                <NText depth="3">观察指标：{{ exp.observationMetric }}</NText>
                <NText depth="3">结束条件：{{ exp.endCondition }}</NText>
              </NSpace>
            </NCard>
          </div>
          <NEmpty v-else description="当前正式策略暂无受控实验" data-testid="sw-experiments-empty" />
        </NTabPane>

        <!-- 6. Proposal Review -->
        <NTabPane name="review" tab="提案审核">
          <div v-if="pendingProposals.length > 0" data-testid="sw-review">
            <NList bordered>
              <NListItem
                v-for="proposal in pendingProposals"
                :key="proposal.id"
                :data-testid="`sw-proposal-${proposal.id}`"
                :class="{ 'sw-proposal-highlight': proposal.id === highlightedProposalId }"
              >
                <NSpace vertical size="small">
                  <NSpace align="center">
                    <NTag :type="proposal.generatedBy === 'ai' ? 'info' : 'default'" size="small" data-testid="sw-proposal-source">
                      {{ proposal.generatedBy === 'ai' ? 'AI 生成' : '手工建立' }}
                    </NTag>
                    <NTag :type="evidenceLevelTagType[proposal.window.evidenceLevel] ?? 'default'" size="small">
                      {{ windowTypeLabel(proposal.window.windowType) }}
                    </NTag>
                    <NTag v-if="proposal.stale" type="warning" size="small" data-testid="sw-proposal-stale">
                      输入已变化 / 已失效
                    </NTag>
                  </NSpace>
                  <NText strong>{{ proposal.payload.headline }}</NText>
                  <NText class="ai-narrative">{{ proposal.payload.summary }}</NText>
                  <NText depth="3" v-if="proposal.aiGeneration" data-testid="sw-proposal-ai-meta">
                    生成时间：{{ formatDate(proposal.aiGeneration.generatedAt) }}；
                    输入依据（系统计算，AI 不可更改）：证据等级
                    {{ evidenceLevelLabel(proposal.window.evidenceLevel) }}
                  </NText>
                  <NText strong>可执行行动</NText>
                  <NSpace>
                    <NTag v-for="t in proposal.window.allowedActionTypes" :key="t" size="tiny" type="success">
                      {{ actionLabel(t) }}
                    </NTag>
                  </NSpace>
                  <NText strong>当前禁止</NText>
                  <NText depth="3">{{ proposal.payload.prohibitedActions.join('；') }}</NText>
                  <NText strong>不确定性</NText>
                  <NText depth="3">{{ proposal.payload.uncertainties.join('；') }}</NText>
                  <NSpace>
                    <NButton
                      size="small" type="primary" data-testid="sw-prop-accept"
                      :loading="busy" :disabled="proposal.stale"
                      @click="acceptProposal(proposal)"
                    >接受并激活</NButton>
                    <NButton
                      size="small" data-testid="sw-prop-modify"
                      :loading="busy" :disabled="proposal.stale"
                      @click="openModifyProposal(proposal)"
                    >修改后接受</NButton>
                    <NButton size="small" type="error" ghost data-testid="sw-prop-reject" :loading="busy" @click="rejectProposal(proposal)">
                      拒绝
                    </NButton>
                    <NButton size="small" data-testid="sw-prop-defer" :loading="busy" @click="deferProposal(proposal)">
                      稍后处理
                    </NButton>
                  </NSpace>
                </NSpace>
              </NListItem>
            </NList>
          </div>
          <NEmpty v-else description="当前没有待审核的策略提案" data-testid="sw-review-empty" />
        </NTabPane>

        <!-- 7. Version History -->
        <NTabPane name="versions" tab="版本历史">
          <div v-if="versions.length > 0" data-testid="sw-versions">
            <NTimeline>
              <NTimelineItem
                v-for="version in versions"
                :key="version.id"
                :type="version.id === state?.activeVersionId ? 'success' : 'default'"
                :data-testid="`sw-version-${version.id}`"
              >
                <NSpace vertical size="small">
                  <NText strong>V{{ version.version }} · {{ version.payload.headline }}</NText>
                  <NText depth="3">激活时间：{{ formatDate(version.activatedAt) }}</NText>
                  <NText depth="3">来源：{{ version.generationMode === 'ai' ? 'AI 生成' : '手工建立' }}</NText>
                  <NText depth="3" v-if="version.decisionDiff.length > 0">修改摘要：{{ version.decisionDiff.join('、') }}</NText>
                  <NButton
                    v-if="version.id !== state?.activeVersionId"
                    size="tiny" data-testid="sw-activate" :loading="busy"
                    @click="activateVersion(version.id)"
                  >切换到该版本</NButton>
                </NSpace>
              </NTimelineItem>
            </NTimeline>
          </div>
          <NEmpty v-else description="尚无正式策略版本" data-testid="sw-versions-empty" />
        </NTabPane>
      </NTabs>

      <NCollapse style="margin-top: 12px;">
        <NCollapseItem title="查看技术信息" name="tech" data-testid="sw-technical">
          <pre>{{ JSON.stringify({
            stateVersion: state?.stateVersion,
            activeVersionId: state?.activeVersionId,
            proposals: state?.proposals.length,
            versions: state?.versions.length,
          }, null, 2) }}</pre>
        </NCollapseItem>
      </NCollapse>
    </NSpin>

    <NModal
      v-model:show="showDraftEditor"
      preset="card"
      style="max-width: 720px;"
      :title="draftEditorMode?.kind === 'modify' ? '修改后接受策略提案' : '手工建立策略提案'"
      data-testid="sw-draft-modal"
    >
      <NAlert type="warning" :bordered="true" style="margin-bottom: 12px;">
        此时仍是提案。窗口类型、允许/禁止的行动、分配约束与证据引用由系统按证据自动计算，不能手工改写，只能编辑叙述性描述；保存后由服务端重新校验门禁。
      </NAlert>
      <NSpace vertical size="small">
        <NText strong>标题</NText>
        <NInput v-model:value="draftSeed.headline" data-testid="sw-draft-headline" />
        <NText strong>目标</NText>
        <NInput v-model:value="draftSeed.objective" type="textarea" :autosize="{ minRows: 2 }" />
        <NText strong>概述</NText>
        <NInput v-model:value="draftSeed.summary" type="textarea" :autosize="{ minRows: 2 }" />
        <NText strong>不确定性（每行一条）</NText>
        <NInput v-model:value="draftUncertaintiesText" type="textarea" :autosize="{ minRows: 2 }" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="draftEditorMode = null">取消</NButton>
          <NButton type="primary" :loading="busy" data-testid="sw-draft-submit" @click="submitDraft">
            {{ draftEditorMode?.kind === 'modify' ? '保存并激活' : '建立提案' }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </main>
</template>

<style scoped>
.sw-page { padding: 16px; max-width: 1080px; margin: 0 auto; }
.hero { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 16px; }
.eyebrow { color: #999; font-size: 12px; margin: 0; }
.lede { color: #444; margin: 4px 0; }
.disclaimer { color: #888; font-size: 12px; }
.ai-narrative { font-style: italic; }
.sw-proposal-highlight { background: #f0f7ff; }
ul { margin: 4px 0; padding-left: 20px; }
</style>
