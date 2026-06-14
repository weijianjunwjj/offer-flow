<script setup lang="ts">
// Task 3 + Task 4：岗位基础信息保存，以及基于全局配置和岗位信息生成 Prompt。
// 不接 AI API，不承接 AI 结果，不展示报告或话术（留待后续 Task）。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { JobSeekerProfile } from '../storage';
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

// Prompt 内容变化（编辑表单等）后，复制反馈失效，重置为初始态。
watch(generatedPrompt, () => {
  copyState.value = 'idle';
});

async function copyPrompt(): Promise<void> {
  const ok = await copyText(generatedPrompt.value);
  copyState.value = ok ? 'done' : 'fail';
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
        Gemini 等外部 AI，再把返回结果贴回工具（AI 结果承接在后续 Task 实现）。
      </p>
      <textarea
        class="prompt-text"
        :value="generatedPrompt"
        readonly
        rows="16"
      ></textarea>
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
.prompt-block {
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
@media (max-width: 560px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
