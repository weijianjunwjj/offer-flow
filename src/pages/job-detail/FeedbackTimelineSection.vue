<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { ApplicationApiError } from '../../api/jobMemoryApi';
import type { FeedbackEventRecord } from '../../domain/job-memory';
import {
  formatActorLabel,
  formatApplicationChannelLabel,
  formatApplicationOutcomeLabel,
  formatApplicationStageLabel,
  formatClosedState,
  formatCommunicationStatusLabel,
  formatDateTime,
  formatEvidenceLevelLabel,
  formatProjectionStatusLabel,
  formatReasonCodeLabel,
  formatSourceConfidenceLabel,
  formatVoidedState,
} from '../../domain/presentation';
import { isJobDetailBundleV2 } from '../../page-scopes/jobDetailTypes';
import { navigationConfirm } from '../../router/confirmNavigation';
import FeedbackEventFields from './FeedbackEventFields.vue';
import { formatEventTime, eventTimePrecisionLabel } from './feedbackEventTime';
import {
  CLOSING_EVENT_TYPES,
  HIGH_IMPACT_EVENT_TYPES,
  buildAppendFeedbackEventRequest,
  buildTimelineEntries,
  buildVoidFeedbackEventRequest,
  canVoidTimelineEvent,
  createEmptyEventDraft,
  createEventVoidDraft,
  eventFactPreview,
  eventTypeLabel,
  fingerprintEventDrafts,
  type FeedbackEventDraft,
  type FeedbackEventVoidDraft,
} from './feedbackTimelineModel';
import { useInjectedDetailScope } from './sectionScope';

const props = defineProps<{ scopeRequired: boolean }>();
const scope = useInjectedDetailScope(props.scopeRequired);
const writeError = ref('');
const projectionTechnicalExpanded = ref(false);
const expandedEventTechnicalIds = ref<ReadonlySet<string>>(new Set());

const bundle = computed(() => {
  const current = scope?.$source.bundle ?? null;
  return current !== null && isJobDetailBundleV2(current) ? current : null;
});
const selected = computed(() => bundle.value?.memory.applications.find(
  ({ record }) => record.id === scope?.selectedApplicationId,
) ?? null);
const entries = computed(() => buildTimelineEntries(selected.value?.events ?? []));
const writeInFlight = computed(() => scope?.actionStatus.applicationWrite === 'loading');
const eventDraft = computed<FeedbackEventDraft | null>({
  get: () => scope?.eventDraft ?? null,
  set: (value) => { if (scope) scope.eventDraft = value; },
});
const eventVoidDraft = computed<FeedbackEventVoidDraft | null>({
  get: () => scope?.eventVoidDraft ?? null,
  set: (value) => { if (scope) scope.eventVoidDraft = value; },
});
const appendRequest = computed(() => (
  eventDraft.value === null || selected.value === null
    ? null
    : buildAppendFeedbackEventRequest(eventDraft.value, selected.value.record.rowVersion)
));
const voidRequest = computed(() => (
  eventVoidDraft.value === null || selected.value === null
    ? null
    : buildVoidFeedbackEventRequest(eventVoidDraft.value, selected.value.record.rowVersion)
));

function formatRecordedTime(value: number): string {
  return formatDateTime(value);
}

function nullableTime(value: number | null): string {
  return formatDateTime(value, '尚未记录');
}

function toggleEventTechnicalInfo(eventId: string, open: boolean): void {
  const next = new Set(expandedEventTechnicalIds.value);
  if (open) next.add(eventId);
  else next.delete(eventId);
  expandedEventTechnicalIds.value = next;
}

function markEventDraftBaseline(): void {
  if (!scope) return;
  scope.eventDraftBaselineFingerprint = fingerprintEventDrafts(scope.eventDraft, scope.eventVoidDraft);
}

function openComposer(): void {
  if (!scope || selected.value === null || selected.value.record.voidedAt !== null) return;
  writeError.value = '';
  scope.eventDraft = createEmptyEventDraft(selected.value.record.channel);
  scope.eventVoidDraft = null;
  scope.timelineUi.composerExpanded = true;
  markEventDraftBaseline();
}

function openVoid(event: FeedbackEventRecord): void {
  if (!scope || selected.value === null) return;
  writeError.value = '';
  scope.eventDraft = null;
  scope.eventVoidDraft = createEventVoidDraft(event.id, event.channel ?? selected.value.record.channel);
  scope.timelineUi.composerExpanded = false;
  markEventDraftBaseline();
}

function closeDraft(): void {
  if (!scope || writeInFlight.value) return;
  if (scope.isEventDirty && !navigationConfirm.confirmDiscardChanges('放弃尚未提交的反馈事实草稿？')) return;
  scope.resetEventDrafts();
  writeError.value = '';
}

function confirmationText(draft: FeedbackEventDraft): string {
  const closes = CLOSING_EVENT_TYPES.has(draft.eventType);
  return [
    '确认写入这条求职事实？',
    `事实：${eventFactPreview(draft)}`,
    `时间精度：${eventTimePrecisionLabel(draft.timePrecision)}`,
    `事实主体：${formatActorLabel(draft.actor)}`,
    `原因：${formatReasonCodeLabel(draft.reasonCode.trim())}`,
    `是否关闭投影：${closes ? '是' : '否'}`,
    '是否可能改变默认流程摘要：是（最终以服务端投影为准）',
  ].join('\n');
}

async function submitEvent(): Promise<void> {
  if (!scope || !selected.value || !eventDraft.value || !appendRequest.value || writeInFlight.value) return;
  if (selected.value.record.voidedAt !== null || selected.value.projection.isVoided) {
    writeError.value = '已作废的求职流程不能新增事件。';
    return;
  }
  if (!appendRequest.value.ok || appendRequest.value.value === null) {
    writeError.value = appendRequest.value.error;
    return;
  }
  const requiresConfirmation = HIGH_IMPACT_EVENT_TYPES.has(eventDraft.value.eventType)
    || selected.value.projection.isClosed;
  if (requiresConfirmation) {
    const closedWarning = selected.value.projection.isClosed
      ? '\n当前流程已关闭：该记录不会重新开启旧流程；若是新的招聘流程，请在上方新建求职流程。'
      : '';
    if (!window.confirm(`${confirmationText(eventDraft.value)}${closedWarning}`)) return;
  }
  writeError.value = '';
  try {
    await scope.appendFeedbackEvent(selected.value.record.id, appendRequest.value.value);
  } catch (error) {
    writeError.value = readableError(error);
  }
}

async function submitVoid(): Promise<void> {
  if (!scope || !selected.value || !eventVoidDraft.value || !voidRequest.value || writeInFlight.value) return;
  if (!voidRequest.value.ok || voidRequest.value.value === null) {
    writeError.value = voidRequest.value.error;
    return;
  }
  const target = selected.value.events.find(({ id }) => id === eventVoidDraft.value?.targetEventId);
  if (!target) {
    writeError.value = '目标事件已不存在，请重新读取。';
    return;
  }
  const replacement = eventVoidDraft.value.replacementEnabled
    ? eventFactPreview(eventVoidDraft.value.replacementEvent)
    : '不添加替代事件';
  const replacementCloses = eventVoidDraft.value.replacementEnabled
    && CLOSING_EVENT_TYPES.has(eventVoidDraft.value.replacementEvent.eventType);
  const confirmed = window.confirm([
    '确认纠正这条历史记录？',
    `错误记录：${eventTypeLabel(target.eventType)}`,
    `作废原因：${eventVoidDraft.value.reason.trim()}`,
    `替代事实：${replacement}`,
    `替代事实是否关闭投影：${replacementCloses ? '是' : '否'}`,
    '是否可能改变默认流程摘要：是（最终以服务端投影为准）',
    '历史事件不会被原地覆盖；系统会追加作废审计，并在同一事务内可选追加替代事件。',
  ].join('\n'));
  if (!confirmed) return;
  writeError.value = '';
  try {
    await scope.voidFeedbackEvent(target.id, voidRequest.value.value);
  } catch (error) {
    writeError.value = readableError(error);
  }
}

function readableError(error: unknown): string {
  if (!(error instanceof ApplicationApiError)) return (error as Error).message;
  const labels: Partial<Record<ApplicationApiError['code'], string>> = {
    VERSION_CONFLICT: '求职流程版本已变化，已重新读取并保留纠错草稿；请核对后重试。',
    NETWORK_ERROR: '网络结果不确定，草稿和同一幂等键已保留；请核对时间线后重试。',
    EVENT_ALREADY_VOIDED: '该记录已被其他操作纠正，时间线已重新读取。',
    APPLICATION_ALREADY_VOIDED: '这条求职流程已作废，不能继续写入事件。',
    FEEDBACK_EVENT_NOT_FOUND: '目标事件不存在或已被移走，请重新读取。',
    INVALID_REPLACEMENT_EVENT: '替代事件不是允许的普通业务事实。',
    AUDIT_EVENT_NOT_USER_CREATABLE: '系统审计事件不能由用户直接创建。',
  };
  return labels[error.code] ?? error.message;
}

function eventDetails(event: FeedbackEventRecord): string[] {
  const details = [
    `事实主体：${formatActorLabel(event.actor)}`,
    `渠道：${event.channel === null ? '未记录渠道' : formatApplicationChannelLabel(event.channel)}`,
    `来源可信度：${formatSourceConfidenceLabel(event.sourceConfidence)}`,
    `证据强度：${formatEvidenceLevelLabel(event.evidenceLevel)}`,
  ];
  if (event.reasonCode !== null) details.push(`原因：${formatReasonCodeLabel(event.reasonCode)}`);
  if (event.eventType === 'no_response_recorded') {
    details.push(`观察截止：${formatRecordedTime(event.payload.observedAsOf)}`);
  }
  return details;
}

async function focusEvent(eventId: string): Promise<void> {
  if (!scope) return;
  scope.timelineUi.focusedEventId = eventId;
  await nextTick();
  document.getElementById(`feedback-event-${eventId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
</script>

<template>
  <section v-if="bundle" class="timeline-section" :data-scope-id="scope?.$id" data-feedback-timeline>
    <header class="section-head">
      <div>
        <h2>反馈事实时间线</h2>
        <p>历史事实不可原地覆盖；误录通过追加作废审计和可选替代事件纠正。</p>
      </div>
      <button
        v-if="selected && selected.record.voidedAt === null && !selected.projection.isVoided"
        type="button"
        class="primary-btn"
        @click="openComposer"
      >手工记录事实</button>
    </header>

    <div v-if="!selected" class="empty-state">
      请先在“求职流程”中创建或选择一条记录；时间线不会自动制造投递事实。
    </div>

    <template v-else>
      <p class="legacy-boundary">
        这里展示的是事实事件推导出的当前流程状态；决策面板与当前所选流程保持一致。
      </p>
      <div class="projection-grid" :class="`projection-${selected.projection.projectionStatus}`">
        <span><b>流程阶段</b>{{ formatApplicationStageLabel(selected.projection.stage) }}</span>
        <span><b>流程结果</b>{{ formatApplicationOutcomeLabel(selected.projection.outcome) }}</span>
        <span><b>沟通状态</b>{{ formatCommunicationStatusLabel(selected.projection.communicationStatus) }}</span>
        <span><b>跟进次数</b>{{ selected.projection.followUpCount }} 次</span>
        <span><b>下次可跟进时间</b>{{ nullableTime(selected.projection.nextAllowedFollowUpAt) }}</span>
        <span><b>最近有效事实</b>{{ nullableTime(selected.projection.lastMeaningfulEventAt) }}</span>
        <span><b>结束 / 作废</b>{{ formatClosedState(selected.projection.isClosed) }} / {{ formatVoidedState(selected.projection.isVoided) }}</span>
        <span><b>事实投影</b>{{ formatProjectionStatusLabel(selected.projection.projectionStatus) }}</span>
      </div>
      <p v-if="selected.projection.warnings.length || selected.projection.errors.length" class="projection-issues">
        当前流程投影存在 {{ selected.projection.warnings.length + selected.projection.errors.length }} 项技术提示，请核对事实记录。
      </p>
      <details class="technical-info" @toggle="projectionTechnicalExpanded = ($event.target as HTMLDetailsElement).open">
        <summary>查看技术信息</summary>
        <div v-if="projectionTechnicalExpanded">
          <p>流程标识：{{ selected.record.id }} · 行版本：{{ selected.record.rowVersion }}</p>
          <p>原始投影：{{ selected.projection.stage }} / {{ selected.projection.outcome ?? 'null' }} / {{ selected.projection.communicationStatus }} / {{ selected.projection.projectionStatus }}</p>
          <ul v-if="selected.projection.warnings.length || selected.projection.errors.length">
            <li v-for="issue in [...selected.projection.warnings, ...selected.projection.errors]" :key="`${issue.code}-${issue.eventId ?? ''}`">{{ issue.code }}：{{ issue.message }}</li>
          </ul>
        </div>
      </details>

      <p v-if="selected.record.voidedAt !== null || selected.projection.isVoided" class="closed-warning danger">
        当前求职流程已作废，禁止新增或纠正反馈事实。
      </p>
      <p v-else-if="selected.projection.isClosed" class="closed-warning">
        当前流程已关闭。新增入口默认收起；仍可补记晚到事实，但不会重开旧流程。再次投递请在上方新建求职流程。
      </p>

      <div v-if="entries.length === 0" class="empty-state">当前流程还没有反馈事实。</div>
      <div v-else class="timeline-list">
        <article
          v-for="entry in entries"
          :id="`feedback-event-${entry.event.id}`"
          :key="entry.event.id"
          class="timeline-entry"
          :class="{
            audit: entry.auditLabel !== null,
            voided: entry.isVoided,
            focused: scope?.timelineUi.focusedEventId === entry.event.id,
          }"
          :data-event-id="entry.event.id"
          :data-event-type="entry.event.eventType"
        >
          <header>
            <div class="event-title">
              <strong>{{ eventTypeLabel(entry.event.eventType) }}</strong>
              <i v-if="entry.auditLabel">{{ entry.auditLabel }}</i>
              <i v-if="entry.isVoided" class="voided-pill">已作废</i>
            </div>
            <button
              v-if="canVoidTimelineEvent(selected, entry)"
              type="button"
              class="correct-btn"
              @click="openVoid(entry.event)"
            >纠正记录</button>
          </header>
          <div class="time-row">
            <span>
              <b>发生时间 · {{ eventTimePrecisionLabel(entry.event.timePrecision) }}</b>
              {{ formatEventTime(entry.event.eventAt, entry.event.timePrecision) }}
            </span>
            <span><b>记录时间</b>{{ formatRecordedTime(entry.event.createdAt) }}</span>
          </div>
          <p class="event-meta">{{ eventDetails(entry.event).join(' · ') }}</p>
          <details class="technical-info event-technical" @toggle="toggleEventTechnicalInfo(entry.event.id, ($event.target as HTMLDetailsElement).open)">
            <summary>查看技术信息</summary>
            <p v-if="expandedEventTechnicalIds.has(entry.event.id)">事件标识：{{ entry.event.id }} · 原始类型：{{ entry.event.eventType }} · 记录来源：{{ entry.event.recordedBy }}</p>
          </details>
          <p v-if="entry.event.note" class="event-note">{{ entry.event.note }}</p>
          <p v-if="entry.event.eventType === 'legacy_status_imported'" class="audit-detail">
            弱证据 / 系统推断的迁移兼容记录，不伪装成用户确认的新事实。
          </p>
          <p v-if="entry.event.eventType === 'event_voided'" class="audit-detail">
            指向错误记录
            <button type="button" class="inline-link" @click="focusEvent(entry.event.targetEventId)">查看原记录</button>
            ；原因：{{ entry.event.payload.reason }}
          </p>
          <div v-if="entry.voidEvent" class="void-detail">
            <strong>作废原因：{{ entry.voidEvent.payload.reason }}</strong>
            <span>作废记录时间：{{ formatRecordedTime(entry.voidEvent.createdAt) }}</span>
            <span v-if="entry.replacementEvent">
              该记录已由另一条记录替代：
              <button type="button" class="inline-link" @click="focusEvent(entry.replacementEvent.id)">
                {{ eventTypeLabel(entry.replacementEvent.eventType) }}
              </button>
            </span>
          </div>
        </article>
      </div>
    </template>

    <p v-if="writeError" class="write-error" role="alert">{{ writeError }}</p>

    <div v-if="eventDraft && selected" class="modal-backdrop" role="presentation" @click.self="closeDraft">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="event-create-title">
        <header class="modal-head">
          <div><h2 id="event-create-title">手工记录反馈事实</h2><p>没有自动保存；默认值只是建议，提交前请逐项核对。</p></div>
          <button type="button" class="close-btn" :disabled="writeInFlight" @click="closeDraft">×</button>
        </header>
        <FeedbackEventFields v-model="eventDraft" />
        <div class="fact-preview" data-fact-preview>
          <b>事实预览</b>
          <span>{{ eventFactPreview(eventDraft) }}</span>
          <span>确认后将写入当前求职流程；不会自动发送或改变其他流程。</span>
        </div>
        <p v-if="selected.projection.isClosed" class="closed-warning">
          该流程已关闭；保存前会再次确认，事件不会重新开启旧流程。
        </p>
        <p v-if="writeError" class="write-error" role="alert">{{ writeError }}</p>
        <footer class="modal-actions">
          <button type="button" @click="closeDraft">取消</button>
          <button type="button" class="primary-btn" :disabled="writeInFlight" @click="submitEvent">
            {{ writeInFlight ? '提交中…' : '保存这条事实' }}
          </button>
        </footer>
      </section>
    </div>

    <div v-if="eventVoidDraft && selected" class="modal-backdrop" role="presentation" @click.self="closeDraft">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="event-void-title">
        <header class="modal-head">
          <div><h2 id="event-void-title">纠正历史记录</h2><p>原事件不会被覆盖；系统将追加作废审计。</p></div>
          <button type="button" class="close-btn" :disabled="writeInFlight" @click="closeDraft">×</button>
        </header>
        <label class="stack"><span>作废原因（必填）</span><textarea v-model="eventVoidDraft.reason" rows="3" data-void-reason /></label>
        <label class="replace-toggle"><input v-model="eventVoidDraft.replacementEnabled" type="checkbox" /><span>同时添加替代业务事件</span></label>
        <FeedbackEventFields v-if="eventVoidDraft.replacementEnabled" v-model="eventVoidDraft.replacementEvent" />
        <div class="fact-preview" data-void-preview>
          <b>纠错预览</b>
          <span>原记录将追加作废审计，不会被原地覆盖</span>
          <span v-if="eventVoidDraft.replacementEnabled">→ {{ eventFactPreview(eventVoidDraft.replacementEvent) }}</span>
          <span v-else>→ 不添加替代事件</span>
        </div>
        <p v-if="writeError" class="write-error" role="alert">{{ writeError }}</p>
        <footer class="modal-actions">
          <button type="button" @click="closeDraft">取消</button>
          <button type="button" class="danger-btn" :disabled="writeInFlight" @click="submitVoid">
            {{ writeInFlight ? '提交中…' : '二次确认并纠正' }}
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.timeline-section { margin: 20px 0; padding: 22px; border: 1px solid var(--of-line); border-radius: var(--of-radius); background: var(--of-card); box-shadow: var(--of-shadow); }
.section-head, .modal-head, .modal-actions, .timeline-entry header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.section-head h2, .modal-head h2 { margin: 0 0 5px; }
.section-head p, .modal-head p { margin: 0; color: var(--of-ink-2); font-size: 13px; line-height: 1.6; }
.primary-btn, .danger-btn, .close-btn, .correct-btn, .modal-actions button { border: 0; border-radius: 8px; padding: 8px 13px; cursor: pointer; }
.primary-btn { background: var(--of-brand); color: #fff; }
.danger-btn { background: #dc2626; color: #fff; }
button:disabled { cursor: not-allowed; opacity: .5; }
.legacy-boundary { margin: 16px 0; padding: 10px 12px; border-radius: 9px; background: #eff6ff; color: #334155; font-size: 13px; }
.projection-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 12px; border: 1px solid #dbeafe; border-radius: 10px; background: #f8fafc; color: #334155; font-size: 12px; }
.projection-grid span { min-width: 0; overflow-wrap: anywhere; }
.projection-grid b { display: block; margin-bottom: 2px; color: #94a3b8; font-size: 11px; }
.projection-degraded { border-color: #f59e0b; }
.projection-invalid { border-color: #ef4444; background: #fff7f7; }
.projection-issues { margin: 10px 0 0; padding: 10px 28px; border-radius: 8px; background: #fffbeb; color: #92400e; font-size: 12px; }
.closed-warning { margin: 12px 0; padding: 10px 12px; border-radius: 8px; background: #fff7ed; color: #9a3412; font-size: 12px; }
.closed-warning.danger { background: #fef2f2; color: #991b1b; }
.empty-state { margin-top: 14px; padding: 22px; text-align: center; border: 1px dashed #cbd5e1; border-radius: 10px; color: #64748b; }
.timeline-list { display: grid; gap: 12px; margin-top: 16px; }
.timeline-entry { padding: 14px; border: 1px solid #e2e8f0; border-radius: 11px; background: #fff; }
.timeline-entry.audit { background: #f8fafc; color: #64748b; }
.timeline-entry.voided { opacity: .68; border-style: dashed; }
.timeline-entry.voided .event-title strong { text-decoration: line-through; }
.timeline-entry.focused { box-shadow: 0 0 0 3px rgba(37,99,235,.2); }
.event-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.event-title i { padding: 2px 7px; border-radius: 999px; background: #e2e8f0; color: #475569; font-size: 11px; font-style: normal; }
.event-title i.voided-pill { background: #fee2e2; color: #991b1b; }
.event-title code { color: #94a3b8; font-size: 11px; }
.correct-btn { padding: 5px 9px; background: #f1f5f9; color: #334155; font-size: 12px; }
.time-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 10px; font-size: 12px; }
.time-row b { display: block; color: #94a3b8; font-size: 11px; }
.event-meta, .event-note, .audit-detail { margin: 8px 0 0; color: #64748b; font-size: 12px; line-height: 1.6; }
.void-detail { display: grid; gap: 5px; margin-top: 10px; padding: 10px; border-radius: 8px; background: #fef2f2; color: #991b1b; font-size: 12px; }
.inline-link { border: 0; padding: 0; background: transparent; color: #2563eb; cursor: pointer; text-decoration: underline; }
.write-error { margin: 12px 0 0; color: #b91c1c; font-size: 13px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 45; display: grid; place-items: center; padding: 24px; background: rgba(15,23,42,.42); }
.modal-card { width: min(820px, 100%); max-height: calc(100vh - 48px); overflow: auto; box-sizing: border-box; padding: 22px; border-radius: 16px; background: #fff; box-shadow: 0 24px 80px rgba(15,23,42,.28); }
.close-btn { padding: 2px 9px; background: #f1f5f9; font-size: 24px; }
.modal-head { margin-bottom: 18px; }
.fact-preview { display: grid; gap: 5px; margin-top: 14px; padding: 11px 12px; border-radius: 9px; background: #eff6ff; color: #334155; font-size: 12px; }
.modal-actions { justify-content: flex-end; margin-top: 20px; }
.stack { display: grid; gap: 6px; color: #475569; font-size: 12px; }
.stack textarea { box-sizing: border-box; width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; font: inherit; }
.replace-toggle { display: flex; align-items: center; gap: 8px; margin: 14px 0; color: #334155; font-size: 13px; }
@media (max-width: 760px) { .section-head { flex-direction: column; } .projection-grid, .time-row { grid-template-columns: 1fr; } .modal-backdrop { padding: 10px; } }
</style>
