<script setup lang="ts">
// 应用根组件 + 最小导航壳。
// Task 2 不引入 vue-router；如后续需要深链接或刷新保持视图，再按 DEC-012 复审。
import { ref } from 'vue';
import ProfileConfigPage from './pages/ProfileConfigPage.vue';
import JobListPage from './pages/JobListPage.vue';
import BattlefieldPage from './pages/BattlefieldPage.vue';

type Section = 'profile' | 'jobs';
type JobsView = 'list' | 'battlefield';

const section = ref<Section>('jobs');
const jobsView = ref<JobsView>('list');
const activeJobId = ref<string | null>(null);

function goProfile(): void {
  section.value = 'profile';
}

function goJobs(): void {
  section.value = 'jobs';
  jobsView.value = 'list';
}

function openBattlefield(jobId: string | null): void {
  activeJobId.value = jobId;
  jobsView.value = 'battlefield';
}

function backToList(): void {
  jobsView.value = 'list';
}
</script>

<template>
  <div class="app">
    <header class="app-nav">
      <div class="brand-area">
        <strong class="brand">OfferFlow · Offer来了</strong>
        <span class="tagline">
          Manual Mode（手动模式）· 本地求职手账 · 不接入 AI API，分析交给你选的外部 AI
        </span>
      </div>
      <nav class="nav-links">
        <button
          :class="{ active: section === 'profile' }"
          @click="goProfile"
        >
          简历配置
        </button>
        <button :class="{ active: section === 'jobs' }" @click="goJobs">
          岗位台账
        </button>
      </nav>
    </header>

    <ProfileConfigPage v-if="section === 'profile'" />

    <template v-else>
      <JobListPage
        v-if="jobsView === 'list'"
        @create="openBattlefield(null)"
        @open="openBattlefield"
      />
      <BattlefieldPage
        v-else
        :job-id="activeJobId"
        @back="backToList"
        @saved="backToList"
      />
    </template>
  </div>
</template>

<style scoped>
.app-nav {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 12px 20px;
  border-bottom: 1px solid #eceff3;
  background: #fff;
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand-area {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-right: auto;
}
.brand {
  font-size: 16px;
  color: #2563eb;
}
.tagline {
  font-size: 12px;
  color: #647084;
}
.nav-links {
  display: flex;
  gap: 8px;
}
.nav-links button {
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  font-size: 14px;
  cursor: pointer;
  color: #647084;
}
.nav-links button:hover {
  background: #f2f6ff;
}
.nav-links button.active {
  color: #2563eb;
  background: #eef3ff;
  font-weight: 600;
}
</style>
