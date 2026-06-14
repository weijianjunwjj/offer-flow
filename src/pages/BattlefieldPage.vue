<script setup lang="ts">
// Task 3 - Task 6：保存岗位、生成 Prompt、承接外部 AI 原文，并展示报告原文 + 编辑/复制 Boss 话术。
// 不接 AI API，不做复杂解析，不做完整评分系统 / 多版本话术 / 风险标签系统。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { JobSeekerProfile, JobReport, ParseStatus } from '../storage';
import { useStores } from '../app/stores';
import { buildAnalysisPrompt } from '../app/prompt';
import { copyText } from '../app/clipboard';

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
const loadError = ref('');

const isEdit = computed(() => props.jobId !== null);
const modeLabel = computed(() => (isEdit.value ? '查看 / 编辑岗位' : '新建岗位'));

// 至少填写一个字段才允许保存，避免创建完全空白的岗位记录。
const canSave = computed(() =>
  [form.company, form.role, form.city, form.salaryRange, form.jdText].some(
    (value) => value.trim() !== '',
  ),
);

const profile = ref<JobSeekerProfile | null>(null);
const generatedPrompt = computed(() => buildAnalysisPrompt(profile.value, form));
const copyState = ref<'idle' | 'done' | 'fail'>('idle');
const aiRawResult = ref('');
const aiPastedAt = ref<number | null>(null);
const parseStatus = ref<ParseStatus>('none');
const aiSaveState = ref<'idle' | 'done' | 'fail'>('idle');
const aiSaveError = ref('');
const canSaveAiResult = computed(
  () => props.jobId !== null && aiRawResult.value.trim() !== '',
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
    aiRawResult.value = job.aiRawResult;
    aiPastedAt.value = job.aiPastedAt;
    parseStatus.value = job.parseStatus;
    report.value = job.report;
    greeting.value = job.report?.greetingMessage ?? '';
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
    const stores = useStores();
    if (props.jobId === null) {
      stores.jobs.createJob(payload);
    } else {
      stores.jobs.updateJob(props.jobId, payload);
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
  try {
    const pastedAt = Date.now();
    useStores().jobs.updateJob(props.jobId, {
      aiRawResult: aiRawResult.value,
      aiPastedAt: pastedAt,
      parseStatus: 'unparsed',
    });
    aiPastedAt.value = pastedAt;
    parseStatus.value = 'unparsed';
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
        粘贴 ChatGPT、Claude、Gemini
        等外部 AI 返回的完整内容。本步骤只保存原文并标记为未解析，不会因格式不同而阻断保存。
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
      <p v-if="parseStatus !== 'none'" class="parse-status">
        解析状态：{{ parseStatus === 'parsed' ? '已解析' : '未解析（原文已保存）' }}
      </p>
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
  max-width: 760px;
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
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
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
  padding: 8px 10px;
  border: 1px solid #cbd2d9;
  border-radius: 8px;
  font: inherit;
  background: #fff;
}
textarea {
  resize: vertical;
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
.report-block {
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid #eceff3;
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
}
</style>
