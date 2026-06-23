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

// content 内边距与最大宽度，最大宽度由全局设计令牌统一控制。
const contentStyle =
  'box-sizing: border-box; width: 100%; padding: 24px; max-width: var(--of-content-max-width); margin: 0 auto;';
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <n-message-provider>
      <n-layout class="app-shell" position="absolute">
        <n-layout-header class="app-nav" bordered>
          <div class="brand-area">
            <span class="brand-mark" aria-hidden="true" />
            <div class="brand-text">
              <div class="brand-line">
                <strong class="brand">OfferFlow · Offer来了</strong>
                <span class="brand-ver">v0.2.0</span>
              </div>
              <span class="tagline">
                One-Shot Opportunity Radar · 手动模式 · 不接入 AI API，分析交给你选的外部 AI
              </span>
            </div>
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
/* 浅色高级科技感设计令牌（全局，供各页面 scoped 样式复用）。 */
:root {
  color-scheme: light;
  --of-bg: #f6f8fc;
  --of-ink: #0f172a;
  --of-ink-2: #475569;
  --of-muted: #94a3b8;
  --of-line: rgba(15, 23, 42, 0.08);
  --of-brand: #2563eb;
  --of-brand-2: #0ea5e9;
  --of-card: #ffffff;
  --of-radius: 16px;
  --of-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 18px 40px -28px rgba(16, 24, 40, 0.22);
  --of-content-max-width: 1212px;
}
html,
body,
#app {
  margin: 0;
  height: 100%;
  background: var(--of-bg);
  color: var(--of-ink);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
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
  align-items: center;
  gap: 12px;
  margin-right: auto;
}
.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  flex: none;
  background: linear-gradient(135deg, var(--of-brand), var(--of-brand-2));
  box-shadow: 0 4px 12px -4px rgba(37, 99, 235, 0.5);
}
.brand-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.brand-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand {
  font-size: 16px;
  letter-spacing: 0.3px;
  /* 保留渐变品牌字，但克制不荧光：蓝 → 青蓝。 */
  background: linear-gradient(90deg, var(--of-brand), var(--of-brand-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.brand-ver {
  font-size: 11px;
  font-weight: 600;
  color: var(--of-brand);
  background: rgba(37, 99, 235, 0.1);
  padding: 1px 7px;
  border-radius: 999px;
}
.tagline {
  font-size: 12px;
  color: #5b6573;
}
</style>
