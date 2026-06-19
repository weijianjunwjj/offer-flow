<script setup lang="ts">
// Task 9：岗位台账列表升级。
// 新增列：公司规模 / 机会分；新增筛选：城市 / 公司规模 / 沟通状态 / 机会分下限；
// 新增排序：更新时间 / 机会分 / 匹配度。筛选排序仅影响前端展示，不改持久化数据。
import { computed, onMounted, ref } from 'vue';
import { NSelect } from 'naive-ui';
import type { JobRecord, CompanySizeTier, ContactStatus } from '../storage';
import { useStores } from '../app/stores';
import { CONTACT_STATUS_LABELS, CONTACT_STATUS_OPTIONS } from '../app/labels';
import { COMPANY_SIZE_LABELS, COMPANY_SIZE_OPTIONS } from '../app/companyLabels';
import { calculateTargetProfileScore } from '../app/targetProfileScore';

const emit = defineEmits<{
  create: [];
  open: [jobId: string];
}>();

const jobs = ref<JobRecord[]>([]);
const loadError = ref('');

// 筛选 / 排序状态（仅前端展示，空串 / 0 表示不筛选）。
const cityFilter = ref<string>('');
const sizeFilter = ref<CompanySizeTier | ''>('');
const statusFilter = ref<ContactStatus | ''>('');
const minScore = ref<number>(0);
const sortKey = ref<'updated' | 'opportunity' | 'match' | 'profile'>('updated');

function load(): void {
  try {
    jobs.value = useStores().jobs.listJobs();
  } catch (error) {
    loadError.value = (error as Error).message;
  }
}

onMounted(load);

// 公司规模：以用户在表单手填的 companyInput.sizeTier 为准（用户的明确意图最优先）；
// 仅当用户未填（unknown）时，才回退用 AI 画像 companyAssessment.sizeTier；都没有才 unknown。
function effectiveSizeTier(job: JobRecord): CompanySizeTier {
  if (job.companyInput.sizeTier !== 'unknown') {
    return job.companyInput.sizeTier;
  }
  return job.companyAssessment?.sizeTier ?? 'unknown';
}
function opportunityScoreOf(job: JobRecord): number | null {
  return job.opportunityAnalysis?.opportunityScore ?? null;
}
function matchNumberOf(job: JobRecord): number | null {
  const n = Number.parseInt(job.matchScore, 10);
  return Number.isNaN(n) ? null : n;
}

function sizeLabel(job: JobRecord): string {
  return COMPANY_SIZE_LABELS[effectiveSizeTier(job)];
}
function scoreDisplay(job: JobRecord): string {
  const s = opportunityScoreOf(job);
  return s === null ? '-' : String(s);
}
// 第三项指标：目标公司画像匹配度（本地现算，旧岗位完全空白时返回 null → 显示「待评估」）。
function profileScoreOf(job: JobRecord): number | null {
  const r = calculateTargetProfileScore({
    city: job.city,
    role: job.role,
    salaryRange: job.salaryRange,
    jdText: job.jdText,
    companyInput: job.companyInput,
    companyAssessment: job.companyAssessment,
  });
  return r?.score ?? null;
}
function profileScoreDisplay(job: JobRecord): string {
  const s = profileScoreOf(job);
  return s === null ? '待评估' : String(s);
}

// 下拉选项
const cityOptions = computed(() => {
  const cities = Array.from(
    new Set(jobs.value.map((j) => j.city.trim()).filter((c) => c !== '')),
  );
  return [{ label: '全部城市', value: '' }, ...cities.map((c) => ({ label: c, value: c }))];
});
const sizeOptions = [{ label: '全部规模', value: '' }, ...COMPANY_SIZE_OPTIONS];
const statusOptions = [
  { label: '全部状态', value: '' },
  ...CONTACT_STATUS_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
];
const scoreOptions = [
  { label: '机会分 不限', value: 0 },
  { label: '50+', value: 50 },
  { label: '65+', value: 65 },
  { label: '70+', value: 70 },
  { label: '75+', value: 75 },
  { label: '85+', value: 85 },
];
const sortOptions = [
  { label: '按更新时间', value: 'updated' },
  { label: '按机会分', value: 'opportunity' },
  { label: '按匹配度', value: 'match' },
  { label: '按画像匹配', value: 'profile' },
];

const filteredJobs = computed(() => {
  const list = jobs.value.filter((j) => {
    if (cityFilter.value !== '' && j.city.trim() !== cityFilter.value) return false;
    if (sizeFilter.value !== '' && effectiveSizeTier(j) !== sizeFilter.value) return false;
    if (statusFilter.value !== '' && j.contactStatus !== statusFilter.value) return false;
    if (minScore.value > 0) {
      const s = opportunityScoreOf(j);
      if (s === null || s < minScore.value) return false;
    }
    return true;
  });
  const sorted = [...list];
  if (sortKey.value === 'opportunity') {
    sorted.sort((a, b) => (opportunityScoreOf(b) ?? -1) - (opportunityScoreOf(a) ?? -1));
  } else if (sortKey.value === 'match') {
    sorted.sort((a, b) => (matchNumberOf(b) ?? -1) - (matchNumberOf(a) ?? -1));
  } else if (sortKey.value === 'profile') {
    sorted.sort((a, b) => (profileScoreOf(b) ?? -1) - (profileScoreOf(a) ?? -1));
  } else {
    sorted.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return sorted;
});

function resetFilters(): void {
  cityFilter.value = '';
  sizeFilter.value = '';
  statusFilter.value = '';
  minScore.value = 0;
  sortKey.value = 'updated';
}

function dash(value: string): string {
  return value.trim() === '' ? '—' : value;
}
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <main class="job-list">
    <header class="page-head">
      <div>
        <h1>岗位台账</h1>
        <p class="hint">统一管理已分析岗位，点击任一岗位进入主战场。</p>
      </div>
      <button class="new-btn" @click="emit('create')">+ 新建岗位</button>
    </header>

    <p v-if="loadError" class="banner banner-error" role="alert">
      读取岗位列表失败：{{ loadError }}
    </p>

    <section v-if="jobs.length === 0" class="empty" role="status">
      <p class="empty-title">还没有岗位记录</p>
      <p class="empty-sub">
        OfferFlow 是一个本地求职整理工具，不接入 AI、不自动分析。它帮你把找工作的动作理顺：
      </p>
      <ol class="empty-flow">
        <li>录入 Boss 岗位信息与 JD</li>
        <li>一键生成结构化分析 Prompt</li>
        <li>复制到 ChatGPT / Claude / Gemini 等外部 AI</li>
        <li>把 AI 返回结果贴回岗位，沉淀报告与打招呼话术</li>
        <li>维护沟通状态，面试前随时回看</li>
      </ol>
      <button class="new-btn" @click="emit('create')">+ 新建岗位</button>
    </section>

    <template v-else>
      <div class="filters">
        <label class="filter">
          <span class="filter-cap">城市</span>
          <n-select v-model:value="cityFilter" :options="cityOptions" size="small" />
        </label>
        <label class="filter">
          <span class="filter-cap">公司规模</span>
          <n-select v-model:value="sizeFilter" :options="sizeOptions" size="small" />
        </label>
        <label class="filter">
          <span class="filter-cap">沟通状态</span>
          <n-select v-model:value="statusFilter" :options="statusOptions" size="small" />
        </label>
        <label class="filter">
          <span class="filter-cap">机会分下限</span>
          <n-select v-model:value="minScore" :options="scoreOptions" size="small" />
        </label>
        <label class="filter">
          <span class="filter-cap">排序</span>
          <n-select v-model:value="sortKey" :options="sortOptions" size="small" />
        </label>
        <button class="reset-btn" type="button" @click="resetFilters">重置</button>
      </div>

      <p class="result-count">共 {{ filteredJobs.length }} / {{ jobs.length }} 个岗位</p>

      <div class="asset-list">
        <article
          v-for="job in filteredJobs"
          :key="job.id"
          class="asset-card"
          @click="emit('open', job.id)"
        >
          <div class="ac-score" :class="{ none: scoreDisplay(job) === '-' }">
            <span class="ac-score-num">{{ scoreDisplay(job) }}</span>
            <span class="ac-score-cap">机会分</span>
          </div>
          <div class="ac-main">
            <div class="ac-title-row">
              <span class="ac-company">{{ dash(job.company) }}</span>
              <span class="ac-role">{{ dash(job.role) }}</span>
            </div>
            <div class="ac-meta">
              <span class="ac-chip">{{ dash(job.city) }}</span>
              <span class="ac-chip strong">{{ dash(job.salaryRange) }}</span>
              <span class="ac-chip">{{ sizeLabel(job) }}</span>
              <span class="ac-chip">匹配 {{ dash(job.matchScore) }}</span>
              <span class="ac-chip" title="基于目标公司画像">画像 {{ profileScoreDisplay(job) }}</span>
            </div>
          </div>
          <div class="ac-side">
            <span class="ac-status" :data-status="job.contactStatus">
              {{ CONTACT_STATUS_LABELS[job.contactStatus] }}
            </span>
            <span class="ac-time">{{ formatTime(job.updatedAt) }}</span>
          </div>
        </article>
      </div>

      <p v-if="filteredJobs.length === 0" class="no-match" role="status">
        没有符合当前筛选条件的岗位。<button class="link-btn" @click="resetFilters">清除筛选</button>
      </p>
    </template>
  </main>
</template>

<style scoped>
.job-list {
  max-width: 1040px;
  margin: 0 auto;
  padding: 24px 16px 64px;
  color: #1f2933;
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.page-head h1 {
  margin: 0 0 4px;
  font-size: 22px;
}
.hint {
  margin: 0;
  color: #647084;
  font-size: 13px;
}
.new-btn {
  flex: none;
  padding: 9px 16px;
  border: none;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.new-btn:hover {
  background: #1d4ed8;
}
.banner {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  margin-bottom: 16px;
}
.banner-error {
  background: #fdecec;
  color: #a4262c;
}
.empty {
  margin-top: 48px;
  text-align: center;
  color: #647084;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.empty-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #1f2933;
}
.empty-sub {
  margin: 0 0 8px;
  font-size: 13px;
  max-width: 460px;
}
.empty-flow {
  margin: 0 0 16px;
  padding-left: 20px;
  max-width: 460px;
  text-align: left;
  color: #647084;
  font-size: 13px;
  line-height: 1.9;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  padding: 14px 16px;
  margin-bottom: 12px;
  border: 1px solid #eceff3;
  border-radius: 12px;
  background: #f8fafc;
}
.filter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 130px;
}
.filter-cap {
  font-size: 12px;
  color: #647084;
}
.reset-btn {
  padding: 6px 14px;
  border: 1px solid #cbd2d9;
  border-radius: 8px;
  background: #fff;
  font-size: 13px;
  cursor: pointer;
  height: 34px;
}
.reset-btn:hover {
  background: #f2f6ff;
}
.result-count {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--of-muted);
}
.asset-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.asset-card {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  padding: 16px 18px;
  border: 1px solid var(--of-line);
  border-radius: 14px;
  background: var(--of-card);
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  cursor: pointer;
  transition: box-shadow 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
}
.asset-card:hover {
  border-color: rgba(37, 99, 235, 0.35);
  box-shadow: 0 14px 30px -18px rgba(16, 24, 40, 0.45);
  transform: translateY(-1px);
}
.ac-score {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 0;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.1), rgba(14, 165, 233, 0.07));
}
.ac-score-num {
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  color: var(--of-brand);
}
.ac-score.none .ac-score-num {
  color: var(--of-muted);
  font-weight: 500;
}
.ac-score-cap {
  font-size: 11px;
  color: var(--of-ink-2);
}
.ac-main {
  min-width: 0;
}
.ac-title-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.ac-company {
  font-size: 15px;
  font-weight: 600;
  color: var(--of-ink);
}
.ac-role {
  font-size: 13px;
  color: var(--of-ink-2);
}
.ac-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.ac-chip {
  font-size: 12px;
  color: var(--of-ink-2);
  background: #eef2f8;
  padding: 3px 10px;
  border-radius: 999px;
}
.ac-chip.strong {
  color: var(--of-ink);
  font-weight: 600;
}
.ac-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex: none;
}
.ac-status {
  font-size: 12px;
  font-weight: 600;
  padding: 3px 12px;
  border-radius: 999px;
  background: #eef1f5;
  color: #475569;
}
.ac-status[data-status='greeted'],
.ac-status[data-status='replied'] {
  background: #dbeafe;
  color: #1e40af;
}
.ac-status[data-status='interview_scheduled'] {
  background: #dcfce7;
  color: #166534;
}
.ac-status[data-status='rejected'] {
  background: #fee2e2;
  color: #991b1b;
}
.ac-time {
  font-size: 11px;
  color: var(--of-muted);
}
.no-match {
  margin: 24px 0 0;
  text-align: center;
  font-size: 13px;
  color: #647084;
}
.link-btn {
  border: none;
  background: none;
  color: #2563eb;
  cursor: pointer;
  font-size: 13px;
  padding: 0 4px;
}
</style>
