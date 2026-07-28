<script setup lang="ts">
/**
 * RC-11 反向追踪面板（只读）。两部分共用同一来源链展示：
 * - 正向：传入 promotionId 时自动加载「晋升 → 候选版本/触发原因/推荐批次/正式对象」；
 * - 反向：统一只读查询区，按 Job/Application/FeedbackEvent 反查引用它的晋升。
 *
 * 忠实透传服务端状态：无来源 → 明确「不可追溯」；绝不提供删除/修改/自动修复按钮。
 */
import { ref, watch } from 'vue';
import { NButton, NCard, NInput, NSelect, NSpin, NTag, NText, NAlert, NEmpty } from 'naive-ui';
import { ApiError } from '../../api/client';
import RadarPromotionOriginTrace from './RadarPromotionOriginTrace.vue';
import {
  radarPromotionTraceApi,
  type FormalObjectKind, type FormalObjectTrace, type PromotionOriginTrace,
} from '../../api/radarPromotionTraceApi';

const props = defineProps<{ promotionId: string | null }>();

const originBusy = ref(false);
const origin = ref<PromotionOriginTrace | null>(null);
const originError = ref('');

const OBJECT_OPTIONS: Array<{ label: string; value: FormalObjectKind }> = [
  { label: '岗位（Job）', value: 'job' },
  { label: '投递（Application）', value: 'application' },
  { label: '反馈事件（FeedbackEvent）', value: 'feedback_event' },
];
const lookupKind = ref<FormalObjectKind>('job');
const lookupId = ref('');
const lookupBusy = ref(false);
const lookupResult = ref<FormalObjectTrace | null>(null);
const lookupError = ref('');

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

async function loadOrigin(promotionId: string): Promise<void> {
  originBusy.value = true; originError.value = ''; origin.value = null;
  try {
    origin.value = await radarPromotionTraceApi.traceByPromotion(promotionId);
  } catch (error) {
    originError.value = safeMessage(error, '追溯晋升来源失败');
  } finally {
    originBusy.value = false;
  }
}

/** 传入晋升 id（如刚确认晋升）即自动加载来源链；置空则清空。 */
watch(() => props.promotionId, (id) => {
  if (id === null || id === '') { origin.value = null; originError.value = ''; return; }
  void loadOrigin(id);
}, { immediate: true });

async function runLookup(): Promise<void> {
  const id = lookupId.value.trim();
  if (id === '' || lookupBusy.value) return;
  lookupBusy.value = true; lookupError.value = ''; lookupResult.value = null;
  try {
    lookupResult.value = await radarPromotionTraceApi.traceByObject(lookupKind.value, id);
  } catch (error) {
    lookupError.value = safeMessage(error, '反查晋升来源失败');
  } finally {
    lookupBusy.value = false;
  }
}
</script>

<template>
  <NCard size="small" class="trace-panel" data-testid="promotion-trace-panel" title="晋升来源追溯（只读）">
    <!-- 正向：晋升 → 来源链 -->
    <section v-if="promotionId" class="block" data-testid="trace-origin-section">
      <NText strong>本次晋升的来源链</NText>
      <NSpin v-if="originBusy" size="small" class="mt" />
      <NAlert v-else-if="originError" type="error" :title="originError" class="mt" data-testid="trace-origin-error" />
      <RadarPromotionOriginTrace v-else-if="origin" :origin="origin" testid="trace-origin" class="mt" />
    </section>

    <!-- 反向：统一只读查询区 -->
    <section class="block" data-testid="trace-lookup-section">
      <NText strong>反查正式对象来源</NText>
      <p class="hint">输入正式对象 ID，反查引用它的晋升记录。仅呈现已存储关联，无来源时明确标注不可追溯。</p>
      <div class="lookup-form">
        <NSelect v-model:value="lookupKind" size="small" :options="OBJECT_OPTIONS"
          class="kind" data-testid="trace-lookup-kind" />
        <NInput v-model:value="lookupId" size="small" placeholder="正式对象 ID"
          data-testid="trace-lookup-id" @keyup.enter="runLookup" />
        <NButton size="small" :loading="lookupBusy" :disabled="lookupId.trim() === ''"
          data-testid="trace-lookup-run" @click="runLookup">反查来源</NButton>
      </div>

      <NAlert v-if="lookupError" type="error" :title="lookupError" class="mt" data-testid="trace-lookup-error" />

      <template v-if="lookupResult">
        <!-- 无来源：明确不可追溯，不编造 -->
        <NEmpty v-if="!lookupResult.traceable" size="small" class="mt" data-testid="trace-lookup-untraceable"
          description="不可追溯：没有任何晋升记录引用该正式对象（可能在 Radar 之外创建，或为历史数据）" />
        <div v-else class="mt" data-testid="trace-lookup-result">
          <NTag size="small" type="info" data-testid="trace-lookup-count">
            共 {{ lookupResult.promotions.length }} 条晋升引用该对象{{ lookupResult.promotions.length > 1 ? '（link 模式：一对象对应多份晋升）' : '' }}
          </NTag>
          <RadarPromotionOriginTrace v-for="p in lookupResult.promotions" :key="p.promotionId"
            :origin="p" :testid="`trace-lookup-origin-${p.promotionId}`" />
        </div>
      </template>
    </section>
  </NCard>
</template>

<style scoped>
.trace-panel { margin-top: 12px; font-size: 13px; }
.block { padding: 8px 0; }
.block + .block { border-top: 1px solid var(--of-line, rgba(15, 23, 42, 0.08)); margin-top: 8px; }
.mt { margin-top: 8px; }
.hint { font-size: 12px; color: var(--of-ink-2, #475569); margin: 4px 0 8px; line-height: 1.6; }
.lookup-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.lookup-form .kind { width: 200px; }
.lookup-form .n-input { flex: 1; min-width: 200px; }
</style>
