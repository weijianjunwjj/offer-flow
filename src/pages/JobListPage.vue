<script setup lang="ts">
// Task 2：岗位台账列表（空壳）。
// 仅负责：空状态、列表展示、新建入口、点击进入主战场。
// 不做筛选、不做统计、不做看板。岗位的录入与保存在 Task 3 实现。
import { onMounted, ref } from 'vue';
import type { JobRecord } from '../storage';
import { useStores } from '../app/stores';
import { CONTACT_STATUS_LABELS } from '../app/labels';

const emit = defineEmits<{
  create: [];
  open: [jobId: string];
}>();

const jobs = ref<JobRecord[]>([]);
const loadError = ref('');

function load(): void {
  try {
    jobs.value = useStores().jobs.listJobs();
  } catch (error) {
    loadError.value = (error as Error).message;
  }
}

onMounted(load);

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
      <p class="empty-sub">点击「新建岗位」开始第一条岗位分析。</p>
      <button class="new-btn" @click="emit('create')">+ 新建岗位</button>
    </section>

    <table v-else class="table">
      <thead>
        <tr>
          <th>公司</th>
          <th>岗位</th>
          <th>城市</th>
          <th>薪资</th>
          <th>匹配度</th>
          <th>沟通状态</th>
          <th>更新时间</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="job in jobs"
          :key="job.id"
          class="row"
          @click="emit('open', job.id)"
        >
          <td>{{ dash(job.company) }}</td>
          <td>{{ dash(job.role) }}</td>
          <td>{{ dash(job.city) }}</td>
          <td>{{ dash(job.salaryRange) }}</td>
          <td>{{ dash(job.matchScore) }}</td>
          <td>
            <span class="status">{{ CONTACT_STATUS_LABELS[job.contactStatus] }}</span>
          </td>
          <td>{{ formatTime(job.updatedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </main>
</template>

<style scoped>
.job-list {
  max-width: 920px;
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
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.table th,
.table td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid #eceff3;
}
.table th {
  color: #647084;
  font-size: 12px;
  font-weight: 600;
  background: #f7f9fc;
}
.row {
  cursor: pointer;
}
.row:hover {
  background: #f2f6ff;
}
.status {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: #eef1f5;
  font-size: 12px;
}
</style>
