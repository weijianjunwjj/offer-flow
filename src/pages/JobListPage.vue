<script setup lang="ts">
// Task 9：岗位台账列表升级。
// 新增列：公司规模 / 机会分；新增筛选：城市 / 公司规模 / 沟通状态 / 机会分下限；
// 排序：更新时间 / 机会分 / 目标画像。筛选排序仅影响前端展示，不改持久化数据。
// 指标分层（DEC-019）：机会分为唯一主指标（大数字 + 默认排序）；目标画像为「是否我的菜」辅助徽章；
// 人岗匹配（综合匹配度）不在列表常驻，收进主战场雷达卡。
import { computed, onMounted, ref } from 'vue';
import { NSelect } from 'naive-ui';
import type {
  JobRecord,
  CompanySizeTier,
  CommunicationStatus,
  ApplyAdvice,
  OpportunityRadar,
} from '../storage';
import { deriveDecision, type DerivedDecision } from '../decision';
import { useStores } from '../app/stores';
import { COMMUNICATION_STATUS_LABELS, COMMUNICATION_STATUS_OPTIONS } from '../app/labels';
import {
  STRATEGY_LABELS,
  nextActionLabel,
} from '../app/decisionLabels';
import {
  COMPANY_SIZE_LABELS,
  COMPANY_SIZE_OPTIONS,
  APPLY_ADVICE_LABELS,
} from '../app/companyLabels';
import { calculateTargetProfileScore, getTargetProfileLevel } from '../app/targetProfileScore';
import { getOpportunityScoreLevel } from '../app/opportunityScore';
import { opportunityTone, profileTone, applyAdviceTone } from '../app/scoreVisuals';
import OpportunityMiniBars from '../components/OpportunityMiniBars.vue';

const emit = defineEmits<{
  create: [];
  open: [jobId: string];
}>();

const jobs = ref<JobRecord[]>([]);
const loadError = ref('');

// 筛选 / 排序状态（仅前端展示，空串 / 0 表示不筛选）。
const cityFilter = ref<string>('');
const sizeFilter = ref<CompanySizeTier | ''>('');
const statusFilter = ref<CommunicationStatus | ''>('');
const minScore = ref<number>(0);
type SortKey = 'updated' | 'opportunity' | 'profile' | 'decision';
type DecisionFilter = '' | 'greeting' | 'followup' | 'stopLoss' | 'waiting';
const sortKey = ref<SortKey>('opportunity');
const decisionFilter = ref<DecisionFilter>('');

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
// DEC-019 视觉分层：机会分（主判决）/ 目标画像（是否我的菜）/ 投递建议（行动指令）各自的等级 + 色调。
function oppLevelOf(job: JobRecord): string {
  const s = opportunityScoreOf(job);
  return s === null ? '未分析' : getOpportunityScoreLevel(s);
}
function oppToneOf(job: JobRecord): string {
  return opportunityTone(opportunityScoreOf(job));
}
function profileToneOf(job: JobRecord): string {
  return profileTone(profileScoreOf(job));
}
function profileBadgeText(job: JobRecord): string {
  const s = profileScoreOf(job);
  return s === null ? '目标画像 待评估' : `${getTargetProfileLevel(s)} · 目标画像 ${s}`;
}
function radarOf(job: JobRecord): OpportunityRadar | null {
  return job.opportunityAnalysis?.opportunityRadar ?? null;
}
function adviceOf(job: JobRecord): ApplyAdvice | '' {
  return job.opportunityAnalysis?.applyAdvice ?? '';
}
function adviceToneOf(job: JobRecord): string {
  return applyAdviceTone(adviceOf(job));
}
function adviceLabelOf(job: JobRecord): string {
  return APPLY_ADVICE_LABELS[adviceOf(job)];
}
const decisionById = computed(() => {
  const map = new Map<string, DerivedDecision>();
  for (const job of jobs.value) {
    map.set(job.id, deriveDecision(job, jobs.value));
  }
  return map;
});
function decisionOf(job: JobRecord): DerivedDecision {
  return decisionById.value.get(job.id) ?? deriveDecision(job, jobs.value);
}
function decisionActionLabel(job: JobRecord): string {
  return nextActionLabel(decisionOf(job).nextAction);
}
function decisionActionKey(job: JobRecord): string {
  return decisionOf(job).nextAction ?? 'done';
}
function isWaitingForReply(job: JobRecord, decision: DerivedDecision): boolean {
  return (
    decision.nextAction === 'wait' &&
    (
      job.communicationStatus === 'greeted_unread' ||
      job.communicationStatus === 'greeted_read_no_reply' ||
      job.communicationStatus === 'paused'
    )
  );
}
function matchesDecisionFilter(job: JobRecord): boolean {
  if (decisionFilter.value === '') {
    return true;
  }
  const decision = decisionOf(job);
  switch (decisionFilter.value) {
    case 'greeting':
      return decision.nextAction === 'send_greeting';
    case 'followup':
      return (
        decision.nextAction === 'follow_up_once' ||
        decision.nextAction === 'follow_up_with_new_angle' ||
        decision.nextAction === 'continue_conversation'
      );
    case 'stopLoss':
      return decision.stopLoss === true || decision.nextAction === 'close_opportunity';
    case 'waiting':
      return isWaitingForReply(job, decision);
    default: {
      const exhaustive: never = decisionFilter.value;
      return exhaustive;
    }
  }
}
function decisionPriority(job: JobRecord): number {
  const decision = decisionOf(job);
  if (decision.stopLoss || decision.nextAction === 'close_opportunity') {
    return 1;
  }
  if (
    decision.nextAction === 'follow_up_with_new_angle' ||
    decision.nextAction === 'follow_up_once' ||
    decision.nextAction === 'continue_conversation'
  ) {
    return 2;
  }
  if (decision.nextAction === 'send_greeting') {
    return 3;
  }
  if (decision.nextAction === 'prepare_interview') {
    return 4;
  }
  if (decision.nextAction === 'wait' || decision.nextAction === 'pause_watch') {
    return 5;
  }
  if (decision.nextAction === null) {
    return 6;
  }
  return 7;
}
// 上下文行：城市 / 薪资 / 规模，压成弱信息（非指标，不与判决抢注意力）。
function contextLine(job: JobRecord): string {
  return [dash(job.city), dash(job.salaryRange), sizeLabel(job)].join(' · ');
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
  ...COMMUNICATION_STATUS_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
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
  { label: '按决策优先级', value: 'decision' },
  { label: '按更新时间', value: 'updated' },
  { label: '按机会分', value: 'opportunity' },
  { label: '按目标画像', value: 'profile' },
];
const decisionFilterOptions: ReadonlyArray<{ value: DecisionFilter; label: string }> = [
  { value: 'greeting', label: '待打招呼' },
  { value: 'followup', label: '可跟进' },
  { value: 'stopLoss', label: '待止损' },
  { value: 'waiting', label: '等回复' },
];

const filteredJobs = computed(() => {
  const list = jobs.value.filter((j) => {
    if (cityFilter.value !== '' && j.city.trim() !== cityFilter.value) return false;
    if (sizeFilter.value !== '' && effectiveSizeTier(j) !== sizeFilter.value) return false;
    if (statusFilter.value !== '' && j.communicationStatus !== statusFilter.value) return false;
    if (!matchesDecisionFilter(j)) return false;
    if (minScore.value > 0) {
      const s = opportunityScoreOf(j);
      if (s === null || s < minScore.value) return false;
    }
    return true;
  });
  const sorted = [...list];
  if (sortKey.value === 'opportunity') {
    sorted.sort((a, b) => (opportunityScoreOf(b) ?? -1) - (opportunityScoreOf(a) ?? -1));
  } else if (sortKey.value === 'profile') {
    sorted.sort((a, b) => (profileScoreOf(b) ?? -1) - (profileScoreOf(a) ?? -1));
  } else if (sortKey.value === 'decision') {
    sorted.sort((a, b) => {
      const priorityDiff = decisionPriority(a) - decisionPriority(b);
      return priorityDiff === 0 ? b.updatedAt - a.updatedAt : priorityDiff;
    });
  } else {
    sorted.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return sorted;
});

function resetFilters(): void {
  cityFilter.value = '';
  sizeFilter.value = '';
  statusFilter.value = '';
  decisionFilter.value = '';
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

      <div class="decision-filters" aria-label="决策筛选">
        <button
          type="button"
          class="decision-filter-chip"
          :class="{ active: decisionFilter === '' }"
          @click="decisionFilter = ''"
        >
          全部行动
        </button>
        <button
          v-for="option in decisionFilterOptions"
          :key="option.value"
          type="button"
          class="decision-filter-chip"
          :class="{ active: decisionFilter === option.value }"
          @click="decisionFilter = option.value"
        >
          {{ option.label }}
        </button>
      </div>

      <p class="result-count">共 {{ filteredJobs.length }} / {{ jobs.length }} 个岗位</p>

      <div class="asset-list">
        <article
          v-for="job in filteredJobs"
          :key="job.id"
          class="asset-card"
          @click="emit('open', job.id)"
        >
          <div
            class="ac-score"
            :class="['tone-' + oppToneOf(job), { none: scoreDisplay(job) === '-' }]"
            title="综合判断这条机会值不值得优先追。"
          >
            <span class="ac-score-num">{{ scoreDisplay(job) }}</span>
            <span class="ac-score-cap">机会分</span>
            <span class="ac-score-level">{{ oppLevelOf(job) }}</span>
            <OpportunityMiniBars
              v-if="radarOf(job)"
              :radar="radarOf(job)!"
              class="ac-mini"
            />
          </div>
          <div class="ac-main">
            <div class="ac-title-row">
              <span class="ac-company">{{ dash(job.company) }}</span>
              <span class="ac-role">{{ dash(job.role) }}</span>
            </div>
            <div class="ac-signals">
              <span
                class="ac-badge"
                :class="'tone-' + profileToneOf(job)"
                title="这家公司与我的目标公司画像有多接近。"
              >
                <i class="ac-dot" aria-hidden="true"></i>{{ profileBadgeText(job) }}
              </span>
              <span
                v-if="adviceToneOf(job) !== 'none'"
                class="ac-badge soft"
                :class="'tone-' + adviceToneOf(job)"
                title="外部 AI 给出的投递建议"
              >
                {{ adviceLabelOf(job) }}
              </span>
              <span
                class="ac-badge decision strategy"
                :data-strategy="decisionOf(job).strategy"
                title="实时派生的跟进策略"
              >
                {{ STRATEGY_LABELS[decisionOf(job).strategy] }}
              </span>
              <span
                class="ac-badge decision action"
                :data-action="decisionActionKey(job)"
                title="实时派生的下一步动作"
              >
                {{ decisionActionLabel(job) }}
              </span>
              <span
                v-if="decisionOf(job).stopLoss"
                class="ac-badge stop-loss"
                title="当前建议收口，不再继续消耗精力"
              >
                建议止损
              </span>
              <span
                v-if="decisionOf(job).companyWarning"
                class="ac-badge company-warning"
                :title="decisionOf(job).companyWarning"
              >
                同公司预警
              </span>
            </div>
            <div class="ac-context">{{ contextLine(job) }}</div>
          </div>
          <div class="ac-side">
            <span class="ac-status" :data-status="job.communicationStatus">
              {{ COMMUNICATION_STATUS_LABELS[job.communicationStatus] }}
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
.decision-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: -2px 0 12px;
}
.decision-filter-chip {
  padding: 6px 13px;
  border: 1px solid #d8e0ec;
  border-radius: 999px;
  background: #fff;
  color: #475569;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.decision-filter-chip:hover {
  background: #f2f6ff;
}
.decision-filter-chip.active {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
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
  grid-template-columns: 96px minmax(0, 1fr) auto;
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
  gap: 1px;
  padding: 9px 6px 8px;
  border-radius: 12px;
  background: #f1f3f6;
}
.ac-score-num {
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  color: #64748b;
}
.ac-score-cap {
  font-size: 11px;
  color: var(--of-ink-2);
}
.ac-score-level {
  margin-top: 1px;
  font-size: 10.5px;
  font-weight: 600;
  color: #64748b;
  text-align: center;
  line-height: 1.2;
}
.ac-mini {
  margin-top: 6px;
  opacity: 0.9;
}
.ac-score.none .ac-mini {
  display: none;
}
/* 机会分按等级上色：高价值=绿 / 优质=蓝 / 可观察=青 / 谨慎=琥珀 / 低价值·未分析=灰 */
.ac-score.tone-strong {
  background: rgba(22, 101, 52, 0.1);
}
.ac-score.tone-strong .ac-score-num,
.ac-score.tone-strong .ac-score-level {
  color: #166534;
}
.ac-score.tone-good {
  background: rgba(37, 99, 235, 0.1);
}
.ac-score.tone-good .ac-score-num,
.ac-score.tone-good .ac-score-level {
  color: #1d4ed8;
}
.ac-score.tone-watch {
  background: rgba(14, 116, 144, 0.1);
}
.ac-score.tone-watch .ac-score-num,
.ac-score.tone-watch .ac-score-level {
  color: #0e7490;
}
.ac-score.tone-caution {
  background: rgba(180, 83, 9, 0.1);
}
.ac-score.tone-caution .ac-score-num,
.ac-score.tone-caution .ac-score-level {
  color: #b45309;
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
.ac-signals {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.ac-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 11px;
  border-radius: 999px;
  background: #eef1f5;
  color: #475569;
}
.ac-badge.soft {
  font-weight: 500;
}
.ac-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.85;
}
/* 目标画像 / 投递建议徽章按等级上色，与机会分色调同一套语义 */
.ac-badge.tone-strong {
  background: #dcfce7;
  color: #166534;
}
.ac-badge.tone-good {
  background: #dbeafe;
  color: #1e40af;
}
.ac-badge.tone-watch {
  background: #cffafe;
  color: #0e7490;
}
.ac-badge.tone-caution {
  background: #fef3c7;
  color: #92400e;
}
.ac-badge.tone-weak {
  background: #eef1f5;
  color: #475569;
}
.ac-badge.decision {
  border: 1px solid transparent;
  font-weight: 600;
}
.ac-badge.strategy[data-strategy='main_attack'] {
  background: #dbeafe;
  color: #1e40af;
}
.ac-badge.strategy[data-strategy='low_cost_probe'] {
  background: #cffafe;
  color: #0e7490;
}
.ac-badge.strategy[data-strategy='cautious_watch'] {
  background: #f1f5f9;
  color: #475569;
}
.ac-badge.strategy[data-strategy='cut_loss'] {
  background: #fee2e2;
  color: #991b1b;
}
.ac-badge.action[data-action='send_greeting'],
.ac-badge.action[data-action='follow_up_once'],
.ac-badge.action[data-action='follow_up_with_new_angle'],
.ac-badge.action[data-action='continue_conversation'] {
  background: #dcfce7;
  color: #166534;
}
.ac-badge.action[data-action='prepare_interview'] {
  background: #e0e7ff;
  color: #3730a3;
}
.ac-badge.action[data-action='wait'],
.ac-badge.action[data-action='pause_watch'] {
  background: #fef3c7;
  color: #92400e;
}
.ac-badge.action[data-action='close_opportunity'],
.ac-badge.action[data-action='done'] {
  background: #eef1f5;
  color: #475569;
}
.ac-badge.stop-loss {
  background: #fee2e2;
  color: #991b1b;
}
.ac-badge.company-warning {
  background: #fff7ed;
  color: #9a3412;
}
.ac-context {
  margin-top: 7px;
  font-size: 12px;
  color: var(--of-muted);
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
.ac-status[data-status='greeted_unread'],
.ac-status[data-status='greeted_read_no_reply'],
.ac-status[data-status='replied'] {
  background: #dbeafe;
  color: #1e40af;
}
.ac-status[data-status='interviewing'] {
  background: #dcfce7;
  color: #166534;
}
.ac-status[data-status='paused'] {
  background: #fef3c7;
  color: #92400e;
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
