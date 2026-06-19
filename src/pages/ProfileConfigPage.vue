<script setup lang="ts">
// Task 1：简历 / 偏好配置页。
// 仅负责全局配置（JobSeekerProfile）的录入、保存与刷新回显。
// 不做岗位主战场、不做 Prompt、不做 AI 结果、不做报告。
import { onMounted, reactive, ref } from 'vue';
import type { JobSeekerProfile, JobSearchFocus } from '../storage';
import { useStores } from '../app/stores';

function emptyProfile(): JobSeekerProfile {
  return {
    resumeText: '',
    projectExperience: '',
    targetCity: '',
    targetRole: '',
    expectedSalary: '',
    acceptOutsourcing: false,
    acceptOvertime: false,
    jobSearchFocus: 'stability',
    weaknessNote: '',
  };
}

const focusOptions: ReadonlyArray<{ value: JobSearchFocus; label: string }> = [
  { value: 'stability', label: '求稳' },
  { value: 'raise', label: '涨薪' },
  { value: 'resume', label: '履历' },
  { value: 'growth', label: '技术成长' },
];

const form = reactive<JobSeekerProfile>(emptyProfile());
const loadError = ref('');
const savedAt = ref<number | null>(null);

onMounted(() => {
  try {
    const saved = useStores().config.getProfile();
    if (saved !== null) {
      // 用默认值兜底缺失字段，再覆盖已存字段，避免旧数据缺字段时报错。
      Object.assign(form, emptyProfile(), saved);
    }
  } catch (error) {
    loadError.value = (error as Error).message;
  }
});

function handleSave(): void {
  // 覆盖式保存：全局配置只存一份。
  useStores().config.saveProfile({ ...form });
  savedAt.value = Date.now();
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <main class="profile-page">
    <header class="page-head">
      <h1>简历 / 偏好配置</h1>
      <p class="hint">
        全局配置只保存一份，后续岗位分析会复用这里的信息，无需重复填写。
      </p>
    </header>

    <p v-if="loadError" class="banner banner-error" role="alert">
      读取已保存配置失败：{{ loadError }}
    </p>

    <form class="form" @submit.prevent="handleSave">
      <label class="field">
        <span class="label">简历正文</span>
        <textarea
          v-model="form.resumeText"
          rows="6"
          placeholder="粘贴你的简历正文"
        ></textarea>
      </label>

      <label class="field">
        <span class="label">项目经历</span>
        <textarea
          v-model="form.projectExperience"
          rows="5"
          placeholder="填写代表性项目经历"
        ></textarea>
      </label>

      <div class="grid">
        <label class="field">
          <span class="label">目标城市</span>
          <input v-model="form.targetCity" type="text" placeholder="如：苏州" />
        </label>

        <label class="field">
          <span class="label">目标岗位方向</span>
          <input
            v-model="form.targetRole"
            type="text"
            placeholder="如：高级前端 / 前端架构"
          />
        </label>

        <label class="field">
          <span class="label">期望薪资</span>
          <input
            v-model="form.expectedSalary"
            type="text"
            placeholder="如：18-24K"
          />
        </label>

        <label class="field">
          <span class="label">当前求职重点</span>
          <select v-model="form.jobSearchFocus">
            <option
              v-for="opt in focusOptions"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </label>
      </div>

      <div class="checks">
        <label class="check">
          <input v-model="form.acceptOutsourcing" type="checkbox" />
          <span>接受外包</span>
        </label>
        <label class="check">
          <input v-model="form.acceptOvertime" type="checkbox" />
          <span>接受加班</span>
        </label>
      </div>

      <label class="field">
        <span class="label">个人短板说明</span>
        <textarea
          v-model="form.weaknessNote"
          rows="3"
          placeholder="如：学历 / 年限 / 离职原因等"
        ></textarea>
      </label>

      <div class="actions">
        <button type="submit" class="save-btn">保存配置</button>
        <span v-if="savedAt !== null" class="saved-feedback" role="status">
          已保存 ✓（{{ formatTime(savedAt) }}）
        </span>
      </div>
    </form>
  </main>
</template>

<style scoped>
.profile-page {
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 16px 64px;
  color: #1f2933;
}
.page-head h1 {
  margin: 0 0 4px;
  font-size: 22px;
}
.hint {
  margin: 0 0 16px;
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
  padding: 22px;
  border: 1px solid var(--of-line);
  border-radius: var(--of-radius);
  background: var(--of-card);
  box-shadow: var(--of-shadow);
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
textarea,
select {
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
textarea:focus,
select:focus {
  outline: none;
  border-color: var(--of-brand);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
textarea {
  resize: vertical;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.checks {
  display: flex;
  gap: 24px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 16px;
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
.save-btn:hover {
  background: #1d4ed8;
}
.saved-feedback {
  color: #1a7f37;
  font-size: 13px;
}
@media (max-width: 560px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
