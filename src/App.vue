<script setup lang="ts">
// 应用根组件 + 最小导航壳。
// Task 2 引入 Naive UI 基础壳：n-config-provider（默认浅色主题）+ n-message-provider，建立浅色高级科技感外壳。
// 视觉方向：浅色、干净、高级，类 Linear / Vercel / 飞书多维表格的清爽感，不做暗黑驾驶舱。
// 仍不引入 vue-router / 状态管理 / 图标库 / 图表库；导航沿用 App 级视图切换（DEC-012 / DEC-017）。
import { ref } from 'vue';
import type { GlobalThemeOverrides } from 'naive-ui';
import {
  NConfigProvider,
  NMessageProvider,
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NButton,
  NSpace,
} from 'naive-ui';
import ProfileConfigPage from './pages/ProfileConfigPage.vue';
import JobListPage from './pages/JobListPage.vue';
import BattlefieldPage from './pages/BattlefieldPage.vue';

type Section = 'profile' | 'jobs';
type JobsView = 'list' | 'battlefield';

const section = ref<Section>('jobs');
const jobsView = ref<JobsView>('list');
const activeJobId = ref<string | null>(null);

// 浅色高级科技感主题微调：蓝 / 青蓝主色，浅色底，深灰黑文字，圆角克制。
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#2563eb',
    primaryColorHover: '#3b82f6',
    primaryColorPressed: '#1d4ed8',
    primaryColorSuppl: '#2563eb',
    bodyColor: '#f6f8fc',
    cardColor: '#ffffff',
    textColorBase: '#1f2937',
    borderRadius: '10px',
  },
};

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

// content 内边距与最大宽度，集中管理便于后续统一调版。
const contentStyle = 'padding: 24px; max-width: 1080px; margin: 0 auto;';
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <n-message-provider>
      <n-layout class="app-shell" position="absolute">
        <n-layout-header class="app-nav" bordered>
          <div class="brand-area">
            <strong class="brand">OfferFlow · Offer来了</strong>
            <span class="tagline">
              One-Shot Opportunity Radar · Manual Mode（手动模式）· 不接入 AI API，分析交给你选的外部 AI
            </span>
          </div>
          <n-space :size="8">
            <n-button
              :type="section === 'profile' ? 'primary' : 'tertiary'"
              :ghost="section === 'profile'"
              size="small"
              @click="goProfile"
            >
              简历配置
            </n-button>
            <n-button
              :type="section === 'jobs' ? 'primary' : 'tertiary'"
              :ghost="section === 'jobs'"
              size="small"
              @click="goJobs"
            >
              岗位台账
            </n-button>
          </n-space>
        </n-layout-header>

        <n-layout-content class="app-content" :content-style="contentStyle">
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
        </n-layout-content>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
/* 浅色高级科技感全局底色：保证 n-layout 之外的可视区域同样为浅色。 */
:root {
  color-scheme: light;
}
html,
body,
#app {
  margin: 0;
  height: 100%;
  background: #f6f8fc;
  color: #1f2937;
}
</style>

<style scoped>
.app-shell {
  height: 100%;
  /* 浅色克制高光：低饱和蓝 / 青蓝，营造干净清爽的科技感（类 Linear / Vercel），不做荧光。 */
  background:
    radial-gradient(1200px 600px at 82% -12%, rgba(37, 99, 235, 0.06), transparent 60%),
    radial-gradient(900px 500px at -8% 8%, rgba(14, 165, 233, 0.05), transparent 55%),
    #f6f8fc;
}
.app-nav {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 14px 24px;
  position: sticky;
  top: 0;
  z-index: 10;
  backdrop-filter: blur(8px);
  background: rgba(255, 255, 255, 0.78);
}
.brand-area {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-right: auto;
}
.brand {
  font-size: 16px;
  letter-spacing: 0.3px;
  /* 保留渐变品牌字，但克制不荧光：蓝 → 青蓝。 */
  background: linear-gradient(90deg, #2563eb, #0ea5e9);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.tagline {
  font-size: 12px;
  color: #5b6573;
}
</style>
