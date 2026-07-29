<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NSpin, NTag, NText } from 'naive-ui';
import { ApiError } from '../../api/client';
import {
  radarAnalysisApi,
  type AnalysisTaskView, type CandidateAnalysisHistoryView, type JobMatchAnalysisView,
  type AnalysisPoint, type AnalysisPointKind, type JobMatchAnalysisPayloadV1,
} from '../../api/radarAnalysisApi';

const props = withDefaults(defineProps<{
  candidateId: string;
  candidateVersionId: string;
  enabled: boolean;
  /** 轮询间隔（ms）。默认 1000，测试可注入更小值配合 fake timers。 */
  pollIntervalMs?: number;
}>(), { pollIntervalMs: 1000 });

const task = ref<AnalysisTaskView | null>(null);
const activeResult = ref<JobMatchAnalysisView | null>(null);
const history = ref<CandidateAnalysisHistoryView[]>([]);
const historyLoading = ref(false);
const actionBusy = ref(false);
const errorText = ref('');
const conflictHint = ref('');

/** 迟到响应保护：候选/版本切换即自增；异步回调只在 gen 未变时写状态。 */
const generation = ref(0);
let disposed = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
function stale(gen: number): boolean {
  return disposed || gen !== generation.value;
}
function safeMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * 刷新恢复指针：仅持久化 taskId，按 candidateVersionId 分键，绝不写 Snapshot/Payload/JD/敏感数据。
 * 不同候选版本各自独立键，旧候选指针绝不污染新候选。sessionStorage 不可用（隐私模式/SSR）时静默降级。
 */
function pointerKey(candidateVersionId: string): string {
  return `offerflow.analysis.task.${candidateVersionId}`;
}
function readPointer(candidateVersionId: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(pointerKey(candidateVersionId)) ?? null;
  } catch { return null; }
}
function writePointer(candidateVersionId: string, taskId: string): void {
  try { globalThis.sessionStorage?.setItem(pointerKey(candidateVersionId), taskId); } catch { /* 降级：仅失去刷新恢复 */ }
}
function clearPointer(candidateVersionId: string): void {
  try { globalThis.sessionStorage?.removeItem(pointerKey(candidateVersionId)); } catch { /* ignore */ }
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** 单次轮询：请求未完成不发下一次；组件/版本切换或终态即停；绝不叠加定时器。 */
async function pollOnce(gen: number): Promise<void> {
  if (stale(gen) || pollInFlight || task.value === null) return;
  pollInFlight = true;
  try {
    const latest = await radarAnalysisApi.getTask(task.value.id);
    if (stale(gen)) return;
    task.value = latest;
    if (isTerminal(latest.status)) {
      stopPolling();
      if (latest.status === 'succeeded') await loadResultAndHistory(gen);
      return;
    }
  } catch (error) {
    if (stale(gen)) return;
    conflictHint.value = safeMessage(error, '轮询任务状态失败');
  } finally {
    pollInFlight = false;
  }
  if (!stale(gen) && task.value !== null && !isTerminal(task.value.status)) {
    pollTimer = setTimeout(() => { void pollOnce(gen); }, props.pollIntervalMs);
  }
}

function startPolling(gen: number): void {
  stopPolling();
  void pollOnce(gen);
}

/** run 为「即发即忘」：后端 run 同步返回终态，但由轮询驱动 UI 中间态（queued/running）。 */
function fireRun(gen: number, taskId: string): void {
  radarAnalysisApi.runTask(taskId).catch(() => { /* 失败/取消由轮询获取的终态体现 */ });
  startPolling(gen);
}

async function loadResultAndHistory(gen: number): Promise<void> {
  const recordId = task.value?.resultRecordId ?? null;
  try {
    if (recordId !== null) {
      const result = await radarAnalysisApi.getAnalysis(recordId);
      if (stale(gen)) return;
      activeResult.value = result;
    }
    await loadHistory(gen);
  } catch (error) {
    if (stale(gen)) return;
    conflictHint.value = safeMessage(error, '加载分析结果失败');
  }
}

async function loadHistory(gen: number): Promise<void> {
  historyLoading.value = true;
  try {
    const items = await radarAnalysisApi.listCandidateAnalyses(props.candidateId);
    if (stale(gen)) return;
    history.value = items;
  } catch (error) {
    if (stale(gen)) return;
    errorText.value = safeMessage(error, '加载分析历史失败');
  } finally {
    if (!stale(gen)) historyLoading.value = false;
  }
}

/** 开始分析：create（幂等）→ 若已有结果直接展示 → 否则显式 run + 轮询。绝不重复 create。 */
async function startAnalysis(): Promise<void> {
  if (actionBusy.value || task.value !== null) return;
  const gen = generation.value;
  actionBusy.value = true;
  errorText.value = '';
  conflictHint.value = '';
  try {
    const created = await radarAnalysisApi.createTask(props.candidateVersionId);
    if (stale(gen)) return;
    task.value = created;
    // 幂等 create 成功即落刷新恢复指针（含当前版本键）：刷新后 mount 能凭此恢复本次任务。
    writePointer(props.candidateVersionId, created.id);
    if (created.status === 'succeeded') {
      await loadResultAndHistory(gen);
    } else if (!isTerminal(created.status)) {
      fireRun(gen, created.id);
    }
  } catch (error) {
    if (!stale(gen)) errorText.value = safeMessage(error, '创建分析任务失败');
  } finally {
    if (!stale(gen)) actionBusy.value = false;
  }
}

/** 重试：失败任务 retry → queued → 显式 run + 轮询。达上限或非法转换由后端 409 拒绝。 */
async function retryAnalysis(): Promise<void> {
  const current = task.value;
  if (actionBusy.value || current === null) return;
  const gen = generation.value;
  actionBusy.value = true;
  conflictHint.value = '';
  try {
    const queued = await radarAnalysisApi.retryTask(current.id);
    if (stale(gen)) return;
    task.value = queued;
    if (!isTerminal(queued.status)) fireRun(gen, queued.id);
  } catch (error) {
    if (stale(gen)) return;
    if (error instanceof ApiError && error.status === 409) {
      conflictHint.value = '任务状态已变化（可能已达重试上限），已刷新最新状态';
      await refreshTask(gen);
    } else {
      conflictHint.value = safeMessage(error, '重试失败');
    }
  } finally {
    if (!stale(gen)) actionBusy.value = false;
  }
}

/** 取消：停止轮询后 cancel；running 的即发 run 会被后端取消，终态由 cancel 返回体现。 */
async function cancelAnalysis(): Promise<void> {
  const current = task.value;
  if (actionBusy.value || current === null) return;
  const gen = generation.value;
  actionBusy.value = true;
  conflictHint.value = '';
  stopPolling();
  try {
    const cancelled = await radarAnalysisApi.cancelTask(current.id);
    if (!stale(gen)) task.value = cancelled;
  } catch (error) {
    if (stale(gen)) return;
    if (error instanceof ApiError && error.status === 409) {
      conflictHint.value = '任务已进入终态，已刷新最新状态';
      await refreshTask(gen);
    } else {
      conflictHint.value = safeMessage(error, '取消失败');
    }
  } finally {
    if (!stale(gen)) actionBusy.value = false;
  }
}

async function refreshTask(gen: number): Promise<void> {
  if (task.value === null) return;
  try {
    const latest = await radarAnalysisApi.getTask(task.value.id);
    if (stale(gen)) return;
    task.value = latest;
    if (latest.status === 'succeeded') await loadResultAndHistory(gen);
  } catch { /* 刷新失败保留原状态 */ }
}

/**
 * 刷新/挂载恢复：凭当前版本键的 sessionStorage 指针 GET task 恢复状态。
 * - 仅恢复本版本的 task（entityId 必须等于当前版本；否则视为陈旧指针，清除且不污染新候选）；
 * - 非终态 → 恢复中间态并接管轮询；succeeded → 拉结果；terminal 保留指针供后续刷新展示；
 * - 指针失效（task 不存在/请求失败）→ 清除，静默回落到 not_started，绝不自动 create。
 */
async function recoverPersistedTask(gen: number, candidateVersionId: string): Promise<void> {
  const taskId = readPointer(candidateVersionId);
  if (taskId === null) return;
  let recovered: AnalysisTaskView;
  try {
    recovered = await radarAnalysisApi.getTask(taskId);
  } catch {
    clearPointer(candidateVersionId); // 指针失效（可能 404）：清除，回落 not_started。
    return;
  }
  if (stale(gen) || candidateVersionId !== props.candidateVersionId) return;
  if (recovered.entityId !== candidateVersionId) {
    clearPointer(candidateVersionId); // 陈旧指针指向别的版本：绝不污染当前候选。
    return;
  }
  task.value = recovered;
  if (recovered.status === 'succeeded') {
    await loadResultAndHistory(gen);
  } else if (!isTerminal(recovered.status)) {
    startPolling(gen); // 接管进行中任务的轮询（不重新 create、不再次 run）。
  }
}

/** 候选/版本切换：自增 gen 作废迟到响应、停轮询、清任务与结果、重载新候选历史并尝试刷新恢复。 */
function resetForTarget(): void {
  generation.value += 1;
  stopPolling();
  pollInFlight = false;
  task.value = null;
  activeResult.value = null;
  errorText.value = '';
  conflictHint.value = '';
  if (props.enabled && props.candidateId !== '') {
    const gen = generation.value;
    const versionId = props.candidateVersionId;
    void loadHistory(gen);
    void recoverPersistedTask(gen, versionId);
  } else {
    history.value = [];
  }
}

watch(
  () => [props.candidateId, props.candidateVersionId, props.enabled] as const,
  () => resetForTarget(),
  { immediate: true },
);

onBeforeUnmount(() => {
  disposed = true;
  stopPolling();
});

/** 当前版本的历史结果（同一输入幂等 → 至多一条），用于刷新后恢复展示。 */
const currentVersionResult = computed<JobMatchAnalysisView | null>(() => {
  return history.value.find((r) => r.candidateVersionId === props.candidateVersionId) ?? null;
});

/** 展示结果优先取本次任务产出，其次取当前版本历史结果。 */
const displayedResult = computed<JobMatchAnalysisView | null>(() => {
  if (activeResult.value !== null && activeResult.value.candidateVersionId === props.candidateVersionId) {
    return activeResult.value;
  }
  return currentVersionResult.value;
});

/** 面板阶段：disabled 优先；其次按任务状态；无任务但有当前结果 → succeeded；否则 not_started。 */
const phase = computed<'disabled' | 'not_started' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>(() => {
  if (!props.enabled) return 'disabled';
  if (task.value !== null) return task.value.status;
  return displayedResult.value !== null ? 'succeeded' : 'not_started';
});

const isStale = computed(() => displayedResult.value?.validity.status === 'stale');
const attemptsExhausted = computed(() => task.value !== null && task.value.attemptCount >= task.value.maxAttempts);
const showStartButton = computed(() => phase.value === 'not_started' && !actionBusy.value);

const RECOMMENDATION_LABELS: Record<string, string> = {
  apply_now: '建议立即投递', stretch: '可作为冲刺机会', verify: '核验后再决定', skip: '建议跳过',
};
const CONFIDENCE_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高' };
const KIND_LABELS: Record<AnalysisPointKind, string> = {
  fact: '事实', inference: '推断', user_preference: '用户偏好', rule_result: '规则结果', unknown: '未知',
};
const ASSESSMENT_LABELS: Record<string, string> = {
  strong: '强匹配', moderate: '中等', weak: '弱匹配', unknown: '未知',
};
const STALE_REASON_LABELS: Record<string, string> = {
  candidate_version_changed: '岗位版本已更新',
  resume_version_changed: '简历版本已更新',
  job_match_profile_changed: '匹配画像已更新',
  capability_baseline_changed: '能力基线已更新',
  market_position_changed: '市场位置已更新',
  strategy_changed: '求职策略已更新',
  rule_version_changed: '规则版本已更新',
  prompt_version_changed: '分析提示词已更新',
  analysis_policy_changed: '分析策略已更新',
  model_policy_invalidated: '模型策略已失效',
};
function recommendationLabel(v: string): string { return RECOMMENDATION_LABELS[v] ?? v; }
function confidenceLabel(v: string): string { return CONFIDENCE_LABELS[v] ?? v; }
function kindLabel(v: AnalysisPointKind): string { return KIND_LABELS[v] ?? v; }
function assessmentLabel(v: string): string { return ASSESSMENT_LABELS[v] ?? v; }
function staleReasonLabel(v: string): string { return STALE_REASON_LABELS[v] ?? v; }

const DIMENSION_ORDER: Array<{ key: keyof JobMatchAnalysisPayloadV1['dimensions']; label: string }> = [
  { key: 'roleFit', label: '岗位匹配' },
  { key: 'capabilityFit', label: '能力匹配' },
  { key: 'businessAndCompanyFit', label: '业务与公司匹配' },
  { key: 'cityAndSalaryFit', label: '城市与薪资匹配' },
];
const EVIDENCE_SECTIONS: Array<{ key: keyof JobMatchAnalysisPayloadV1; label: string }> = [
  { key: 'transferableEvidence', label: '可迁移证据' },
  { key: 'hardConstraints', label: '硬性约束' },
  { key: 'risks', label: '风险' },
  { key: 'gaps', label: '差距' },
  { key: 'counterEvidence', label: '反证' },
  { key: 'uncertainties', label: '不确定项' },
];
function pointsOf(payload: JobMatchAnalysisPayloadV1, key: keyof JobMatchAnalysisPayloadV1): AnalysisPoint[] {
  return payload[key] as AnalysisPoint[];
}
function timeText(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
</script>

<template>
  <NCard size="small" class="analysis-panel" data-testid="analysis-panel" :title="`单岗位分析`">
    <!-- 未开启：仅提示，不显示分析按钮 -->
    <NEmpty v-if="phase === 'disabled'" description="单岗位分析功能尚未开启" size="small" data-testid="analysis-disabled" />

    <template v-else>
      <NAlert v-if="errorText" type="error" :title="errorText" class="mb" data-testid="analysis-error" closable @close="errorText = ''" />
      <NAlert v-if="conflictHint" type="warning" :title="conflictHint" class="mb" data-testid="analysis-conflict" closable @close="conflictHint = ''" />

      <!-- 未开始：可点击开始分析 -->
      <div v-if="phase === 'not_started'" class="state-row" data-testid="analysis-not-started">
        <NText depth="3">尚未对该岗位版本运行分析。</NText>
        <NButton v-if="showStartButton" type="primary" size="small" :loading="actionBusy" :disabled="actionBusy"
          data-testid="analysis-start" @click="startAnalysis">开始分析</NButton>
      </div>

      <!-- 进行中：queued / running -->
      <div v-else-if="phase === 'queued' || phase === 'running'" class="state-row" data-testid="analysis-running">
        <NSpin size="small" />
        <NTag size="small" type="info">{{ phase === 'queued' ? '排队中' : '分析中' }}</NTag>
        <NText depth="3" data-testid="analysis-attempts">尝试 {{ task?.attemptCount }}/{{ task?.maxAttempts }}</NText>
        <NText depth="3">创建于 {{ timeText(task?.createdAt ?? null) }}</NText>
        <NText v-if="task?.startedAt" depth="3">开始于 {{ timeText(task.startedAt) }}</NText>
        <NButton size="small" :disabled="actionBusy" data-testid="analysis-cancel" @click="cancelAnalysis">取消</NButton>
      </div>

      <!-- 失败：安全错误 + 重试（达上限禁用并说明） -->
      <div v-else-if="phase === 'failed'" class="state-row failed" data-testid="analysis-failed">
        <NTag size="small" type="error">分析失败</NTag>
        <NText depth="3" data-testid="analysis-error-code">错误码：{{ task?.errorCode ?? '未知' }}</NText>
        <NText depth="3" data-testid="analysis-error-message">{{ task?.errorMessage ?? '无附加信息' }}</NText>
        <NText depth="3">尝试 {{ task?.attemptCount }}/{{ task?.maxAttempts }}</NText>
        <template v-if="attemptsExhausted">
          <NText depth="3" data-testid="analysis-exhausted">已达最大重试次数，不能再重试。</NText>
        </template>
        <NButton v-else type="primary" size="small" :disabled="actionBusy" data-testid="analysis-retry" @click="retryAnalysis">重试</NButton>
      </div>

      <!-- 已取消：终态，不提供重试；输入未变不再显示重新开始 -->
      <div v-else-if="phase === 'cancelled'" class="state-row" data-testid="analysis-cancelled">
        <NTag size="small">已取消</NTag>
        <NText depth="3">该分析已被取消。输入版本变化后可重新发起分析。</NText>
      </div>

      <!-- 成功：结论先行的分析结果 -->
      <div v-else-if="phase === 'succeeded' && displayedResult" class="result" data-testid="analysis-result">
        <!-- stale：醒目但克制的历史参考提示 -->
        <NAlert v-if="isStale" type="warning" class="mb" data-testid="analysis-stale-banner"
          title="该分析基于旧版本输入，仅供历史参考。">
          <div class="stale-reasons" data-testid="analysis-stale-reasons">
            {{ displayedResult.validity.staleReasons.map(staleReasonLabel).join('、') || '输入版本已变化' }}
          </div>
        </NAlert>

        <!-- 顶部摘要：结论 + 置信度 + summary -->
        <div class="summary" data-testid="analysis-summary">
          <span class="rec" data-testid="analysis-recommendation">{{ recommendationLabel(displayedResult.recommendation) }}</span>
          <NTag size="small" data-testid="analysis-confidence">置信度：{{ confidenceLabel(displayedResult.confidence) }}</NTag>
          <NTag size="small" :type="isStale ? 'warning' : 'success'" data-testid="analysis-validity">{{ isStale ? '历史参考' : '当前有效' }}</NTag>
        </div>
        <p class="summary-text">{{ displayedResult.payload.summary }}</p>

        <!-- 四维分析 -->
        <div v-for="dim in DIMENSION_ORDER" :key="dim.key" class="section" :data-testid="`analysis-dim-${dim.key}`">
          <div class="section-head">
            <NText strong>{{ dim.label }}</NText>
            <NTag size="tiny">{{ assessmentLabel(displayedResult.payload.dimensions[dim.key].assessment) }}</NTag>
          </div>
          <p class="dim-summary">{{ displayedResult.payload.dimensions[dim.key].summary }}</p>
          <div v-for="(pt, i) in displayedResult.payload.dimensions[dim.key].points" :key="i" class="point">
            <NTag size="tiny" :data-testid="`analysis-kind-${pt.kind}`">{{ kindLabel(pt.kind) }}</NTag>
            <span class="point-stmt">{{ pt.statement }}</span>
            <details v-if="pt.evidenceKeys.length > 0" class="evidence">
              <summary>证据引用（{{ pt.evidenceKeys.length }}）</summary>
              <code v-for="k in pt.evidenceKeys" :key="k" class="ekey">{{ k }}</code>
            </details>
          </div>
        </div>

        <!-- 岗位事实 -->
        <div v-if="displayedResult.payload.jobFacts.length > 0" class="section" data-testid="analysis-jobfacts">
          <NText strong>岗位事实</NText>
          <div v-for="(f, i) in displayedResult.payload.jobFacts" :key="i" class="point">
            <NTag size="tiny">{{ kindLabel(f.kind) }}</NTag>
            <span class="point-stmt">{{ f.statement }}</span>
            <details v-if="f.evidenceKeys.length > 0" class="evidence">
              <summary>证据引用（{{ f.evidenceKeys.length }}）</summary>
              <code v-for="k in f.evidenceKeys" :key="k" class="ekey">{{ k }}</code>
            </details>
          </div>
        </div>

        <!-- 证据分区（可迁移证据 / 硬约束 / 风险 / 差距 / 反证 / 不确定项） -->
        <div v-for="sec in EVIDENCE_SECTIONS" :key="sec.key" class="section">
          <template v-if="pointsOf(displayedResult.payload, sec.key).length > 0">
            <NText strong>{{ sec.label }}</NText>
            <div v-for="(pt, i) in pointsOf(displayedResult.payload, sec.key)" :key="i" class="point" :data-testid="`analysis-${String(sec.key)}`">
              <NTag size="tiny">{{ kindLabel(pt.kind) }}</NTag>
              <span class="point-stmt">{{ pt.statement }}</span>
              <NText depth="3" class="point-expl">{{ pt.explanation }}</NText>
              <details v-if="pt.evidenceKeys.length > 0" class="evidence">
                <summary>证据引用（{{ pt.evidenceKeys.length }}）</summary>
                <code v-for="k in pt.evidenceKeys" :key="k" class="ekey">{{ k }}</code>
              </details>
            </div>
          </template>
        </div>

        <!-- 纯文本清单：缺失证据 / 招聘方问题 / 沟通切入点 -->
        <div v-if="displayedResult.payload.missingEvidence.length > 0" class="section" data-testid="analysis-missing">
          <NText strong>缺失证据</NText>
          <ul class="lines"><li v-for="(l, i) in displayedResult.payload.missingEvidence" :key="i">{{ l }}</li></ul>
        </div>
        <div v-if="displayedResult.payload.recruiterQuestions.length > 0" class="section" data-testid="analysis-questions">
          <NText strong>建议向招聘方核实</NText>
          <ul class="lines"><li v-for="(l, i) in displayedResult.payload.recruiterQuestions" :key="i">{{ l }}</li></ul>
        </div>
        <div v-if="displayedResult.payload.communicationAngles.length > 0" class="section" data-testid="analysis-angles">
          <NText strong>沟通切入点</NText>
          <ul class="lines"><li v-for="(l, i) in displayedResult.payload.communicationAngles" :key="i">{{ l }}</li></ul>
        </div>

        <!-- 模型 / 版本号默认折叠：生成时间等排查信息保留在 DOM，默认不占视觉 -->
        <details class="meta tech-details" data-testid="analysis-meta">
          <summary class="tech-summary">技术细节（模型与版本号）</summary>
          <NText depth="3">模型：{{ displayedResult.modelProvider }} / {{ displayedResult.modelName }}</NText>
          <NText depth="3">规则 {{ displayedResult.ruleVersion }} · 提示词 {{ displayedResult.promptVersion }} · 策略 {{ displayedResult.analysisPolicyVersion }}</NText>
          <NText depth="3">生成于 {{ timeText(displayedResult.createdAt) }}</NText>
        </details>
      </div>
    </template>
  </NCard>
</template>

<style scoped>
.analysis-panel { margin-top: 12px; font-size: 13px; }
.mb { margin-bottom: 8px; }
.state-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.state-row.failed { flex-direction: column; align-items: flex-start; }
.result { font-size: 13px; }
.summary { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 4px; }
.rec { font-weight: 600; color: var(--of-brand, #2563eb); }
.summary-text { margin: 4px 0 12px; color: var(--of-ink, #0f172a); line-height: 1.5; }
.section { margin-top: 12px; }
.section-head { display: flex; gap: 8px; align-items: center; }
.dim-summary { margin: 4px 0; color: var(--of-ink-2, #475569); line-height: 1.5; }
.point { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; padding: 3px 0; border-bottom: 1px dashed var(--of-line, rgba(15, 23, 42, 0.08)); }
.point-stmt { flex: 1; min-width: 200px; }
.point-expl { width: 100%; }
.evidence { width: 100%; }
.evidence summary { cursor: pointer; color: var(--of-ink-2, #475569); font-size: 12px; }
.ekey { display: inline-block; margin: 2px 4px 0 0; padding: 0 8px; background: rgba(15, 23, 42, 0.05); border-radius: 999px; font-size: 12px; color: var(--of-ink-2, #475569); }
.lines { margin: 4px 0; padding-left: 18px; }
.lines li { line-height: 1.5; }
.meta { margin-top: 12px; display: flex; flex-direction: column; gap: 2px; padding-top: 8px; border-top: 1px solid var(--of-line, rgba(15, 23, 42, 0.08)); }
/* 技术细节折叠：模型与版本号默认收起，靠颜色弱化 summary */
.tech-summary { cursor: pointer; font-size: 12px; color: var(--of-muted, #94a3b8); }
.stale-reasons { font-size: 12px; margin-top: 4px; }
</style>
