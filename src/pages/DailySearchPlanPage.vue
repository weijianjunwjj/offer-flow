<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  NAlert, NButton, NCard, NCollapse, NCollapseItem, NEmpty, NInput, NInputNumber,
  NSpace, NSpin, NTag, NText,
} from 'naive-ui';
import { ApiError } from '../api/client';
import {
  dailySearchPlanApi,
  type DailySearchPlan,
  type DailySearchPlanStatus,
  type DailySearchPlanVersion,
  type SearchPlanCity,
  type SearchPlanConfigInput,
  type SearchSourceConfig,
} from '../api/dailySearchPlanApi';

/**
 * OfferFlow v0.9 — 每日求职计划配置页（T023）。
 *
 * 把 T022 CRUD + T032 控制（Run Now / Skip Today / Pause / Resume）收敛成一个可操作的用户级
 * 配置页。以后端为唯一真源：不自行计算 schedule occurrence / timezone / catch-up / skip / 并发。
 *
 * 版本语义：DailySearchPlanVersion 是不可变快照，编辑配置 = 读取 active version → 编辑表单 →
 * POST 创建新版本并激活（绝不 PATCH 旧版本）。
 */

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_DAILY_AT = '09:00';
const DEFAULT_LATEST_CATCH_UP = '12:00';
const DEFAULT_SOURCE_CONFIGS: SearchSourceConfig[] = [
  { providerKey: 'tavily', searchDepth: 'basic', country: 'china', enabled: true },
];

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface PlanRow {
  plan: DailySearchPlan;
  activeVersion: DailySearchPlanVersion | null;
}

interface SearchPlanFormState {
  name: string;
  dailyAt: string;
  citiesText: string;
  roleDirectionsText: string;
  baseKeywordsText: string;
  expandedKeywordsText: string;
  maxQueriesPerRun: number | null;
  latestCatchUpTime: string;
}

const rows = ref<PlanRow[]>([]);
const loading = ref(true);
const errorText = ref('');
const notice = ref('');
const capabilityUnavailable = ref(false);

const formMode = ref<'create' | 'edit' | null>(null);
const editingPlanId = ref<string | null>(null);
const form = reactive<SearchPlanFormState>(emptyForm());
const formError = ref('');
const submitting = ref(false);

const runningPlanId = ref<string | null>(null);
const skippingPlanId = ref<string | null>(null);
const statusPlanId = ref<string | null>(null);
const confirmSkipPlanId = ref<string | null>(null);

function emptyForm(): SearchPlanFormState {
  return {
    name: '',
    dailyAt: DEFAULT_DAILY_AT,
    citiesText: '',
    roleDirectionsText: '',
    baseKeywordsText: '',
    expandedKeywordsText: '',
    maxQueriesPerRun: null,
    latestCatchUpTime: DEFAULT_LATEST_CATCH_UP,
  };
}

function readSchedule(version: DailySearchPlanVersion): { dailyAt: string; timezone: string } {
  const schedule = version.schedule ?? {};
  const dailyAt = typeof schedule.dailyAt === 'string' && schedule.dailyAt !== ''
    ? schedule.dailyAt : DEFAULT_DAILY_AT;
  const timezone = typeof schedule.timezone === 'string' && schedule.timezone !== ''
    ? schedule.timezone : DEFAULT_TIMEZONE;
  return { dailyAt, timezone };
}

function splitList(text: string): string[] {
  return text
    .split(/[\n,，;；]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function citiesToText(cities: SearchPlanCity[]): string {
  return cities.map((city) => city.name).join('\n');
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusLabel(status: DailySearchPlanStatus): string {
  if (status === 'active') return '运行中';
  if (status === 'paused') return '已暂停';
  return '已删除';
}

function statusType(status: DailySearchPlanStatus): 'success' | 'warning' | 'default' {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  return 'default';
}

async function loadPlans(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  capabilityUnavailable.value = false;
  try {
    const { plans } = await dailySearchPlanApi.list();
    rows.value = await Promise.all(plans.map(async (plan): Promise<PlanRow> => {
      try {
        const detail = await dailySearchPlanApi.get(plan.id);
        return { plan, activeVersion: detail.activeVersion };
      } catch {
        return { plan, activeVersion: null };
      }
    }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      capabilityUnavailable.value = true;
      errorText.value = '每日求职计划能力当前未启用。';
    } else {
      errorText.value = error instanceof ApiError ? error.message : '加载每日求职计划失败';
    }
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadPlans();
});

// ── 创建 / 编辑表单 ──────────────────────────────────────────────────────────

const formCardTitle = computed(() => (formMode.value === 'create' ? '创建每日求职计划' : '编辑配置（保存生成新版本）'));

function openCreate(): void {
  Object.assign(form, emptyForm());
  formMode.value = 'create';
  editingPlanId.value = null;
  formError.value = '';
}

function openEdit(planId: string): void {
  const row = rows.value.find((entry) => entry.plan.id === planId);
  if (row === undefined) return;
  const schedule = row.activeVersion === null
    ? { dailyAt: DEFAULT_DAILY_AT, timezone: DEFAULT_TIMEZONE }
    : readSchedule(row.activeVersion);
  const scanBudget = row.activeVersion?.scanBudget ?? {};
  const maxQueries = typeof scanBudget.maxQueriesPerRun === 'number' ? scanBudget.maxQueriesPerRun : null;
  form.name = row.plan.name;
  form.dailyAt = schedule.dailyAt;
  form.citiesText = row.activeVersion === null ? '' : citiesToText(row.activeVersion.cities);
  form.roleDirectionsText = row.activeVersion === null ? '' : row.activeVersion.roleDirections.join('\n');
  form.baseKeywordsText = row.activeVersion === null ? '' : row.activeVersion.baseKeywords.join('\n');
  form.expandedKeywordsText = row.activeVersion === null ? '' : row.activeVersion.expandedKeywords.join('\n');
  form.maxQueriesPerRun = maxQueries;
  form.latestCatchUpTime = row.activeVersion?.latestCatchUpTime ?? DEFAULT_LATEST_CATCH_UP;
  formMode.value = 'edit';
  editingPlanId.value = planId;
  formError.value = '';
}

function closeForm(): void {
  formMode.value = null;
  editingPlanId.value = null;
  formError.value = '';
}

function validateForm(): string | null {
  if (formMode.value === 'create' && form.name.trim() === '') {
    return '计划名称不能为空';
  }
  if (!HHMM_RE.test(form.dailyAt)) {
    return '每天运行时间需为 HH:mm 格式（如 09:00）';
  }
  if (!HHMM_RE.test(form.latestCatchUpTime)) {
    return '补跑截止时间需为 HH:mm 格式（如 12:00）';
  }
  return null;
}

function buildConfig(): SearchPlanConfigInput {
  const base = editingPlanId.value === null
    ? null
    : (rows.value.find((entry) => entry.plan.id === editingPlanId.value)?.activeVersion ?? null);
  const scanBudget: Record<string, unknown> = form.maxQueriesPerRun !== null && form.maxQueriesPerRun > 0
    ? { maxQueriesPerRun: form.maxQueriesPerRun }
    : (base?.scanBudget ?? {});
  return {
    cities: splitList(form.citiesText).map((name, index) => ({ name, priority: index + 1 })),
    roleDirections: splitList(form.roleDirectionsText),
    baseKeywords: splitList(form.baseKeywordsText),
    expandedKeywords: splitList(form.expandedKeywordsText),
    hardConstraints: base?.hardConstraints ?? [],
    sourceConfigs: base !== null && base.sourceConfigs.length > 0 ? base.sourceConfigs : DEFAULT_SOURCE_CONFIGS,
    schedule: { dailyAt: form.dailyAt, timezone: DEFAULT_TIMEZONE },
    scanBudget,
    analysisBudget: base?.analysisBudget ?? {},
    briefPolicy: base?.briefPolicy ?? {},
    explorationPolicy: base?.explorationPolicy ?? {},
    notificationPolicy: base?.notificationPolicy ?? {},
    latestCatchUpTime: form.latestCatchUpTime,
  };
}

async function submitForm(): Promise<void> {
  const validationError = validateForm();
  if (validationError !== null) {
    formError.value = validationError;
    return;
  }
  formError.value = '';
  submitting.value = true;
  try {
    if (formMode.value === 'create') {
      await dailySearchPlanApi.create({ name: form.name.trim(), ...buildConfig() });
      notice.value = `已创建计划「${form.name.trim()}」`;
    } else if (formMode.value === 'edit' && editingPlanId.value !== null) {
      const result = await dailySearchPlanApi.createVersion(editingPlanId.value, buildConfig());
      notice.value = `已保存配置，生成新版本 v${result.version.version} 并激活`;
    }
    closeForm();
    await loadPlans();
  } catch (error) {
    formError.value = error instanceof ApiError ? error.message : '保存失败';
  } finally {
    submitting.value = false;
  }
}

// ── 控制操作（T032）──────────────────────────────────────────────────────────

async function runNow(planId: string): Promise<void> {
  if (runningPlanId.value !== null) return;
  runningPlanId.value = planId;
  notice.value = '';
  try {
    const result = await dailySearchPlanApi.runNow(planId);
    notice.value = `已启动运行（SourceRun ${result.sourceRunId}，状态 ${result.status}）`;
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '立即运行失败';
  } finally {
    runningPlanId.value = null;
  }
}

async function skipToday(planId: string): Promise<void> {
  if (skippingPlanId.value !== null) return;
  skippingPlanId.value = planId;
  confirmSkipPlanId.value = null;
  notice.value = '';
  try {
    const result = await dailySearchPlanApi.skipToday(planId);
    notice.value = `已跳过今天自动运行（${result.skipped.scheduledDay}），仍可手动立即运行`;
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '跳过今天失败';
  } finally {
    skippingPlanId.value = null;
  }
}

function applyPlan(updated: DailySearchPlan): void {
  const row = rows.value.find((entry) => entry.plan.id === updated.id);
  if (row !== undefined) row.plan = updated;
}

async function pause(planId: string): Promise<void> {
  if (statusPlanId.value !== null) return;
  statusPlanId.value = planId;
  notice.value = '';
  try {
    const result = await dailySearchPlanApi.pause(planId);
    applyPlan(result.plan);
    notice.value = '已暂停自动调度';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '暂停失败';
  } finally {
    statusPlanId.value = null;
  }
}

async function resume(planId: string): Promise<void> {
  if (statusPlanId.value !== null) return;
  statusPlanId.value = planId;
  notice.value = '';
  try {
    const result = await dailySearchPlanApi.resume(planId);
    applyPlan(result.plan);
    notice.value = '已恢复自动调度';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '恢复失败';
  } finally {
    statusPlanId.value = null;
  }
}

// ── 卡片展示辅助 ─────────────────────────────────────────────────────────────

function dailyAtOf(row: PlanRow): string {
  return row.activeVersion === null ? '—' : readSchedule(row.activeVersion).dailyAt;
}

function timezoneOf(row: PlanRow): string {
  return row.activeVersion === null ? '—' : readSchedule(row.activeVersion).timezone;
}

function citiesOf(row: PlanRow): string {
  return row.activeVersion === null ? '' : row.activeVersion.cities.map((city) => city.name).join('、');
}

function rolesOf(row: PlanRow): string {
  return row.activeVersion === null ? '' : row.activeVersion.roleDirections.join('、');
}

function keywordsOf(row: PlanRow): string {
  return row.activeVersion === null ? '' : row.activeVersion.baseKeywords.join('、');
}

function hasSearchConfig(row: PlanRow): boolean {
  return row.activeVersion !== null
    && (row.activeVersion.cities.length > 0 || row.activeVersion.roleDirections.length > 0 || row.activeVersion.baseKeywords.length > 0);
}
</script>

<template>
  <main class="daily-search-plan-page" data-testid="daily-search-plan-page">
    <header class="hero">
      <div>
        <div class="eyebrow">OfferFlow v0.9 · 每日主动求职</div>
        <h1>每日求职计划</h1>
        <p>配置每日自动找岗计划，随时立即运行、跳过今天或暂停恢复。每次保存配置都会生成新的不可变版本并自动激活。</p>
      </div>
      <n-button
        v-if="!capabilityUnavailable && formMode === null"
        type="primary"
        data-testid="create-plan"
        @click="openCreate"
      >
        创建计划
      </n-button>
    </header>

    <n-alert
      v-if="capabilityUnavailable"
      type="warning"
      class="block"
      data-testid="capability-unavailable"
    >
      每日求职计划能力当前未启用。请在服务端启用 OFFERFLOW_DAILY_SEARCH_PLAN 后刷新页面。
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
    <n-alert
      v-if="notice"
      type="success"
      closable
      class="block"
      data-testid="page-notice"
      @close="notice = ''"
    >
      {{ notice }}
    </n-alert>

    <n-spin :show="loading">
      <n-card v-if="formMode !== null" :title="formCardTitle" size="small" class="block" data-testid="plan-form">
        <n-alert v-if="formMode === 'edit'" type="info" class="form-alert">
          保存修改将创建新的不可变版本并自动激活，不会原地修改历史版本。
        </n-alert>
        <n-alert v-if="formError" type="error" class="form-alert" data-testid="form-error">{{ formError }}</n-alert>

        <div class="form-grid">
          <div v-if="formMode === 'create'" class="field field-wide">
            <n-text depth="3">计划名称</n-text>
            <n-input v-model:value="form.name" placeholder="如「每日前端岗位」" data-testid="form-name" />
          </div>
          <div class="field">
            <n-text depth="3">每天运行时间（HH:mm）</n-text>
            <n-input v-model:value="form.dailyAt" placeholder="09:00" data-testid="form-daily-at" />
          </div>
          <div class="field">
            <n-text depth="3">时区</n-text>
            <n-input :value="DEFAULT_TIMEZONE + '（中国标准时间）'" disabled data-testid="form-timezone" />
          </div>
          <div class="field field-wide">
            <n-text depth="3">目标城市（每行一个）</n-text>
            <n-input v-model:value="form.citiesText" type="textarea" placeholder="苏州&#10;无锡" :rows="3" data-testid="form-cities" />
          </div>
          <div class="field field-wide">
            <n-text depth="3">岗位方向（每行一个）</n-text>
            <n-input v-model:value="form.roleDirectionsText" type="textarea" placeholder="前端开发&#10;全栈开发" :rows="3" data-testid="form-roles" />
          </div>
          <div class="field field-wide">
            <n-text depth="3">基础关键词（每行一个）</n-text>
            <n-input v-model:value="form.baseKeywordsText" type="textarea" placeholder="React&#10;TypeScript" :rows="3" data-testid="form-keywords" />
          </div>
          <div class="field field-wide">
            <n-text depth="3">扩展关键词（可选，每行一个）</n-text>
            <n-input v-model:value="form.expandedKeywordsText" type="textarea" placeholder="可留空" :rows="2" data-testid="form-expanded" />
          </div>
        </div>

        <n-collapse class="advanced">
          <n-collapse-item title="高级设置" name="advanced">
            <div class="form-grid">
              <div class="field">
                <n-text depth="3">每次最大查询数（可选）</n-text>
                <n-input-number v-model:value="form.maxQueriesPerRun" :min="1" placeholder="不填则使用默认" data-testid="form-max-queries" />
              </div>
              <div class="field">
                <n-text depth="3">补跑截止时间（HH:mm）</n-text>
                <n-input v-model:value="form.latestCatchUpTime" placeholder="12:00" data-testid="form-catchup" />
              </div>
            </div>
            <n-text depth="3" style="display:block;margin-top:8px">搜索 Provider：Tavily（P0 唯一支持，自动附加 basic / china 配置）。</n-text>
          </n-collapse-item>
        </n-collapse>

        <div class="form-actions">
          <n-button type="primary" :loading="submitting" data-testid="form-submit" @click="submitForm">保存</n-button>
          <n-button :disabled="submitting" data-testid="form-cancel" @click="closeForm">取消</n-button>
        </div>
      </n-card>

      <template v-else>
        <n-empty v-if="rows.length === 0" description="还没有每日求职计划" class="block" data-testid="empty-state">
          <template #extra>
            <n-button type="primary" data-testid="empty-create" @click="openCreate">创建每日求职计划</n-button>
          </template>
        </n-empty>

        <n-card
          v-for="row in rows"
          v-else
          :key="row.plan.id"
          size="small"
          class="block"
          :data-testid="`plan-${row.plan.id}`"
        >
          <template #header>
            <n-space align="center">
              <n-text strong>{{ row.plan.name }}</n-text>
              <n-tag size="small" :type="statusType(row.plan.status)">{{ statusLabel(row.plan.status) }}</n-tag>
              <n-tag size="small" data-testid="plan-version">
                {{ row.activeVersion === null ? '无激活版本' : `v${row.activeVersion.version}` }}
              </n-tag>
            </n-space>
          </template>

          <n-space vertical size="small">
            <n-text depth="3">每天 {{ dailyAtOf(row) }}（{{ timezoneOf(row) }}）· 最后修改 {{ formatTime(row.plan.updatedAt) }}</n-text>
            <n-text v-if="hasSearchConfig(row)" depth="3">
              城市：{{ citiesOf(row) || '未设置' }} · 方向：{{ rolesOf(row) || '未设置' }} · 关键词：{{ keywordsOf(row) || '未设置' }}
            </n-text>
            <n-text v-else depth="3">搜索目标尚未配置，可点击「编辑」补齐城市 / 方向 / 关键词。</n-text>

            <n-alert v-if="confirmSkipPlanId === row.plan.id" type="warning" class="block" data-testid="skip-confirm">
              今天将不再自动运行此计划，仍可手动立即运行。
              <n-space style="margin-top:8px">
                <n-button size="small" type="warning" :loading="skippingPlanId === row.plan.id" data-testid="confirm-skip" @click="skipToday(row.plan.id)">确认跳过今天</n-button>
                <n-button size="small" :disabled="skippingPlanId === row.plan.id" data-testid="cancel-skip" @click="confirmSkipPlanId = null">取消</n-button>
              </n-space>
            </n-alert>

            <n-space v-if="row.plan.status !== 'deleted'">
              <n-button
                size="small"
                type="primary"
                :loading="runningPlanId === row.plan.id"
                :disabled="runningPlanId !== null && runningPlanId !== row.plan.id"
                data-testid="run-now"
                @click="runNow(row.plan.id)"
              >
                立即运行
              </n-button>
              <n-button
                size="small"
                :disabled="skippingPlanId === row.plan.id || confirmSkipPlanId === row.plan.id"
                data-testid="skip-today"
                @click="confirmSkipPlanId = row.plan.id"
              >
                跳过今天自动运行
              </n-button>
              <n-button
                v-if="row.plan.status === 'active'"
                size="small"
                :loading="statusPlanId === row.plan.id"
                data-testid="pause"
                @click="pause(row.plan.id)"
              >
                暂停
              </n-button>
              <n-button
                v-else
                size="small"
                :loading="statusPlanId === row.plan.id"
                data-testid="resume"
                @click="resume(row.plan.id)"
              >
                恢复
              </n-button>
              <n-button size="small" data-testid="edit" @click="openEdit(row.plan.id)">编辑</n-button>
            </n-space>
            <n-text v-else depth="3">该计划已删除，只读。</n-text>
          </n-space>
        </n-card>
      </template>
    </n-spin>
  </main>
</template>

<style scoped>
.daily-search-plan-page { display: flex; flex-direction: column; gap: 16px; padding-bottom: 56px; }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 28px; border: 1px solid var(--of-line, #e2e8f0); border-radius: var(--of-radius, 16px); background: linear-gradient(135deg, #fff, #f0f7ff); box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.hero h1 { margin: 4px 0 8px; font-size: 30px; }
.hero p { max-width: 760px; margin: 0; color: var(--of-ink-2, #475569); }
.eyebrow { color: var(--of-brand, #2563eb); font-weight: 700; font-size: 12px; letter-spacing: .08em; }
.block { margin-top: 16px; }
.form-alert { margin-bottom: 12px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-wide { grid-column: 1 / -1; }
.advanced { margin-top: 16px; }
.form-actions { margin-top: 16px; display: flex; gap: 8px; }
@media (max-width: 860px) { .hero { align-items: flex-start; flex-direction: column; } .form-grid { grid-template-columns: 1fr; } }
</style>
