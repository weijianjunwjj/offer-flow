<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NList,
  NListItem,
  NModal,
  NSpace,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  NText,
  NTimeline,
  NTimelineItem,
} from 'naive-ui';
import { jobMatchProfileApi } from '../api/jobMatchProfileApi';
import {
  JOB_MATCH_CITY_CODES,
  cloneJobMatchProfileDraft,
  createEmptyJobMatchProfileDraft,
  type JobMatchCityCode,
  type JobMatchCityProfile,
  type JobMatchConfidence,
  type JobMatchEvidenceRef,
  type JobMatchProfileDraft,
  type JobMatchProfileProposal,
  type JobMatchProfileVersion,
  type JobMatchProfileView,
  type JobMatchRoleBand,
} from '../domain/job-match-profile';
import {
  JOB_MATCH_CAPABILITY_LEVEL_LABELS,
  JOB_MATCH_CITY_LABELS,
  JOB_MATCH_CONFIDENCE_LABELS,
  JOB_MATCH_GENERATED_BY_LABELS,
  JOB_MATCH_PROPOSAL_STATUS_LABELS,
} from '../domain/presentation';
import JobMatchProfileEditor from './job-match-profile/JobMatchProfileEditor.vue';
import RoleBandCard from './job-match-profile/RoleBandCard.vue';

type TabCode = 'global' | JobMatchCityCode;
type EditorMode = { kind: 'manual' } | { kind: 'modify'; proposalId: string };

const view = ref<JobMatchProfileView | null>(null);
const loading = ref(true);
const busy = ref(false);
const errorText = ref('');
const notice = ref('');
const activeTab = ref<TabCode>('global');
const editorMode = ref<EditorMode | null>(null);
const editorSeed = ref<JobMatchProfileDraft>(createEmptyJobMatchProfileDraft());
const showEditor = computed({
  get: () => editorMode.value !== null,
  set: (visible: boolean) => { if (!visible) editorMode.value = null; },
});

const cityTabs: Array<{ code: TabCode; label: string }> = [
  { code: 'global', label: '全局画像' },
  ...JOB_MATCH_CITY_CODES.map((city) => ({ code: city, label: JOB_MATCH_CITY_LABELS[city] })),
];

const confidenceTagType: Record<JobMatchConfidence, 'success' | 'info' | 'warning'> = {
  actionable: 'success',
  exploratory: 'info',
  insufficient: 'warning',
};

const state = computed(() => view.value?.state ?? null);
const activeVersion = computed<JobMatchProfileVersion | null>(() => view.value?.activeVersion ?? null);
const llmConfigured = computed(() => view.value?.llmConfigured ?? false);
const pendingProposals = computed<JobMatchProfileProposal[]>(() => (
  state.value?.proposals.filter((proposal) => proposal.status === 'proposed') ?? []
));
const currentCity = computed<JobMatchCityProfile | null>(() => {
  if (activeVersion.value === null || activeTab.value === 'global') return null;
  return activeVersion.value.cityProfiles.find((profile) => profile.city === activeTab.value) ?? null;
});
const currentConfidence = computed<JobMatchConfidence | null>(() => {
  if (activeVersion.value === null) return null;
  return activeTab.value === 'global' ? activeVersion.value.confidence : currentCity.value?.confidence ?? null;
});
const showSampleGuard = computed(() => (
  currentConfidence.value === 'insufficient' || currentConfidence.value === 'exploratory'
));
const bands = computed<Array<{ title: string; tone: 'stretch' | 'primary' | 'safe'; band: JobMatchRoleBand }> | null>(() => {
  const source = activeTab.value === 'global' ? activeVersion.value : currentCity.value;
  if (source === null || source === undefined) return null;
  return [
    { title: '冲刺岗位', tone: 'stretch', band: source.stretchRoles },
    { title: '主攻岗位', tone: 'primary', band: source.primaryRoles },
    { title: '稳妥岗位', tone: 'safe', band: source.safeRoles },
  ];
});
const supportEvidence = computed<JobMatchEvidenceRef[]>(() => (
  (activeTab.value === 'global' ? activeVersion.value?.supportingEvidence : currentCity.value?.supportingEvidence) ?? []
));
const counterEvidence = computed<JobMatchEvidenceRef[]>(() => (
  (activeTab.value === 'global' ? activeVersion.value?.counterEvidence : currentCity.value?.counterEvidence) ?? []
));

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `key-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN');
}
function evidenceStrengthLabel(strength: JobMatchEvidenceRef['strength']): string {
  return strength === 'strong' ? '强' : strength === 'medium' ? '中' : '弱';
}
function expectedVersion(): number {
  return state.value?.stateVersion ?? 0;
}

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    view.value = await jobMatchProfileApi.get();
  } catch (error) {
    errorText.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

async function run(action: () => Promise<JobMatchProfileView>, success: string): Promise<boolean> {
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

function generateProposal(): Promise<boolean> {
  return run(
    () => jobMatchProfileApi.generate({ idempotencyKey: newKey(), expectedProfileStateVersion: expectedVersion() }),
    'AI 已生成待审核提案，尚未成为正式画像',
  );
}

function openManualEditor(): void {
  editorSeed.value = createEmptyJobMatchProfileDraft();
  editorMode.value = { kind: 'manual' };
}

function openModifyEditor(proposal: JobMatchProfileProposal): void {
  editorSeed.value = cloneJobMatchProfileDraft(proposal.payload);
  editorMode.value = { kind: 'modify', proposalId: proposal.id };
}

function closeEditor(): void {
  editorMode.value = null;
}

async function submitEditor(draft: JobMatchProfileDraft): Promise<void> {
  const mode = editorMode.value;
  if (mode === null) return;
  const ok = mode.kind === 'manual'
    ? await run(
      () => jobMatchProfileApi.manual({
        idempotencyKey: newKey(), expectedProfileStateVersion: expectedVersion(), payload: draft,
      }),
      '已建立手工提案，请在下方审核后再确认为正式画像',
    )
    : await run(
      () => jobMatchProfileApi.accept(mode.proposalId, {
        idempotencyKey: newKey(),
        expectedProfileStateVersion: expectedVersion(),
        decisionNote: '用户修改草案后确认为正式画像',
        modifiedPayload: draft,
      }),
      '已保存修改并激活新的正式画像版本',
    );
  if (ok) editorMode.value = null;
}

async function acceptProposal(proposal: JobMatchProfileProposal): Promise<void> {
  await run(
    () => jobMatchProfileApi.accept(proposal.id, {
      idempotencyKey: newKey(),
      expectedProfileStateVersion: expectedVersion(),
      decisionNote: '用户确认当前提案为正式岗位匹配画像',
    }),
    '已激活新的正式画像版本',
  );
}

async function rejectProposal(proposal: JobMatchProfileProposal): Promise<void> {
  await run(
    () => jobMatchProfileApi.reject(proposal.id, {
      idempotencyKey: newKey(), expectedProfileStateVersion: expectedVersion(), decisionNote: '用户拒绝该提案',
    }),
    '已拒绝该提案，正式画像未改变',
  );
}

async function deferProposal(proposal: JobMatchProfileProposal): Promise<void> {
  await run(
    () => jobMatchProfileApi.defer(proposal.id, {
      idempotencyKey: newKey(), expectedProfileStateVersion: expectedVersion(), decisionNote: '用户稍后处理该提案',
    }),
    '已标记稍后处理，正式画像未改变',
  );
}

function activateVersion(version: JobMatchProfileVersion): Promise<boolean> {
  return run(
    () => jobMatchProfileApi.activate(version.id, {
      idempotencyKey: newKey(), expectedProfileStateVersion: expectedVersion(), confirmed: true,
    }),
    `已切换到版本 V${version.version}`,
  );
}

onMounted(load);
</script>

<template>
  <main class="jmp-page" data-testid="jmp-page">
    <header class="hero">
      <div>
        <div class="eyebrow">OfferFlow v0.7 · G1</div>
        <h1>岗位匹配画像</h1>
        <p>先看清自己在全局与四座城市里的位置，再决定往哪里冲。AI 只递交提案，是否成为正式画像由你确认。</p>
      </div>
      <n-space>
        <n-button :loading="busy" :disabled="loading" data-testid="jmp-manual" @click="openManualEditor">
          手工建立提案
        </n-button>
        <n-button
          type="primary"
          :loading="busy"
          :disabled="loading || !llmConfigured"
          :title="llmConfigured ? '' : '未配置 AI Provider，可改用手工建立提案'"
          data-testid="jmp-generate"
          @click="generateProposal"
        >
          使用 AI 生成提案
        </n-button>
      </n-space>
    </header>

    <n-alert v-if="!loading && !llmConfigured" type="warning" class="block" data-testid="jmp-llm-hint">
      当前尚未配置 AI Provider，AI 生成入口不可用；你仍可手工建立提案。
    </n-alert>
    <n-alert v-if="errorText" type="error" closable class="block" data-testid="jmp-error" @close="errorText = ''">
      {{ errorText }}
    </n-alert>
    <n-alert v-if="notice" type="success" closable class="block" data-testid="jmp-notice" @close="notice = ''">
      {{ notice }}
    </n-alert>

    <n-spin :show="loading">
      <n-card class="status-card" :bordered="false" data-testid="jmp-active-status">
        <n-space justify="space-between" align="center">
          <div>
            <n-text depth="3">当前正式版本</n-text>
            <div class="status-title">
              {{ activeVersion ? `V${activeVersion.version} · ${activeVersion.northStarPositioning}` : '尚未建立正式画像' }}
            </div>
            <n-text v-if="activeVersion" depth="3">激活于 {{ formatTime(activeVersion.activatedAt) }}</n-text>
            <n-text v-else depth="3">草案不会自动顶替正式版本，需在下方审核并确认。</n-text>
          </div>
          <n-tag :type="activeVersion ? 'success' : 'warning'">
            {{ activeVersion ? '用户已确认' : '等待人工确认' }}
          </n-tag>
        </n-space>
      </n-card>

      <n-card title="全局与四城市画像" class="block" :bordered="false">
        <n-empty
          v-if="!activeVersion"
          description="还没有已确认的正式画像。草案不会偷偷顶替正式版本。"
          data-testid="jmp-empty"
        >
          <template #extra>
            <n-text depth="3">先用「手工建立提案」或「AI 生成提案」创建草案，审核确认后才会成为正式画像。</n-text>
          </template>
        </n-empty>
        <n-tabs v-else v-model:value="activeTab" type="line" animated>
          <n-tab-pane v-for="tab in cityTabs" :key="tab.code" :name="tab.code" :tab="tab.label">
            <div class="view-head" :data-testid="`jmp-view-${tab.code}`">
              <div>
                <h2 v-if="tab.code === 'global'">{{ activeVersion.northStarPositioning }}</h2>
                <h2 v-else>{{ currentCity?.summary }}</h2>
                <n-text depth="3">
                  当前最高可达岗位：{{ tab.code === 'global' ? activeVersion.highestReachableRole : currentCity?.highestReachableRole }}
                </n-text>
              </div>
              <n-tag v-if="currentConfidence" :type="confidenceTagType[currentConfidence]">
                {{ JOB_MATCH_CONFIDENCE_LABELS[currentConfidence] }}
              </n-tag>
            </div>

            <n-alert v-if="showSampleGuard" type="warning" class="block" data-testid="jmp-sample-guard">
              样本不足或仅探索性判断：禁止据此正式降薪、禁止据此正式降级、禁止据此下调长期岗位定位。
            </n-alert>

            <div v-if="bands" class="bands">
              <RoleBandCard v-for="item in bands" :key="item.tone" :title="item.title" :tone="item.tone" :band="item.band" />
            </div>

            <!-- 全局专属：能力、限制、环境、可接受范围 -->
            <template v-if="tab.code === 'global'">
              <div class="two-columns block">
                <n-card title="核心优势与支撑能力" size="small">
                  <n-list>
                    <n-list-item v-for="cap in activeVersion.coreCapabilities.filter((c) => c.level !== 'to_validate')" :key="cap.key">
                      <strong>{{ cap.label }}</strong>（{{ JOB_MATCH_CAPABILITY_LEVEL_LABELS[cap.level] }}）— {{ cap.summary }}
                    </n-list-item>
                  </n-list>
                  <n-empty v-if="activeVersion.coreCapabilities.every((c) => c.level === 'to_validate')" size="small" description="尚未确认核心优势" />
                </n-card>
                <n-card title="待验证能力" size="small">
                  <n-list>
                    <n-list-item v-for="cap in activeVersion.coreCapabilities.filter((c) => c.level === 'to_validate')" :key="cap.key">
                      <strong>{{ cap.label }}</strong> — {{ cap.summary }}
                    </n-list-item>
                  </n-list>
                  <n-empty v-if="!activeVersion.coreCapabilities.some((c) => c.level === 'to_validate')" size="small" description="暂无" />
                </n-card>
                <n-card title="主要限制" size="small">
                  <n-list>
                    <n-list-item v-for="item in activeVersion.constraints" :key="item.key"><strong>{{ item.label }}</strong> — {{ item.summary }}</n-list-item>
                  </n-list>
                  <n-empty v-if="activeVersion.constraints.length === 0" size="small" description="尚未录入明确限制" />
                </n-card>
                <n-card title="理想公司与团队环境" size="small">
                  <p>{{ activeVersion.idealEnvironment.description }}</p>
                  <n-text depth="3">
                    {{ [...activeVersion.idealEnvironment.companySizes, ...activeVersion.idealEnvironment.companyTypes, ...activeVersion.idealEnvironment.industries, ...activeVersion.idealEnvironment.teamTraits].join(' · ') || '尚待补充' }}
                  </n-text>
                </n-card>
              </div>

              <n-card title="可接受范围" size="small" class="block">
                <n-descriptions bordered :column="1" label-placement="left">
                  <n-descriptions-item label="薪资边界">{{ activeVersion.acceptableRange.salaryNote }}</n-descriptions-item>
                  <n-descriptions-item label="岗位">{{ activeVersion.acceptableRange.roleTitles.join(' · ') || '尚待补充' }}</n-descriptions-item>
                  <n-descriptions-item label="接受城市">{{ activeVersion.acceptableRange.cities.map((c) => JOB_MATCH_CITY_LABELS[c]).join(' · ') || '尚待补充' }}</n-descriptions-item>
                  <n-descriptions-item label="办公方式">{{ activeVersion.acceptableRange.workModes.join(' · ') || '尚待补充' }}</n-descriptions-item>
                  <n-descriptions-item label="其他边界">{{ activeVersion.acceptableRange.notes.join('；') || '暂无' }}</n-descriptions-item>
                </n-descriptions>
              </n-card>
            </template>

            <!-- 城市专属：门槛、薪资、偏好、借用证据 -->
            <template v-else-if="currentCity">
              <div class="two-columns block">
                <n-card title="本地学历门槛" size="small"><n-text>{{ currentCity.educationBarrier }}</n-text></n-card>
                <n-card title="本地薪资说明" size="small"><n-text>{{ currentCity.salaryNote }}</n-text></n-card>
                <n-card title="偏好公司画像" size="small"><n-text depth="3">{{ currentCity.preferredCompanyProfile.join(' · ') || '尚待补充' }}</n-text></n-card>
                <n-card title="缺失证据" size="small">
                  <n-list><n-list-item v-for="item in currentCity.missingEvidence" :key="item">{{ item }}</n-list-item></n-list>
                  <n-empty v-if="currentCity.missingEvidence.length === 0" size="small" description="暂无" />
                </n-card>
              </div>

              <n-card title="跨城借用证据（默认降权，不并入本地置信）" size="small" class="block" data-testid="jmp-borrowed">
                <n-empty v-if="currentCity.borrowedEvidence.length === 0" size="small" description="本城市未借用其他城市证据" />
                <n-list v-else>
                  <n-list-item v-for="(item, index) in currentCity.borrowedEvidence" :key="index">
                    <div><strong>来源城市：{{ JOB_MATCH_CITY_LABELS[item.sourceCity] }}</strong></div>
                    <div>借用原因：{{ item.reason }}</div>
                    <div>权重 / 降权说明：{{ item.discountNote }}</div>
                    <div>不适用范围：{{ item.notApplicableTo.join(' · ') || '未标注' }}</div>
                  </n-list-item>
                </n-list>
              </n-card>
            </template>

            <n-card title="证据、反证与不确定性" size="small" class="block">
              <div class="evidence-grid">
                <section>
                  <h3>支持证据</h3>
                  <n-empty v-if="supportEvidence.length === 0" size="small" description="暂无支持证据" />
                  <n-list v-else>
                    <n-list-item v-for="(item, index) in supportEvidence" :key="index">
                      {{ item.summary }}<br><n-text depth="3">{{ item.label }} · 强度{{ evidenceStrengthLabel(item.strength) }}</n-text>
                    </n-list-item>
                  </n-list>
                </section>
                <section>
                  <h3>相反证据</h3>
                  <n-empty v-if="counterEvidence.length === 0" size="small" description="暂无相反证据" />
                  <n-list v-else>
                    <n-list-item v-for="(item, index) in counterEvidence" :key="index">
                      {{ item.summary }}<br><n-text depth="3">{{ item.label }} · 强度{{ evidenceStrengthLabel(item.strength) }}</n-text>
                    </n-list-item>
                  </n-list>
                </section>
                <section>
                  <h3>{{ tab.code === 'global' ? '最大不确定性' : '本地缺失与不确定性' }}</h3>
                  <n-list>
                    <n-list-item v-for="item in (tab.code === 'global' ? activeVersion.largestUncertainties : currentCity?.missingEvidence ?? [])" :key="item">{{ item }}</n-list-item>
                  </n-list>
                </section>
              </div>
            </n-card>
          </n-tab-pane>
        </n-tabs>
      </n-card>

      <n-card title="待审核提案 · Proposal Review" class="block" :bordered="false" data-testid="jmp-review">
        <n-empty v-if="pendingProposals.length === 0" description="暂无待审核提案" />
        <n-list v-else>
          <n-list-item v-for="proposal in pendingProposals" :key="proposal.id" :data-testid="`jmp-proposal-${proposal.id}`">
            <n-space vertical size="small" style="width: 100%">
              <div>
                <strong>{{ proposal.payload.northStarPositioning }}</strong>
                <div>
                  <n-text depth="3">
                    {{ JOB_MATCH_GENERATED_BY_LABELS[proposal.generatedBy] }}
                    · {{ JOB_MATCH_PROPOSAL_STATUS_LABELS[proposal.status] }}
                    · {{ formatTime(proposal.createdAt) }}
                    <template v-if="proposal.modelInfo"> · {{ proposal.modelInfo }}</template>
                  </n-text>
                </div>
              </div>
              <n-space>
                <n-button type="primary" size="small" :loading="busy" data-testid="jmp-accept" @click="acceptProposal(proposal)">接受并激活</n-button>
                <n-button size="small" :loading="busy" data-testid="jmp-modify" @click="openModifyEditor(proposal)">修改后接受</n-button>
                <n-button size="small" type="error" ghost :loading="busy" data-testid="jmp-reject" @click="rejectProposal(proposal)">拒绝</n-button>
                <n-button size="small" :loading="busy" data-testid="jmp-defer" @click="deferProposal(proposal)">稍后处理</n-button>
              </n-space>
            </n-space>
          </n-list-item>
        </n-list>
      </n-card>

      <n-card title="版本历史" class="block" :bordered="false" data-testid="jmp-versions">
        <n-empty v-if="!state || state.versions.length === 0" description="暂无正式版本历史" />
        <n-timeline v-else>
          <n-timeline-item
            v-for="version in state.versions"
            :key="version.id"
            :type="version.id === state.activeVersionId ? 'success' : 'default'"
            :data-testid="`jmp-version-${version.id}`"
          >
            <n-space justify="space-between" align="center">
              <div>
                <strong>V{{ version.version }} · {{ version.northStarPositioning }}</strong>
                <div><n-text depth="3">{{ formatTime(version.createdAt) }} · {{ version.status === 'active' ? '当前正式版本' : '历史版本' }}</n-text></div>
              </div>
              <n-button
                v-if="version.id !== state.activeVersionId"
                size="small"
                :loading="busy"
                data-testid="jmp-activate"
                @click="activateVersion(version)"
              >切换为正式版本</n-button>
              <n-tag v-else type="success">当前版本</n-tag>
            </n-space>
          </n-timeline-item>
        </n-timeline>
      </n-card>

      <n-collapse class="block" data-testid="jmp-technical">
        <n-collapse-item title="查看技术信息（默认折叠）" name="technical">
          <pre>{{ JSON.stringify({
            stateVersion: state?.stateVersion ?? 0,
            activeVersionId: state?.activeVersionId ?? null,
            proposals: state?.proposals.length ?? 0,
            versions: state?.versions.length ?? 0,
            activeSourceSnapshot: activeVersion?.sourceSnapshot ?? null,
          }, null, 2) }}</pre>
        </n-collapse-item>
      </n-collapse>
    </n-spin>

    <n-modal v-model:show="showEditor" preset="card" :title="editorMode?.kind === 'manual' ? '手工建立岗位画像提案' : '修改草案后接受'" style="width: min(1080px, 94vw)" data-testid="jmp-editor">
      <template v-if="editorMode">
        <n-alert type="warning" class="block">
          此时仍是草案，不会影响正式画像；接受后才生成不可原地修改的新版本。四城市结论相互独立，跨城证据只能显式借用并降权。
        </n-alert>
        <JobMatchProfileEditor
          :model-value="editorSeed"
          :submit-label="editorMode.kind === 'manual' ? '建立提案' : '保存修改并激活'"
          @submit="submitEditor"
          @cancel="closeEditor"
        />
      </template>
    </n-modal>
  </main>
</template>

<style scoped>
.jmp-page { display: flex; flex-direction: column; gap: 16px; padding-bottom: 56px; }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 28px; border: 1px solid var(--of-line, #e2e8f0); border-radius: var(--of-radius, 16px); background: linear-gradient(135deg, #fff, #f0f7ff); box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.hero h1 { margin: 4px 0 8px; font-size: 30px; }
.hero p { max-width: 720px; margin: 0; color: var(--of-ink-2, #475569); }
.eyebrow { color: var(--of-brand, #2563eb); font-weight: 700; font-size: 12px; letter-spacing: .08em; }
.block { margin-top: 16px; }
.status-card { box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.status-title { margin: 5px 0; font-size: 20px; font-weight: 700; }
.view-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.view-head h2 { margin: 8px 0 4px; }
.bands { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.two-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.evidence-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.evidence-grid h3 { margin-top: 0; }
pre { white-space: pre-wrap; color: var(--of-ink-2, #475569); }
@media (max-width: 860px) { .hero { align-items: flex-start; flex-direction: column; } .bands, .evidence-grid { grid-template-columns: 1fr; } }
@media (max-width: 620px) { .two-columns { grid-template-columns: 1fr; } }
</style>
