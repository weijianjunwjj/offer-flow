<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NCollapse, NCollapseItem, NEmpty, NList, NListItem,
  NModal, NSpace, NSpin, NTabPane, NTabs, NTag, NText, NTimeline, NTimelineItem,
} from 'naive-ui';
import { ApiError, ApiNetworkError } from '../api/client';
import { marketPositionApi } from '../api/marketPositionApi';
import { features } from '../config/features';
import {
  createEmptyMarketPositionDraft,
  cloneMarketPositionDraft,
  marketPositionDraftFromVersion,
  MARKET_POSITION_CITY_CODES,
  type MarketPositionCityCode,
  type MarketPositionDraft,
  type MarketPositionProposal,
  type MarketPositionScopeProfile,
  type MarketPositionVersion,
  type MarketPositionView,
} from '../domain/market-position';
import {
  DECISION_GATE_STATUS_LABELS,
  DECISION_GATE_TYPE_LABELS,
  MARKET_POSITION_CITY_LABELS,
  MARKET_POSITION_EVIDENCE_LEVEL_LABELS,
} from '../domain/presentation';
import MarketPositionDraftEditor from './market-position/MarketPositionDraftEditor.vue';

type DraftEditorMode = { kind: 'manual' } | { kind: 'modify'; proposalId: string };

const view = ref<MarketPositionView | null>(null);
const loading = ref(true);
const busy = ref(false);
const generating = ref(false);
const errorText = ref('');
const notice = ref('');
const activeTab = ref<'overview' | MarketPositionCityCode | 'review' | 'versions'>('overview');
const highlightedProposalId = ref<string | null>(null);

const draftEditorMode = ref<DraftEditorMode | null>(null);
const draftSeed = ref<MarketPositionDraft>(createEmptyMarketPositionDraft());
const showDraftEditor = computed({
  get: () => draftEditorMode.value !== null,
  set: (visible: boolean) => { if (!visible) draftEditorMode.value = null; },
});

const evidenceLevelTagType: Record<string, 'success' | 'info' | 'warning'> = {
  supported: 'success',
  directional: 'info',
  insufficient: 'warning',
};
const gateStatusTagType: Record<string, 'success' | 'info' | 'warning'> = {
  decision_ready: 'success',
  observe_only: 'info',
  blocked: 'warning',
};

const state = computed(() => view.value?.state ?? null);
const activeVersion = computed<MarketPositionVersion | null>(() => view.value?.activeVersion ?? null);
const pendingProposals = computed<MarketPositionProposal[]>(() => (
  state.value?.proposals.filter((p) => p.status === 'proposed') ?? []
));

function cityProfile(city: MarketPositionCityCode): MarketPositionScopeProfile | null {
  return activeVersion.value?.cityProfiles.find((profile) => profile.scope.city === city) ?? null;
}

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `key-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN');
}
function expectedVersion(): number {
  return state.value?.stateVersion ?? 0;
}
function describeError(error: unknown): string {
  if (error instanceof ApiNetworkError) {
    if (features.g4SandboxEnabled) {
      return 'G4 隔离环境后端未启动或已退出，请重新启动 dev:g4-sandbox。';
    }
    return '网络请求失败，请检查后端服务是否可用';
  }
  if (error instanceof ApiError) {
    const code = (error.body as { code?: string } | undefined)?.code;
    if (code === 'MARKET_POSITION_AI_UNAVAILABLE') return 'AI 服务尚未配置或暂不可用，可改用手工建立市场位置提案';
    if (code === 'MARKET_POSITION_AI_OUTPUT_INVALID') return 'AI 未能生成符合安全约束的文案，可重试或改用手工建立市场位置提案';
    if (code === 'MARKET_POSITION_AI_EVIDENCE_REFERENCE_INVALID') return 'AI 引用了无效证据，已阻止生成，可重试或改用手工建立市场位置提案';
    if (code === 'MARKET_POSITION_INPUT_STALE') return '正式输入数据已发生变化，请刷新后重新生成';
    if (code === 'MARKET_POSITION_PROPOSAL_ALREADY_EXISTS') return '相同输入已有待审核的 AI 生成提案，请先处理该提案';
    return error.message;
  }
  return '操作失败，请稍后重试';
}

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    view.value = await marketPositionApi.get();
  } catch (error) {
    errorText.value = describeError(error);
  } finally {
    loading.value = false;
  }
}

async function run(action: () => Promise<MarketPositionView>, success: string): Promise<boolean> {
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

async function generateProposal(): Promise<void> {
  if (generating.value || busy.value) return;
  generating.value = true;
  errorText.value = '';
  notice.value = '';
  try {
    const before = new Set((state.value?.proposals ?? []).map((p) => p.id));
    view.value = await marketPositionApi.generateProposal({
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(),
    });
    if (view.value.reused) {
      notice.value = '相同输入已有待审核的 AI 生成提案，已自动打开该提案';
      const existing = (state.value?.proposals ?? [])
        .filter((p) => p.generatedBy === 'ai' && p.status === 'proposed')
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      highlightedProposalId.value = existing?.id ?? null;
    } else {
      notice.value = '已生成待审核的 AI 市场位置提案，请审核后确认';
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
  draftSeed.value = activeVersion.value !== null
    ? cloneMarketPositionDraft(marketPositionDraftFromVersion(activeVersion.value))
    : createEmptyMarketPositionDraft();
  draftEditorMode.value = { kind: 'manual' };
}
function openModifyProposal(proposal: MarketPositionProposal): void {
  draftSeed.value = cloneMarketPositionDraft(proposal.payload);
  draftEditorMode.value = { kind: 'modify', proposalId: proposal.id };
}
async function submitDraft(payload: MarketPositionDraft): Promise<void> {
  const mode = draftEditorMode.value;
  if (mode === null) return;
  const ok = mode.kind === 'manual'
    ? await run(
      () => marketPositionApi.createManualProposal({ idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), payload }),
      '已建立手工市场位置提案，请审核后确认',
    )
    : await run(
      () => marketPositionApi.acceptProposal(mode.proposalId, {
        idempotencyKey: newKey(), expectedStateVersion: expectedVersion(),
        decisionNote: '用户修改草案后确认为正式版本', modifiedPayload: payload,
      }),
      '已保存修改并激活新的正式市场位置版本',
    );
  if (ok) draftEditorMode.value = null;
}

function acceptProposal(proposal: MarketPositionProposal): Promise<boolean> {
  return run(
    () => marketPositionApi.acceptProposal(proposal.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户确认为正式市场位置版本',
    }),
    '已激活新的正式市场位置版本',
  );
}
function rejectProposal(proposal: MarketPositionProposal): Promise<boolean> {
  return run(
    () => marketPositionApi.rejectProposal(proposal.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户拒绝该提案',
    }),
    '已拒绝该提案，正式版本未改变',
  );
}
function deferProposal(proposal: MarketPositionProposal): Promise<boolean> {
  return run(
    () => marketPositionApi.deferProposal(proposal.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户稍后处理该提案',
    }),
    '已标记稍后处理，正式版本未改变',
  );
}
function activateVersion(version: MarketPositionVersion): Promise<boolean> {
  return run(
    () => marketPositionApi.activateVersion(version.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), confirmed: true,
    }),
    `已切换到市场位置版本 V${version.version}`,
  );
}

onMounted(load);
</script>

<template>
  <main class="mp-page" data-testid="mp-page">
    <header class="hero">
      <div>
        <div class="eyebrow">OfferFlow v0.7 · G4</div>
        <h1>市场位置画像</h1>
        <p>
          统一岗位匹配画像（G1）、能力基线（G2）与历史投递漏斗（G3）形成的市场位置判断。
          本页不做自动决策、不自动降薪、不放弃方向、不触发搬迁；证据不足时会明确标注，绝不虚构市场结论。
        </p>
      </div>
      <n-space vertical align="end">
        <n-space>
          <n-button
            type="primary"
            :loading="generating"
            :disabled="loading || busy"
            data-testid="mp-ai-generate"
            @click="generateProposal"
          >AI 生成市场位置提案</n-button>
          <n-button :loading="busy" :disabled="loading || generating" data-testid="mp-manual-draft" @click="openManualDraft">手工建立市场位置提案</n-button>
        </n-space>
        <n-text depth="3" style="max-width: 420px; text-align: right; font-size: 12px" data-testid="mp-ai-disclosure">
          系统将基于 G1 岗位画像、G2 能力基线和 G3 正式市场反馈生成待审核提案，不会自动成为正式结论。
        </n-text>
      </n-space>
    </header>

    <n-alert v-if="!loading && !view?.llmConfigured" type="warning" class="block" data-testid="mp-ai-not-configured">
      当前环境未配置 AI 服务，AI 生成按钮仍可点击，但会提示不可用；可改用手工建立市场位置提案。
    </n-alert>
    <n-alert v-if="errorText" type="error" closable class="block" data-testid="mp-error" @close="errorText = ''">{{ errorText }}</n-alert>
    <n-alert v-if="notice" type="success" closable class="block" data-testid="mp-notice" @close="notice = ''">{{ notice }}</n-alert>

    <n-spin :show="loading">
      <n-card class="status-card" :bordered="false" data-testid="mp-active-status">
        <n-space justify="space-between" align="center">
          <div>
            <n-text depth="3">当前正式市场位置版本</n-text>
            <div class="status-title">{{ activeVersion ? `V${activeVersion.version} · ${activeVersion.global.headline}` : '尚未建立正式市场位置版本' }}</div>
            <n-text v-if="activeVersion" depth="3">激活于 {{ formatTime(activeVersion.activatedAt) }}</n-text>
            <n-text v-else depth="3">手工提案与审核不会自动成为正式版本，需人工确认。</n-text>
          </div>
          <n-tag :type="activeVersion ? 'success' : 'warning'">{{ activeVersion ? '用户已确认' : '等待人工确认' }}</n-tag>
        </n-space>
      </n-card>

      <n-tabs v-model:value="activeTab" type="line" animated class="block">
        <n-tab-pane name="overview" tab="全局总览">
          <n-empty v-if="!activeVersion" description="还没有已确认的正式市场位置版本。" data-testid="mp-overview-empty" />
          <template v-else>
            <n-card size="small" class="block" data-testid="mp-scope-global">
              <n-space justify="space-between" align="center">
                <strong>{{ activeVersion.global.headline }}</strong>
                <n-tag :type="evidenceLevelTagType[activeVersion.global.evidenceSufficiency.evidenceLevel]">
                  {{ MARKET_POSITION_EVIDENCE_LEVEL_LABELS[activeVersion.global.evidenceSufficiency.evidenceLevel] }}
                </n-tag>
              </n-space>
              <p>{{ activeVersion.global.positioning }}</p>
              <n-text depth="3">{{ activeVersion.global.evidenceSufficiency.allowedClaims.join('；') || '暂无可下的结论' }}</n-text>
              <n-card v-for="gate in activeVersion.global.decisionGates" :key="gate.gateType" size="small" class="block" :data-testid="`mp-gate-${gate.gateType}`">
                <n-space justify="space-between" align="center">
                  <strong>{{ DECISION_GATE_TYPE_LABELS[gate.gateType] }}</strong>
                  <n-tag :type="gateStatusTagType[gate.status]">{{ DECISION_GATE_STATUS_LABELS[gate.status] }}</n-tag>
                </n-space>
                <n-text depth="3">{{ gate.rationale }}</n-text>
              </n-card>
            </n-card>
          </template>
        </n-tab-pane>

        <n-tab-pane v-for="city in MARKET_POSITION_CITY_CODES" :key="city" :name="city" :tab="MARKET_POSITION_CITY_LABELS[city]">
          <n-empty v-if="!activeVersion || !cityProfile(city)" description="该城市暂无正式市场位置结论" :data-testid="`mp-city-empty-${city}`" />
          <template v-else>
            <n-card size="small" class="block" :data-testid="`mp-city-${city}`">
              <n-space justify="space-between" align="center">
                <strong>{{ cityProfile(city)!.headline }}</strong>
                <n-tag :type="evidenceLevelTagType[cityProfile(city)!.evidenceSufficiency.evidenceLevel]">
                  {{ MARKET_POSITION_EVIDENCE_LEVEL_LABELS[cityProfile(city)!.evidenceSufficiency.evidenceLevel] }}
                </n-tag>
              </n-space>
              <p>{{ cityProfile(city)!.positioning }}</p>
              <n-text depth="3">{{ cityProfile(city)!.evidenceSufficiency.allowedClaims.join('；') || '暂无可下的结论' }}</n-text>
              <n-card v-for="gate in cityProfile(city)!.decisionGates" :key="gate.gateType" size="small" class="block" :data-testid="`mp-city-gate-${city}-${gate.gateType}`">
                <n-space justify="space-between" align="center">
                  <strong>{{ DECISION_GATE_TYPE_LABELS[gate.gateType] }}</strong>
                  <n-tag :type="gateStatusTagType[gate.status]">{{ DECISION_GATE_STATUS_LABELS[gate.status] }}</n-tag>
                </n-space>
                <n-text depth="3">{{ gate.rationale }}</n-text>
              </n-card>
            </n-card>
          </template>
        </n-tab-pane>

        <n-tab-pane name="review" tab="提案审核">
          <n-card title="待审核市场位置提案" size="small" data-testid="mp-review">
            <n-empty v-if="pendingProposals.length === 0" description="暂无待审核提案" />
            <n-list v-else>
              <n-list-item
                v-for="proposal in pendingProposals"
                :key="proposal.id"
                :data-testid="`mp-proposal-${proposal.id}`"
                :class="{ 'mp-proposal-highlight': proposal.id === highlightedProposalId }"
              >
                <n-space vertical size="small" style="width: 100%">
                  <div>
                    <n-space align="center" size="small">
                      <n-tag :type="proposal.generatedBy === 'ai' ? 'info' : 'default'" data-testid="mp-proposal-source">
                        {{ proposal.generatedBy === 'ai' ? 'AI 生成' : '手工建立' }}
                      </n-tag>
                      <strong>{{ proposal.payload.global.headline }}</strong>
                    </n-space>
                    <div><n-text depth="3">{{ formatTime(proposal.createdAt) }}</n-text></div>
                  </div>

                  <n-card v-if="proposal.aiGeneration" size="small" embedded data-testid="mp-proposal-ai-meta">
                    <n-space vertical size="small">
                      <n-text depth="3">生成时间：{{ formatTime(proposal.aiGeneration.generatedAt) }}</n-text>
                      <n-text depth="3">
                        输入依据：G1 岗位画像 {{ proposal.inputSnapshot.jobMatchProfileVersionId ?? '无' }}
                        · G2 能力基线 {{ proposal.inputSnapshot.capabilityBaselineVersionId ?? '无' }}
                        · G3 数据截止 {{ formatTime(proposal.inputSnapshot.funnelCutoffAt) }}
                      </n-text>
                    </n-space>
                  </n-card>

                  <n-card size="small" embedded :data-testid="`mp-proposal-detail-${proposal.id}`">
                    <n-space vertical size="small">
                      <n-space justify="space-between" align="center">
                        <n-text depth="3">全局证据等级（系统计算，AI 不可更改）</n-text>
                        <n-tag :type="evidenceLevelTagType[proposal.payload.global.evidenceSufficiency.evidenceLevel]">
                          {{ MARKET_POSITION_EVIDENCE_LEVEL_LABELS[proposal.payload.global.evidenceSufficiency.evidenceLevel] }}
                        </n-tag>
                      </n-space>
                      <n-text class="ai-narrative" depth="1">{{ proposal.payload.global.positioning }}</n-text>
                      <n-text depth="3">允许结论：{{ proposal.payload.global.evidenceSufficiency.allowedClaims.join('；') || '暂无' }}</n-text>
                      <n-text depth="3">禁止结论：{{ proposal.payload.global.evidenceSufficiency.blockedClaims.join('；') || '暂无' }}</n-text>
                      <n-text v-if="proposal.payload.global.uncertainties.length" depth="3">
                        不确定性：{{ proposal.payload.global.uncertainties.join('；') }}
                      </n-text>
                      <n-space>
                        <n-tag
                          v-for="gate in proposal.payload.global.decisionGates"
                          :key="gate.gateType"
                          size="small"
                          :type="gateStatusTagType[gate.status]"
                        >{{ DECISION_GATE_TYPE_LABELS[gate.gateType] }}：{{ DECISION_GATE_STATUS_LABELS[gate.status] }}</n-tag>
                      </n-space>
                    </n-space>
                  </n-card>

                  <n-space>
                    <n-button type="primary" size="small" :loading="busy" data-testid="mp-prop-accept" @click="acceptProposal(proposal)">接受并激活</n-button>
                    <n-button size="small" :loading="busy" data-testid="mp-prop-modify" @click="openModifyProposal(proposal)">修改后接受</n-button>
                    <n-button size="small" type="error" ghost :loading="busy" data-testid="mp-prop-reject" @click="rejectProposal(proposal)">拒绝</n-button>
                    <n-button size="small" :loading="busy" data-testid="mp-prop-defer" @click="deferProposal(proposal)">稍后处理</n-button>
                  </n-space>
                </n-space>
              </n-list-item>
            </n-list>
          </n-card>
        </n-tab-pane>

        <n-tab-pane name="versions" tab="版本历史">
          <n-card title="市场位置版本历史" size="small" data-testid="mp-versions">
            <n-empty v-if="!state || state.versions.length === 0" description="暂无正式版本历史" data-testid="mp-versions-empty" />
            <n-timeline v-else>
              <n-timeline-item
                v-for="version in state.versions"
                :key="version.id"
                :type="version.id === state.activeVersionId ? 'success' : 'default'"
                :data-testid="`mp-version-${version.id}`"
              >
                <n-space justify="space-between" align="center">
                  <div>
                    <strong>V{{ version.version }} · {{ version.global.headline }}</strong>
                    <div><n-text depth="3">{{ formatTime(version.createdAt) }} · {{ version.status === 'active' ? '当前正式版本' : '历史版本' }}</n-text></div>
                  </div>
                  <n-button v-if="version.id !== state.activeVersionId" size="small" :loading="busy" data-testid="mp-activate" @click="activateVersion(version)">切换为正式版本</n-button>
                  <n-tag v-else type="success">当前版本</n-tag>
                </n-space>
              </n-timeline-item>
            </n-timeline>
          </n-card>
        </n-tab-pane>
      </n-tabs>

      <n-collapse class="block" data-testid="mp-technical">
        <n-collapse-item title="查看技术信息（默认折叠）" name="technical">
          <pre>{{ JSON.stringify({
            stateVersion: state?.stateVersion ?? 0,
            activeVersionId: state?.activeVersionId ?? null,
            proposals: state?.proposals.length ?? 0,
            versions: state?.versions.length ?? 0,
          }, null, 2) }}</pre>
        </n-collapse-item>
      </n-collapse>
    </n-spin>

    <n-modal
      v-model:show="showDraftEditor"
      preset="card"
      :title="draftEditorMode?.kind === 'manual' ? '手工建立市场位置提案' : '修改草案后接受'"
      style="width: min(1200px, 96vw)"
      data-testid="mp-draft-modal"
    >
      <template v-if="draftEditorMode">
        <n-alert type="warning" class="block">
          此时仍是提案，不会影响正式版本；证据等级、决策门与允许/禁止措辞由系统按证据自动计算，不能手工改写，只能编辑叙述性描述。
        </n-alert>
        <MarketPositionDraftEditor
          :model-value="draftSeed"
          :submit-label="draftEditorMode.kind === 'manual' ? '建立提案' : '保存修改并激活'"
          @submit="submitDraft"
          @cancel="draftEditorMode = null"
        />
      </template>
    </n-modal>
  </main>
</template>

<style scoped>
.mp-page { display: flex; flex-direction: column; gap: 16px; padding-bottom: 56px; }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 28px; border: 1px solid var(--of-line, #e2e8f0); border-radius: var(--of-radius, 16px); background: linear-gradient(135deg, #fff, #f0f7ff); box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.hero h1 { margin: 4px 0 8px; font-size: 30px; }
.hero p { max-width: 760px; margin: 0; color: var(--of-ink-2, #475569); }
.eyebrow { color: var(--of-brand, #2563eb); font-weight: 700; font-size: 12px; letter-spacing: .08em; }
.block { margin-top: 16px; }
.status-card { box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.status-title { margin: 5px 0; font-size: 20px; font-weight: 700; }
.ai-narrative { display: block; font-style: italic; }
.mp-proposal-highlight { outline: 2px solid var(--of-brand, #2563eb); border-radius: 8px; }
pre { white-space: pre-wrap; color: var(--of-ink-2, #475569); }
@media (max-width: 860px) { .hero { align-items: flex-start; flex-direction: column; } }
</style>
