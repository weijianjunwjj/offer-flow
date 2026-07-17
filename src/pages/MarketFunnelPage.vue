<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NEmpty, NSelect, NSpace, NSpin, NStatistic, NTable, NTag, NText,
} from 'naive-ui';
import { funnelApi } from '../api/funnelApi';
import { ApiError } from '../api/client';
import type {
  FunnelGroupResult, FunnelOverview, FunnelResult, FunnelStageCount,
} from '../domain/funnel';
import {
  FUNNEL_PROCESS_STATUS_LABELS,
  FUNNEL_STAGE_LABELS,
  FUNNEL_CONFIDENCE_TIER_LABELS,
  JOB_FAMILY_LABELS,
} from '../domain/funnel';
import type { ApplicationChannel } from '../domain/job-memory';
import { APPLICATION_CHANNEL_LABELS } from '../domain/presentation';

const result = ref<FunnelResult | null>(null);
const loading = ref(true);
const errorText = ref('');

const cityFilter = ref<string | null>(null);
const channelFilter = ref<ApplicationChannel | null>(null);
const groupBy = ref<'none' | 'city' | 'jobFamily' | 'channel' | 'resumeVersion'>('none');

const groupByOptions = [
  { value: 'none', label: '不分组 / 总览' },
  { value: 'city', label: '按城市' },
  { value: 'jobFamily', label: '按岗位族' },
  { value: 'channel', label: '按渠道' },
  { value: 'resumeVersion', label: '按简历版本' },
];

const channelOptions = Object.entries(APPLICATION_CHANNEL_LABELS).map(([value, label]) => ({
  value,
  label,
}));

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    result.value = await funnelApi.get({
      city: cityFilter.value,
      channel: channelFilter.value,
      groupBy: groupBy.value,
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
  groupBy.value = 'none';
  void load();
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function conversionFromPreviousLabel(stage: FunnelStageCount, index: number): string {
  if (index === 0) return '起点';
  return formatPercent(stage.conversionFromPrevious);
}

function groupLabel(group: FunnelGroupResult): string {
  const key = group.key;
  if (groupBy.value === 'city') return key.city ?? '城市未知';
  if (groupBy.value === 'jobFamily') return JOB_FAMILY_LABELS[key.jobFamily];
  if (groupBy.value === 'channel') return APPLICATION_CHANNEL_LABELS[key.channel];
  if (groupBy.value === 'resumeVersion') return key.resumeVersionId ?? '未绑定简历版本';
  return '总览';
}

const activeOverview = computed<FunnelOverview | null>(() => result.value?.overview ?? null);

const confidenceHighShare = computed(() => {
  const share = activeOverview.value?.confidence.recalledOrInferredShare ?? null;
  return share !== null && share > 0.5;
});

onMounted(load);
</script>

<template>
  <div class="market-funnel-page">
    <NCard title="基础漏斗">
      <template #header-extra>
        <NSpace>
          <NSelect
            v-model:value="groupBy"
            placeholder="分组维度"
            :options="groupByOptions"
            style="width: 160px"
            @update:value="load"
          />
          <NSelect
            v-model:value="cityFilter"
            placeholder="按城市筛选"
            clearable
            :options="[]"
            filterable
            tag
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
          <!-- 可信度总览 -->
          <NCard size="small" title="数据可信度总览" style="margin-bottom: 16px">
            <NSpace>
              <NStatistic label="总已投递流程数" :value="result.overview.confidence.totalAppliedCount" />
              <NStatistic
                v-for="tier in (Object.keys(FUNNEL_CONFIDENCE_TIER_LABELS) as Array<keyof typeof FUNNEL_CONFIDENCE_TIER_LABELS>)"
                :key="tier"
                :label="FUNNEL_CONFIDENCE_TIER_LABELS[tier]"
                :value="result.overview.confidence.counts[tier]"
              />
              <NStatistic
                label="回忆/推断数据占比"
                :value="formatPercent(result.overview.confidence.recalledOrInferredShare)"
              />
            </NSpace>
            <NAlert v-if="confidenceHighShare" type="warning" style="margin-top: 12px">
              当前漏斗主要来自历史回忆或推断数据，只适合建立求职基线，不等同于精确运营统计，也不能直接用于降薪、降级或城市市场结论。
            </NAlert>
          </NCard>

          <!-- 全局/分组总览：可视化漏斗阶段 -->
          <NCard size="small" title="漏斗阶段总览（总数 / 相对上一阶段 / 相对已投递）" style="margin-bottom: 16px">
            <NSpace vertical size="large">
              <NSpace wrap>
                <NCard
                  v-for="(stage, index) in result.overview.stages"
                  :key="stage.stage"
                  size="small"
                  style="width: 180px"
                >
                  <NStatistic :label="FUNNEL_STAGE_LABELS[stage.stage]" :value="stage.count" />
                  <NText depth="3" style="display: block; font-size: 12px; margin-top: 4px">
                    相对上一阶段：{{ conversionFromPreviousLabel(stage, index) }}
                  </NText>
                  <NText depth="3" style="display: block; font-size: 12px">
                    相对已投递：{{ formatPercent(stage.conversionFromApplied) }}
                  </NText>
                </NCard>
              </NSpace>
            </NSpace>
          </NCard>

          <!-- 终态分布 -->
          <NCard size="small" title="流程终态 / 当前状态分布" style="margin-bottom: 16px">
            <NSpace wrap>
              <NStatistic
                v-for="status in (Object.keys(FUNNEL_PROCESS_STATUS_LABELS) as Array<keyof typeof FUNNEL_PROCESS_STATUS_LABELS>)"
                :key="status"
                :label="FUNNEL_PROCESS_STATUS_LABELS[status]"
                :value="result.overview.statusCounts[status]"
              />
            </NSpace>
          </NCard>

          <!-- 分组结果 -->
          <template v-if="groupBy !== 'none'">
            <NEmpty v-if="result.groups.length === 0" description="当前分组维度下暂无可统计的流程" />
            <NTable v-else :bordered="false" :single-line="false">
              <thead>
                <tr>
                  <th>分组</th>
                  <th>已投递</th>
                  <th>有效回复</th>
                  <th>索要简历</th>
                  <th>面试安排</th>
                  <th>Offer 收到</th>
                  <th>进行中</th>
                  <th>招聘方拒绝</th>
                  <th>回忆/推断占比</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="group in result.groups" :key="groupLabel(group)">
                  <td>{{ groupLabel(group) }}</td>
                  <td>{{ group.overview.stages.find((s) => s.stage === 'applied')?.count ?? 0 }}</td>
                  <td>{{ group.overview.stages.find((s) => s.stage === 'valid_reply')?.count ?? 0 }}</td>
                  <td>{{ group.overview.stages.find((s) => s.stage === 'resume_requested')?.count ?? 0 }}</td>
                  <td>{{ group.overview.stages.find((s) => s.stage === 'interview_scheduled')?.count ?? 0 }}</td>
                  <td>{{ group.overview.stages.find((s) => s.stage === 'offer_received')?.count ?? 0 }}</td>
                  <td>{{ group.overview.statusCounts.in_progress }}</td>
                  <td>{{ group.overview.statusCounts.rejected_by_recruiter }}</td>
                  <td>
                    <NTag
                      :type="(group.overview.confidence.recalledOrInferredShare ?? 0) > 0.5 ? 'warning' : 'default'"
                      size="small"
                    >
                      {{ formatPercent(group.overview.confidence.recalledOrInferredShare) }}
                    </NTag>
                  </td>
                </tr>
              </tbody>
            </NTable>
            <NText v-if="groupBy === 'jobFamily'" depth="3" style="display: block; margin-top: 8px; font-size: 12px">
              岗位族由岗位标题按规则归类，原始岗位名称可在明细中查看。
            </NText>
          </template>

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
