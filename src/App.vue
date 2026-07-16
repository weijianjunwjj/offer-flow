<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import type { GlobalThemeOverrides } from 'naive-ui';
import {
  NConfigProvider,
  NMessageProvider,
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NButton,
  NSpace,
  NAlert,
} from 'naive-ui';
import { features } from './config/features';
const route = useRoute();
const router = useRouter();
const resumeVersionNavigationEnabled = computed(() => router.hasRoute('profile-versions'));
const historyImportNavigationEnabled = computed(() => router.hasRoute('history-import'));
const marketPositionNavigationEnabled = computed(() => router.hasRoute('market-position'));
const strategyWindowNavigationEnabled = computed(() => router.hasRoute('strategy-window'));
const g3SandboxBannerVisible = computed(() => features.g3SandboxEnabled);
const g4SandboxBannerVisible = computed(() => features.g4SandboxEnabled);
const g5SandboxBannerVisible = computed(() => features.g5SandboxEnabled);
const activeSection = computed(() => {
  if (route.name === 'job-match-profile') return 'job-match-profile';
  if (route.name === 'capability-baseline') return 'capability-baseline';
  if (route.name === 'market-funnel') return 'market-funnel';
  if (route.name === 'history-import') return 'history-import';
  if (route.name === 'market-position') return 'market-position';
  if (route.name === 'strategy-window') return 'strategy-window';
  if (route.name === 'profile' || route.name === 'profile-versions') return 'profile';
  return 'jobs';
});

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
  void router.push({ name: 'profile' });
}

function goJobMatchProfile(): void {
  void router.push({ name: 'job-match-profile' });
}

function goCapabilityBaseline(): void {
  void router.push({ name: 'capability-baseline' });
}

function goMarketFunnel(): void {
  void router.push({ name: 'market-funnel' });
}

function goHistoryImport(): void {
  void router.push({ name: 'history-import' });
}

function goMarketPosition(): void {
  void router.push({ name: 'market-position' });
}

function goStrategyWindow(): void {
  void router.push({ name: 'strategy-window' });
}

function goJobs(): void {
  void router.push({ name: 'jobs' });
}

function goProfileVersions(): void {
  void router.push({ name: 'profile-versions' });
}

function routeViewKey(): string {
  if (route.name === 'job-detail') {
    return `job-detail:${String(route.params.jobId ?? '')}`;
  }
  return String(route.name ?? route.fullPath);
}

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
                <span class="brand-ver">v0.6.2</span>
              </div>
              <span class="tagline">
                Backend + SQLite · AI 只生成提案 · 人工确认，不做 Boss 自动化
              </span>
            </div>
          </div>
          <n-space :size="8">
            <n-button
              :type="activeSection === 'profile' ? 'primary' : 'tertiary'"
              :ghost="activeSection === 'profile'"
              size="small"
              @click="goProfile"
            >
              简历配置
            </n-button>
            <n-button
              v-if="resumeVersionNavigationEnabled"
              :type="route.name === 'profile-versions' ? 'primary' : 'tertiary'"
              :ghost="route.name === 'profile-versions'"
              size="small"
              @click="goProfileVersions"
            >
              简历版本
            </n-button>
            <n-button
              :type="activeSection === 'job-match-profile' ? 'primary' : 'tertiary'"
              :ghost="activeSection === 'job-match-profile'"
              size="small"
              @click="goJobMatchProfile"
            >
              岗位匹配画像
            </n-button>
            <n-button
              :type="activeSection === 'capability-baseline' ? 'primary' : 'tertiary'"
              :ghost="activeSection === 'capability-baseline'"
              size="small"
              data-testid="nav-capability-baseline"
              @click="goCapabilityBaseline"
            >
              能力基线
            </n-button>
            <n-button
              :type="activeSection === 'market-funnel' ? 'primary' : 'tertiary'"
              :ghost="activeSection === 'market-funnel'"
              size="small"
              data-testid="nav-market-funnel"
              @click="goMarketFunnel"
            >
              基础漏斗
            </n-button>
            <n-button
              v-if="historyImportNavigationEnabled"
              :type="activeSection === 'history-import' ? 'primary' : 'tertiary'"
              :ghost="activeSection === 'history-import'"
              size="small"
              data-testid="nav-history-import"
              @click="goHistoryImport"
            >
              历史补录
            </n-button>
            <n-button
              v-if="marketPositionNavigationEnabled"
              :type="activeSection === 'market-position' ? 'primary' : 'tertiary'"
              :ghost="activeSection === 'market-position'"
              size="small"
              data-testid="nav-market-position"
              @click="goMarketPosition"
            >
              市场位置画像
            </n-button>
            <n-button
              v-if="strategyWindowNavigationEnabled"
              :type="activeSection === 'strategy-window' ? 'primary' : 'tertiary'"
              :ghost="activeSection === 'strategy-window'"
              size="small"
              data-testid="nav-strategy-window"
              @click="goStrategyWindow"
            >
              求职策略
            </n-button>
            <n-button
              :type="activeSection === 'jobs' ? 'primary' : 'tertiary'"
              :ghost="activeSection === 'jobs'"
              size="small"
              @click="goJobs"
            >
              岗位台账
            </n-button>
          </n-space>
        </n-layout-header>

        <n-layout-content class="app-content" :content-style="contentStyle">
          <n-alert
            v-if="g3SandboxBannerVisible"
            type="warning"
            :bordered="true"
            data-testid="g3-sandbox-banner"
            style="margin-bottom: 16px;"
          >
            当前为 G3 隔离验收环境，所有补录操作只写入测试副本，不会修改真实求职数据。
          </n-alert>
          <n-alert
            v-if="g4SandboxBannerVisible"
            type="warning"
            :bordered="true"
            data-testid="g4-sandbox-banner"
            style="margin-bottom: 16px;"
          >
            当前为 G4 隔离验收环境，市场位置画像只读取测试副本数据，不会修改真实求职数据，也不会在真实生产入口开启。
          </n-alert>
          <n-alert
            v-if="g5SandboxBannerVisible"
            type="warning"
            :bordered="true"
            data-testid="g5-sandbox-banner"
            style="margin-bottom: 16px;"
          >
            当前为 G5 隔离验收环境，策略提案只写入测试副本，不会修改真实求职数据，也不会自动执行投递、联系、降薪、迁移或放弃方向。
          </n-alert>
          <RouterView v-slot="{ Component }">
            <component :is="Component" :key="routeViewKey()" />
          </RouterView>
        </n-layout-content>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
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
