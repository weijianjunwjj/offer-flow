<script setup lang="ts">
// Task 3 - Task 6：保存岗位、生成 Prompt、承接外部 AI 原文，并展示报告原文 + 编辑/复制 Boss 话术。
// 不接 AI API，不做复杂解析，不做完整评分系统 / 多版本话术 / 风险标签系统。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { NSelect, NInput } from 'naive-ui';
import type {
  ContactStatus,
  CompanyInput,
  CompanyAssessment,
  CompanySizeTier,
  OpportunityAnalysis,
  JobRecord,
  JobSeekerProfile,
  JobReport,
  ParseStatus,
} from '../storage';
import { emptyCompanyInput } from '../storage';
import { useStores } from '../app/stores';
import { buildAnalysisPrompt } from '../app/prompt';
import { copyText } from '../app/clipboard';
import { CONTACT_STATUS_OPTIONS } from '../app/labels';
import {
  COMPANY_SIZE_OPTIONS,
  COMPANY_SIZE_LABELS,
  LEVEL_LABELS,
  RISK_LABELS,
  CONFIDENCE_LABELS,
  APPLY_ADVICE_LABELS,
} from '../app/companyLabels';
import { extractMatchScore, normalizeMatchScore } from '../app/matchScore';
import {
  extractOfferFlowJson,
  parseOfferFlowJson,
  type OfferFlowJsonParseStatus,
} from '../app/offerFlowJson';
import { getOpportunityScoreLevel } from '../app/opportunityScore';
import {
  calculateTargetProfileScore,
  type TargetProfileScore,
} from '../app/targetProfileScore';
import { opportunityTone, profileTone, applyAdviceTone } from '../app/scoreVisuals';
import OpportunityRadarChart from '../components/OpportunityRadarChart.vue';

const props = defineProps<{
  jobId: string | null;
}>();

const emit = defineEmits<{
  back: [];
  saved: [];
}>();

interface JobBasicForm {
  company: string;
  role: string;
  city: string;
  salaryRange: string;
  jdText: string;
}

function emptyForm(): JobBasicForm {
  return { company: '', role: '', city: '', salaryRange: '', jdText: '' };
}

const form = reactive<JobBasicForm>(emptyForm());
// Task 4：公司与机会补充（v0.2）。与基础信息一起由「保存岗位」持久化，新建 / 编辑 / 旧岗位均适用。
const companyForm = reactive<CompanyInput>(emptyCompanyInput());
const loadError = ref('');

const isEdit = computed(() => props.jobId !== null);
const modeLabel = computed(() => (isEdit.value ? '查看 / 编辑岗位' : '新建岗位'));

// 至少填写一个字段才允许保存，避免创建完全空白的岗位记录。
// 公司补充的文本字段也算「有内容」（sizeTier 有默认值 unknown，不计入）。
const canSave = computed(() =>
  [
    form.company,
    form.role,
    form.city,
    form.salaryRange,
    form.jdText,
    companyForm.staffRange,
    companyForm.companyType,
    companyForm.financingStage,
    companyForm.commuteTime,
    companyForm.commuteWay,
    companyForm.companyNote,
    companyForm.opportunityNote,
  ].some((value) => value.trim() !== ''),
);

const profile = ref<JobSeekerProfile | null>(null);
const generatedPrompt = computed(() =>
  buildAnalysisPrompt(profile.value, form, companyForm),
);
const copyState = ref<'idle' | 'done' | 'fail'>('idle');
const aiRawResult = ref('');
const aiPastedAt = ref<number | null>(null);
const parseStatus = ref<ParseStatus>('none');
const aiSaveState = ref<'idle' | 'done' | 'fail'>('idle');
const aiSaveError = ref('');
const aiExtractedMatch = ref('');
const canSaveAiResult = computed(
  () => props.jobId !== null && aiRawResult.value.trim() !== '',
);

// Task 7：OFFER_FLOW_JSON 自动解析结果（仅状态/反馈用，雷达展示在 Task 8）。
const companyAssessment = ref<CompanyAssessment | null>(null);
const opportunityAnalysis = ref<OpportunityAnalysis | null>(null);
const jsonStatus = ref<OfferFlowJsonParseStatus | ''>('');
const jsonWarnings = ref<string[]>([]);
const JSON_STATUS_LABELS: Record<OfferFlowJsonParseStatus, string> = {
  success: '已解析机会雷达',
  not_found: 'JSON 未找到，已保存原文',
  invalid_json: 'JSON 解析失败，已保存原文',
  partial: '字段不完整，已部分解析',
};
const jsonStatusLabel = computed(() =>
  jsonStatus.value === '' ? '' : JSON_STATUS_LABELS[jsonStatus.value],
);

// Task 8：机会雷达卡展示。无任何结构化数据时显示空状态。
const hasOpportunity = computed(
  () => opportunityAnalysis.value !== null || companyAssessment.value !== null,
);
const scoreLevel = computed(() =>
  opportunityAnalysis.value
    ? getOpportunityScoreLevel(opportunityAnalysis.value.opportunityScore)
    : '',
);
// DEC-019 视觉分层：机会分英雄区 + 投递建议行动指令的色调与文案。
const oppTone = computed(() =>
  opportunityTone(opportunityAnalysis.value?.opportunityScore ?? null),
);
const adviceTone = computed(() =>
  applyAdviceTone(opportunityAnalysis.value?.applyAdvice ?? ''),
);
const adviceLabel = computed(
  () => APPLY_ADVICE_LABELS[opportunityAnalysis.value?.applyAdvice ?? ''],
);

// 第三项指标：目标公司画像匹配度。本地现算（不持久化、不依赖 AI），跟随表单实时变化。
// 完全空白岗位 → null → 显示「待评估」；不影响上面两项指标。
const profileScore = computed<TargetProfileScore | null>(() =>
  calculateTargetProfileScore({
    city: form.city,
    role: form.role,
    salaryRange: form.salaryRange,
    jdText: form.jdText,
    companyInput: companyForm,
    companyAssessment: companyAssessment.value,
  }),
);
const profileLevelText = computed(() => profileScore.value?.level ?? '待评估');
const profileToneText = computed(() => profileTone(profileScore.value?.score ?? null));

// 机会雷达「规模」标签：以用户手填的 companyForm.sizeTier 为准，仅当未填（unknown）才回退 AI 画像。
// 与 JobListPage / targetProfileScore 的 effectiveSizeTier 同口径，避免手填中厂却显示 AI 小厂的矛盾。
const effectiveSizeTier = computed<CompanySizeTier>(() =>
  companyForm.sizeTier !== 'unknown'
    ? companyForm.sizeTier
    : (companyAssessment.value?.sizeTier ?? 'unknown'),
);

// Task 6：报告原文兜底展示 + Boss 话术编辑。
const report = ref<JobReport | null>(null);
const greeting = ref('');
const greetingSaveState = ref<'idle' | 'done' | 'fail'>('idle');
const greetingSaveError = ref('');
const reportCopyState = ref<'idle' | 'done' | 'fail'>('idle');
const greetingCopyState = ref<'idle' | 'done' | 'fail'>('idle');
const hasReportContent = computed(() => aiRawResult.value.trim() !== '');

function emptyReport(): JobReport {
  return {
    jobType: '',
    keywords: '',
    techStackMatch: '',
    projectMatch: '',
    strengths: '',
    risks: '',
    resumeAdvice: '',
    interviewChecklist: '',
    applyAdvice: '',
    greetingMessage: '',
  };
}

// Prompt 内容变化（编辑表单等）后，复制反馈失效，重置为初始态。
watch(generatedPrompt, () => {
  copyState.value = 'idle';
});

watch(aiRawResult, () => {
  aiSaveState.value = 'idle';
  aiSaveError.value = '';
  reportCopyState.value = 'idle';
  jsonStatus.value = '';
  jsonWarnings.value = [];
});

watch(greeting, () => {
  greetingSaveState.value = 'idle';
  greetingSaveError.value = '';
  greetingCopyState.value = 'idle';
});

async function copyPrompt(): Promise<void> {
  const ok = await copyText(generatedPrompt.value);
  copyState.value = ok ? 'done' : 'fail';
}

async function copyReport(): Promise<void> {
  const ok = await copyText(aiRawResult.value);
  reportCopyState.value = ok ? 'done' : 'fail';
}

async function copyGreeting(): Promise<void> {
  const ok = await copyText(greeting.value);
  greetingCopyState.value = ok ? 'done' : 'fail';
}

function saveGreeting(): void {
  if (props.jobId === null) {
    return;
  }
  greetingSaveState.value = 'idle';
  greetingSaveError.value = '';
  try {
    const nextReport: JobReport = {
      ...(report.value ?? emptyReport()),
      greetingMessage: greeting.value,
    };
    useStores().jobs.updateJob(props.jobId, { report: nextReport });
    report.value = nextReport;
    greetingSaveState.value = 'done';
  } catch (error) {
    greetingSaveState.value = 'fail';
    greetingSaveError.value = `保存话术失败：${(error as Error).message}`;
  }
}

// Task 7：沟通状态流转。手动切换，立即持久化，不做自动推进 / 提醒 / 流程校验。
const contactStatus = ref<ContactStatus>('not_contacted');
const contactStatusUpdatedAt = ref<number | null>(null);
const statusSaveState = ref<'idle' | 'done' | 'fail'>('idle');
const statusSaveError = ref('');
const currentStatusLabel = computed(
  () =>
    CONTACT_STATUS_OPTIONS.find((option) => option.value === contactStatus.value)
      ?.label ?? '',
);

function changeContactStatus(next: ContactStatus): void {
  if (props.jobId === null) {
    return;
  }
  const previous = contactStatus.value;
  contactStatus.value = next;
  statusSaveState.value = 'idle';
  statusSaveError.value = '';
  try {
    const updatedAt = Date.now();
    useStores().jobs.updateJob(props.jobId, {
      contactStatus: next,
      contactStatusUpdatedAt: updatedAt,
    });
    contactStatusUpdatedAt.value = updatedAt;
    statusSaveState.value = 'done';
  } catch (error) {
    // 持久化失败则回滚选择，并提示。
    contactStatus.value = previous;
    statusSaveState.value = 'fail';
    statusSaveError.value = `更新状态失败：${(error as Error).message}`;
  }
}

// v0.1.1：匹配度手动录入。匹配度为单值，区间自动取中位（见 normalizeMatchScore）。
const matchScore = ref('');
const matchSaveState = ref<'idle' | 'done' | 'fail'>('idle');
const matchSaveError = ref('');
const matchScorePreview = computed(() => normalizeMatchScore(matchScore.value));

// 用 @input 重置反馈，而非 watch：保存时会把输入归一化（如 70%-80% → 75%）改写
// matchScore，watch 会把刚置的「已保存」反馈清掉；@input 只在用户真实输入时触发。
function onMatchInput(): void {
  matchSaveState.value = 'idle';
  matchSaveError.value = '';
}

function saveMatchScore(): void {
  if (props.jobId === null) {
    return;
  }
  matchSaveState.value = 'idle';
  matchSaveError.value = '';
  try {
    const normalized = normalizeMatchScore(matchScore.value);
    useStores().jobs.updateJob(props.jobId, { matchScore: normalized });
    matchScore.value = normalized;
    matchSaveState.value = 'done';
  } catch (error) {
    matchSaveState.value = 'fail';
    matchSaveError.value = `保存人岗匹配失败：${(error as Error).message}`;
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

onMounted(() => {
  try {
    profile.value = useStores().config.getProfile();
  } catch {
    // 配置读取失败不阻断主战场；Prompt 中对应字段以「（未填写）」兜底。
    profile.value = null;
  }

  if (props.jobId === null) {
    return;
  }
  try {
    const job = useStores().jobs.getJob(props.jobId);
    if (job === null) {
      loadError.value = '该岗位不存在，可能已被删除。';
      return;
    }
    form.company = job.company;
    form.role = job.role;
    form.city = job.city;
    form.salaryRange = job.salaryRange;
    form.jdText = job.jdText;
    // 旧岗位经 storage 读取已补默认值，这里直接回显即可。
    Object.assign(companyForm, job.companyInput);
    aiRawResult.value = job.aiRawResult;
    aiPastedAt.value = job.aiPastedAt;
    parseStatus.value = job.parseStatus;
    report.value = job.report;
    greeting.value = job.report?.greetingMessage ?? '';
    matchScore.value = job.matchScore;
    companyAssessment.value = job.companyAssessment;
    opportunityAnalysis.value = job.opportunityAnalysis;
    contactStatus.value = job.contactStatus;
    contactStatusUpdatedAt.value = job.contactStatusUpdatedAt;
  } catch (error) {
    loadError.value = (error as Error).message;
  }
});

function handleSave(): void {
  if (!canSave.value) {
    return;
  }
  loadError.value = '';
  try {
    const payload = {
      company: form.company,
      role: form.role,
      city: form.city,
      salaryRange: form.salaryRange,
      jdText: form.jdText,
    };
    const companyInput: CompanyInput = { ...companyForm };
    const stores = useStores();
    if (props.jobId === null) {
      // createJob 只收基础信息；公司补充随后用 updateJob 写入（不改数据层接口）。
      const created = stores.jobs.createJob(payload);
      stores.jobs.updateJob(created.id, { companyInput });
    } else {
      stores.jobs.updateJob(props.jobId, { ...payload, companyInput });
    }
    emit('saved');
  } catch (error) {
    loadError.value = `保存岗位失败：${(error as Error).message}`;
  }
}

function saveAiResult(): void {
  if (props.jobId === null || !canSaveAiResult.value) {
    return;
  }

  aiSaveState.value = 'idle';
  aiSaveError.value = '';
  jsonStatus.value = '';
  jsonWarnings.value = [];
  try {
    const pastedAt = Date.now();
    const raw = aiRawResult.value;

    // Task 7：尽力解析 OFFER_FLOW_JSON。解析失败 / 未找到不得阻断保存、不得清空已有结构化字段。
    const parsed = parseOfferFlowJson(extractOfferFlowJson(raw) ?? '');

    // 原文必存（最高优先）。
    const patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>> = {
      aiRawResult: raw,
      aiPastedAt: pastedAt,
    };

    // 匹配度：优先 JSON；其次 v0.1.1 文本提取；都没有则不动已有值（no-clobber）。
    let appliedMatch = '';
    if (parsed.matchScore !== '') {
      patch.matchScore = parsed.matchScore;
      appliedMatch = parsed.matchScore;
    } else {
      const extracted = extractMatchScore(raw);
      if (extracted !== null) {
        patch.matchScore = extracted;
        appliedMatch = extracted;
      }
    }

    // 结构化字段：仅解析出来时才写，未解析则省略 → updateJob 合并保留旧值（no-clobber）。
    let wroteStructured = false;
    if (parsed.companyAssessment !== null) {
      patch.companyAssessment = parsed.companyAssessment;
      wroteStructured = true;
    }
    if (parsed.opportunityAnalysis !== null) {
      patch.opportunityAnalysis = parsed.opportunityAnalysis;
      wroteStructured = true;
      // bossGreeting 为空时不覆盖已有话术。
      const g = parsed.opportunityAnalysis.bossGreeting.trim();
      if (g !== '') {
        patch.report = { ...(report.value ?? emptyReport()), greetingMessage: g };
      }
    }

    // 写了结构化数据视为已解析；否则保持「未解析（原文已保存）」。
    patch.parseStatus = wroteStructured ? 'parsed' : 'unparsed';

    useStores().jobs.updateJob(props.jobId, patch);

    // 同步本地状态（仅同步实际写入的字段）。
    aiPastedAt.value = pastedAt;
    parseStatus.value = patch.parseStatus;
    if (patch.matchScore !== undefined) {
      matchScore.value = patch.matchScore;
    }
    if (patch.companyAssessment !== undefined) {
      companyAssessment.value = patch.companyAssessment;
    }
    if (patch.opportunityAnalysis !== undefined) {
      opportunityAnalysis.value = patch.opportunityAnalysis;
    }
    if (patch.report) {
      report.value = patch.report;
      greeting.value = patch.report.greetingMessage;
    }
    aiExtractedMatch.value = appliedMatch;
    jsonStatus.value = parsed.status;
    jsonWarnings.value = parsed.warnings;
    aiSaveState.value = 'done';
  } catch (error) {
    aiSaveState.value = 'fail';
    aiSaveError.value = `保存 AI 原文失败：${(error as Error).message}`;
  }
}
</script>

<template>
  <main class="battlefield">
    <button class="back-btn" @click="emit('back')">← 返回台账</button>
    <h1>岗位主战场</h1>
    <p class="mode">
      当前模式：{{ modeLabel }}
      <span v-if="jobId" class="job-id">（岗位 ID：{{ jobId }}）</span>
    </p>

    <p v-if="loadError" class="banner banner-error" role="alert">
      {{ loadError }}
    </p>

    <section v-if="isEdit" class="status-block">
      <h2>沟通状态</h2>
      <div class="status-options" role="group" aria-label="沟通状态">
        <button
          v-for="opt in CONTACT_STATUS_OPTIONS"
          :key="opt.value"
          type="button"
          class="status-chip"
          :class="{ active: contactStatus === opt.value }"
          @click="changeContactStatus(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
      <p class="status-meta">
        <span v-if="statusSaveState === 'fail'" class="status-fail" role="alert">
          {{ statusSaveError }}
        </span>
        <span
          v-else-if="contactStatusUpdatedAt !== null"
          class="status-saved"
        >
          当前：{{ currentStatusLabel }}（更新于
          {{ formatTime(contactStatusUpdatedAt) }}）
        </span>
      </p>
    </section>

    <section v-if="isEdit" class="match-block">
      <h2>人岗匹配</h2>
      <div class="match-row">
        <input
          v-model="matchScore"
          type="text"
          class="match-input"
          placeholder="如 85%；AI 给区间（如 70%-80%）会自动取中位"
          @input="onMatchInput"
        />
        <button type="button" class="save-btn" @click="saveMatchScore">
          保存人岗匹配
        </button>
        <span
          v-if="matchSaveState === 'done'"
          class="save-feedback ok"
          role="status"
        >
          已保存 ✓
        </span>
        <span
          v-else-if="matchSaveState === 'fail'"
          class="save-feedback fail"
          role="alert"
        >
          {{ matchSaveError }}
        </span>
      </div>
      <p class="match-hint">
        即 AI 给出的「综合匹配度」——保存 AI 原文时会自动提取并填入此处；也可手动覆盖。人岗匹配为单值（区间自动取中位）。当前将保存为：<strong>{{
          matchScorePreview === '' ? '（空）' : matchScorePreview
        }}</strong>
      </p>
    </section>

    <form class="form" @submit.prevent="handleSave">
      <div class="grid">
        <label class="field">
          <span class="label">公司名</span>
          <input v-model="form.company" type="text" placeholder="如：某某科技" />
        </label>
        <label class="field">
          <span class="label">岗位名</span>
          <input v-model="form.role" type="text" placeholder="如：高级前端" />
        </label>
        <label class="field">
          <span class="label">城市</span>
          <input v-model="form.city" type="text" placeholder="如：苏州" />
        </label>
        <label class="field">
          <span class="label">薪资范围</span>
          <input
            v-model="form.salaryRange"
            type="text"
            placeholder="如：18-24K"
          />
        </label>
      </div>

      <label class="field">
        <span class="label">岗位 JD</span>
        <textarea
          v-model="form.jdText"
          rows="8"
          placeholder="粘贴 Boss 岗位 JD 原文"
        ></textarea>
      </label>

      <div class="company-extra">
        <h2>公司与机会补充</h2>
        <p class="company-extra-hint">
          这些信息会随岗位一起保存，并作为 One-Shot Prompt 的输入。AI 不确定时请如实留空，不要乱猜。
        </p>
        <div class="grid">
          <div class="field">
            <span class="label">公司规模</span>
            <n-select v-model:value="companyForm.sizeTier" :options="COMPANY_SIZE_OPTIONS" />
          </div>
          <div class="field">
            <span class="label">人员规模原文</span>
            <n-input v-model:value="companyForm.staffRange" placeholder="如：100-499 人" />
          </div>
          <div class="field">
            <span class="label">公司类型</span>
            <n-input v-model:value="companyForm.companyType" placeholder="如：自研业务 / 外包 / 国企" />
          </div>
          <div class="field">
            <span class="label">融资阶段</span>
            <n-input v-model:value="companyForm.financingStage" placeholder="如：A 轮 / 已上市 / 未明确" />
          </div>
          <div class="field">
            <span class="label">通勤时间</span>
            <n-input v-model:value="companyForm.commuteTime" placeholder="如：45min" />
          </div>
          <div class="field">
            <span class="label">通勤方式</span>
            <n-input v-model:value="companyForm.commuteWay" placeholder="如：地铁 / 自驾 / 步行" />
          </div>
        </div>
        <div class="field">
          <span class="label">公司备注</span>
          <n-input
            v-model:value="companyForm.companyNote"
            type="textarea"
            :rows="3"
            placeholder="对公司的额外了解，如口碑、业务方向、团队情况"
          />
        </div>
        <div class="field">
          <span class="label">机会备注</span>
          <n-input
            v-model:value="companyForm.opportunityNote"
            type="textarea"
            :rows="3"
            placeholder="你对这个机会的判断、顾虑或期待"
          />
        </div>
      </div>

      <div class="actions">
        <button type="submit" class="save-btn" :disabled="!canSave">
          保存岗位
        </button>
        <button type="button" class="cancel-btn" @click="emit('back')">
          取消
        </button>
        <span v-if="!canSave" class="save-hint">至少填写一个字段后才能保存</span>
      </div>
    </form>

    <section class="prompt-block">
      <div class="prompt-head">
        <h2>分析 Prompt</h2>
        <button type="button" class="copy-btn" @click="copyPrompt">
          一键复制
        </button>
        <span v-if="copyState === 'done'" class="copy-feedback ok" role="status">
          已复制 ✓
        </span>
        <span
          v-else-if="copyState === 'fail'"
          class="copy-feedback fail"
          role="alert"
        >
          复制失败，请手动选择文本复制
        </span>
      </div>
      <p class="prompt-hint">
        本工具不接入任何 AI API。请复制下方 Prompt，粘贴到 ChatGPT / Claude /
        Gemini 等外部 AI，再把返回结果完整贴回下方文本框。
      </p>
      <textarea
        class="prompt-text"
        :value="generatedPrompt"
        readonly
        rows="16"
      ></textarea>
    </section>

    <section class="ai-result-block">
      <h2>外部 AI 结果原文</h2>
      <p class="ai-result-hint">
        粘贴 ChatGPT、Claude、Gemini 等外部 AI 返回的完整内容（含 OFFER_FLOW_JSON）。保存时会尽力解析机会雷达；解析失败或未找到 JSON 也会照常保存原文，不会清空已有结构化数据。
      </p>
      <textarea
        v-model="aiRawResult"
        class="ai-result-text"
        rows="16"
        :disabled="jobId === null"
        placeholder="在这里粘贴外部 AI 返回的完整原文"
      ></textarea>
      <div class="ai-result-actions">
        <button
          type="button"
          class="save-btn"
          :disabled="!canSaveAiResult"
          @click="saveAiResult"
        >
          保存 AI 原文
        </button>
        <span v-if="jobId === null" class="save-hint">
          请先保存岗位，再录入 AI 结果
        </span>
        <span
          v-else-if="aiSaveState === 'done' && aiPastedAt !== null"
          class="save-feedback ok"
          role="status"
        >
          已保存 ✓（{{ formatTime(aiPastedAt) }}）
        </span>
        <span
          v-else-if="aiSaveState === 'fail'"
          class="save-feedback fail"
          role="alert"
        >
          {{ aiSaveError }}
        </span>
        <span
          v-else-if="aiPastedAt !== null"
          class="save-feedback saved-at"
        >
          上次保存：{{ formatTime(aiPastedAt) }}
        </span>
      </div>
      <p
        v-if="jsonStatus !== ''"
        class="parse-status"
        :class="{
          ok: jsonStatus === 'success',
          warn: jsonStatus === 'partial',
          fail: jsonStatus === 'invalid_json',
        }"
        role="status"
      >
        {{ jsonStatusLabel }}
      </p>
      <p v-else-if="parseStatus !== 'none'" class="parse-status">
        解析状态：{{ parseStatus === 'parsed' ? '已解析机会雷达' : '未解析（原文已保存）' }}
      </p>
      <ul v-if="jsonWarnings.length > 0" class="json-warnings">
        <li v-for="(w, i) in jsonWarnings.slice(0, 5)" :key="i">{{ w }}</li>
        <li v-if="jsonWarnings.length > 5" class="more">
          …等共 {{ jsonWarnings.length }} 条提示
        </li>
      </ul>
      <p
        v-if="aiSaveState === 'done' && aiExtractedMatch !== ''"
        class="ai-extracted"
        role="status"
      >
        已自动提取综合匹配度：<strong>{{ aiExtractedMatch }}</strong
        >（已填入下方「匹配度」，可手动调整）
      </p>
    </section>

    <section v-if="isEdit" class="radar-block">
      <h2>机会雷达</h2>

      <p v-if="!hasOpportunity" class="radar-empty">
        还没有机会雷达。粘贴 AI 分析结果后，这里会亮起来。
      </p>

      <div v-else class="radar-grid">
        <!-- 左：机会分英雄区（主判决） + 人岗匹配 / 目标画像两张判读卡 + 雷达图 -->
        <div class="radar-left">
          <div
            v-if="opportunityAnalysis"
            class="hero"
            :class="'tone-' + oppTone"
            title="综合判断这条机会值不值得优先追。"
          >
            <div class="hero-score">
              <span class="hero-num">{{ opportunityAnalysis.opportunityScore }}</span>
              <span class="hero-unit">/ 100</span>
            </div>
            <div class="hero-meta">
              <span class="hero-cap">机会分</span>
              <span class="hero-level">{{ scoreLevel }}</span>
              <span
                v-if="adviceTone !== 'none'"
                class="hero-advice"
                :class="'tone-' + adviceTone"
              >
                {{ adviceLabel }}
              </span>
            </div>
          </div>

          <div v-if="opportunityAnalysis" class="judge-row">
            <div
              class="judge-card"
              title="以我的能力，我拿不拿得下这个岗位（来自 AI 的综合匹配度）。"
            >
              <span class="judge-num">{{ matchScore === '' ? '—' : matchScore }}</span>
              <span class="judge-cap">人岗匹配</span>
              <span class="judge-sub">我拿不拿得下</span>
            </div>
            <div
              class="judge-card"
              :class="'tone-' + profileToneText"
              :title="profileScore?.reason ?? '这家公司与我的目标公司画像有多接近。'"
            >
              <span class="judge-num">{{ profileScore === null ? '—' : profileScore.score }}</span>
              <span class="judge-cap">目标画像 · {{ profileLevelText }}</span>
              <span class="judge-sub">是不是我的菜</span>
            </div>
          </div>

          <OpportunityRadarChart
            v-if="opportunityAnalysis"
            :radar="opportunityAnalysis.opportunityRadar"
          />
        </div>

        <!-- 右：公司画像 + 风险 / 投递建议 -->
        <div class="radar-right">
          <div v-if="companyAssessment" class="profile-tags">
            <span class="tag">规模 · {{ COMPANY_SIZE_LABELS[effectiveSizeTier] }}</span>
            <span v-if="companyAssessment.companyType" class="tag">
              类型 · {{ companyAssessment.companyType }}
            </span>
            <span class="tag">稳定性 · {{ LEVEL_LABELS[companyAssessment.stabilityLevel] }}</span>
            <span class="tag">成长性 · {{ LEVEL_LABELS[companyAssessment.growthPotential] }}</span>
            <span class="tag">置信度 · {{ CONFIDENCE_LABELS[companyAssessment.confidence] }}</span>
          </div>
          <div v-if="opportunityAnalysis" class="profile-tags">
            <span class="tag risk">风险 · {{ RISK_LABELS[opportunityAnalysis.riskLevel] }}</span>
            <span class="tag advice">
              投递建议 · {{ APPLY_ADVICE_LABELS[opportunityAnalysis.applyAdvice] }}
            </span>
          </div>
          <p v-if="companyAssessment && companyAssessment.summary" class="profile-summary">
            {{ companyAssessment.summary }}
          </p>
        </div>
      </div>

      <template v-if="hasOpportunity && opportunityAnalysis">
        <div v-if="profileScore" class="radar-section">
          <h3>目标画像说明</h3>
          <p class="radar-text">{{ profileScore.reason }}</p>
        </div>
        <div v-if="opportunityAnalysis.decisionSummary" class="radar-section">
          <h3>决策摘要</h3>
          <p class="radar-text">{{ opportunityAnalysis.decisionSummary }}</p>
        </div>
        <div v-if="opportunityAnalysis.interviewFocus.length > 0" class="radar-section">
          <h3>面试关注点</h3>
          <ul class="focus-list">
            <li v-for="(f, i) in opportunityAnalysis.interviewFocus" :key="i">{{ f }}</li>
          </ul>
        </div>
        <p class="radar-note">Boss 打招呼话术见下方「Boss 打招呼话术」区，可编辑与复制。</p>
      </template>
    </section>

    <section v-if="isEdit" class="report-block">
      <div class="report-head">
        <h2>分析报告</h2>
        <button
          type="button"
          class="copy-btn"
          :disabled="!hasReportContent"
          @click="copyReport"
        >
          复制报告
        </button>
        <span v-if="reportCopyState === 'done'" class="copy-feedback ok" role="status">
          已复制 ✓
        </span>
        <span
          v-else-if="reportCopyState === 'fail'"
          class="copy-feedback fail"
          role="alert"
        >
          复制失败，请手动选择文本复制
        </span>
      </div>
      <p class="report-hint">
        v0.1 不自动结构化解析，下方直接展示外部 AI 返回的报告原文，可阅读与复制。
      </p>
      <textarea
        v-if="hasReportContent"
        class="report-text"
        :value="aiRawResult"
        readonly
        rows="14"
      ></textarea>
      <p v-else class="report-empty">
        暂无报告原文。请先在上方「外部 AI 结果原文」中粘贴并保存 AI 返回内容。
      </p>

      <div class="greeting-head">
        <h3>Boss 打招呼话术</h3>
        <button type="button" class="copy-btn" @click="copyGreeting">
          复制话术
        </button>
        <span
          v-if="greetingCopyState === 'done'"
          class="copy-feedback ok"
          role="status"
        >
          已复制 ✓
        </span>
        <span
          v-else-if="greetingCopyState === 'fail'"
          class="copy-feedback fail"
          role="alert"
        >
          复制失败，请手动选择文本复制
        </span>
      </div>
      <p class="greeting-hint">
        可从报告原文中摘出 / 手动编辑打招呼话术，保存后可在 Boss 直聘直接发送。
      </p>
      <textarea
        v-model="greeting"
        class="greeting-text"
        rows="5"
        placeholder="编辑你的 Boss 打招呼话术"
      ></textarea>
      <div class="greeting-actions">
        <button type="button" class="save-btn" @click="saveGreeting">
          保存话术
        </button>
        <span
          v-if="greetingSaveState === 'done'"
          class="save-feedback ok"
          role="status"
        >
          已保存 ✓
        </span>
        <span
          v-else-if="greetingSaveState === 'fail'"
          class="save-feedback fail"
          role="alert"
        >
          {{ greetingSaveError }}
        </span>
      </div>
    </section>
  </main>
</template>

<style scoped>
.battlefield {
  max-width: 1000px;
  margin: 0 auto;
  padding: 24px 16px 64px;
  color: #1f2933;
}
.back-btn {
  margin-bottom: 16px;
  padding: 6px 12px;
  border: 1px solid #cbd2d9;
  border-radius: 8px;
  background: #fff;
  font-size: 13px;
  cursor: pointer;
}
.back-btn:hover {
  background: #f2f6ff;
}
h1 {
  margin: 0 0 8px;
  font-size: 22px;
}
.mode {
  margin: 0 0 16px;
  font-size: 14px;
}
.job-id {
  color: #647084;
  font-size: 13px;
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
.status-block {
  margin-bottom: 20px;
  padding: 20px;
  border: 1px solid var(--of-line);
  border-radius: var(--of-radius);
  background: var(--of-card);
  box-shadow: var(--of-shadow);
}
.status-block h2 {
  margin: 0 0 10px;
  font-size: 15px;
}
.status-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.status-chip {
  padding: 6px 14px;
  border: 1px solid #cbd2d9;
  border-radius: 999px;
  background: #fff;
  font-size: 13px;
  color: #1f2933;
  cursor: pointer;
}
.status-chip:hover {
  background: #f2f6ff;
}
.status-chip.active {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
}
.status-meta {
  margin: 10px 0 0;
  min-height: 18px;
  font-size: 12px;
  color: #647084;
}
.status-fail {
  color: #a4262c;
}
.match-block {
  margin-bottom: 20px;
  padding: 20px;
  border: 1px solid var(--of-line);
  border-radius: var(--of-radius);
  background: var(--of-card);
  box-shadow: var(--of-shadow);
}
.match-block h2 {
  margin: 0 0 10px;
  font-size: 15px;
}
.match-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.match-input {
  flex: 1 1 220px;
  min-width: 180px;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid #cbd2d9;
  border-radius: 8px;
  font: inherit;
  background: #fff;
}
.match-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #647084;
}
.match-hint strong {
  color: #1f2933;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--of-line);
  border-radius: var(--of-radius);
  background: var(--of-card);
  box-shadow: var(--of-shadow);
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label {
  font-size: 13px;
  font-weight: 600;
}
input[type='text'],
textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid #d7deea;
  border-radius: 10px;
  font: inherit;
  background: #fff;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
input[type='text']:focus,
textarea:focus {
  outline: none;
  border-color: var(--of-brand);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
textarea {
  resize: vertical;
}
.company-extra {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 16px;
  margin-top: 4px;
  border-top: 1px dashed var(--of-line);
}
.company-extra h2 {
  margin: 0;
  font-size: 15px;
}
.company-extra-hint {
  margin: -8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #647084;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.save-btn {
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.save-btn:hover:not(:disabled) {
  background: #1d4ed8;
}
.save-btn:disabled {
  background: #aebfe0;
  cursor: not-allowed;
}
.cancel-btn {
  padding: 10px 16px;
  border: 1px solid #cbd2d9;
  border-radius: 8px;
  background: #fff;
  font-size: 14px;
  cursor: pointer;
}
.cancel-btn:hover {
  background: #f2f6ff;
}
.save-hint {
  color: #647084;
  font-size: 12px;
}
.prompt-block,
.ai-result-block,
.radar-block,
.report-block {
  margin-top: 20px;
  padding: 20px;
  border: 1px solid var(--of-line);
  border-radius: var(--of-radius);
  background: var(--of-card);
  box-shadow: var(--of-shadow);
}
/* 统一的区块标题渐变小竖条，营造浅色高级科技感。 */
.battlefield h2 {
  position: relative;
  padding-left: 12px;
}
.battlefield h2::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 15px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--of-brand), var(--of-brand-2));
}
.radar-block {
  background:
    radial-gradient(640px 220px at 92% -30%, rgba(14, 165, 233, 0.08), transparent 60%),
    linear-gradient(180deg, #ffffff, #fbfdff);
}
.radar-block h2 {
  margin: 0 0 14px;
  font-size: 16px;
}
.radar-empty {
  margin: 0;
  padding: 24px 16px;
  border: 1px dashed #cbd2d9;
  border-radius: 12px;
  background: #f8fafc;
  color: #647084;
  font-size: 13px;
  text-align: center;
}
.radar-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.radar-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border: 1px solid #eceff3;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 18px 40px -28px rgba(16, 24, 40, 0.25);
}
/* 机会分英雄区（主判决） */
.hero {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 16px 20px;
  border-radius: 14px;
  background: #f1f3f6;
}
.hero-score {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.hero-num {
  font-size: 44px;
  font-weight: 700;
  line-height: 1;
  color: #64748b;
}
.hero-unit {
  font-size: 13px;
  color: #94a3b8;
}
.hero-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}
.hero-cap {
  font-size: 12px;
  color: #647084;
}
.hero-level {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.1;
  color: #64748b;
}
.hero-advice {
  margin-top: 3px;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 11px;
  border-radius: 999px;
  background: #eef1f5;
  color: #475569;
}
.hero.tone-strong {
  background: rgba(22, 101, 52, 0.1);
}
.hero.tone-strong .hero-num,
.hero.tone-strong .hero-level {
  color: #166534;
}
.hero.tone-good {
  background: rgba(37, 99, 235, 0.1);
}
.hero.tone-good .hero-num,
.hero.tone-good .hero-level {
  color: #1d4ed8;
}
.hero.tone-watch {
  background: rgba(14, 116, 144, 0.1);
}
.hero.tone-watch .hero-num,
.hero.tone-watch .hero-level {
  color: #0e7490;
}
.hero.tone-caution {
  background: rgba(180, 83, 9, 0.1);
}
.hero.tone-caution .hero-num,
.hero.tone-caution .hero-level {
  color: #b45309;
}
.hero-advice.tone-strong {
  background: #dcfce7;
  color: #166534;
}
.hero-advice.tone-good {
  background: #dbeafe;
  color: #1e40af;
}
.hero-advice.tone-caution {
  background: #fef3c7;
  color: #92400e;
}
.hero-advice.tone-weak {
  background: #eef1f5;
  color: #475569;
}
/* 人岗匹配 / 目标画像两张判读卡（次级） */
.judge-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  width: 100%;
}
.judge-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 0.5px solid #eceff3;
  background: #fff;
}
.judge-num {
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  color: #1f2933;
}
.judge-cap {
  font-size: 12px;
  color: #647084;
  margin-top: 5px;
}
.judge-sub {
  font-size: 11px;
  color: #94a3b8;
}
.judge-card.tone-strong {
  background: #f0fdf4;
  border-color: #bbf7d0;
}
.judge-card.tone-strong .judge-num {
  color: #166534;
}
.judge-card.tone-good {
  background: #eff6ff;
  border-color: #bfdbfe;
}
.judge-card.tone-good .judge-num {
  color: #1e40af;
}
.judge-card.tone-watch {
  background: #ecfeff;
  border-color: #a5f3fc;
}
.judge-card.tone-watch .judge-num {
  color: #0e7490;
}
.judge-card.tone-caution {
  background: #fffbeb;
  border-color: #fde68a;
}
.judge-card.tone-caution .judge-num {
  color: #92400e;
}
.judge-card.tone-weak {
  background: #f8fafc;
  border-color: #e2e8f0;
}
.radar-right {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.profile-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tag {
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12.5px;
  background: #eef2f8;
  color: #1f2933;
}
.tag.risk {
  background: #fef3c7;
  color: #92400e;
}
.tag.advice {
  background: #dbeafe;
  color: #1e40af;
}
.profile-summary {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: #475569;
}
.radar-section {
  margin-top: 18px;
}
.radar-section h3 {
  margin: 0 0 6px;
  font-size: 14px;
}
.radar-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: #475569;
}
.focus-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.8;
  color: #475569;
}
.radar-note {
  margin: 16px 0 0;
  font-size: 12px;
  color: #94a3b8;
}
.prompt-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.prompt-head h2 {
  margin: 0;
  font-size: 16px;
}
.copy-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: #16a34a;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.copy-btn:hover {
  background: #15803d;
}
.copy-feedback {
  font-size: 13px;
}
.copy-feedback.ok {
  color: #1a7f37;
}
.copy-feedback.fail {
  color: #a4262c;
}
.prompt-hint {
  margin: 0 0 10px;
  color: #647084;
  font-size: 12px;
  line-height: 1.6;
}
.prompt-text {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid #cbd2d9;
  border-radius: 8px;
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: #f7f9fc;
  color: #1f2933;
  resize: vertical;
}
.ai-result-block h2 {
  margin: 0 0 8px;
  font-size: 16px;
}
.ai-result-hint {
  margin: 0 0 10px;
  color: #647084;
  font-size: 12px;
  line-height: 1.6;
}
.ai-result-text:disabled {
  background: #f3f4f6;
  color: #8a94a6;
  cursor: not-allowed;
}
.ai-result-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.save-feedback,
.parse-status {
  font-size: 13px;
}
.save-feedback.ok {
  color: #1a7f37;
}
.save-feedback.fail {
  color: #a4262c;
}
.save-feedback.saved-at,
.parse-status {
  color: #647084;
}
.parse-status {
  margin: 10px 0 0;
}
.parse-status.ok {
  color: #1a7f37;
}
.parse-status.warn {
  color: #b45309;
}
.parse-status.fail {
  color: #a4262c;
}
.json-warnings {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #647084;
  line-height: 1.6;
}
.json-warnings .more {
  list-style: none;
  margin-left: -18px;
  color: #8a94a6;
}
.ai-extracted {
  margin: 8px 0 0;
  font-size: 13px;
  color: #1a7f37;
}
.ai-extracted strong {
  color: #14532d;
}
.report-head,
.greeting-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.report-head h2 {
  margin: 0;
  font-size: 16px;
}
.greeting-head {
  margin-top: 24px;
}
.greeting-head h3 {
  margin: 0;
  font-size: 15px;
}
.report-hint,
.greeting-hint {
  margin: 0 0 10px;
  color: #647084;
  font-size: 12px;
  line-height: 1.6;
}
.report-text {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid #cbd2d9;
  border-radius: 8px;
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: #f7f9fc;
  color: #1f2933;
  resize: vertical;
}
.report-empty {
  margin: 0;
  padding: 16px;
  border: 1px dashed #cbd2d9;
  border-radius: 8px;
  color: #647084;
  font-size: 13px;
  background: #fafbfc;
}
.greeting-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
@media (max-width: 560px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .ai-result-actions {
    align-items: flex-start;
    flex-direction: column;
  }
  .radar-grid {
    grid-template-columns: 1fr;
  }
}
</style>
