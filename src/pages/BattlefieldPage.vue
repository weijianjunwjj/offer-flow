<script setup lang="ts">
// Task 3：岗位主战场基础信息 + 保存。
// 仅负责岗位基础信息（公司 / 岗位 / 城市 / 薪资 / JD）的录入与保存，打通创建/更新闭环。
// 不做 Prompt、不做 AI 结果、不做报告、不做话术（留待后续 Task）。
import { computed, onMounted, reactive, ref } from 'vue';
import { useStores } from '../app/stores';

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

onMounted(() => {
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
@media (max-width: 560px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
