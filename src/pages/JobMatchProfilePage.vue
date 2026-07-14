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
  NDivider,
  NEmpty,
  NInput,
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
  useMessage,
} from 'naive-ui';
import { jobMatchProfileApi } from '../api/jobMatchProfileApi';
import {
  JobMatchProfileDraftSchema,
  createEmptyJobMatchProfileState,
  getActiveJobMatchProfileVersion,
  getJobMatchProfileView,
  type JobMatchCityCode,
  type JobMatchProfileProposal,
  type JobMatchProfileState,
  type JobMatchProfileView,
} from '../domain/job-match-profile';

const message = useMessage();
const state = ref<JobMatchProfileState>(createEmptyJobMatchProfileState());
const loading = ref(true);
const busy = ref(false);
const errorText = ref('');
const activeCity = ref<JobMatchCityCode>('global');
const reviewProposal = ref<JobMatchProfileProposal | null>(null);
const editedDraftJson = ref('');
const showReview = computed({
  get: () => reviewProposal.value !== null,
  set: (visible: boolean) => {
    if (!visible) reviewProposal.value = null;
  },
});

const cityTabs: Array<{ code: JobMatchCityCode; label: string }> = [
  { code: 'global', label: '全局画像' },
  { code: 'suzhou', label: '苏州' },
  { code: 'wuxi', label: '无锡' },
  { code: 'shanghai', label: '上海' },
  { code: 'hangzhou', label: '杭州' },
];
const activeVersion = computed(() => getActiveJobMatchProfileVersion(state.value));
const activeView = computed<JobMatchProfileView | null>(() => (
  activeVersion.value ? getJobMatchProfileView(activeVersion.value.draft, activeCity.value) : null
));
const pendingProposals = computed(() => state.value.proposals.filter(
  (proposal) => proposal.status === 'proposed' || proposal.status === 'deferred',
));

const confidenceLabels = {
  insufficient: '样本不足',
  exploratory: '探索性',
  actionable: '可行动',
} as const;
const confidenceTypes = {
  insufficient: 'warning',
  exploratory: 'info',
  actionable: 'success',
} as const;

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN');
}

function openReview(proposal: JobMatchProfileProposal): void {
  reviewProposal.value = proposal;
  editedDraftJson.value = JSON.stringify(proposal.draft, null, 2);
}

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    state.value = await jobMatchProfileApi.get();
  } catch (error) {
    errorText.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

async function run(action: () => Promise<JobMatchProfileState>, success: string): Promise<boolean> {
  busy.value = true;
  errorText.value = '';
  try {
    state.value = await action();
    message.success(success);
    return true;
  } catch (error) {
    errorText.value = (error as Error).message;
    return false;
  } finally {
    busy.value = false;
  }
}

function createManualProposal(): Promise<boolean> {
  return run(
    () => jobMatchProfileApi.createManualProposal(state.value.stateVersion),
    '已建立手工草案，请先审核，尚未成为正式画像',
  );
}

function createAiProposal(): Promise<boolean> {
  return run(
    () => jobMatchProfileApi.createAiProposal(state.value.stateVersion),
    'AI 草案已生成，请先审核，尚未成为正式画像',
  );
}

async function decide(
  proposal: JobMatchProfileProposal,
  action: 'accept' | 'reject' | 'defer',
): Promise<void> {
  const success = await run(
    () => jobMatchProfileApi.decideProposal(proposal.id, {
      expectedStateVersion: state.value.stateVersion,
      action,
      note: action === 'accept' ? '用户确认当前草案为正式岗位匹配画像' : '',
    }),
    action === 'accept' ? '已激活新的正式画像版本' : action === 'reject' ? '已拒绝该提案' : '已标记稍后处理',
  );
  if (success) reviewProposal.value = null;
}

async function modifyAndAccept(proposal: JobMatchProfileProposal): Promise<void> {
  try {
    const modifiedDraft = JobMatchProfileDraftSchema.parse(JSON.parse(editedDraftJson.value));
    const success = await run(
      () => jobMatchProfileApi.decideProposal(proposal.id, {
        expectedStateVersion: state.value.stateVersion,
        action: 'modify_and_accept',
        note: '用户修改草案后确认成为正式岗位匹配画像',
        modifiedDraft,
      }),
      '已保存修改并激活新的正式画像版本',
    );
    if (success) reviewProposal.value = null;
  } catch (error) {
    errorText.value = `修改后的草案不符合严格结构：${(error as Error).message}`;
  }
}

function activate(versionId: string): Promise<boolean> {
  return run(
    () => jobMatchProfileApi.activateVersion(versionId, state.value.stateVersion),
    '已切换正式画像版本',
  );
}

onMounted(load);
</script>

<template>
  <main class="profile-page">
    <header class="hero">
      <div>
        <div class="eyebrow">OfferFlow v0.7 · G1</div>
        <h1>岗位匹配画像</h1>
        <p>先看清自己在全局与四座城市里的位置，再决定往哪里冲。AI 只递提案，方向盘始终在你手里。</p>
      </div>
      <n-space>
        <n-button :loading="busy" @click="createManualProposal">手工建立草案</n-button>
        <n-button type="primary" :loading="busy" @click="createAiProposal">使用现有 AI 生成提案</n-button>
      </n-space>
    </header>

    <n-alert v-if="errorText" type="error" closable class="block" @close="errorText = ''">
      {{ errorText }}
    </n-alert>

    <n-spin :show="loading">
      <n-card class="status-card" :bordered="false">
        <n-space justify="space-between" align="center">
          <div>
            <n-text depth="3">当前正式版本</n-text>
            <div class="status-title">
              {{ activeVersion ? `V${activeVersion.versionNumber} · ${activeVersion.draft.title}` : '尚未建立正式画像' }}
            </div>
            <n-text v-if="activeVersion" depth="3">激活于 {{ formatTime(activeVersion.activatedAt) }}</n-text>
            <n-text v-else depth="3">先建立草案并在 Proposal Review 中确认，页面不会自动替你下结论。</n-text>
          </div>
          <n-tag :type="activeVersion ? 'success' : 'warning'">
            {{ activeVersion ? '用户已确认' : '等待人工确认' }}
          </n-tag>
        </n-space>
      </n-card>

      <n-card title="全局与四城市画像" class="block" :bordered="false">
        <n-tabs v-model:value="activeCity" type="line" animated>
          <n-tab-pane v-for="tab in cityTabs" :key="tab.code" :name="tab.code" :tab="tab.label">
            <n-empty v-if="!activeView" description="还没有已激活画像。草案不会偷偷顶替正式版本。" />
            <template v-else>
              <div class="view-head">
                <div>
                  <h2>{{ activeView.headline }}</h2>
                  <p>{{ activeView.corePositioning }}</p>
                </div>
                <n-tag :type="confidenceTypes[activeView.confidenceState]">
                  {{ confidenceLabels[activeView.confidenceState] }}
                </n-tag>
              </div>
              <n-alert :type="activeView.confidenceState === 'actionable' ? 'success' : 'warning'" class="block">
                {{ activeView.confidenceReason }}
              </n-alert>
              <n-descriptions bordered :column="1" label-placement="left" class="block">
                <n-descriptions-item label="核心岗位定位">{{ activeView.corePositioning }}</n-descriptions-item>
                <n-descriptions-item label="当前最高可达岗位">{{ activeView.highestReachableRole }}</n-descriptions-item>
              </n-descriptions>
              <div class="bands">
                <n-card v-for="band in [activeView.stretch, activeView.focus, activeView.safe]" :key="band.label" size="small">
                  <template #header>{{ band.label === 'stretch' ? '冲刺' : band.label === 'focus' ? '主攻' : '稳妥' }}</template>
                  <strong>{{ band.roles.join(' / ') }}</strong>
                  <p>薪资：{{ band.salaryRange }}</p>
                  <p>公司：{{ band.companyRange.join('；') }}</p>
                  <n-text depth="3">{{ band.notes.join('；') }}</n-text>
                </n-card>
              </div>
              <div class="two-columns block">
                <n-card title="核心优势" size="small"><n-list><n-list-item v-for="item in activeView.strengths" :key="item">{{ item }}</n-list-item></n-list></n-card>
                <n-card title="待验证能力" size="small"><n-list><n-list-item v-for="item in activeView.capabilitiesToValidate" :key="item">{{ item }}</n-list-item></n-list></n-card>
                <n-card title="主要限制" size="small"><n-list><n-list-item v-for="item in activeView.constraints" :key="item">{{ item }}</n-list-item></n-list></n-card>
                <n-card title="理想公司与团队" size="small"><n-list><n-list-item v-for="item in activeView.idealEnvironment" :key="item">{{ item }}</n-list-item></n-list></n-card>
              </div>
              <n-card title="证据、反证与最大不确定性" size="small" class="block">
                <div class="evidence-grid">
                  <section>
                    <h3>支持证据</h3>
                    <n-empty v-if="activeView.supportEvidence.length === 0" description="暂无支持证据" />
                    <n-list v-else><n-list-item v-for="item in activeView.supportEvidence" :key="item.id">{{ item.statement }}<br><n-text depth="3">{{ item.sourceLabel }} · 权重 {{ item.weight }}</n-text></n-list-item></n-list>
                  </section>
                  <section>
                    <h3>反证</h3>
                    <n-empty v-if="activeView.counterEvidence.length === 0" description="暂无直接反证" />
                    <n-list v-else><n-list-item v-for="item in activeView.counterEvidence" :key="item.id">{{ item.statement }}<br><n-text depth="3">{{ item.sourceLabel }} · 权重 {{ item.weight }}</n-text></n-list-item></n-list>
                  </section>
                  <section><h3>最大不确定性</h3><n-list><n-list-item v-for="item in activeView.biggestUncertainties" :key="item">{{ item }}</n-list-item></n-list></section>
                </div>
              </n-card>
              <n-alert type="error" class="block">当前禁止结论：{{ activeView.blockedConclusions.join('；') }}</n-alert>
            </template>
          </n-tab-pane>
        </n-tabs>
      </n-card>

      <n-card title="Proposal Review" class="block" :bordered="false">
        <n-empty v-if="pendingProposals.length === 0" description="暂无待审核提案" />
        <n-list v-else>
          <n-list-item v-for="proposal in pendingProposals" :key="proposal.id">
            <n-space justify="space-between" align="center">
              <div><strong>{{ proposal.draft.title }}</strong><div><n-text depth="3">{{ proposal.source === 'ai' ? 'AI 提案' : '手工草案' }} · {{ formatTime(proposal.createdAt) }}</n-text></div></div>
              <n-button @click="openReview(proposal)">审核提案</n-button>
            </n-space>
          </n-list-item>
        </n-list>
      </n-card>

      <n-card title="版本历史" class="block" :bordered="false">
        <n-empty v-if="state.versions.length === 0" description="暂无正式版本历史" />
        <n-timeline v-else>
          <n-timeline-item v-for="version in state.versions" :key="version.id" :type="version.id === state.activeVersionId ? 'success' : 'default'">
            <n-space justify="space-between" align="center">
              <div><strong>V{{ version.versionNumber }} · {{ version.draft.title }}</strong><div><n-text depth="3">{{ formatTime(version.createdAt) }} · {{ version.changeNote || '无备注' }}</n-text></div></div>
              <n-button v-if="version.id !== state.activeVersionId" size="small" :loading="busy" @click="activate(version.id)">切换为正式版本</n-button>
              <n-tag v-else type="success">当前版本</n-tag>
            </n-space>
          </n-timeline-item>
        </n-timeline>
      </n-card>

      <n-collapse class="block">
        <n-collapse-item title="查看技术信息" name="technical">
          <pre>{{ JSON.stringify({ stateVersion: state.stateVersion, activeVersionId: state.activeVersionId, proposals: state.proposals.length, versions: state.versions.length }, null, 2) }}</pre>
        </n-collapse-item>
      </n-collapse>
    </n-spin>

    <n-modal v-model:show="showReview" preset="card" title="审核岗位匹配画像提案" style="width: min(920px, 92vw)">
      <template v-if="reviewProposal">
        <n-alert type="warning">此时仍是提案，不会影响正式画像。接受后才会生成新的不可原地修改版本。</n-alert>
        <n-divider />
        <h3>{{ reviewProposal.draft.title }}</h3>
        <p>{{ reviewProposal.draft.summary }}</p>
        <n-tabs type="segment">
          <n-tab-pane v-for="tab in cityTabs" :key="tab.code" :name="tab.code" :tab="tab.label">
            <strong>{{ getJobMatchProfileView(reviewProposal.draft, tab.code).corePositioning }}</strong>
            <p>{{ getJobMatchProfileView(reviewProposal.draft, tab.code).confidenceReason }}</p>
          </n-tab-pane>
        </n-tabs>
        <n-collapse class="block">
          <n-collapse-item title="修改草案（严格 JSON）" name="edit-draft">
            <n-alert type="info" class="edit-hint">修改后会重新按同一 Draft Schema 校验；原提案仍保留，正式版本保存修改后的内容。</n-alert>
            <n-input v-model:value="editedDraftJson" type="textarea" :autosize="{ minRows: 12, maxRows: 24 }" />
          </n-collapse-item>
        </n-collapse>
        <n-space justify="end" class="modal-actions">
          <n-button :loading="busy" @click="decide(reviewProposal, 'defer')">稍后处理</n-button>
          <n-button type="error" ghost :loading="busy" @click="decide(reviewProposal, 'reject')">拒绝</n-button>
          <n-button :loading="busy" @click="modifyAndAccept(reviewProposal)">修改后接受</n-button>
          <n-button type="primary" :loading="busy" @click="decide(reviewProposal, 'accept')">直接接受并激活</n-button>
        </n-space>
      </template>
    </n-modal>
  </main>
</template>

<style scoped>
.profile-page { display: flex; flex-direction: column; gap: 18px; padding-bottom: 56px; }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 28px; border: 1px solid var(--of-line); border-radius: var(--of-radius); background: linear-gradient(135deg, #fff, #f0f7ff); box-shadow: var(--of-shadow); }
.hero h1 { margin: 4px 0 8px; font-size: 30px; }
.hero p { max-width: 720px; margin: 0; color: var(--of-ink-2); }
.eyebrow { color: var(--of-brand); font-weight: 700; font-size: 12px; letter-spacing: .08em; }
.block { margin-top: 16px; }
.status-card { box-shadow: var(--of-shadow); }
.status-title { margin: 5px 0; font-size: 20px; font-weight: 700; }
.view-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.view-head h2 { margin: 8px 0 4px; }
.view-head p { margin: 0; color: var(--of-ink-2); }
.bands { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.two-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.evidence-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.evidence-grid h3 { margin-top: 0; }
.modal-actions { margin-top: 20px; }
.edit-hint { margin-bottom: 12px; }
pre { white-space: pre-wrap; color: var(--of-ink-2); }
@media (max-width: 860px) { .hero { align-items: flex-start; flex-direction: column; } .bands, .evidence-grid { grid-template-columns: 1fr; } }
@media (max-width: 620px) { .two-columns { grid-template-columns: 1fr; } }
</style>
