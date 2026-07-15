<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NCollapse, NCollapseItem, NEmpty, NList, NListItem,
  NModal, NSpace, NSpin, NTabPane, NTabs, NTag, NText, NTimeline, NTimelineItem,
} from 'naive-ui';
import { capabilityBaselineApi } from '../api/capabilityBaselineApi';
import {
  createEmptyCandidateEvidenceContent,
  createEmptyCapabilityBaselineDraft,
  cloneCandidateEvidenceContent,
  cloneCapabilityBaselineDraft,
  type CandidateEvidence,
  type CandidateEvidenceContent,
  type CapabilityBaselineDraft,
  type CapabilityBaselineProposal,
  type CapabilityBaselineVersion,
  type CapabilityBaselineView,
  type CapabilityConclusionStatus,
} from '../domain/capability-baseline';
import {
  CAPABILITY_CONCLUSION_STATUS_LABELS,
  CAPABILITY_CONSTRAINT_KIND_LABELS,
  CAPABILITY_EVIDENCE_GENERATOR_LABELS,
  CAPABILITY_EVIDENCE_POLARITY_LABELS,
  CAPABILITY_EVIDENCE_SOURCE_TYPE_LABELS,
  CAPABILITY_EVIDENCE_STATUS_LABELS,
  CAPABILITY_EVIDENCE_STRENGTH_LABELS,
} from '../domain/presentation';
import CandidateEvidenceEditor from './capability-baseline/CandidateEvidenceEditor.vue';
import CapabilityBaselineEditor from './capability-baseline/CapabilityBaselineEditor.vue';

type EvidenceEditorMode = { kind: 'manual' } | { kind: 'modify'; evidenceId: string };
type BaselineEditorMode = { kind: 'manual' } | { kind: 'modify'; proposalId: string };

const view = ref<CapabilityBaselineView | null>(null);
const loading = ref(true);
const busy = ref(false);
const errorText = ref('');
const notice = ref('');
const activeTab = ref<'baseline' | 'review' | 'library' | 'versions'>('baseline');

const evidenceEditorMode = ref<EvidenceEditorMode | null>(null);
const evidenceSeed = ref<CandidateEvidenceContent>(createEmptyCandidateEvidenceContent());
const showEvidenceEditor = computed({
  get: () => evidenceEditorMode.value !== null,
  set: (visible: boolean) => { if (!visible) evidenceEditorMode.value = null; },
});

const baselineEditorMode = ref<BaselineEditorMode | null>(null);
const baselineSeed = ref<CapabilityBaselineDraft>(createEmptyCapabilityBaselineDraft());
const showBaselineEditor = computed({
  get: () => baselineEditorMode.value !== null,
  set: (visible: boolean) => { if (!visible) baselineEditorMode.value = null; },
});

const statusTagType: Record<CapabilityConclusionStatus, 'success' | 'info' | 'warning' | 'error'> = {
  established: 'success',
  supported: 'success',
  exploratory: 'info',
  insufficient: 'warning',
  contradicted: 'error',
};

const state = computed(() => view.value?.state ?? null);
const activeVersion = computed<CapabilityBaselineVersion | null>(() => view.value?.activeVersion ?? null);
const llmConfigured = computed(() => view.value?.llmConfigured ?? false);
const allEvidence = computed<CandidateEvidence[]>(() => state.value?.evidence ?? []);
const pendingEvidence = computed(() => allEvidence.value.filter((e) => e.status === 'proposed' || e.status === 'deferred'));
const acceptedEvidence = computed(() => allEvidence.value.filter((e) => e.status === 'accepted' || e.status === 'modified_and_accepted'));
const pendingProposals = computed<CapabilityBaselineProposal[]>(() => (
  state.value?.proposals.filter((p) => p.status === 'proposed') ?? []
));
const evidenceOptions = computed(() => acceptedEvidence.value.map((e) => ({
  label: `${effective(e).capabilityLabel} · ${effective(e).summary.slice(0, 20)}`,
  value: e.id,
})));

function effective(evidence: CandidateEvidence): CandidateEvidenceContent {
  if (evidence.acceptedContent !== null) return evidence.acceptedContent;
  return {
    capabilityKey: evidence.capabilityKey, capabilityLabel: evidence.capabilityLabel,
    polarity: evidence.polarity, strength: evidence.strength, sourceType: evidence.sourceType,
    sourceId: evidence.sourceId, sourceLabel: evidence.sourceLabel, city: evidence.city,
    summary: evidence.summary, observedAt: evidence.observedAt,
    timePrecision: evidence.timePrecision, sourceConfidence: evidence.sourceConfidence,
  };
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

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    view.value = await capabilityBaselineApi.get();
  } catch (error) {
    errorText.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

async function run(action: () => Promise<CapabilityBaselineView>, success: string): Promise<boolean> {
  busy.value = true;
  errorText.value = '';
  notice.value = '';
  try {
    view.value = await action();
    notice.value = success;
    return true;
  } catch (error) {
    errorText.value = (error as Error).message;
    return false;
  } finally {
    busy.value = false;
  }
}

function generateEvidence(): Promise<boolean> {
  return run(
    () => capabilityBaselineApi.generateEvidence({ idempotencyKey: newKey(), expectedStateVersion: expectedVersion() }),
    'AI 已生成候选证据，尚未进入正式证据库，请逐条审核',
  );
}
function generateBaseline(): Promise<boolean> {
  return run(
    () => capabilityBaselineApi.generateBaselineProposal({ idempotencyKey: newKey(), expectedStateVersion: expectedVersion() }),
    'AI 已生成能力基线提案，尚未成为正式基线',
  );
}

function openManualEvidence(): void {
  evidenceSeed.value = createEmptyCandidateEvidenceContent();
  evidenceEditorMode.value = { kind: 'manual' };
}
function openModifyEvidence(evidence: CandidateEvidence): void {
  evidenceSeed.value = cloneCandidateEvidenceContent(effective(evidence));
  evidenceEditorMode.value = { kind: 'modify', evidenceId: evidence.id };
}
async function submitEvidence(content: CandidateEvidenceContent): Promise<void> {
  const mode = evidenceEditorMode.value;
  if (mode === null) return;
  const ok = mode.kind === 'manual'
    ? await run(
      () => capabilityBaselineApi.createManualEvidence({ idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), content }),
      '已录入候选证据，请在审核后接受方可进入正式证据库',
    )
    : await run(
      () => capabilityBaselineApi.acceptEvidence(mode.evidenceId, {
        idempotencyKey: newKey(), expectedStateVersion: expectedVersion(),
        decisionNote: '用户修改后接受该证据', modifiedContent: content,
      }),
      '已保存修改并接受该证据',
    );
  if (ok) evidenceEditorMode.value = null;
}

function acceptEvidence(evidence: CandidateEvidence): Promise<boolean> {
  return run(
    () => capabilityBaselineApi.acceptEvidence(evidence.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户确认该证据',
    }),
    '已接受该证据，进入正式证据库',
  );
}
function rejectEvidence(evidence: CandidateEvidence): Promise<boolean> {
  return run(
    () => capabilityBaselineApi.rejectEvidence(evidence.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户拒绝该证据',
    }),
    '已拒绝该证据，不会进入正式证据库',
  );
}
function deferEvidence(evidence: CandidateEvidence): Promise<boolean> {
  return run(
    () => capabilityBaselineApi.deferEvidence(evidence.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户稍后处理',
    }),
    '已标记稍后处理，正式证据库未改变',
  );
}

function openManualBaseline(): void {
  baselineSeed.value = createEmptyCapabilityBaselineDraft();
  baselineEditorMode.value = { kind: 'manual' };
}
function openModifyBaseline(proposal: CapabilityBaselineProposal): void {
  baselineSeed.value = cloneCapabilityBaselineDraft(proposal.payload);
  baselineEditorMode.value = { kind: 'modify', proposalId: proposal.id };
}
async function submitBaseline(payload: CapabilityBaselineDraft): Promise<void> {
  const mode = baselineEditorMode.value;
  if (mode === null) return;
  const ok = mode.kind === 'manual'
    ? await run(
      () => capabilityBaselineApi.createManualBaselineProposal({ idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), payload }),
      '已建立手工能力基线提案，请审核后确认',
    )
    : await run(
      () => capabilityBaselineApi.acceptBaselineProposal(mode.proposalId, {
        idempotencyKey: newKey(), expectedStateVersion: expectedVersion(),
        decisionNote: '用户修改草案后确认为正式基线', modifiedPayload: payload,
      }),
      '已保存修改并激活新的正式能力基线版本',
    );
  if (ok) baselineEditorMode.value = null;
}

function acceptProposal(proposal: CapabilityBaselineProposal): Promise<boolean> {
  return run(
    () => capabilityBaselineApi.acceptBaselineProposal(proposal.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户确认为正式能力基线',
    }),
    '已激活新的正式能力基线版本',
  );
}
function rejectProposal(proposal: CapabilityBaselineProposal): Promise<boolean> {
  return run(
    () => capabilityBaselineApi.rejectBaselineProposal(proposal.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户拒绝该提案',
    }),
    '已拒绝该提案，正式基线未改变',
  );
}
function deferProposal(proposal: CapabilityBaselineProposal): Promise<boolean> {
  return run(
    () => capabilityBaselineApi.deferBaselineProposal(proposal.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), decisionNote: '用户稍后处理该提案',
    }),
    '已标记稍后处理，正式基线未改变',
  );
}
function activateVersion(version: CapabilityBaselineVersion): Promise<boolean> {
  return run(
    () => capabilityBaselineApi.activateVersion(version.id, {
      idempotencyKey: newKey(), expectedStateVersion: expectedVersion(), confirmed: true,
    }),
    `已切换到能力基线版本 V${version.version}`,
  );
}

onMounted(load);
</script>

<template>
  <main class="cb-page" data-testid="cb-page">
    <header class="hero">
      <div>
        <div class="eyebrow">OfferFlow v0.7 · G2</div>
        <h1>能力基线</h1>
        <p>由简历、项目、面试与招聘反馈支撑的长期能力判断。短期无回复不会自动降低能力；AI 只递交候选证据与提案，是否成为正式结论由你确认。</p>
      </div>
      <n-space>
        <n-button :loading="busy" :disabled="loading" data-testid="cb-manual-evidence" @click="openManualEvidence">手工录入证据</n-button>
        <n-button :loading="busy" :disabled="loading || !llmConfigured" data-testid="cb-generate-evidence" @click="generateEvidence">AI 生成候选证据</n-button>
        <n-button :loading="busy" :disabled="loading" data-testid="cb-manual-baseline" @click="openManualBaseline">手工建立基线提案</n-button>
        <n-button type="primary" :loading="busy" :disabled="loading || !llmConfigured" data-testid="cb-generate-baseline" @click="generateBaseline">AI 生成基线提案</n-button>
      </n-space>
    </header>

    <n-alert v-if="!loading && !llmConfigured" type="warning" class="block" data-testid="cb-llm-hint">
      当前尚未配置 AI Provider，AI 生成入口不可用；你仍可手工录入证据与建立提案。
    </n-alert>
    <n-alert v-if="errorText" type="error" closable class="block" data-testid="cb-error" @close="errorText = ''">{{ errorText }}</n-alert>
    <n-alert v-if="notice" type="success" closable class="block" data-testid="cb-notice" @close="notice = ''">{{ notice }}</n-alert>

    <n-spin :show="loading">
      <n-card class="status-card" :bordered="false" data-testid="cb-active-status">
        <n-space justify="space-between" align="center">
          <div>
            <n-text depth="3">当前正式能力基线</n-text>
            <div class="status-title">{{ activeVersion ? `V${activeVersion.version} · ${activeVersion.summary}` : '尚未建立正式能力基线' }}</div>
            <n-text v-if="activeVersion" depth="3">激活于 {{ formatTime(activeVersion.activatedAt) }}</n-text>
            <n-text v-else depth="3">候选证据与提案不会自动成为正式基线，需人工确认。</n-text>
          </div>
          <n-tag :type="activeVersion ? 'success' : 'warning'">{{ activeVersion ? '用户已确认' : '等待人工确认' }}</n-tag>
        </n-space>
      </n-card>

      <n-tabs v-model:value="activeTab" type="line" animated class="block">
        <!-- 长期能力基线 -->
        <n-tab-pane name="baseline" tab="长期能力基线">
          <n-empty v-if="!activeVersion" description="还没有已确认的正式能力基线。候选证据与提案不会偷偷成为正式结论。" data-testid="cb-baseline-empty" />
          <template v-else>
            <n-card v-for="dim in activeVersion.capabilities" :key="dim.key" size="small" class="block" :data-testid="`cb-dim-${dim.key}`">
              <n-space justify="space-between" align="center">
                <strong>{{ dim.label }}</strong>
                <n-tag :type="statusTagType[dim.conclusionStatus]">{{ CAPABILITY_CONCLUSION_STATUS_LABELS[dim.conclusionStatus] }}</n-tag>
              </n-space>
              <p>{{ dim.conclusion }}</p>
              <div class="evidence-grid">
                <section>
                  <h4>支持证据</h4>
                  <n-empty v-if="dim.supportingEvidenceRefs.length === 0" size="small" description="暂无支持证据" />
                  <ul v-else><li v-for="ref in dim.supportingEvidenceRefs" :key="ref">{{ ref }}</li></ul>
                </section>
                <section>
                  <h4>相反证据</h4>
                  <n-empty v-if="dim.counterEvidenceRefs.length === 0" size="small" description="暂无相反证据" />
                  <ul v-else><li v-for="ref in dim.counterEvidenceRefs" :key="ref">{{ ref }}</li></ul>
                </section>
                <section>
                  <h4>尚未验证</h4>
                  <ul><li v-for="item in dim.unverified" :key="item">{{ item }}</li></ul>
                </section>
              </div>
              <n-text depth="3">最大不确定性：{{ dim.largestUncertainty }} · 版本 V{{ activeVersion.version }} · 更新于 {{ formatTime(activeVersion.activatedAt) }}</n-text>
            </n-card>

            <n-card title="外部门槛与可达性约束（非能力事实）" size="small" class="block" data-testid="cb-external-constraints">
              <n-empty v-if="activeVersion.externalConstraints.length === 0" size="small" description="暂无外部门槛记录" />
              <n-list v-else>
                <n-list-item v-for="item in activeVersion.externalConstraints" :key="item.key">
                  <strong>{{ item.label }}</strong>（{{ CAPABILITY_CONSTRAINT_KIND_LABELS[item.kind] }}）— {{ item.summary }}
                </n-list-item>
              </n-list>
            </n-card>
          </template>
        </n-tab-pane>

        <!-- 候选证据审核 -->
        <n-tab-pane name="review" tab="候选证据审核">
          <n-card title="待审核 / 稍后处理候选证据" size="small" data-testid="cb-review">
            <n-empty v-if="pendingEvidence.length === 0" description="暂无待审核候选证据" />
            <n-list v-else>
              <n-list-item v-for="ev in pendingEvidence" :key="ev.id" :data-testid="`cb-evidence-${ev.id}`">
                <n-space vertical size="small" style="width: 100%">
                  <div>
                    <strong>{{ effective(ev).capabilityLabel }}</strong>
                    <n-space :size="6" style="margin: 4px 0">
                      <n-tag size="small" :type="effective(ev).polarity === 'counter' ? 'error' : effective(ev).polarity === 'support' ? 'success' : 'default'">
                        {{ CAPABILITY_EVIDENCE_POLARITY_LABELS[effective(ev).polarity] }}
                      </n-tag>
                      <n-tag size="small">强度{{ CAPABILITY_EVIDENCE_STRENGTH_LABELS[effective(ev).strength] }}</n-tag>
                      <n-tag size="small">{{ CAPABILITY_EVIDENCE_SOURCE_TYPE_LABELS[effective(ev).sourceType] }}</n-tag>
                      <n-tag size="small">{{ CAPABILITY_EVIDENCE_GENERATOR_LABELS[ev.generatedBy] }}</n-tag>
                      <n-tag size="small">{{ CAPABILITY_EVIDENCE_STATUS_LABELS[ev.status] }}</n-tag>
                    </n-space>
                    <div>{{ effective(ev).summary }}</div>
                    <n-text depth="3">来源：{{ effective(ev).sourceLabel }}{{ effective(ev).city ? ` · 城市 ${effective(ev).city}` : '' }}{{ effective(ev).observedAt ? ` · 观察于 ${formatTime(effective(ev).observedAt as number)}` : '' }}</n-text>
                  </div>
                  <n-space>
                    <n-button type="primary" size="small" :loading="busy" data-testid="cb-ev-accept" @click="acceptEvidence(ev)">接受</n-button>
                    <n-button size="small" :loading="busy" data-testid="cb-ev-modify" @click="openModifyEvidence(ev)">修改后接受</n-button>
                    <n-button size="small" type="error" ghost :loading="busy" data-testid="cb-ev-reject" @click="rejectEvidence(ev)">拒绝</n-button>
                    <n-button size="small" :loading="busy" data-testid="cb-ev-defer" @click="deferEvidence(ev)">稍后处理</n-button>
                  </n-space>
                </n-space>
              </n-list-item>
            </n-list>
          </n-card>

          <n-card title="待审核能力基线提案 · Proposal Review" size="small" class="block" data-testid="cb-proposal-review">
            <n-empty v-if="pendingProposals.length === 0" description="暂无待审核基线提案" />
            <n-list v-else>
              <n-list-item v-for="proposal in pendingProposals" :key="proposal.id" :data-testid="`cb-proposal-${proposal.id}`">
                <n-space vertical size="small" style="width: 100%">
                  <div>
                    <strong>{{ proposal.payload.summary }}</strong>
                    <div><n-text depth="3">{{ CAPABILITY_EVIDENCE_GENERATOR_LABELS[proposal.generatedBy] }} · {{ formatTime(proposal.createdAt) }}<template v-if="proposal.modelInfo"> · {{ proposal.modelInfo }}</template></n-text></div>
                  </div>
                  <n-space>
                    <n-button type="primary" size="small" :loading="busy" data-testid="cb-prop-accept" @click="acceptProposal(proposal)">接受并激活</n-button>
                    <n-button size="small" :loading="busy" data-testid="cb-prop-modify" @click="openModifyBaseline(proposal)">修改后接受</n-button>
                    <n-button size="small" type="error" ghost :loading="busy" data-testid="cb-prop-reject" @click="rejectProposal(proposal)">拒绝</n-button>
                    <n-button size="small" :loading="busy" data-testid="cb-prop-defer" @click="deferProposal(proposal)">稍后处理</n-button>
                  </n-space>
                </n-space>
              </n-list-item>
            </n-list>
          </n-card>
        </n-tab-pane>

        <!-- 证据库 -->
        <n-tab-pane name="library" tab="证据库">
          <n-card title="正式能力证据库（已接受）" size="small" data-testid="cb-library">
            <n-empty v-if="acceptedEvidence.length === 0" description="正式证据库为空；接受候选证据后才会出现在此" data-testid="cb-library-empty" />
            <n-list v-else>
              <n-list-item v-for="ev in acceptedEvidence" :key="ev.id" :data-testid="`cb-library-${ev.id}`">
                <strong>{{ effective(ev).capabilityLabel }}</strong>
                · {{ CAPABILITY_EVIDENCE_POLARITY_LABELS[effective(ev).polarity] }}
                · 强度{{ CAPABILITY_EVIDENCE_STRENGTH_LABELS[effective(ev).strength] }}
                — {{ effective(ev).summary }}
                <div><n-text depth="3">{{ effective(ev).sourceLabel }} · {{ CAPABILITY_EVIDENCE_STATUS_LABELS[ev.status] }}</n-text></div>
              </n-list-item>
            </n-list>
          </n-card>
        </n-tab-pane>

        <!-- 版本历史 -->
        <n-tab-pane name="versions" tab="版本历史">
          <n-card title="能力基线版本历史" size="small" data-testid="cb-versions">
            <n-empty v-if="!state || state.versions.length === 0" description="暂无正式版本历史" data-testid="cb-versions-empty" />
            <n-timeline v-else>
              <n-timeline-item
                v-for="version in state.versions"
                :key="version.id"
                :type="version.id === state.activeVersionId ? 'success' : 'default'"
                :data-testid="`cb-version-${version.id}`"
              >
                <n-space justify="space-between" align="center">
                  <div>
                    <strong>V{{ version.version }} · {{ version.summary }}</strong>
                    <div><n-text depth="3">{{ formatTime(version.createdAt) }} · {{ version.status === 'active' ? '当前正式版本' : '历史版本' }}</n-text></div>
                  </div>
                  <n-button v-if="version.id !== state.activeVersionId" size="small" :loading="busy" data-testid="cb-activate" @click="activateVersion(version)">切换为正式版本</n-button>
                  <n-tag v-else type="success">当前版本</n-tag>
                </n-space>
              </n-timeline-item>
            </n-timeline>
          </n-card>
        </n-tab-pane>
      </n-tabs>

      <n-collapse class="block" data-testid="cb-technical">
        <n-collapse-item title="查看技术信息（默认折叠）" name="technical">
          <pre>{{ JSON.stringify({
            stateVersion: state?.stateVersion ?? 0,
            activeVersionId: state?.activeVersionId ?? null,
            evidence: allEvidence.length,
            acceptedEvidence: acceptedEvidence.length,
            proposals: state?.proposals.length ?? 0,
            versions: state?.versions.length ?? 0,
          }, null, 2) }}</pre>
        </n-collapse-item>
      </n-collapse>
    </n-spin>

    <n-modal v-model:show="showEvidenceEditor" preset="card" :title="evidenceEditorMode?.kind === 'manual' ? '手工录入候选证据' : '修改后接受证据'" style="width: min(880px, 94vw)" data-testid="cb-evidence-editor">
      <template v-if="evidenceEditorMode">
        <n-alert type="warning" class="block">此时仍是候选证据，接受后才进入正式证据库。学历、薪资、城市供给等外部门槛不要写成能力反证。</n-alert>
        <CandidateEvidenceEditor
          :model-value="evidenceSeed"
          :submit-label="evidenceEditorMode.kind === 'manual' ? '录入候选证据' : '保存修改并接受'"
          @submit="submitEvidence"
          @cancel="evidenceEditorMode = null"
        />
      </template>
    </n-modal>

    <n-modal v-model:show="showBaselineEditor" preset="card" :title="baselineEditorMode?.kind === 'manual' ? '手工建立能力基线提案' : '修改草案后接受'" style="width: min(1080px, 94vw)" data-testid="cb-baseline-editor">
      <template v-if="baselineEditorMode">
        <n-alert type="warning" class="block">此时仍是提案，不会影响正式基线；接受后才生成不可原地修改的新版本。能力事实与外部门槛必须分离，反证不得被隐藏。</n-alert>
        <CapabilityBaselineEditor
          :model-value="baselineSeed"
          :evidence-options="evidenceOptions"
          :submit-label="baselineEditorMode.kind === 'manual' ? '建立提案' : '保存修改并激活'"
          @submit="submitBaseline"
          @cancel="baselineEditorMode = null"
        />
      </template>
    </n-modal>
  </main>
</template>

<style scoped>
.cb-page { display: flex; flex-direction: column; gap: 16px; padding-bottom: 56px; }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 28px; border: 1px solid var(--of-line, #e2e8f0); border-radius: var(--of-radius, 16px); background: linear-gradient(135deg, #fff, #f0f7ff); box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.hero h1 { margin: 4px 0 8px; font-size: 30px; }
.hero p { max-width: 760px; margin: 0; color: var(--of-ink-2, #475569); }
.eyebrow { color: var(--of-brand, #2563eb); font-weight: 700; font-size: 12px; letter-spacing: .08em; }
.block { margin-top: 16px; }
.status-card { box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.status-title { margin: 5px 0; font-size: 20px; font-weight: 700; }
.evidence-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin: 8px 0; }
.evidence-grid h4 { margin: 0 0 6px; }
pre { white-space: pre-wrap; color: var(--of-ink-2, #475569); }
@media (max-width: 860px) { .hero { align-items: flex-start; flex-direction: column; } .evidence-grid { grid-template-columns: 1fr; } }
</style>
