<script setup lang="ts">
/**
 * RC-10 雷达动作栏：收藏 / 忽略 / 标记优先 / 已投待反馈。
 *
 * Human-in-the-loop 与边界：
 * - 每一族都是一键切换：未生效→执行 set，已生效→显示对应撤销入口；
 * - 状态由服务端 append-only 事件流派生，刷新后重新拉取即恢复（不依赖本地缓存）；
 * - 撤销只恢复 Radar 决策状态，绝不触碰正式 Job/Application/FeedbackEvent（服务端保证）；
 * - 没有任何自动晋升：本组件只调用动作 API，绝不触碰 promotion API、不做任何写入；
 *   「晋升跟进」按钮只 emit('promote-followup') 意图，由页面打开晋升面板，用户仍需预览+确认；
 * - 动作变化后 emit('changed')，由页面让旧推荐批次失效（复用服务端 handledStateHash/stale）。
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import { NAlert, NButton, NSpin, NSpace, NTag, NText } from 'naive-ui';
import { ApiError } from '../../api/client';
import {
  radarActionApi, type ActionFamily, type ActionStateView, type CandidateActionView,
} from '../../api/radarActionApi';

const props = defineProps<{ candidateId: string }>();
const emit = defineEmits<{
  (e: 'changed', candidateId: string): void;
  /**
   * 「已投待反馈」候选的晋升跟进意图。只发意图、由页面接管打开晋升面板，
   * 用户仍需在面板内独立预览 + 确认——本组件不触碰任何 promotion API、不做写入。
   * 已投待反馈会被推荐永久抑制（跨版本），此入口是它够到晋升面板的唯一动线。
   */
  (e: 'promote-followup', candidateVersionId: string): void;
}>();

const view = ref<CandidateActionView | null>(null);
const loading = ref(false);
const busy = ref<ActionFamily | null>(null);
const errorText = ref('');

/** 迟到响应保护：候选切换即自增；异步回调只在 gen 未变时写状态。 */
const generation = ref(0);
let disposed = false;

function stale(gen: number): boolean {
  return disposed || gen !== generation.value;
}
function safeMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

async function reload(): Promise<void> {
  const gen = generation.value;
  loading.value = true;
  errorText.value = '';
  try {
    const next = await radarActionApi.getView(props.candidateId);
    if (stale(gen)) return;
    view.value = next;
  } catch (error) {
    if (!stale(gen)) { view.value = null; errorText.value = safeMessage(error, '加载动作状态失败'); }
  } finally {
    if (!stale(gen)) loading.value = false;
  }
}

async function toggle(family: ActionFamily): Promise<void> {
  if (busy.value !== null || view.value === null) return;
  const active = isActive(view.value, family);
  const gen = generation.value;
  busy.value = family;
  errorText.value = '';
  try {
    const result = active
      ? await radarActionApi.revert({ candidateId: props.candidateId, family })
      : await radarActionApi.apply({ candidateId: props.candidateId, family });
    if (stale(gen)) return;
    view.value = result.view;
    // 只有真正变更才通知页面失效旧推荐（幂等 no-op 不打扰）。
    if (result.changed) emit('changed', props.candidateId);
  } catch (error) {
    if (!stale(gen)) errorText.value = safeMessage(error, '操作失败');
  } finally {
    if (!stale(gen)) busy.value = null;
  }
}

/** 族名（save/ignore）→ 生效态键（saved/ignored）；priority/appliedPending 同名。 */
const STATE_KEY: Record<ActionFamily, keyof ActionStateView> = {
  save: 'saved', ignore: 'ignored', priority: 'priority', appliedPending: 'appliedPending',
};
function isActive(v: CandidateActionView, family: ActionFamily): boolean {
  return v.state[STATE_KEY[family]];
}

watch(() => props.candidateId, () => { generation.value += 1; void reload(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; });

const FAMILIES: Array<{ family: ActionFamily; setLabel: string; revertLabel: string; activeText: string }> = [
  { family: 'save', setLabel: '收藏', revertLabel: '取消收藏', activeText: '已收藏' },
  { family: 'ignore', setLabel: '忽略', revertLabel: '恢复', activeText: '已忽略' },
  { family: 'priority', setLabel: '标记优先', revertLabel: '取消优先', activeText: '重点关注' },
  { family: 'appliedPending', setLabel: '标记已投待反馈', revertLabel: '撤销已投', activeText: '已投待反馈' },
];
</script>

<template>
  <div class="action-bar" data-testid="action-bar">
    <NSpin :show="loading" size="small">
      <NAlert v-if="errorText" type="error" size="small" :title="errorText" class="mb"
        closable data-testid="action-error" @close="errorText = ''" />
      <NSpace v-if="view" size="small" align="center">
        <template v-for="f in FAMILIES" :key="f.family">
          <!-- 已生效：显示状态 Tag + 对应撤销入口；未生效：显示 set 按钮 -->
          <span v-if="isActive(view, f.family)" class="active-group" :data-testid="`action-active-${f.family}`">
            <NTag size="small" type="success">{{ f.activeText }}</NTag>
            <NButton size="tiny" :loading="busy === f.family" :disabled="busy !== null"
              :data-testid="`action-revert-${f.family}`" @click="toggle(f.family)">{{ f.revertLabel }}</NButton>
            <!-- 已投待反馈是推荐永久抑制态：给唯一一条够到晋升面板的动线（只发意图，不写入）。 -->
            <NButton v-if="f.family === 'appliedPending' && view.activeCandidateVersionId"
              size="tiny" :disabled="busy !== null" data-testid="action-promote-followup"
              @click="emit('promote-followup', view.activeCandidateVersionId)">晋升跟进</NButton>
          </span>
          <NButton v-else size="small" :loading="busy === f.family" :disabled="busy !== null"
            :data-testid="`action-set-${f.family}`" @click="toggle(f.family)">{{ f.setLabel }}</NButton>
        </template>
      </NSpace>
      <NText v-else-if="!loading && !errorText" depth="3" data-testid="action-empty">暂无动作状态</NText>
    </NSpin>
  </div>
</template>

<style scoped>
.action-bar { margin-top: 8px; }
.mb { margin-bottom: 6px; }
.active-group { display: inline-flex; gap: 4px; align-items: center; }
</style>
