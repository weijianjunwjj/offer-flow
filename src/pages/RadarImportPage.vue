<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  NAlert, NButton, NCard, NCheckbox, NCollapse, NCollapseItem, NEmpty, NInput,
  NInputNumber, NSpace, NSpin, NTag, NText,
} from 'naive-ui';
import { ApiError } from '../api/client';
import {
  radarApi,
  type RadarCaptureItemCorrection, type RadarCaptureRecognizedFields,
  type RadarCaptureSessionView, type RadarCommitCaptureSessionResult,
  type RadarPreviewItem,
} from '../api/radarApi';
import {
  clearPersistedSessionId, resolveSessionId, shouldClearOnStatus,
  stripSessionIdFromHash, truncateSessionId, type SessionStorageLike,
} from './radar/sessionCapability';
import {
  batchItemStatus, canCommit, committableConfirmedIndexes,
  isItemCommitBlocked as gateItemCommitBlocked, itemBlockingIssues as gateItemBlockingIssues,
  shouldDefaultConfirm,
} from './radar/commitGate';
import { readCapturedActivityStatus } from './radar/captureMetadata';
import { useRouter } from 'vue-router';
import RadarStageStepper from '../components/radar/RadarStageStepper.vue';
import RadarGuideBar from '../components/radar/RadarGuideBar.vue';
import RadarNextActionCard from '../components/radar/RadarNextActionCard.vue';

const props = defineProps<{ sessionId?: string | null }>();

const router = useRouter();
/** 主线导航：步骤条只发意图，这里用现有路由跳转（review 未开则回落 jobs）。 */
function goStage(stage: 'collect' | 'review' | 'promote'): void {
  if (stage === 'collect') { void router.push({ name: 'radar-import' }); return; }
  if (stage === 'review' && router.hasRoute('radar-review')) { void router.push({ name: 'radar-review' }); return; }
  void router.push({ name: 'jobs' });
}
function goReview(): void { goStage('review'); }

function getStorage(): SessionStorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readQuerySessionId(): string | null {
  if (props.sessionId !== undefined && props.sessionId !== null && props.sessionId !== '') {
    return props.sessionId;
  }
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return query.get('sessionId');
}

const sessionId = ref<string | null>(null);

/**
 * 初始化本次会话 capability：优先地址栏 query（合法则存入 sessionStorage），否则回退 sessionStorage；
 * 若来自地址栏，立即用 history.replaceState 清除完整 sessionId，仍停留在 /radar/import。
 */
function initSession(): void {
  const storage = getStorage();
  if (storage === null) {
    sessionId.value = readQuerySessionId();
    return;
  }
  const resolved = resolveSessionId({ querySessionId: readQuerySessionId(), storage });
  sessionId.value = resolved.sessionId;
  if (resolved.fromQuery) {
    const cleaned = stripSessionIdFromHash(window.location.hash);
    if (cleaned !== window.location.hash) {
      window.history.replaceState(window.history.state, '', cleaned.length > 0 ? cleaned : '#/radar/import');
    }
  }
}

function clearCapability(): void {
  const storage = getStorage();
  if (storage !== null) clearPersistedSessionId(storage);
}
const view = ref<RadarCaptureSessionView | null>(null);
const loading = ref(true);
const busy = ref(false);
const errorText = ref('');
const notice = ref('');
const commitResult = ref<RadarCommitCaptureSessionResult | null>(null);

const confirmedIndexes = reactive(new Set<number>());
const correctionDrafts = reactive(new Map<number, RadarCaptureRecognizedFields>());
const correctionNotes = reactive(new Map<number, string>());

function emptyFields(): RadarCaptureRecognizedFields {
  return {
    company: null, role: null, city: null,
    salaryMinK: null, salaryMaxK: null, salaryPeriod: null,
    experienceRequirement: null, educationRequirement: null,
  };
}

async function loadSession(): Promise<void> {
  if (sessionId.value === null) {
    loading.value = false;
    return;
  }
  loading.value = true;
  errorText.value = '';
  try {
    const loaded = await radarApi.getSession(sessionId.value);
    absorbView(loaded);
    // 会话已进入终态：清除本地 capability，刷新后不再恢复敏感会话。
    if (shouldClearOnStatus(loaded.session.status)) clearCapability();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // 会话不存在/已失效：丢弃 capability，不残留在 sessionStorage。
      clearCapability();
      sessionId.value = null;
    }
    errorText.value = error instanceof ApiError ? error.message : '加载采集预览失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  initSession();
  void loadSession();
});

const isDraftable = computed(() => view.value?.session.status === 'preview');

function itemCommitBlocked(item: RadarPreviewItem): boolean {
  return gateItemCommitBlocked(item);
}

function itemBlockingIssues(item: RadarPreviewItem): string[] {
  return gateItemBlockingIssues(item);
}

function itemActivityStatus(item: RadarPreviewItem): string | null {
  return readCapturedActivityStatus(item.extractionMetadata);
}

/** 是否存在任何「已勾选且未阻塞」的可提交条目（决定全局确认按钮可用性，§九）。 */
const hasCommittableItems = computed(() => (
  view.value !== null && canCommit(view.value.items, confirmedIndexes)
));

function toggleConfirmed(index: number, checked: boolean): void {
  // 阻塞条目（如 list_panel 未取到稳定岗位 ID）禁止纳入确认，防止建立错误来源记录（§六）。
  const item = view.value?.items.find((candidate) => candidate.index === index);
  if (checked && item !== undefined && itemCommitBlocked(item)) return;
  if (checked) confirmedIndexes.add(index);
  else confirmedIndexes.delete(index);
}

async function commit(): Promise<void> {
  if (view.value === null || sessionId.value === null) return;
  // §九 防御：只提交「已勾选且未被阻塞」的条目；无可提交条目时不发起任何 commit 请求。
  const committable = committableConfirmedIndexes(view.value.items, confirmedIndexes);
  if (committable.length === 0) {
    errorText.value = '没有可确认写入的条目（被阻塞或未勾选的条目不会写入）';
    return;
  }
  busy.value = true;
  errorText.value = '';
  try {
    const corrections: RadarCaptureItemCorrection[] = [];
    for (const item of view.value.items) {
      if (!committable.includes(item.index)) continue;
      const draft = correctionDrafts.get(item.index);
      if (draft === undefined) continue;
      const changed = JSON.stringify(draft) !== JSON.stringify({ ...emptyFields(), ...item.recognizedFields });
      if (changed) {
        corrections.push({
          index: item.index,
          recognizedFields: draft,
          correctionNote: correctionNotes.get(item.index) ?? null,
        });
      }
    }
    commitResult.value = await radarApi.commitSession(sessionId.value, {
      confirmedIndexes: committable,
      corrections,
    });
    view.value = { ...view.value, session: commitResult.value.session };
    clearCapability();
    notice.value = '已确认写入，草稿采集会话结束';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '确认写入失败';
  } finally {
    busy.value = false;
  }
}

async function cancel(): Promise<void> {
  if (sessionId.value === null) return;
  busy.value = true;
  errorText.value = '';
  try {
    const session = await radarApi.cancelSession(sessionId.value);
    if (view.value !== null) view.value = { ...view.value, session };
    clearCapability();
    notice.value = '已取消本次采集，未写入任何数据';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '取消采集失败';
  } finally {
    busy.value = false;
  }
}

function outcomeLabel(kind: string): string {
  if (kind === 'created') return '已创建新候选';
  if (kind === 'unchanged') return '内容未变化（幂等，未写入新版本）';
  return '来源已存在但内容变化，已创建新版本';
}

function absorbView(next: RadarCaptureSessionView): void {
  view.value = next;
  for (const item of next.items) {
    if (!correctionDrafts.has(item.index)) {
      // §九/§四 阻塞条目不默认勾选；批量项仅 captured 默认勾选（needs_correction 需人工确认后再勾）。
      if (shouldDefaultConfirm(item)) confirmedIndexes.add(item.index);
      correctionDrafts.set(item.index, { ...emptyFields(), ...item.recognizedFields });
    }
  }
}

/** 批量采集汇总（存在 boss_batch_capture 项时展示）。 */
const batchSummary = computed(() => {
  const items = view.value?.items ?? [];
  const batchItems = items.filter((item) => {
    const meta = item.extractionMetadata as { kind?: unknown } | null | undefined;
    return meta !== null && meta !== undefined && meta.kind === 'boss_batch_capture';
  });
  if (batchItems.length === 0) return null;
  let captured = 0;
  let needsCorrection = 0;
  let blocked = 0;
  for (const item of batchItems) {
    const status = batchItemStatus(item);
    if (itemCommitBlocked(item)) blocked += 1;
    else if (status === 'needs_correction') needsCorrection += 1;
    else captured += 1;
  }
  return { total: batchItems.length, captured, needsCorrection, blocked };
});

</script>

<template>
  <main class="radar-import-page" data-testid="radar-import-page">
    <header class="hero">
      <div>
        <div class="eyebrow">OfferFlow v0.8 · V8-2</div>
        <h1>当前页采集预览</h1>
        <p>核对采集到的字段，纠正后再确认写入。取消不会创建任何 Snapshot 或 Candidate。</p>
      </div>
    </header>

    <RadarStageStepper current="collect" class="block" @navigate="goStage" />
    <RadarGuideBar
      class="block"
      what="收集岗位：采集当前页并写入草稿候选库"
      now="核对字段、纠正后勾选要写入的条目，再点「确认写入」"
      next="写入成功后去「审核处理」登记重复与变化"
    />

    <n-alert v-if="errorText" type="error" closable class="block" data-testid="radar-import-error" @close="errorText = ''">{{ errorText }}</n-alert>
    <n-alert v-if="notice" type="success" closable class="block" data-testid="radar-import-notice" @close="notice = ''">{{ notice }}</n-alert>

    <n-spin :show="loading">
      <template v-if="view !== null">
        <n-card size="small" class="block">
          <n-space justify="space-between" align="center">
            <span>会话 {{ truncateSessionId(view.session.id) }}</span>
            <n-tag size="small">{{ view.session.status }}</n-tag>
          </n-space>
        </n-card>

        <n-card v-if="batchSummary !== null" size="small" title="批量采集汇总" class="block" data-testid="radar-batch-summary">
          <n-space>
            <n-tag size="small">共 {{ batchSummary.total }} 项</n-tag>
            <n-tag size="small" type="success">已采集 {{ batchSummary.captured }}</n-tag>
            <n-tag size="small" type="warning">待确认 {{ batchSummary.needsCorrection }}</n-tag>
            <n-tag size="small" type="error">阻塞 {{ batchSummary.blocked }}</n-tag>
          </n-space>
          <n-text depth="3" style="display:block;margin-top:8px">仅「已采集」项默认勾选；「待确认」需人工核对后勾选；「阻塞」项不可写入。提交失败数见扩展浮层提示。</n-text>
        </n-card>

        <n-empty v-if="view.items.length === 0" description="该会话尚未采集到任何条目" class="block" />

        <n-card
          v-for="item in view.items"
          :key="item.index"
          size="small"
          class="block"
          :data-testid="`radar-preview-item-${item.index}`"
        >
          <template #header>
            <n-space align="center">
              <n-checkbox
                :checked="confirmedIndexes.has(item.index)"
                :disabled="!isDraftable || itemCommitBlocked(item)"
                :data-testid="`radar-confirm-${item.index}`"
                @update:checked="(checked: boolean) => toggleConfirmed(item.index, checked)"
              >
                纳入本次确认
              </n-checkbox>
              <n-text depth="3">{{ item.captureMethod }}</n-text>
            </n-space>
          </template>

          <n-space vertical size="small">
            <n-alert
              v-if="itemCommitBlocked(item)"
              type="error"
              class="block"
              :data-testid="`radar-blocked-${item.index}`"
            >
              该条目暂不可写入：{{ itemBlockingIssues(item).join('；') || '缺少稳定岗位身份' }}
            </n-alert>
            <n-text depth="3">来源 URL：{{ item.sourceUrl ?? '（无）' }}</n-text>
            <n-text depth="3">页面标题：{{ item.pageTitle ?? '（未识别）' }}</n-text>

            <n-space vertical size="small" v-if="correctionDrafts.get(item.index)">
              <n-space :wrap="true" size="small">
                <n-space vertical size="small">
                  <n-text depth="3">公司</n-text>
                  <n-input v-model:value="correctionDrafts.get(item.index)!.company" :disabled="!isDraftable" placeholder="未识别" />
                </n-space>
                <n-space vertical size="small">
                  <n-text depth="3">岗位</n-text>
                  <n-input v-model:value="correctionDrafts.get(item.index)!.role" :disabled="!isDraftable" placeholder="未识别" />
                </n-space>
                <n-space vertical size="small">
                  <n-text depth="3">城市</n-text>
                  <n-input v-model:value="correctionDrafts.get(item.index)!.city" :disabled="!isDraftable" placeholder="未识别" />
                </n-space>
                <n-space vertical size="small">
                  <n-text depth="3">薪资下限（K）</n-text>
                  <n-input-number v-model:value="correctionDrafts.get(item.index)!.salaryMinK" :disabled="!isDraftable" clearable />
                </n-space>
                <n-space vertical size="small">
                  <n-text depth="3">薪资上限（K）</n-text>
                  <n-input-number v-model:value="correctionDrafts.get(item.index)!.salaryMaxK" :disabled="!isDraftable" clearable />
                </n-space>
                <n-space vertical size="small">
                  <n-text depth="3">学历要求</n-text>
                  <n-input
                    v-model:value="correctionDrafts.get(item.index)!.educationRequirement"
                    :disabled="!isDraftable"
                    placeholder="未识别"
                    :data-testid="`radar-education-${item.index}`"
                  />
                </n-space>
                <n-space vertical size="small">
                  <n-text depth="3">招聘者活跃度（采集时）</n-text>
                  <n-input
                    :value="itemActivityStatus(item)"
                    readonly
                    placeholder="未识别"
                    :data-testid="`radar-activity-${item.index}`"
                  />
                </n-space>
              </n-space>
              <n-text depth="3">活跃度是采集时只读快照，会随招聘者状态变化，不作为岗位长期事实。</n-text>
              <n-input
                :model-value="correctionNotes.get(item.index) ?? ''"
                :disabled="!isDraftable"
                placeholder="纠正说明（可留空）"
                @update:model-value="(value: string) => correctionNotes.set(item.index, value)"
              />
            </n-space>

            <n-collapse>
              <n-collapse-item title="原始可见文本（默认折叠）" name="raw">
                <pre class="raw-text">{{ item.visibleText }}</pre>
              </n-collapse-item>
            </n-collapse>
          </n-space>
        </n-card>

        <n-card v-if="isDraftable" size="small" title="确认写入" class="block" data-testid="radar-confirm-card">
          <n-alert type="warning" class="block">
            确认后将为每个勾选条目写入不可变 Snapshot 与 CandidateVersion；未勾选条目不会写入。取消将结束本次采集，不写入任何数据。
          </n-alert>
          <n-alert v-if="!hasCommittableItems" type="info" class="block" data-testid="radar-no-committable">
            没有可确认写入的条目：被阻塞或未勾选的条目不会写入。
          </n-alert>
          <n-space>
            <n-button type="primary" :loading="busy" :disabled="!hasCommittableItems" data-testid="radar-commit" @click="commit">确认写入</n-button>
            <n-button :loading="busy" data-testid="radar-cancel" @click="cancel">取消本次采集</n-button>
          </n-space>
        </n-card>

        <n-card v-if="commitResult !== null" size="small" title="写入结果" class="block" data-testid="radar-result">
          <n-table :bordered="false">
            <thead><tr><th>条目</th><th>结果</th><th>决策</th><th>候选 ID</th></tr></thead>
            <tbody>
              <tr v-for="outcome in commitResult.outcomes" :key="outcome.index">
                <td>#{{ outcome.index }}</td>
                <td><n-tag size="small">{{ outcomeLabel(outcome.kind) }}</n-tag></td>
                <td><n-tag size="small" :type="outcome.analysisEligible === false ? 'warning' : 'default'">{{ outcome.decisionType ?? '—' }}</n-tag></td>
                <td>{{ outcome.candidateId === null ? '（未建候选）' : outcome.candidateId.slice(0, 8) }}</td>
              </tr>
            </tbody>
          </n-table>
          <!-- 写入成功后的唯一主 CTA：把用户送到主线下一站「审核处理」，不留原地。 -->
          <RadarNextActionCard
            class="block"
            title="已写入草稿候选，去审核处理"
            hint="在评审工作台登记重复与变化，必要时生成岗位建议并晋升。"
            cta="去审核岗位"
            @act="goReview"
          />
        </n-card>
      </template>
    </n-spin>
  </main>
</template>

<style scoped>
.radar-import-page { display: flex; flex-direction: column; gap: 16px; padding-bottom: 56px; }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 28px; border: 1px solid var(--of-line, #e2e8f0); border-radius: var(--of-radius, 16px); background: linear-gradient(135deg, #fff, #f0f7ff); box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.hero h1 { margin: 4px 0 8px; font-size: 30px; }
.hero p { max-width: 760px; margin: 0; color: var(--of-ink-2, #475569); }
.eyebrow { color: var(--of-brand, #2563eb); font-weight: 700; font-size: 12px; letter-spacing: .08em; }
.block { margin-top: 16px; }
.raw-text { white-space: pre-wrap; color: var(--of-ink-2, #475569); max-height: 240px; overflow-y: auto; }
@media (max-width: 860px) { .hero { align-items: flex-start; flex-direction: column; } }
</style>
