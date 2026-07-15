<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NEmpty, NSelect, NSpace, NSpin, NStatistic, NTable, NTag, NText,
} from 'naive-ui';
import { funnelApi } from '../api/funnelApi';
import { ApiError } from '../api/client';
import type { FunnelGroupResult, FunnelResult } from '../domain/funnel';
import type { ApplicationChannel } from '../domain/job-memory';
import { APPLICATION_CHANNEL_LABELS } from '../domain/presentation';

const result = ref<FunnelResult | null>(null);
const loading = ref(true);
const errorText = ref('');

const cityFilter = ref<string | null>(null);
const channelFilter = ref<ApplicationChannel | null>(null);

const channelOptions = Object.entries(APPLICATION_CHANNEL_LABELS).map(([value, label]) => ({
  value,
  label,
}));

const cityOptions = computed(() => {
  const cities = new Set<string>();
  for (const group of result.value?.groups ?? []) {
    if (group.key.city !== null) cities.add(group.key.city);
  }
  return Array.from(cities).sort().map((city) => ({ value: city, label: city }));
});

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    result.value = await funnelApi.get({
      city: cityFilter.value,
      channel: channelFilter.value,
    });
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '加载基础漏斗失败';
  } finally {
    loading.value = false;
  }
}

function resetFilters(): void {
  cityFilter.value = null;
  channelFilter.value = null;
  void load();
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function replyRate(group: FunnelGroupResult): number {
  return group.processCount === 0 ? 0 : group.validReplyCount / group.processCount;
}

function groupLabel(group: FunnelGroupResult): string {
  const parts = [group.key.city ?? '城市未知', group.key.roleFamily, APPLICATION_CHANNEL_LABELS[group.key.channel]];
  if (group.key.windowLabel !== null) parts.push(group.key.windowLabel);
  return parts.join(' · ');
}

onMounted(load);
</script>

<template>
  <div class="market-funnel-page">
    <NCard title="基础漏斗">
      <template #header-extra>
        <NSpace>
          <NSelect
            v-model:value="cityFilter"
            placeholder="按城市筛选"
            clearable
            :options="cityOptions"
            style="width: 160px"
            @update:value="load"
          />
          <NSelect
            v-model:value="channelFilter"
            placeholder="按渠道筛选"
            clearable
            :options="channelOptions"
            style="width: 160px"
            @update:value="load"
          />
          <NButton size="small" @click="resetFilters">重置</NButton>
        </NSpace>
      </template>

      <NSpin :show="loading">
        <NAlert v-if="errorText" type="error" style="margin-bottom: 12px">{{ errorText }}</NAlert>

        <template v-if="result !== null">
          <NSpace style="margin-bottom: 16px">
            <NStatistic label="已确认投递/招聘接触流程数" :value="result.totalProcessCount" />
          </NSpace>

          <NEmpty v-if="result.groups.length === 0" description="暂无可统计的投递/招聘接触流程" />

          <NTable v-else :bordered="false" :single-line="false">
            <thead>
              <tr>
                <th>分组（城市 · 岗位族 · 渠道）</th>
                <th>流程数</th>
                <th>有效回复数 / 回复率</th>
                <th>曾进入筛选</th>
                <th>曾进入面试</th>
                <th>曾获 Offer</th>
                <th>招聘方拒绝</th>
                <th>用户退出</th>
                <th>岗位关闭</th>
                <th>进行中</th>
                <th>回忆数据占比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="group in result.groups" :key="groupLabel(group)">
                <td>{{ groupLabel(group) }}</td>
                <td>{{ group.processCount }}</td>
                <td>{{ group.validReplyCount }} ({{ formatPercent(replyRate(group)) }})</td>
                <td>{{ group.reachedScreeningCount }}</td>
                <td>{{ group.reachedInterviewingCount }}</td>
                <td>{{ group.reachedOfferCount }}</td>
                <td>{{ group.outcomeCounts.rejected }}</td>
                <td>{{ group.outcomeCounts.userWithdrew }}</td>
                <td>{{ group.outcomeCounts.positionClosed }}</td>
                <td>{{ group.inProgressCount }}</td>
                <td>
                  <NTag :type="group.recalledDataShare > 0.5 ? 'warning' : 'default'" size="small">
                    {{ formatPercent(group.recalledDataShare) }}
                  </NTag>
                </td>
              </tr>
            </tbody>
          </NTable>

          <NCard v-if="result.exclusions.notes.length > 0" title="分母与排除说明" size="small" style="margin-top: 16px">
            <NSpace vertical size="small">
              <NText v-for="note in result.exclusions.notes" :key="note" depth="3">{{ note }}</NText>
            </NSpace>
          </NCard>
        </template>
      </NSpin>
    </NCard>
  </div>
</template>
