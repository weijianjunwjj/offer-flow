import {
  UserFeedbackEventInputSchema,
  type AppendFeedbackEventRequest,
  type UserFeedbackEventInput,
  type VoidFeedbackEventRequest,
} from '../../../server/job-memory/dtoSchemas';
import type {
  ApplicationChannel,
  ApplicationMemory,
  EvidenceLevel,
  FeedbackActor,
  FeedbackEventRecord,
  FeedbackEventType,
  OrdinaryFeedbackEventType,
  SourceConfidence,
  EventTimePrecision,
} from '../../domain/job-memory';
import {
  formatActorLabel,
  formatFeedbackEventTypeLabel,
  formatReasonCodeLabel,
  formatTimePrecisionLabel,
} from '../../domain/presentation';
import { encodeEventTime } from './feedbackEventTime';

export const USER_EVENT_GROUPS = [
  {
    label: '投递与联系',
    eventTypes: [
      'applied', 'hr_contacted', 'greeting_sent', 'message_viewed', 'hr_replied',
      'resume_requested', 'phone_screen', 'follow_up_sent', 'no_response_recorded',
    ],
  },
  {
    label: '面试',
    eventTypes: ['interview_scheduled', 'interview_completed', 'interview_advanced'],
  },
  {
    label: '暂停与恢复',
    eventTypes: ['recruitment_paused', 'recruitment_frozen', 'process_resumed'],
  },
  {
    label: 'Offer 与结束',
    eventTypes: [
      'offer_received', 'rejected', 'user_withdrew', 'position_closed', 'marked_stale',
      'offer_declined', 'offer_accepted',
    ],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  eventTypes: readonly OrdinaryFeedbackEventType[];
}>;

export const USER_EVENT_TYPES = USER_EVENT_GROUPS.flatMap(({ eventTypes }) => [...eventTypes]);

export const AUDIT_EVENT_TYPES = new Set<FeedbackEventType>([
  'application_created',
  'application_metadata_corrected',
  'application_voided',
  'event_voided',
  'legacy_status_imported',
]);

export const HIGH_IMPACT_EVENT_TYPES = new Set<OrdinaryFeedbackEventType>([
  'rejected',
  'user_withdrew',
  'position_closed',
  'marked_stale',
  'offer_received',
  'offer_declined',
  'offer_accepted',
  'recruitment_frozen',
]);

export const CLOSING_EVENT_TYPES = new Set<OrdinaryFeedbackEventType>([
  'rejected',
  'user_withdrew',
  'position_closed',
  'marked_stale',
  'offer_declined',
  'offer_accepted',
]);

export const REJECTION_REASON_CODES = [
  'education', 'salary', 'skills', 'experience', 'headcount', 'position_closed', 'unknown', 'other',
] as const;

export interface FeedbackEventFactDraft {
  eventType: OrdinaryFeedbackEventType;
  eventAtInput: string;
  timePrecision: EventTimePrecision;
  actor: Exclude<FeedbackActor, 'system'>;
  sourceConfidence: SourceConfidence;
  evidenceLevel: EvidenceLevel;
  channel: ApplicationChannel | null;
  note: string;
  reasonCode: string;
  observedAsOfInput: string;
  hrContactedSubmissionState: 'not_applied' | 'unknown';
}

export interface FeedbackEventDraft extends FeedbackEventFactDraft {
  idempotencyKey: string;
}

export interface FeedbackEventVoidDraft {
  targetEventId: string;
  idempotencyKey: string;
  reason: string;
  replacementEnabled: boolean;
  replacementEvent: FeedbackEventFactDraft;
}

export interface TimelineUiState {
  composerExpanded: boolean;
  focusedEventId: string | null;
}

export interface TimelineEntry {
  event: FeedbackEventRecord;
  auditLabel: string | null;
  voidEvent: Extract<FeedbackEventRecord, { eventType: 'event_voided' }> | null;
  replacementEvent: FeedbackEventRecord | null;
  isVoided: boolean;
}

export interface DraftBuildResult<T> {
  ok: boolean;
  value: T | null;
  error: string;
}

export function newEventIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `feedback-event-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createEmptyEventFact(channel: ApplicationChannel | null): FeedbackEventFactDraft {
  return {
    eventType: 'applied',
    eventAtInput: '',
    timePrecision: 'unknown',
    actor: 'user',
    sourceConfidence: 'exact',
    evidenceLevel: 'medium',
    channel,
    note: '',
    reasonCode: '',
    observedAsOfInput: '',
    hrContactedSubmissionState: 'unknown',
  };
}

export function createEmptyEventDraft(channel: ApplicationChannel | null): FeedbackEventDraft {
  return { ...createEmptyEventFact(channel), idempotencyKey: newEventIdempotencyKey() };
}

export function createEventVoidDraft(
  targetEventId: string,
  channel: ApplicationChannel | null,
): FeedbackEventVoidDraft {
  return {
    targetEventId,
    idempotencyKey: newEventIdempotencyKey(),
    reason: '',
    replacementEnabled: false,
    replacementEvent: createEmptyEventFact(channel),
  };
}

export function fingerprintEventDrafts(
  eventDraft: FeedbackEventDraft | null,
  eventVoidDraft: FeedbackEventVoidDraft | null,
): string {
  return JSON.stringify({ eventDraft, eventVoidDraft });
}

function nullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

export function buildUserEventInput(
  draft: FeedbackEventFactDraft,
): DraftBuildResult<UserFeedbackEventInput> {
  const eventTime = encodeEventTime(draft.eventAtInput, draft.timePrecision);
  if (!eventTime.ok) return { ok: false, value: null, error: eventTime.error };

  let payload: Record<string, unknown> = {};
  if (draft.eventType === 'no_response_recorded') {
    const observed = encodeEventTime(draft.observedAsOfInput, 'exact');
    if (!observed.ok || observed.value === null) {
      return { ok: false, value: null, error: '请填写“截至何时仍未回复”的准确时间' };
    }
    payload = { observedAsOf: observed.value };
  } else if (draft.eventType === 'hr_contacted') {
    payload = { submissionState: draft.hrContactedSubmissionState };
  }

  const parsed = UserFeedbackEventInputSchema.safeParse({
    eventType: draft.eventType,
    eventAt: eventTime.value,
    timePrecision: draft.timePrecision,
    actor: draft.actor,
    sourceConfidence: draft.sourceConfidence,
    evidenceLevel: draft.evidenceLevel,
    channel: draft.channel,
    note: nullableText(draft.note),
    reasonCode: nullableText(draft.reasonCode),
    payload,
  });
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      error: parsed.error.issues.map((issue) => issue.message).join('；'),
    };
  }
  return { ok: true, value: parsed.data, error: '' };
}

export function buildAppendFeedbackEventRequest(
  draft: FeedbackEventDraft,
  expectedApplicationVersion: number,
): DraftBuildResult<AppendFeedbackEventRequest> {
  const event = buildUserEventInput(draft);
  if (!event.ok || event.value === null) return { ...event, value: null };
  return {
    ok: true,
    error: '',
    value: {
      idempotencyKey: draft.idempotencyKey,
      expectedApplicationVersion,
      ...event.value,
    },
  };
}

export function buildVoidFeedbackEventRequest(
  draft: FeedbackEventVoidDraft,
  expectedApplicationVersion: number,
): DraftBuildResult<VoidFeedbackEventRequest> {
  if (draft.reason.trim() === '') {
    return { ok: false, value: null, error: '请填写作废原因' };
  }
  let replacementEvent: UserFeedbackEventInput | null = null;
  if (draft.replacementEnabled) {
    const replacement = buildUserEventInput(draft.replacementEvent);
    if (!replacement.ok || replacement.value === null) return { ...replacement, value: null };
    replacementEvent = replacement.value;
  }
  return {
    ok: true,
    error: '',
    value: {
      idempotencyKey: draft.idempotencyKey,
      expectedApplicationVersion,
      reason: draft.reason.trim(),
      replacementEvent,
    },
  };
}

function compareTimeline(left: FeedbackEventRecord, right: FeedbackEventRecord): number {
  const leftTime = left.eventAt ?? left.createdAt;
  const rightTime = right.eventAt ?? right.createdAt;
  return rightTime - leftTime
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id);
}

export function auditLabel(eventType: FeedbackEventType): string | null {
  const labels: Partial<Record<FeedbackEventType, string>> = {
    application_created: '系统审计',
    application_metadata_corrected: '元数据纠正',
    application_voided: '系统审计',
    event_voided: '事件作废',
    legacy_status_imported: '迁移兼容',
  };
  return labels[eventType] ?? null;
}

export function buildTimelineEntries(events: readonly FeedbackEventRecord[]): TimelineEntry[] {
  const voidByTarget = new Map<string, Extract<FeedbackEventRecord, { eventType: 'event_voided' }>>();
  for (const event of [...events].sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ))) {
    if (event.eventType === 'event_voided' && !voidByTarget.has(event.targetEventId)) {
      voidByTarget.set(event.targetEventId, event);
    }
  }
  return [...events].sort(compareTimeline).map((event) => {
    const voidEvent = voidByTarget.get(event.id) ?? null;
    const replacementEvent = voidEvent === null
      ? null
      : events.find((candidate) => (
          candidate.idempotencyKey === `${voidEvent.idempotencyKey}:replacement`
          && candidate.applicationId === event.applicationId
        )) ?? null;
    return {
      event,
      auditLabel: auditLabel(event.eventType),
      voidEvent,
      replacementEvent: replacementEvent === undefined ? null : replacementEvent,
      isVoided: voidEvent !== null,
    };
  });
}

export function canVoidTimelineEvent(
  application: ApplicationMemory,
  entry: TimelineEntry,
): boolean {
  return application.record.voidedAt === null
    && !application.projection.isVoided
    && !AUDIT_EVENT_TYPES.has(entry.event.eventType)
    && !entry.isVoided
    && eventByApplication(application, entry.event);
}

function eventByApplication(application: ApplicationMemory, event: FeedbackEventRecord): boolean {
  return event.applicationId === application.record.id;
}

export function eventTypeLabel(eventType: FeedbackEventType): string {
  return formatFeedbackEventTypeLabel(eventType);
}

export function eventFactPreview(draft: FeedbackEventFactDraft): string {
  const time = draft.timePrecision === 'unknown'
    ? '发生时间未知'
    : `${draft.eventAtInput || '未填写'}（${formatTimePrecisionLabel(draft.timePrecision)}）`;
  return `${eventTypeLabel(draft.eventType)}；${time}；事实主体：${formatActorLabel(draft.actor)}`
    + `${draft.reasonCode.trim() === '' ? '' : `；原因：${formatReasonCodeLabel(draft.reasonCode.trim())}`}`;
}
