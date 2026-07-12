<script setup lang="ts">
// Task 3 - Task 6：保存岗位、生成 Prompt、承接 AI 原文，并展示报告原文 + 编辑/复制 Boss 话术。
// v0.5：已接入 OfferFlow 自有 LLM 调用链路，同时保留手动粘贴外部 AI 结果的备用路径。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { NDatePicker, NSelect, NInput } from 'naive-ui';
import type {
  CommunicationStatus,
  CompanyInput,
  CompanyAssessment,
  CompanySizeTier,
  OpportunityAnalysis,
  JobRecord,
  JobSeekerProfile,
  JobReport,
  ParseStatus,
  StrategyType,
} from '../storage';
import { emptyCompanyInput } from '../storage';
import { profileApi } from '../api/profileApi';
import { jobsApi } from '../api/jobsApi';
import { buildAnalysisPrompt } from '../app/prompt';
import { copyText } from '../app/clipboard';
import { buildMessageTemplate } from '../app/messageTemplates';
import { COMMUNICATION_STATUS_OPTIONS } from '../app/labels';
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
import {
  deriveDecision,
  type MessageScenario,
  type NextActionType,
} from '../decision';
import {
  applyReviewAction,
  getAvailableReviewActions,
  isPendingReview,
} from '../review/reviewWorkflow';
import type { ReviewAction } from '../review/reviewWorkflow';
import { performJdImageOcr } from '../ocr/jdImageOcr';
import { llmApi, type AnalyzeJobResponse } from '../api/llmApi';
import { injectJobDetailScope } from '../page-scopes/jobDetailScope';
import { navigationConfirm } from '../router/confirmNavigation';
import JobBasicInfoSection from './job-detail/JobBasicInfoSection.vue';
import JdInputSection from './job-detail/JdInputSection.vue';
import ImportReviewSection from './job-detail/ImportReviewSection.vue';
import CommunicationSection from './job-detail/CommunicationSection.vue';
import JobDecisionSection from './job-detail/JobDecisionSection.vue';

const props = defineProps<{
  jobId: string | null;
  scopeRequired?: boolean;
}>();

const emit = defineEmits<{
  back: [];
  saved: [];
}>();

const pageScope = props.scopeRequired ? injectJobDetailScope() : null;
let ownerMounted = true;
let ocrGeneration = 0;
let streamRunId = 0;
let streamController: AbortController | null = null;
const saveInFlight = ref(false);

interface JobBasicForm {
  company: string;
  role: string;
  city: string;
  salaryRange: string;
  jdText: string;
}

function emptyForm(): JobBasicForm {
  return { company: '', role: '', city: '苏州', salaryRange: '', jdText: '' };
}

type JdImageOcrStatus = 'pending' | 'processing' | 'done' | 'failed';

interface PendingJdImage {
  id: string;
  file: File;
  previewUrl: string;
  status: JdImageOcrStatus;
  error?: string;
  ocrText?: string;
}

const form = reactive<JobBasicForm>(emptyForm());
// Task 4：公司与机会补充（v0.2）。与基础信息一起由「保存岗位」持久化，新建 / 编辑 / 旧岗位均适用。
const companyForm = reactive<CompanyInput>(emptyCompanyInput());
companyForm.companyType = '自研业务';
companyForm.financingStage = '未融资 / 不明确';
function editableFingerprint(): string {
  return JSON.stringify({ ...form, companyInput: { ...companyForm } });
}
const baselineFingerprint = ref(editableFingerprint());
const isDirty = computed(() => editableFingerprint() !== baselineFingerprint.value);
const loadError = ref('');
const currentJob = ref<JobRecord | null>(null);
const allJobs = ref<JobRecord[]>([]);
const pendingJdImages = ref<PendingJdImage[]>([]);
const jdImagePasteNotice = ref('');
let jdImageIdSeed = 0;

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
const llmAnalyzing = ref(false);
const llmError = ref('');
const llmResult = ref<AnalyzeJobResponse | null>(null);
const aiExtractedMatch = ref('');
const canSaveAiResult = computed(
  () => props.jobId !== null && aiRawResult.value.trim() !== '',
);
const hasJdImages = computed(() => pendingJdImages.value.length > 0);
const canConvertJdImages = computed(() =>
  pendingJdImages.value.some((image) => image.status === 'pending' || image.status === 'failed'),
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

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 KB';
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function jdImageStatusLabel(status: JdImageOcrStatus): string {
  switch (status) {
    case 'pending':
      return '待转换';
    case 'processing':
      return '转换中';
    case 'done':
      return '已转换';
    case 'failed':
      return '转换失败';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function addPendingJdImages(files: File[]): void {
  if (files.length === 0) {
    return;
  }

  const nextImages = files.map((file) => ({
    id: `jd-image-${Date.now()}-${jdImageIdSeed += 1}`,
    file,
    previewUrl: URL.createObjectURL(file),
    status: 'pending' as const,
  }));
  pendingJdImages.value = [...pendingJdImages.value, ...nextImages];
  jdImagePasteNotice.value = `已加入 ${files.length} 张截图，点击“转换文字”后才会 OCR。`;
}

function handleJdPaste(event: ClipboardEvent): void {
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageFiles = items
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  if (imageFiles.length === 0) {
    return;
  }

  event.preventDefault();
  addPendingJdImages(imageFiles);
}

function removePendingJdImage(imageId: string): void {
  const image = pendingJdImages.value.find((item) => item.id === imageId);
  if (image !== undefined) {
    URL.revokeObjectURL(image.previewUrl);
  }
  pendingJdImages.value = pendingJdImages.value.filter((item) => item.id !== imageId);
}

function appendOcrTextToJd(texts: string[]): void {
  const merged = texts.map((text) => text.trim()).filter((text) => text !== '').join('\n\n');
  if (merged === '') {
    return;
  }

  const separator = '--- OCR 识别结果 ---';
  form.jdText =
    form.jdText.trim() === ''
      ? `${separator}\n${merged}`
      : `${form.jdText.trimEnd()}\n\n${separator}\n${merged}`;
}

async function convertPendingJdImages(): Promise<void> {
  const runId = ++ocrGeneration;
  const requestedJobId = props.jobId;
  const targets = pendingJdImages.value.filter(
    (image) => image.status === 'pending' || image.status === 'failed',
  );
  if (targets.length === 0) {
    return;
  }

  jdImagePasteNotice.value = '';
  const recognizedTexts: string[] = [];
  for (const image of targets) {
    image.status = 'processing';
    image.error = undefined;
    try {
      const text = await performJdImageOcr(image.file);
      if (!ownerMounted || runId !== ocrGeneration || requestedJobId !== props.jobId) {
        return;
      }
      if (!pendingJdImages.value.some((candidate) => candidate.id === image.id)) {
        continue;
      }
      image.ocrText = text;
      if (text.trim() === '') {
        image.status = 'failed';
        image.error = 'OCR 未识别到文字';
      } else {
        image.status = 'done';
        recognizedTexts.push(text);
      }
    } catch (error) {
      if (!ownerMounted || runId !== ocrGeneration || requestedJobId !== props.jobId) {
        return;
      }
      image.status = 'failed';
      image.error = (error as Error).message;
    }
  }

  if (ownerMounted && runId === ocrGeneration && requestedJobId === props.jobId) {
    appendOcrTextToJd(recognizedTexts);
  }
}

onBeforeUnmount(() => {
  ownerMounted = false;
  ocrGeneration += 1;
  streamRunId += 1;
  streamController?.abort();
  streamController = null;
  for (const image of pendingJdImages.value) {
    URL.revokeObjectURL(image.previewUrl);
  }
  pendingJdImages.value = [];
  window.removeEventListener('beforeunload', handleBeforeUnload);
});

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

async function saveGreeting(): Promise<void> {
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
    const updated = pageScope
      ? await pageScope.saveGreeting({ report: nextReport })
      : await jobsApi.patch(props.jobId, { report: nextReport });
    await rememberJob(updated);
    report.value = nextReport;
    greetingSaveState.value = 'done';
  } catch (error) {
    greetingSaveState.value = 'fail';
    greetingSaveError.value = `保存话术失败：${(error as Error).message}`;
  }
}

// Task 7 / v0.3 T1：沟通状态流转。手动切换，立即持久化，不做自动推进 / 提醒 / 流程校验。
const communicationStatus = ref<CommunicationStatus>('not_contacted');
const statusSaveState = ref<'idle' | 'done' | 'fail'>('idle');
const statusSaveError = ref('');
const currentStatusLabel = computed(
  () =>
    COMMUNICATION_STATUS_OPTIONS.find((option) => option.value === communicationStatus.value)
      ?.label ?? '',
);
const followupCount = ref(0);
const lastCommunicationNote = ref('');
const highValueSignal = ref(false);
const draftMessageText = ref('');
const lastGreetedAtValue = ref<number | null>(null);
const lastFollowupAtValue = ref<number | null>(null);
const followupSaveState = ref<'idle' | 'done' | 'fail'>('idle');
const followupSaveError = ref('');
const recommendedMessageCopyState = ref<'idle' | 'done' | 'fail'>('idle');
const recommendedMessageFillState = ref<'idle' | 'done'>('idle');
const showPrompt = ref(false);

const reviewSaveState = ref<'idle' | 'done' | 'fail'>('idle');
const reviewSaveError = ref('');
const showReviewPanel = computed(() => {
  const job = currentJob.value;
  return (
    job !== null &&
    (job.reviewStatus !== undefined ||
      job.importStatus === 'imported_draft' ||
      job.importedDraft !== undefined)
  );
});
const pendingReview = computed(() => currentJob.value !== null && isPendingReview(currentJob.value));
const availableReviewActions = computed<ReviewAction[]>(() =>
  currentJob.value === null ? [] : getAvailableReviewActions(currentJob.value),
);
const reviewStatusLabel = computed(() => {
  const status = currentJob.value?.reviewStatus;
  switch (status) {
    case 'pending_review':
      return '待人工确认';
    case 'confirmed':
      return '已确认';
    case 'deferred':
      return '已暂缓';
    case 'rejected':
      return '已拒绝';
    case undefined:
      return '未进入确认';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
});
const reviewNotice = computed(() => {
  const status = currentJob.value?.reviewStatus;
  switch (status) {
    case 'confirmed':
      return '已人工确认，可进入正常跟进决策。';
    case 'deferred':
      return '已暂缓观察，暂不进入主攻跟进。';
    case 'rejected':
      return '已人工拒绝 / 关闭，不再建议跟进。';
    case 'pending_review':
    case undefined:
      return '';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
});
const reviewSourceRows = computed<Array<{ label: string; value: string }>>(() => {
  const job = currentJob.value;
  if (job === null) {
    return [];
  }
  const draft = job.importedDraft;
  const rows = [
    { label: '公司', value: form.company.trim() },
    { label: '岗位', value: form.role.trim() },
    { label: '城市', value: form.city.trim() },
    { label: '薪资', value: form.salaryRange.trim() },
    { label: '导入分类', value: draft?.recommendedCategory ?? '' },
    { label: '置信度', value: formatReviewConfidence(draft?.confidence) },
  ];
  return rows.filter((row) => row.value !== '');
});
const reviewReason = computed(() => currentJob.value?.importedDraft?.reason?.trim() ?? '');
const reviewWarnings = computed(() => currentJob.value?.importedDraft?.warnings ?? []);
const hasReviewAiRawResult = computed(() => aiRawResult.value.trim() !== '');
const reviewParseStatusText = computed(() => {
  switch (parseStatus.value) {
    case 'parsed':
      return '已解析';
    case 'unparsed':
      return '未解析 / 原文已保存';
    case 'none':
      return '无';
    default: {
      const exhaustive: never = parseStatus.value;
      return exhaustive;
    }
  }
});

function formatReviewConfidence(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : '';
}

function reviewActionLabel(action: ReviewAction): string {
  switch (action) {
    case 'confirm':
      return '确认进入机会';
    case 'defer':
      return '暂缓观察';
    case 'reject':
      return '拒绝关闭';
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function reviewActionClass(action: ReviewAction): string {
  return action === 'reject' ? 'danger' : action;
}
const STRATEGY_LABELS: Record<StrategyType, string> = {
  main_attack: '主攻机会',
  low_cost_probe: '低成本试探',
  cautious_watch: '谨慎观察',
  cut_loss: '止损放弃',
};

const NEXT_ACTION_LABELS: Record<NextActionType, string> = {
  send_greeting: '发送打招呼',
  wait: '先等待',
  follow_up_once: '跟进一次',
  follow_up_with_new_angle: '换角度跟进',
  continue_conversation: '继续沟通',
  pause_watch: '暂停观察',
  close_opportunity: '关闭机会',
  prepare_interview: '准备面试',
  manual_review: '先人工确认',
};

const SCENARIO_LABELS: Record<MessageScenario, string> = {
  first_greeting: '首次打招呼',
  high_salary_low_match_probe: '高薪低匹配试探',
  second_followup: '二次跟进',
  final_unread_followup: '最终未读跟进',
  premium_but_cold_closing: '优质但冷淡收口',
  hr_reply_bridge: 'HR 回复承接',
};

const normalizedFollowupCount = computed(() => {
  const count = Number(followupCount.value);
  if (!Number.isFinite(count)) {
    return 0;
  }
  return Math.max(0, Math.floor(count));
});

const followupTimingDisabled = computed(() => communicationStatus.value === 'not_contacted');

function setLastGreetedAtNow(): void {
  if (followupTimingDisabled.value) {
    return;
  }
  lastGreetedAtValue.value = Date.now();
}

function clearLastGreetedAt(): void {
  if (followupTimingDisabled.value) {
    return;
  }
  lastGreetedAtValue.value = null;
}

function setLastFollowupAtNow(): void {
  if (followupTimingDisabled.value) {
    return;
  }
  lastFollowupAtValue.value = Date.now();
}

function clearLastFollowupAt(): void {
  if (followupTimingDisabled.value) {
    return;
  }
  lastFollowupAtValue.value = null;
}

const decisionReport = computed<JobReport | null>(() => {
  const reportAdvice = report.value?.applyAdvice ?? '';
  const analysisAdvice = opportunityAnalysis.value?.applyAdvice ?? '';
  const applyAdvice = reportAdvice !== '' ? reportAdvice : analysisAdvice;
  if (report.value === null && applyAdvice === '') {
    return null;
  }

  return {
    ...(report.value ?? emptyReport()),
    applyAdvice,
  };
});

const decisionRecord = computed<JobRecord | null>(() => {
  if (currentJob.value === null) {
    return null;
  }

  return {
    ...currentJob.value,
    report: decisionReport.value,
    companyInput: { ...companyForm },
    companyAssessment: companyAssessment.value,
    opportunityAnalysis: opportunityAnalysis.value,
    communicationStatus: communicationStatus.value,
    followupCount: normalizedFollowupCount.value,
    lastCommunicationNote:
      lastCommunicationNote.value.trim() === '' ? undefined : lastCommunicationNote.value,
    highValueSignal: highValueSignal.value,
    draftMessageText: draftMessageText.value.trim() === '' ? undefined : draftMessageText.value,
    lastGreetedAt: lastGreetedAtValue.value ?? undefined,
    lastFollowupAt: lastFollowupAtValue.value ?? undefined,
  };
});
const followupDecision = computed(() =>
  decisionRecord.value === null ? null : deriveDecision(decisionRecord.value, allJobs.value),
);
const highValueSignalNote = computed(() => {
  const advice = decisionReport.value?.applyAdvice ?? '';
  return highValueSignal.value && (advice === 'strongly' || advice === 'ok');
});
const nextActionLabel = computed(() =>
  followupDecision.value?.nextAction === null
    ? '已结束，无下一步'
    : followupDecision.value
      ? NEXT_ACTION_LABELS[followupDecision.value.nextAction]
      : '',
);
const recommendedMessageText = computed(() =>
  decisionRecord.value === null ||
  followupDecision.value === null ||
  followupDecision.value.nextAction === 'manual_review'
    ? ''
    : buildMessageTemplate(followupDecision.value.scenario, decisionRecord.value),
);

watch(recommendedMessageText, () => {
  recommendedMessageCopyState.value = 'idle';
  recommendedMessageFillState.value = 'idle';
});

watch(
  [
    followupCount,
    lastCommunicationNote,
    highValueSignal,
    draftMessageText,
    lastGreetedAtValue,
    lastFollowupAtValue,
  ],
  () => {
    followupSaveState.value = 'idle';
    followupSaveError.value = '';
  },
);

async function copyRecommendedMessage(): Promise<void> {
  const ok = await copyText(recommendedMessageText.value);
  recommendedMessageCopyState.value = ok ? 'done' : 'fail';
}

function fillDraftMessage(): void {
  draftMessageText.value = recommendedMessageText.value;
  recommendedMessageFillState.value = 'done';
  recommendedMessageCopyState.value = 'idle';
}

function syncFollowupFacts(job: JobRecord): void {
  communicationStatus.value = job.communicationStatus;
  followupCount.value = job.followupCount;
  lastCommunicationNote.value = job.lastCommunicationNote ?? '';
  highValueSignal.value = job.highValueSignal ?? false;
  draftMessageText.value = job.draftMessageText ?? '';
  lastGreetedAtValue.value = job.lastGreetedAt ?? null;
  lastFollowupAtValue.value = job.lastFollowupAt ?? null;
}

async function rememberJob(job: JobRecord): Promise<void> {
  currentJob.value = job;
  if (pageScope !== null) {
    pageScope.acceptUpdatedJob(job);
    allJobs.value = [...(pageScope.$source.bundle?.allJobs ?? [])];
    return;
  }
  allJobs.value = await jobsApi.list();
}

async function handleReviewAction(action: ReviewAction): Promise<void> {
  if (props.jobId === null || currentJob.value === null) {
    return;
  }
  reviewSaveState.value = 'idle';
  reviewSaveError.value = '';
  try {
    const next = applyReviewAction(currentJob.value, action, new Date().toISOString());
    const reviewPatch = {
      reviewStatus: next.reviewStatus,
      communicationStatus: next.communicationStatus,
    };
    const updated = pageScope
      ? await pageScope.submitImportReview(reviewPatch)
      : await jobsApi.patch(props.jobId, reviewPatch);
    await rememberJob(updated);
    syncFollowupFacts(updated);
    reviewSaveState.value = 'done';
  } catch (error) {
    reviewSaveState.value = 'fail';
    reviewSaveError.value = `保存人工确认失败：${(error as Error).message}`;
  }
}

async function changeCommunicationStatus(next: CommunicationStatus): Promise<void> {
  if (props.jobId === null) {
    return;
  }
  const previous = communicationStatus.value;
  communicationStatus.value = next;
  statusSaveState.value = 'idle';
  statusSaveError.value = '';
  try {
    const updated = pageScope
      ? await pageScope.updateCommunication({ communicationStatus: next })
      : await jobsApi.patch(props.jobId, { communicationStatus: next });
    await rememberJob(updated);
    statusSaveState.value = 'done';
  } catch (error) {
    // 持久化失败则回滚选择，并提示。
    communicationStatus.value = previous;
    statusSaveState.value = 'fail';
    statusSaveError.value = `更新状态失败：${(error as Error).message}`;
  }
}

async function saveFollowupFacts(): Promise<void> {
  if (props.jobId === null) {
    return;
  }
  followupSaveState.value = 'idle';
  followupSaveError.value = '';
  try {
    const communicationPatch = {
      communicationStatus: communicationStatus.value,
      followupCount: normalizedFollowupCount.value,
      lastCommunicationNote:
        lastCommunicationNote.value.trim() === '' ? undefined : lastCommunicationNote.value,
      highValueSignal: highValueSignal.value,
      draftMessageText: draftMessageText.value.trim() === '' ? undefined : draftMessageText.value,
      lastGreetedAt: lastGreetedAtValue.value ?? undefined,
      lastFollowupAt: lastFollowupAtValue.value ?? undefined,
    };
    const updated = pageScope
      ? await pageScope.updateCommunication(communicationPatch)
      : await jobsApi.patch(props.jobId, communicationPatch);
    await rememberJob(updated);
    syncFollowupFacts(updated);
    followupSaveState.value = 'done';
  } catch (error) {
    followupSaveState.value = 'fail';
    followupSaveError.value = `保存跟进事实失败：${(error as Error).message}`;
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

async function saveMatchScore(): Promise<void> {
  if (props.jobId === null) {
    return;
  }
  matchSaveState.value = 'idle';
  matchSaveError.value = '';
  try {
    const normalized = normalizeMatchScore(matchScore.value);
    const updated = pageScope
      ? await pageScope.saveMatchScore(normalized)
      : await jobsApi.patch(props.jobId, { matchScore: normalized });
    await rememberJob(updated);
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

function hydrateJob(job: JobRecord): void {
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
    syncFollowupFacts(job);
    baselineFingerprint.value = editableFingerprint();
}

onMounted(async () => {
  if (pageScope?.$source.bundle) {
    const bundle = pageScope.$source.bundle;
    profile.value = bundle.profile;
    currentJob.value = bundle.job;
    allJobs.value = [...bundle.allJobs];
    hydrateJob(bundle.job);
    return;
  }

  try {
    profile.value = await profileApi.get();
  } catch {
    // 配置读取失败不阻断主战场；Prompt 中对应字段以「（未填写）」兜底。
    profile.value = null;
  }

  if (props.jobId === null) return;
  try {
    const job = await jobsApi.get(props.jobId);
    hydrateJob(job);
    await rememberJob(job);
  } catch (error) {
    loadError.value = (error as Error).message;
  }
});

async function handleSave(): Promise<void> {
  if (!canSave.value || saveInFlight.value) {
    return;
  }
  saveInFlight.value = true;
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
    if (props.jobId === null) {
      await jobsApi.create({ ...payload, companyInput });
    } else {
      if (pageScope) {
        pageScope.jobDraft = { ...payload, companyInput };
        const updated = await pageScope.saveJobDraft();
        if (updated) await rememberJob(updated);
      } else {
        const updated = await jobsApi.patch(props.jobId, { ...payload, companyInput });
        await rememberJob(updated);
      }
    }
    baselineFingerprint.value = editableFingerprint();
    emit('saved');
  } catch (error) {
    loadError.value = `保存岗位失败：${(error as Error).message}`;
  } finally {
    saveInFlight.value = false;
  }
}

function confirmLeave(): boolean {
  if (!isDirty.value && !saveInFlight.value) return true;
  return navigationConfirm.confirmDiscardChanges(
    saveInFlight.value ? '岗位正在保存，确定仍要离开吗？' : '存在未保存的岗位编辑，确定要离开吗？',
  );
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!isDirty.value && !saveInFlight.value) return;
  event.preventDefault();
  event.returnValue = '';
}

window.addEventListener('beforeunload', handleBeforeUnload);
onBeforeRouteLeave(() => confirmLeave());

async function saveAiResult(): Promise<void> {
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

    const updated = pageScope
      ? await pageScope.confirmAnalysis(patch)
      : await jobsApi.patch(props.jobId, patch);
    await rememberJob(updated);

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

async function analyzeWithLlm(): Promise<void> {
  if (props.jobId === null) {
    return;
  }

  streamController?.abort();
  const controller = new AbortController();
  streamController = controller;
  const runId = ++streamRunId;
  const requestedJobId = props.jobId;
  llmAnalyzing.value = true;
  llmError.value = '';
  llmResult.value = null;
  aiRawResult.value = '';

  try {
    const stream = llmApi.analyzeJobStream({ jobId: requestedJobId }, { signal: controller.signal });
    let result = await stream.next();

    while (!result.done) {
      const event = result.value;
      if (
        event &&
        event.type === 'chunk' &&
        event.content &&
        !controller.signal.aborted &&
        ownerMounted &&
        requestedJobId === props.jobId &&
        runId === streamRunId
      ) {
        aiRawResult.value += event.content;
      }
      result = await stream.next();
    }

    if (
      controller.signal.aborted ||
      !ownerMounted ||
      requestedJobId !== props.jobId ||
      runId !== streamRunId
    ) {
      return;
    }
    llmResult.value = result.value;

    if (llmResult.value?.error) {
      llmError.value = llmResult.value.error;
    } else if (aiRawResult.value === '') {
      aiRawResult.value = llmResult.value?.rawText ?? '';
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError' && ownerMounted && runId === streamRunId) {
      llmError.value = `AI 分析请求失败：${(error as Error).message}`;
    }
  } finally {
    if (runId === streamRunId) {
      llmAnalyzing.value = false;
      if (streamController === controller) streamController = null;
    }
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

    <ImportReviewSection v-if="showReviewPanel" :scope-required="isEdit" class="review-panel" :data-review-status="currentJob?.reviewStatus ?? 'none'">
      <div class="review-head">
        <div>
          <h2>人工确认</h2>
          <p class="review-sub">外部导入草稿需人工确认，确认后才进入正式机会流转。</p>
        </div>
        <span class="review-pill">{{ reviewStatusLabel }}</span>
      </div>

      <template v-if="pendingReview">
        <div v-if="reviewSourceRows.length > 0" class="review-source-grid">
          <div v-for="row in reviewSourceRows" :key="row.label" class="review-source-item">
            <span>{{ row.label }}</span>
            <strong>{{ row.value }}</strong>
          </div>
        </div>
        <p v-if="reviewReason" class="review-reason">{{ reviewReason }}</p>
        <div class="review-source-flags">
          <span v-if="currentJob?.importedDraft">已保留导入草稿</span>
          <span v-if="hasReviewAiRawResult">已保留 AI 原文</span>
          <span>解析状态：{{ reviewParseStatusText }}</span>
        </div>
        <ul v-if="reviewWarnings.length > 0" class="review-warnings">
          <li v-for="warning in reviewWarnings.slice(0, 3)" :key="warning">{{ warning }}</li>
        </ul>
        <div class="review-actions" role="group" aria-label="人工确认动作">
          <button
            v-for="action in availableReviewActions"
            :key="action"
            type="button"
            class="review-action-btn"
            :class="reviewActionClass(action)"
            @click="handleReviewAction(action)"
          >
            {{ reviewActionLabel(action) }}
          </button>
        </div>
      </template>

      <p v-else class="review-notice">
        {{ reviewNotice || '导入来源已保留，当前未处于待确认状态。' }}
      </p>

      <p class="review-feedback">
        <span v-if="reviewSaveState === 'done'" class="save-feedback ok" role="status">
          已保存 ✓
        </span>
        <span v-else-if="reviewSaveState === 'fail'" class="save-feedback fail" role="alert">
          {{ reviewSaveError }}
        </span>
      </p>
    </ImportReviewSection>

    <CommunicationSection v-if="isEdit" :scope-required="isEdit" class="followup-panel">
      <div class="followup-head">
        <div>
          <h2>跟进决策</h2>
          <p class="followup-sub">基于当前岗位事实实时派生，仅保存下方手动维护的事实字段。</p>
        </div>
        <span class="status-pill">{{ currentStatusLabel }}</span>
      </div>

      <div v-if="followupDecision" class="decision-grid">
        <div class="decision-card">
          <span class="decision-label">策略</span>
          <strong>{{ STRATEGY_LABELS[followupDecision.strategy] }}</strong>
        </div>
        <div class="decision-card">
          <span class="decision-label">下一步</span>
          <strong>{{ nextActionLabel }}</strong>
        </div>
        <div class="decision-card">
          <span class="decision-label">话术场景</span>
          <strong>{{ SCENARIO_LABELS[followupDecision.scenario] }}</strong>
        </div>
        <div class="decision-card" :class="{ warn: followupDecision.stopLoss }">
          <span class="decision-label">止损</span>
          <strong>{{ followupDecision.stopLoss ? '建议止损' : '继续观察' }}</strong>
        </div>
      </div>

      <p v-if="followupDecision?.stopLoss" class="stoploss-note">
        建议止损：本轮不再继续消耗精力
      </p>
      <p v-if="followupDecision?.companyWarning" class="company-warning">
        {{ followupDecision.companyWarning }}
      </p>
      <p v-if="highValueSignalNote" class="followup-note">
        当前岗位已是高匹配，高价值信号不会覆盖主攻策略。
      </p>

      <div class="followup-facts">
        <div class="status-options" role="group" aria-label="沟通状态">
          <button
            v-for="opt in COMMUNICATION_STATUS_OPTIONS"
            :key="opt.value"
            type="button"
            class="status-chip"
            :class="{ active: communicationStatus === opt.value }"
            @click="changeCommunicationStatus(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <p class="status-meta">
          <span v-if="statusSaveState === 'fail'" class="status-fail" role="alert">
            {{ statusSaveError }}
          </span>
          <span v-else class="status-saved">
            当前：{{ currentStatusLabel }}
          </span>
        </p>

        <div class="followup-facts-grid">
          <label class="fact-field" :class="{ disabled: followupTimingDisabled }">
            <span class="field-label">跟进次数</span>
            <input
              v-model.number="followupCount"
              type="number"
              min="0"
              step="1"
              :disabled="followupTimingDisabled"
            />
          </label>
          <label class="fact-toggle-card" :class="{ active: highValueSignal }">
            <input v-model="highValueSignal" type="checkbox" />
            <span>
              <strong>高价值信号</strong>
              <small>薪资 / 前景值得低成本试探</small>
            </span>
          </label>
        </div>
        <p v-if="followupTimingDisabled" class="followup-disabled-note">
          未沟通时无需维护跟进次数和最近沟通时间，打招呼后再记录。
        </p>

        <div class="followup-time-grid">
          <div class="time-fact-card" :class="{ disabled: followupTimingDisabled }">
            <div class="time-fact-summary">
              <span class="field-label">最近打招呼时间</span>
              <strong>
                {{
                  lastGreetedAtValue === null
                    ? '未记录'
                    : formatTime(lastGreetedAtValue)
                }}
              </strong>
            </div>
            <NDatePicker
              v-model:value="lastGreetedAtValue"
              class="time-picker"
              type="datetime"
              clearable
              :disabled="followupTimingDisabled"
              placeholder="选择最近打招呼时间"
            />
            <div class="time-actions">
              <button
                type="button"
                class="mini-btn"
                :disabled="followupTimingDisabled"
                @click="setLastGreetedAtNow"
              >
                设为现在
              </button>
              <button
                type="button"
                class="mini-btn ghost"
                :disabled="followupTimingDisabled"
                @click="clearLastGreetedAt"
              >
                清空
              </button>
            </div>
          </div>

          <div class="time-fact-card" :class="{ disabled: followupTimingDisabled }">
            <div class="time-fact-summary">
              <span class="field-label">最近跟进时间</span>
              <strong>
                {{
                  lastFollowupAtValue === null
                    ? '未记录'
                    : formatTime(lastFollowupAtValue)
                }}
              </strong>
            </div>
            <NDatePicker
              v-model:value="lastFollowupAtValue"
              class="time-picker"
              type="datetime"
              clearable
              :disabled="followupTimingDisabled"
              placeholder="选择最近跟进时间"
            />
            <div class="time-actions">
              <button
                type="button"
                class="mini-btn"
                :disabled="followupTimingDisabled"
                @click="setLastFollowupAtNow"
              >
                设为现在
              </button>
              <button
                type="button"
                class="mini-btn ghost"
                :disabled="followupTimingDisabled"
                @click="clearLastFollowupAt"
              >
                清空
              </button>
            </div>
          </div>
        </div>

        <div class="message-template-card">
          <div class="template-head">
            <div>
              <span class="field-label">推荐话术</span>
              <p class="template-hint">
                根据当前话术场景生成，可复制或填入下方草稿。
              </p>
            </div>
            <div class="template-actions">
              <button
                type="button"
                class="mini-btn"
                :disabled="recommendedMessageText === ''"
                @click="copyRecommendedMessage"
              >
                复制推荐话术
              </button>
              <button
                type="button"
                class="mini-btn ghost"
                :disabled="recommendedMessageText === ''"
                @click="fillDraftMessage"
              >
                填入草稿
              </button>
            </div>
          </div>
          <p class="template-preview">
            {{ recommendedMessageText }}
          </p>
          <p class="template-feedback">
            <span v-if="recommendedMessageCopyState === 'done'" class="copy-feedback ok">
              已复制 ✓
            </span>
            <span v-else-if="recommendedMessageCopyState === 'fail'" class="copy-feedback fail">
              复制失败，请手动选择文本复制
            </span>
            <span v-else-if="recommendedMessageFillState === 'done'" class="copy-feedback ok">
              已填入草稿，保存后才会落库
            </span>
          </p>
        </div>

        <div class="followup-form-grid">
          <label class="field wide">
            <span class="label">沟通备注</span>
            <textarea
              v-model="lastCommunicationNote"
              rows="3"
              placeholder="例如：HR 已读未回、薪资很高但匹配度一般、暂时观察。"
            ></textarea>
          </label>
          <label class="field wide">
            <span class="label">话术草稿</span>
            <textarea
              v-model="draftMessageText"
              rows="4"
              placeholder="保存你准备发给 Boss / HR 的手动草稿。"
            ></textarea>
          </label>
        </div>

        <div class="followup-actions">
          <button type="button" class="save-btn" @click="saveFollowupFacts">
            保存跟进事实
          </button>
          <span
            v-if="followupSaveState === 'done'"
            class="save-feedback ok"
            role="status"
          >
            已保存 ✓
          </span>
          <span
            v-else-if="followupSaveState === 'fail'"
            class="save-feedback fail"
            role="alert"
          >
            {{ followupSaveError }}
          </span>
        </div>
      </div>
    </CommunicationSection>

    <JobDecisionSection v-if="isEdit" :scope-required="isEdit" class="match-block">
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
    </JobDecisionSection>

    <JobBasicInfoSection :scope-required="isEdit" class="form" @submit="handleSave">
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

      <JdInputSection :scope-required="isEdit">
      <label class="field">
        <span class="label">岗位 JD</span>
        <textarea
          v-model="form.jdText"
          rows="8"
          placeholder="粘贴 Boss 岗位 JD 原文，或直接粘贴 JD 截图后手动转换文字"
          @paste="handleJdPaste"
        ></textarea>
      </label>

      <div v-if="hasJdImages" class="jd-image-panel">
        <div class="jd-image-head">
          <div>
            <strong>待转换 JD 截图</strong>
            <p>图片只保存在当前编辑会话，点击转换文字后才会 OCR，不会自动生成 Prompt 或分析。</p>
          </div>
          <button
            type="button"
            class="jd-convert-btn"
            :disabled="!canConvertJdImages"
            @click="convertPendingJdImages"
          >
            转换文字
          </button>
        </div>
        <p v-if="jdImagePasteNotice" class="jd-image-notice">{{ jdImagePasteNotice }}</p>
        <div class="jd-image-list">
          <article
            v-for="(image, index) in pendingJdImages"
            :key="image.id"
            class="jd-image-item"
            :data-status="image.status"
          >
            <img :src="image.previewUrl" :alt="`JD 截图 ${index + 1}`" />
            <div class="jd-image-meta">
              <strong>截图 {{ index + 1 }}</strong>
              <span>{{ formatFileSize(image.file.size) }}</span>
              <span class="jd-image-status">{{ jdImageStatusLabel(image.status) }}</span>
              <small v-if="image.error">{{ image.error }}</small>
            </div>
            <button type="button" class="jd-image-remove" @click="removePendingJdImage(image.id)">
              删除
            </button>
          </article>
        </div>
      </div>
      </JdInputSection>

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
    </JobBasicInfoSection>

    <section class="prompt-block" v-if="showPrompt">
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
        OfferFlow 已内置 LLM 分析能力，可在下方「AI 分析结果」区点击按钮自动分析。
        以下 Prompt 供手动复制到外部 AI 参考使用。
      </p>
      <textarea
        class="prompt-text"
        :value="generatedPrompt"
        readonly
        rows="16"
      ></textarea>
    </section>

    <section class="ai-result-block">
      <h2>AI 分析结果</h2>
      <p class="ai-result-hint">
        点击下方「AI 分析 JD」由 OfferFlow 自动调用 LLM 分析，也可手动粘贴 ChatGPT / Claude / Gemini 等外部 AI 返回结果作为备用。AI 结果不会自动写入机会雷达，请检查后点击「确认并保存分析结果」。
      </p>

      <div v-if="isEdit" class="llm-action-bar">
        <button
          type="button"
          class="llm-btn"
          :disabled="llmAnalyzing"
          @click="analyzeWithLlm"
        >
          {{ llmAnalyzing ? 'AI 分析中...' : (llmResult && !llmResult.error ? '重新分析 JD' : 'AI 分析 JD') }}
        </button>
        <span v-if="llmAnalyzing" class="llm-loading">正在调用 LLM 分析岗位 JD，请稍候...</span>
        <span v-else-if="llmError" class="llm-error" role="alert">{{ llmError }}</span>
        <span v-else-if="llmResult && !llmResult.error" class="llm-done" role="status">
          AI 分析完成（模型：{{ llmResult.model }}），请检查结果后点击「确认并保存分析结果」。
        </span>
      </div>

      <div v-if="llmResult && llmResult.parsed" class="llm-preview">
        <div class="llm-preview-head">
          <span>AI 分析预览</span>
          <span class="llm-preview-status" :class="llmResult.parseStatus">
            {{ llmResult.parseStatus === 'success' ? '解析成功' : llmResult.parseStatus === 'partial' ? '部分解析' : llmResult.parseStatus === 'not_found' ? '未找到 JSON' : llmResult.parseStatus === 'invalid_json' ? 'JSON 非法' : '解析异常' }}
          </span>
        </div>
        <div class="llm-preview-grid">
          <div class="llm-preview-item">
            <span class="llm-preview-label">综合匹配度</span>
            <strong>{{ llmResult.parsed.matchScore || '—' }}</strong>
          </div>
          <div class="llm-preview-item">
            <span class="llm-preview-label">公司画像</span>
            <strong>{{ llmResult.parsed.companyAssessment ? '✓ 已解析' : '✗ 缺失' }}</strong>
          </div>
          <div class="llm-preview-item">
            <span class="llm-preview-label">机会分析</span>
            <strong>{{ llmResult.parsed.opportunityAnalysis ? '✓ 已解析' : '✗ 缺失' }}</strong>
          </div>
        </div>
        <ul v-if="llmResult.parsed.warnings.length > 0" class="llm-preview-warnings">
          <li v-for="(w, i) in llmResult.parsed.warnings.slice(0, 3)" :key="i">{{ w }}</li>
          <li v-if="llmResult.parsed.warnings.length > 3" class="more">
            …等共 {{ llmResult.parsed.warnings.length }} 条提示
          </li>
        </ul>
      </div>

      <textarea
        v-model="aiRawResult"
        class="ai-result-text"
        rows="16"
        :disabled="jobId === null"
        placeholder="点击 AI 分析 JD 后会自动填入分析原文，也可以手动粘贴外部 AI 返回内容"
      ></textarea>
      <div class="ai-result-actions">
        <button
          type="button"
          class="save-btn"
          :disabled="!canSaveAiResult"
          @click="saveAiResult"
        >
          确认并保存分析结果
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
        还没有机会雷达。AI 分析完成后点击「确认并保存分析结果」，这里会亮起来。
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
        下方直接展示 AI 返回的报告原文（无论来自内置 LLM 分析还是手动粘贴），可阅读与复制；结构化字段的解析结果见上方「AI 分析结果」区。
      </p>
      <textarea
        v-if="hasReportContent"
        class="report-text"
        :value="aiRawResult"
        readonly
        rows="14"
      ></textarea>
      <p v-else class="report-empty">
        暂无报告原文。请先在上方「AI 分析结果」中粘贴并保存 AI 返回内容。
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
  width: 100%;
  box-sizing: border-box;
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
.status-block,
.review-panel,
.followup-panel {
  margin-bottom: 20px;
  padding: 20px;
  border: 1px solid var(--of-line);
  border-radius: var(--of-radius);
  background: var(--of-card);
  box-shadow: var(--of-shadow);
}
.status-block h2,
.review-panel h2,
.followup-panel h2 {
  margin: 0 0 10px;
  font-size: 15px;
}
.followup-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.followup-sub {
  margin: -4px 0 0;
  font-size: 12px;
  color: #647084;
}
.review-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.review-sub {
  margin: -4px 0 0;
  font-size: 12px;
  color: #647084;
}
.review-pill {
  flex: 0 0 auto;
  padding: 5px 12px;
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
  font-size: 12px;
  font-weight: 600;
}
.review-source-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.review-source-item {
  min-height: 58px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid #e5eaf2;
  border-radius: 10px;
  background: #f8fafc;
}
.review-source-item span {
  font-size: 12px;
  color: #647084;
}
.review-source-item strong {
  font-size: 13px;
  color: #1f2933;
  line-height: 1.4;
}
.review-reason,
.review-notice {
  margin: 10px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f8fafc;
  color: #475569;
  font-size: 13px;
  line-height: 1.6;
}
.review-source-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.review-source-flags span {
  padding: 4px 10px;
  border-radius: 999px;
  background: #eef1f5;
  color: #475569;
  font-size: 12px;
}
.review-warnings {
  margin: 10px 0 0;
  padding-left: 18px;
  color: #92400e;
  font-size: 12px;
  line-height: 1.6;
}
.review-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}
.review-action-btn {
  padding: 8px 14px;
  border: 1px solid #cbd2d9;
  border-radius: 8px;
  background: #fff;
  color: #1f2933;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.review-action-btn:hover {
  background: #f2f6ff;
}
.review-action-btn.confirm {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}
.review-action-btn.confirm:hover {
  background: #1d4ed8;
}
.review-action-btn.defer {
  border-color: #f59e0b;
  background: #fffbeb;
  color: #92400e;
}
.review-action-btn.danger {
  border-color: #fecaca;
  background: #fee2e2;
  color: #991b1b;
}
.review-feedback {
  min-height: 18px;
  margin: 10px 0 0;
}
.status-pill {
  flex: 0 0 auto;
  padding: 5px 12px;
  border-radius: 999px;
  background: #eef2f8;
  color: #1f2933;
  font-size: 12px;
}
.decision-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.decision-card {
  min-height: 68px;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid #e5eaf2;
  border-radius: 10px;
  background: #f8fafc;
}
.decision-card.warn {
  border-color: #fde68a;
  background: #fffbeb;
}
.decision-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: #647084;
}
.decision-card strong {
  font-size: 14px;
  color: #1f2933;
}
.stoploss-note,
.company-warning,
.followup-note {
  margin: 10px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
}
.stoploss-note {
  background: #fffbeb;
  color: #92400e;
}
.company-warning {
  background: #eef6ff;
  color: #1e40af;
}
.followup-note {
  background: #f8fafc;
  color: #647084;
}
.followup-facts {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--of-line);
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
.followup-facts-grid {
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(240px, 1fr);
  gap: 16px;
  align-items: stretch;
  margin-top: 12px;
}
.fact-field,
.fact-toggle-card {
  min-height: 72px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  border: 1px solid #e5eaf2;
  border-radius: 12px;
  background: #fff;
}
.fact-field {
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
}
.fact-field.disabled,
.time-fact-card.disabled {
  border-style: dashed;
  background: #f8fafc;
}
.fact-field.disabled .field-label,
.time-fact-card.disabled .field-label,
.time-fact-card.disabled strong {
  color: #94a3b8;
}
.field-label {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 600;
  color: #1f2933;
}
.fact-field input {
  width: 92px;
  text-align: center;
}
.fact-field input:disabled {
  color: #94a3b8;
  background: #f1f5f9;
  cursor: not-allowed;
}
.fact-toggle-card {
  gap: 10px;
  padding: 12px 14px;
  cursor: pointer;
}
.fact-toggle-card.active {
  border-color: #93c5fd;
  background: #eff6ff;
}
.fact-toggle-card input {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}
.fact-toggle-card span {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.fact-toggle-card strong {
  font-size: 13px;
  color: #1f2933;
}
.fact-toggle-card small {
  font-size: 12px;
  color: #647084;
}
.followup-disabled-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: #94a3b8;
}
.followup-time-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(240px, 1fr));
  gap: 16px;
  margin-top: 14px;
}
.time-fact-card {
  min-height: 96px;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(138px, 0.75fr) minmax(220px, 1fr) max-content;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  border: 1px solid #e5eaf2;
  border-radius: 12px;
  background: #fff;
}
.time-fact-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.time-fact-summary strong {
  font-size: 13px;
  color: #647084;
}
.time-picker {
  width: 100%;
  min-width: 0;
}
.time-actions {
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  justify-content: flex-end;
}
.mini-btn {
  border: 1px solid #d8e0ec;
  border-radius: 999px;
  background: #f8fafc;
  padding: 6px 10px;
  font-size: 12px;
  color: #1f2933;
  cursor: pointer;
}
.mini-btn:hover {
  border-color: #93c5fd;
  background: #eff6ff;
}
.mini-btn:disabled {
  border-color: #e2e8f0;
  background: #f8fafc;
  color: #a8b3c1;
  cursor: not-allowed;
}
.mini-btn:disabled:hover {
  border-color: #e2e8f0;
  background: #f8fafc;
}
.mini-btn.ghost {
  background: #fff;
  color: #647084;
}
.mini-btn.ghost:disabled {
  background: #f8fafc;
  color: #a8b3c1;
}
.message-template-card {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid #e5eaf2;
  border-radius: 12px;
  background: #f8fafc;
}
.template-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.template-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #647084;
}
.template-actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.template-preview {
  margin: 12px 0 0;
  padding: 12px;
  border: 1px solid #d8e0ec;
  border-radius: 10px;
  background: #fff;
  color: #1f2933;
  font-size: 13px;
  line-height: 1.7;
}
.template-feedback {
  min-height: 18px;
  margin: 8px 0 0;
}
.followup-form-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
  margin-top: 14px;
}
.followup-form-grid .wide {
  grid-column: 1 / -1;
}
.followup-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
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
input[type='number'],
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
input[type='number']:focus,
textarea:focus {
  outline: none;
  border-color: var(--of-brand);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
textarea {
  resize: vertical;
}
.jd-image-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid #dbe5f4;
  border-radius: var(--of-radius);
  background: #f8fbff;
}
.jd-image-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.jd-image-head strong {
  display: block;
  margin-bottom: 3px;
  font-size: 14px;
}
.jd-image-head p,
.jd-image-notice {
  margin: 0;
  color: #647084;
  font-size: 12px;
  line-height: 1.6;
}
.jd-convert-btn,
.jd-image-remove {
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  background: #fff;
  color: #2563eb;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.jd-convert-btn {
  flex: none;
  padding: 8px 12px;
  font-weight: 600;
}
.jd-convert-btn:disabled {
  color: #94a3b8;
  border-color: #dbe3ef;
  cursor: not-allowed;
}
.jd-image-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.jd-image-item {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}
.jd-image-item img {
  width: 72px;
  height: 54px;
  object-fit: cover;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}
.jd-image-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: #647084;
  font-size: 12px;
}
.jd-image-meta strong {
  color: #1f2933;
  font-size: 13px;
}
.jd-image-meta small {
  color: #b42318;
  overflow-wrap: anywhere;
}
.jd-image-status {
  width: fit-content;
  padding: 1px 7px;
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
}
.jd-image-item[data-status='processing'] .jd-image-status {
  background: #fff7ed;
  color: #9a3412;
}
.jd-image-item[data-status='done'] .jd-image-status {
  background: #ecfdf3;
  color: #027a48;
}
.jd-image-item[data-status='failed'] .jd-image-status {
  background: #fef3f2;
  color: #b42318;
}
.jd-image-remove {
  padding: 6px 9px;
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
.llm-action-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.llm-btn {
  padding: 8px 16px;
  border: 1px solid #4f6ef7;
  border-radius: 8px;
  background: #4f6ef7;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.llm-btn:hover:not(:disabled) {
  background: #3b5de7;
}
.llm-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.llm-loading {
  font-size: 13px;
  color: #4f6ef7;
}
.llm-error {
  font-size: 13px;
  color: #a4262c;
}
.llm-done {
  font-size: 13px;
  color: #1a7f37;
}
.llm-preview {
  margin-bottom: 12px;
  padding: 14px;
  border: 1px solid #d6e4ff;
  border-radius: 10px;
  background: #f5f9ff;
}
.llm-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
  color: #1f2933;
}
.llm-preview-status {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
}
.llm-preview-status.success {
  background: #dcfce7;
  color: #166534;
}
.llm-preview-status.partial {
  background: #fef9c3;
  color: #854d0e;
}
.llm-preview-status.not_found,
.llm-preview-status.invalid_json,
.llm-preview-status.error {
  background: #fdecec;
  color: #991b1b;
}
.llm-preview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}
.llm-preview-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid #e5eaf2;
}
.llm-preview-label {
  font-size: 11px;
  color: #647084;
}
.llm-preview-item strong {
  font-size: 13px;
  color: #1f2933;
}
.llm-preview-warnings {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #92400e;
  line-height: 1.6;
}
.llm-preview-warnings .more {
  color: #647084;
  font-style: italic;
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
  .followup-head {
    flex-direction: column;
  }
  .decision-grid,
  .review-source-grid,
  .followup-facts-grid,
  .followup-time-grid,
  .followup-form-grid {
    grid-template-columns: 1fr;
  }
  .time-fact-card {
    grid-template-columns: 1fr;
  }
  .time-actions {
    justify-content: flex-start;
  }
  .template-head {
    flex-direction: column;
  }
  .template-actions {
    justify-content: flex-start;
  }
}
</style>
