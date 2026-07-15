<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NCollapse, NCollapseItem, NDatePicker, NEmpty, NInput,
  NList, NListItem, NModal, NRadio, NRadioGroup, NSelect, NSpace, NSpin, NSteps, NStep,
  NSwitch, NTable, NTag, NText,
} from 'naive-ui';
import { historyImportApi } from '../api/historyImportApi';
import { ApiError } from '../api/client';
import type {
  HistoricalBaselineDraft,
  HistoricalBaselineDraftContent,
  HistoricalEventDraft,
  HistoricalEventDraftContent,
  HistoricalImportConfirmResult,
  HistoricalImportSession,
  HistoricalImportSessionBundle,
} from '../domain/history-import';
import { HISTORICAL_EVENT_DRAFT_TYPES } from '../domain/history-import';
import {
  APPLICATION_CHANNEL_OPTIONS,
  EVIDENCE_LEVEL_OPTIONS,
  RECRUITING_ENTITY_KIND_OPTIONS,
  SOURCE_CONFIDENCE_OPTIONS,
  formatApplicationChannelLabel,
  formatDateTime,
  formatFeedbackEventTypeLabel,
  formatSourceConfidenceLabel,
} from '../domain/presentation';

type WizardStep = 'baseline' | 'events' | 'preview' | 'confirm' | 'result';

const STEP_INDEX: Record<WizardStep, number> = {
  baseline: 0,
  events: 1,
  preview: 2,
  confirm: 3,
  result: 4,
};

const TIME_PRECISION_OPTIONS = [
  { value: 'exact', label: '精确时间' },
  { value: 'date', label: '仅日期' },
  { value: 'approximate', label: '大约时间' },
  { value: 'unknown', label: '时间未知' },
];

const ACTOR_OPTIONS = [
  { value: 'user', label: '用户本人' },
  { value: 'hr', label: '招聘方 HR' },
  { value: 'interviewer', label: '面试官' },
  { value: 'recruiter', label: '招聘人员或猎头' },
  { value: 'system', label: '系统' },
];

const EVENT_TYPE_OPTIONS = HISTORICAL_EVENT_DRAFT_TYPES.map((type) => ({
  value: type,
  label: formatFeedbackEventTypeLabel(type),
}));

function emptyBaselineContent(): HistoricalBaselineDraftContent {
  return {
    company: '',
    role: '',
    city: null,
    actuallyApplied: true,
    appliedAt: Date.now(),
    timePrecision: 'approximate',
    channel: 'boss',
    recruitingEntityKind: 'unknown',
    recruitingEntityName: null,
    contactName: null,
    resumeVersionId: null,
    highestKnownStage: null,
    sourceConfidence: 'recalled',
    evidenceLevel: 'medium',
    notes: null,
    duplicateOfDraftId: null,
    keepAsIndependentProcess: false,
    independentProcessReason: null,
  };
}

function emptyEventContent(): HistoricalEventDraftContent {
  return {
    eventType: 'hr_replied',
    eventAt: Date.now(),
    timePrecision: 'approximate',
    actor: 'hr',
    sourceConfidence: 'recalled',
    evidenceLevel: 'medium',
    channel: null,
    reasonCode: null,
    note: null,
  };
}

const sessions = ref<HistoricalImportSession[]>([]);
const bundle = ref<HistoricalImportSessionBundle | null>(null);
const confirmResult = ref<HistoricalImportConfirmResult | null>(null);
const loading = ref(true);
const busy = ref(false);
const errorText = ref('');
const notice = ref('');

const currentSession = computed<HistoricalImportSession | null>(() => bundle.value?.session ?? null);
const step = computed<WizardStep>(() => {
  if (confirmResult.value !== null) return 'result';
  const status = currentSession.value?.status;
  if (status === 'confirmed') return 'result';
  if (status === 'preview_generated') return 'confirm';
  return 'baseline';
});
const stepIndex = computed(() => STEP_INDEX[step.value]);

const baselineModalVisible = ref(false);
const baselineModalDraftId = ref<string | null>(null);
const baselineForm = ref<HistoricalBaselineDraftContent>(emptyBaselineContent());

const eventModalVisible = ref(false);
const eventModalBaselineId = ref<string | null>(null);
const eventModalDraftId = ref<string | null>(null);
const eventForm = ref<HistoricalEventDraftContent>(emptyEventContent());

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `key-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function loadSessions(): Promise<void> {
  sessions.value = await historyImportApi.listSessions();
}

async function loadBundle(sessionId: string): Promise<void> {
  bundle.value = await historyImportApi.getSessionBundle(sessionId);
}

onMounted(async () => {
  loading.value = true;
  errorText.value = '';
  try {
    await loadSessions();
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '加载历史补录会话失败';
  } finally {
    loading.value = false;
  }
});

async function startNewSession(): Promise<void> {
  busy.value = true;
  errorText.value = '';
  try {
    const session = await historyImportApi.createSession();
    await loadSessions();
    await loadBundle(session.id);
    confirmResult.value = null;
    notice.value = '已创建新的历史补录会话，草稿不会影响正式数据';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '创建会话失败';
  } finally {
    busy.value = false;
  }
}

async function openSession(sessionId: string): Promise<void> {
  busy.value = true;
  errorText.value = '';
  confirmResult.value = null;
  try {
    await loadBundle(sessionId);
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '打开会话失败';
  } finally {
    busy.value = false;
  }
}

function closeSession(): void {
  bundle.value = null;
  confirmResult.value = null;
}

function openBaselineModal(draft: HistoricalBaselineDraft | null): void {
  baselineModalDraftId.value = draft?.id ?? null;
  baselineForm.value = draft
    ? { ...draft }
    : emptyBaselineContent();
  baselineModalVisible.value = true;
}

async function submitBaseline(): Promise<void> {
  if (bundle.value === null) return;
  busy.value = true;
  errorText.value = '';
  try {
    if (baselineModalDraftId.value === null) {
      await historyImportApi.createBaselineDraft(bundle.value.session.id, baselineForm.value);
    } else {
      const current = bundle.value.drafts.find((d) => d.draft.id === baselineModalDraftId.value)?.draft;
      if (current === undefined) throw new Error('草稿不存在');
      await historyImportApi.updateBaselineDraft(current.id, {
        ...baselineForm.value,
        expectedVersion: current.rowVersion,
      });
    }
    await loadBundle(bundle.value.session.id);
    baselineModalVisible.value = false;
    notice.value = '已保存最小基线草稿';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '保存基线草稿失败';
  } finally {
    busy.value = false;
  }
}

async function deleteBaseline(draft: HistoricalBaselineDraft): Promise<void> {
  if (bundle.value === null) return;
  busy.value = true;
  errorText.value = '';
  try {
    await historyImportApi.deleteBaselineDraft(draft.id);
    await loadBundle(bundle.value.session.id);
    notice.value = '已删除该基线草稿';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '删除基线草稿失败';
  } finally {
    busy.value = false;
  }
}

function openEventModal(baselineDraftId: string, draft: HistoricalEventDraft | null): void {
  eventModalBaselineId.value = baselineDraftId;
  eventModalDraftId.value = draft?.id ?? null;
  eventForm.value = draft ? { ...draft } : emptyEventContent();
  eventModalVisible.value = true;
}

async function submitEvent(): Promise<void> {
  if (bundle.value === null || eventModalBaselineId.value === null) return;
  busy.value = true;
  errorText.value = '';
  try {
    if (eventModalDraftId.value === null) {
      await historyImportApi.createEventDraft(eventModalBaselineId.value, eventForm.value);
    } else {
      const draft = bundle.value.drafts
        .flatMap((d) => d.events)
        .find((e) => e.id === eventModalDraftId.value);
      if (draft === undefined) throw new Error('事件草稿不存在');
      await historyImportApi.updateEventDraft(draft.id, {
        ...eventForm.value,
        expectedVersion: draft.rowVersion,
      });
    }
    await loadBundle(bundle.value.session.id);
    eventModalVisible.value = false;
    notice.value = '已保存详细事件补录草稿';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '保存事件草稿失败';
  } finally {
    busy.value = false;
  }
}

async function deleteEvent(draft: HistoricalEventDraft): Promise<void> {
  if (bundle.value === null) return;
  busy.value = true;
  errorText.value = '';
  try {
    await historyImportApi.deleteEventDraft(draft.id);
    await loadBundle(bundle.value.session.id);
    notice.value = '已删除该事件草稿';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '删除事件草稿失败';
  } finally {
    busy.value = false;
  }
}

async function goToPreview(): Promise<void> {
  if (bundle.value === null) return;
  busy.value = true;
  errorText.value = '';
  try {
    await historyImportApi.markPreviewGenerated(bundle.value.session.id, {
      expectedVersion: bundle.value.session.rowVersion,
    });
    await loadBundle(bundle.value.session.id);
    notice.value = '已生成预览，请核对无误后再确认';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '生成预览失败';
  } finally {
    busy.value = false;
  }
}

async function confirmImport(): Promise<void> {
  if (bundle.value === null) return;
  busy.value = true;
  errorText.value = '';
  try {
    confirmResult.value = await historyImportApi.confirmSession(bundle.value.session.id, {
      idempotencyKey: newKey(),
      expectedVersion: bundle.value.session.rowVersion,
    });
    await loadBundle(bundle.value.session.id);
    await loadSessions();
    notice.value = '已确认补录，结果不可撤回，如有错误请使用作废流程更正';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '确认补录失败';
  } finally {
    busy.value = false;
  }
}

async function discardImport(): Promise<void> {
  if (bundle.value === null) return;
  busy.value = true;
  errorText.value = '';
  try {
    await historyImportApi.discardSession(bundle.value.session.id, {
      expectedVersion: bundle.value.session.rowVersion,
    });
    await loadBundle(bundle.value.session.id);
    await loadSessions();
    notice.value = '已丢弃该补录会话，草稿不会写入正式数据';
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : '丢弃会话失败';
  } finally {
    busy.value = false;
  }
}

function outcomeLabel(kind: string): string {
  if (kind === 'created_application') return '已创建求职流程';
  if (kind === 'kept_independent_no_application') return '仅保留岗位记录（未投递）';
  return '已跳过（重复记录）';
}
</script>

<template>
  <main class="hi-page" data-testid="hi-page">
    <header class="hero">
      <div>
        <div class="eyebrow">OfferFlow v0.7 · G3</div>
        <h1>历史补录</h1>
        <p>补录过去未记录的投递与招聘反馈。所有草稿在确认前不会写入正式数据，可随时修改或丢弃。</p>
      </div>
    </header>

    <n-alert v-if="errorText" type="error" closable class="block" data-testid="hi-error" @close="errorText = ''">{{ errorText }}</n-alert>
    <n-alert v-if="notice" type="success" closable class="block" data-testid="hi-notice" @close="notice = ''">{{ notice }}</n-alert>

    <n-spin :show="loading">
      <template v-if="bundle === null">
        <n-card title="历史补录会话" data-testid="hi-session-list">
          <template #header-extra>
            <n-button type="primary" :loading="busy" data-testid="hi-new-session" @click="startNewSession">新建补录会话</n-button>
          </template>
          <n-empty v-if="sessions.length === 0" description="暂无历史补录会话" data-testid="hi-session-empty" />
          <n-list v-else>
            <n-list-item v-for="session in sessions" :key="session.id">
              <n-space justify="space-between" align="center" style="width: 100%">
                <div>
                  <strong>{{ session.id.slice(0, 8) }}</strong>
                  <n-text depth="3"> · 创建于 {{ formatDateTime(session.createdAt) }}</n-text>
                </div>
                <n-space>
                  <n-tag size="small">{{ session.status }}</n-tag>
                  <n-button size="small" :loading="busy" @click="openSession(session.id)">打开</n-button>
                </n-space>
              </n-space>
            </n-list-item>
          </n-list>
        </n-card>
      </template>

      <template v-else>
        <n-card :data-testid="'hi-wizard'">
          <template #header>
            <n-space justify="space-between" align="center" style="width: 100%">
              <span>会话 {{ bundle.session.id.slice(0, 8) }}</span>
              <n-button size="small" quaternary @click="closeSession">返回会话列表</n-button>
            </n-space>
          </template>

          <n-steps :current="stepIndex + 1" size="small" class="block">
            <n-step title="最小基线" description="补录公司/岗位/是否投递" />
            <n-step title="详细事件" description="补录招呼/回复/面试等细节（可选）" />
            <n-step title="预览" description="核对全部草稿" />
            <n-step title="确认" description="写入正式数据，不可撤回" />
            <n-step title="结果" description="查看补录结果" />
          </n-steps>

          <!-- 最小基线 -->
          <n-card size="small" title="最小基线草稿" class="block" data-testid="hi-baseline-list">
            <template #header-extra>
              <n-button size="small" :disabled="bundle.session.status !== 'draft'" :loading="busy" data-testid="hi-add-baseline" @click="openBaselineModal(null)">新增基线草稿</n-button>
            </template>
            <n-empty v-if="bundle.drafts.length === 0" description="尚未录入任何基线草稿" data-testid="hi-baseline-empty" />
            <n-list v-else>
              <n-list-item v-for="item in bundle.drafts" :key="item.draft.id" :data-testid="`hi-baseline-${item.draft.id}`">
                <n-space vertical size="small" style="width: 100%">
                  <n-space justify="space-between" align="center">
                    <div>
                      <strong>{{ item.draft.company }} · {{ item.draft.role }}</strong>
                      <n-text depth="3">
                        {{ item.draft.city ?? '城市未知' }}
                        · {{ formatApplicationChannelLabel(item.draft.channel) }}
                        · {{ item.draft.actuallyApplied ? '已投递' : '未投递（仅记录）' }}
                        · {{ formatSourceConfidenceLabel(item.draft.sourceConfidence) }}
                      </n-text>
                    </div>
                    <n-space>
                      <n-button size="small" :disabled="bundle.session.status !== 'draft'" @click="openEventModal(item.draft.id, null)">补录事件</n-button>
                      <n-button size="small" :disabled="bundle.session.status !== 'draft'" @click="openBaselineModal(item.draft)">修改</n-button>
                      <n-button size="small" type="error" ghost :disabled="bundle.session.status !== 'draft'" :loading="busy" @click="deleteBaseline(item.draft)">删除</n-button>
                    </n-space>
                  </n-space>
                  <n-table v-if="item.events.length > 0" size="small" :bordered="false">
                    <thead>
                      <tr><th>事件</th><th>时间</th><th>可信度</th><th></th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="ev in item.events" :key="ev.id">
                        <td>{{ formatFeedbackEventTypeLabel(ev.eventType) }}</td>
                        <td>{{ ev.eventAt ? formatDateTime(ev.eventAt) : '时间未知' }}</td>
                        <td>{{ formatSourceConfidenceLabel(ev.sourceConfidence) }}</td>
                        <td>
                          <n-space>
                            <n-button size="tiny" :disabled="bundle.session.status !== 'draft'" @click="openEventModal(item.draft.id, ev)">修改</n-button>
                            <n-button size="tiny" type="error" ghost :disabled="bundle.session.status !== 'draft'" :loading="busy" @click="deleteEvent(ev)">删除</n-button>
                          </n-space>
                        </td>
                      </tr>
                    </tbody>
                  </n-table>
                </n-space>
              </n-list-item>
            </n-list>
          </n-card>

          <!-- 预览与确认 -->
          <n-card v-if="bundle.session.status === 'draft'" size="small" title="生成预览" class="block">
            <n-text depth="3">生成预览前请确认所有基线与事件草稿已录入完整；生成预览后草稿仍可继续编辑。</n-text>
            <div class="block">
              <n-button type="primary" :disabled="bundle.drafts.length === 0" :loading="busy" data-testid="hi-preview" @click="goToPreview">生成预览</n-button>
            </div>
          </n-card>

          <n-card v-if="bundle.session.status === 'preview_generated'" size="small" title="确认补录" class="block" data-testid="hi-confirm-card">
            <n-alert type="warning" class="block">确认后将写入正式数据（创建岗位与求职流程），且不可原地撤回；如需更正请使用后续的作废流程。</n-alert>
            <n-space>
              <n-button type="primary" :loading="busy" data-testid="hi-confirm" @click="confirmImport">确认补录</n-button>
              <n-button :loading="busy" data-testid="hi-discard" @click="discardImport">丢弃该会话</n-button>
            </n-space>
          </n-card>

          <!-- 结果 -->
          <n-card v-if="confirmResult !== null" size="small" title="补录结果" class="block" data-testid="hi-result">
            <n-table :bordered="false">
              <thead><tr><th>基线草稿</th><th>结果</th></tr></thead>
              <tbody>
                <tr v-for="outcome in confirmResult.outcomes" :key="outcome.baselineDraftId">
                  <td>{{ outcome.baselineDraftId.slice(0, 8) }}</td>
                  <td><n-tag size="small">{{ outcomeLabel(outcome.kind) }}</n-tag></td>
                </tr>
              </tbody>
            </n-table>
          </n-card>
          <n-empty v-else-if="bundle.session.status === 'confirmed'" description="该会话已确认，但结果详情不可用（可能来自历史会话）" class="block" />
          <n-alert v-else-if="bundle.session.status === 'discarded'" type="warning" class="block">该会话已被丢弃。</n-alert>

          <n-collapse class="block">
            <n-collapse-item title="查看技术信息（默认折叠）" name="technical">
              <pre>{{ JSON.stringify({ sessionId: bundle.session.id, status: bundle.session.status, rowVersion: bundle.session.rowVersion, draftCount: bundle.drafts.length }, null, 2) }}</pre>
            </n-collapse-item>
          </n-collapse>
        </n-card>
      </template>
    </n-spin>

    <n-modal v-model:show="baselineModalVisible" preset="card" title="最小基线草稿" style="width: min(720px, 94vw)" data-testid="hi-baseline-modal">
      <n-space vertical size="large">
        <n-space vertical size="small">
          <n-text depth="3">公司</n-text>
          <n-input v-model:value="baselineForm.company" placeholder="公司名称" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">岗位</n-text>
          <n-input v-model:value="baselineForm.role" placeholder="岗位名称" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">城市</n-text>
          <n-input v-model:value="baselineForm.city" placeholder="城市（可留空）" clearable />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">是否实际投递</n-text>
          <n-switch v-model:value="baselineForm.actuallyApplied" />
        </n-space>
        <n-space v-if="baselineForm.actuallyApplied" vertical size="small">
          <n-text depth="3">投递时间</n-text>
          <n-date-picker v-model:value="baselineForm.appliedAt" type="datetime" clearable style="width: 100%" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">时间精度</n-text>
          <n-radio-group v-model:value="baselineForm.timePrecision">
            <n-radio v-for="opt in TIME_PRECISION_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</n-radio>
          </n-radio-group>
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">渠道</n-text>
          <n-select v-model:value="baselineForm.channel" :options="APPLICATION_CHANNEL_OPTIONS" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">招聘主体类型</n-text>
          <n-select v-model:value="baselineForm.recruitingEntityKind" :options="RECRUITING_ENTITY_KIND_OPTIONS" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">数据可信度</n-text>
          <n-select v-model:value="baselineForm.sourceConfidence" :options="SOURCE_CONFIDENCE_OPTIONS" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">证据强度</n-text>
          <n-select v-model:value="baselineForm.evidenceLevel" :options="EVIDENCE_LEVEL_OPTIONS" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">备注</n-text>
          <n-input v-model:value="baselineForm.notes" type="textarea" placeholder="补充说明（可留空）" clearable />
        </n-space>
        <n-space justify="end">
          <n-button @click="baselineModalVisible = false">取消</n-button>
          <n-button type="primary" :loading="busy" :disabled="!baselineForm.company.trim() || !baselineForm.role.trim()" data-testid="hi-baseline-submit" @click="submitBaseline">
            保存草稿
          </n-button>
        </n-space>
      </n-space>
    </n-modal>

    <n-modal v-model:show="eventModalVisible" preset="card" title="详细事件补录草稿" style="width: min(720px, 94vw)" data-testid="hi-event-modal">
      <n-space vertical size="large">
        <n-space vertical size="small">
          <n-text depth="3">事件类型</n-text>
          <n-select v-model:value="eventForm.eventType" :options="EVENT_TYPE_OPTIONS" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">事件时间</n-text>
          <n-date-picker v-model:value="eventForm.eventAt" type="datetime" clearable style="width: 100%" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">时间精度</n-text>
          <n-radio-group v-model:value="eventForm.timePrecision">
            <n-radio v-for="opt in TIME_PRECISION_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</n-radio>
          </n-radio-group>
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">动作发起方</n-text>
          <n-select v-model:value="eventForm.actor" :options="ACTOR_OPTIONS" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">数据可信度</n-text>
          <n-select v-model:value="eventForm.sourceConfidence" :options="SOURCE_CONFIDENCE_OPTIONS" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">证据强度</n-text>
          <n-select v-model:value="eventForm.evidenceLevel" :options="EVIDENCE_LEVEL_OPTIONS" />
        </n-space>
        <n-space vertical size="small">
          <n-text depth="3">备注</n-text>
          <n-input v-model:value="eventForm.note" type="textarea" placeholder="补充说明（可留空）" clearable />
        </n-space>
        <n-space justify="end">
          <n-button @click="eventModalVisible = false">取消</n-button>
          <n-button type="primary" :loading="busy" data-testid="hi-event-submit" @click="submitEvent">保存草稿</n-button>
        </n-space>
      </n-space>
    </n-modal>
  </main>
</template>

<style scoped>
.hi-page { display: flex; flex-direction: column; gap: 16px; padding-bottom: 56px; }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 28px; border: 1px solid var(--of-line, #e2e8f0); border-radius: var(--of-radius, 16px); background: linear-gradient(135deg, #fff, #f0f7ff); box-shadow: var(--of-shadow, 0 12px 30px -24px #0f172a); }
.hero h1 { margin: 4px 0 8px; font-size: 30px; }
.hero p { max-width: 760px; margin: 0; color: var(--of-ink-2, #475569); }
.eyebrow { color: var(--of-brand, #2563eb); font-weight: 700; font-size: 12px; letter-spacing: .08em; }
.block { margin-top: 16px; }
pre { white-space: pre-wrap; color: var(--of-ink-2, #475569); }
@media (max-width: 860px) { .hero { align-items: flex-start; flex-direction: column; } }
</style>
