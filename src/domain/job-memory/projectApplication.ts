import { ApplicationProjectionSchema, ApplicationRecordSchema, FeedbackEventRecordSchema } from './schemas';
import type {
  ApplicationOutcome,
  ApplicationProjection,
  ApplicationRecord,
  ApplicationStage,
  FeedbackEventRecord,
  LegacyStatusImportedPayload,
  ProjectionError,
  ProjectionErrorCode,
  ProjectionWarning,
  ProjectionWarningCode,
  SubmissionState,
} from './types';
import type { CommunicationStatus } from '../../storage/types';

const FOLLOWUP_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

interface ProjectionState {
  stage: ApplicationStage;
  outcome: ApplicationOutcome;
  communicationStatus: CommunicationStatus;
  submissionState: SubmissionState;
  appliedAt: number | null;
  lastMeaningfulEventAt: number | null;
  followUpCount: number;
  lastGreetedAt: number | null;
  lastFollowUpAt: number | null;
  isClosed: boolean;
  statusSourceEventId: string | null;
  pausedStage: ApplicationStage | null;
  pausedCommunicationStatus: CommunicationStatus | null;
}

function warning(
  code: ProjectionWarningCode,
  message: string,
  eventId?: string,
  targetEventId?: string,
): ProjectionWarning {
  return { code, message, ...(eventId ? { eventId } : {}), ...(targetEventId ? { targetEventId } : {}) };
}

function error(
  code: ProjectionErrorCode,
  message: string,
  eventId?: string,
  targetEventId?: string,
): ProjectionError {
  return { code, message, ...(eventId ? { eventId } : {}), ...(targetEventId ? { targetEventId } : {}) };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function canonicalEvent(event: FeedbackEventRecord): string {
  return JSON.stringify(canonicalize(event));
}

function emptyState(): ProjectionState {
  return {
    stage: 'created',
    outcome: null,
    communicationStatus: 'not_contacted',
    submissionState: 'unknown',
    appliedAt: null,
    lastMeaningfulEventAt: null,
    followUpCount: 0,
    lastGreetedAt: null,
    lastFollowUpAt: null,
    isClosed: false,
    statusSourceEventId: null,
    pausedStage: null,
    pausedCommunicationStatus: null,
  };
}

function issueText(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'issues' in value) {
    const issues = (value as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues ?? [];
    return issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
  }
  return String(value);
}

function effectiveTime(event: FeedbackEventRecord): number {
  return event.eventAt ?? event.createdAt;
}

function compareCreated(left: FeedbackEventRecord, right: FeedbackEventRecord): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareBusinessTime(left: FeedbackEventRecord, right: FeedbackEventRecord): number {
  return effectiveTime(left) - effectiveTime(right)
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id);
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function applyLegacySeed(state: ProjectionState, payload: LegacyStatusImportedPayload, eventId: string): void {
  state.lastGreetedAt = payload.lastGreetedAt;
  state.lastFollowUpAt = payload.lastFollowupAt;
  state.followUpCount = payload.followupCount;
  state.lastMeaningfulEventAt = maxNullable(payload.lastGreetedAt, payload.lastFollowupAt);
  state.statusSourceEventId = eventId;

  switch (payload.legacyStatus) {
    case 'not_contacted':
      break;
    case 'greeted_unread':
      state.stage = 'contacted';
      state.communicationStatus = 'greeted_unread';
      break;
    case 'greeted_read_no_reply':
      state.stage = 'contacted';
      state.communicationStatus = 'greeted_read_no_reply';
      break;
    case 'replied':
      state.stage = 'contacted';
      state.communicationStatus = 'replied';
      break;
    case 'interviewing':
      state.stage = 'interviewing';
      state.communicationStatus = 'interviewing';
      break;
    case 'paused':
      state.stage = 'paused';
      state.communicationStatus = 'paused';
      break;
    case 'closed':
      state.stage = 'closed';
      state.communicationStatus = 'closed';
      state.isClosed = true;
      break;
    case 'rejected':
      state.stage = 'closed';
      state.outcome = 'rejected';
      state.communicationStatus = 'rejected';
      state.isClosed = true;
      break;
  }
}

function markMeaningful(state: ProjectionState, event: FeedbackEventRecord, time?: number): void {
  state.lastMeaningfulEventAt = maxNullable(state.lastMeaningfulEventAt, time ?? effectiveTime(event));
}

function setActiveState(
  state: ProjectionState,
  event: FeedbackEventRecord,
  stage: ApplicationStage,
  communicationStatus: CommunicationStatus,
): void {
  state.stage = stage;
  state.communicationStatus = communicationStatus;
  state.statusSourceEventId = event.id;
  markMeaningful(state, event);
}

function closeState(
  state: ProjectionState,
  event: FeedbackEventRecord,
  outcome: Exclude<ApplicationOutcome, null>,
  communicationStatus: 'closed' | 'rejected',
): void {
  state.stage = 'closed';
  state.outcome = outcome;
  state.communicationStatus = communicationStatus;
  state.isClosed = true;
  state.statusSourceEventId = event.id;
  markMeaningful(state, event);
}

function reduceBusinessEvent(
  state: ProjectionState,
  event: FeedbackEventRecord,
  warnings: ProjectionWarning[],
): void {
  if (state.isClosed) {
    warnings.push(warning(
      'EVENT_AFTER_CLOSED',
      '流程关闭后的事件不能重新开启旧 Application',
      event.id,
    ));
    return;
  }

  switch (event.eventType) {
    case 'application_created':
      return;
    case 'applied':
      setActiveState(state, event, 'applied', 'not_contacted');
      state.submissionState = 'applied';
      state.appliedAt = event.eventAt;
      return;
    case 'hr_contacted':
      setActiveState(state, event, 'contacted', 'replied');
      state.submissionState = event.payload.submissionState;
      return;
    case 'greeting_sent':
      setActiveState(state, event, 'contacted', 'greeted_unread');
      state.lastGreetedAt = event.eventAt;
      return;
    case 'message_viewed':
      setActiveState(state, event, 'contacted', 'greeted_read_no_reply');
      return;
    case 'hr_replied':
      setActiveState(state, event, 'contacted', 'replied');
      return;
    case 'resume_requested':
    case 'phone_screen':
      setActiveState(state, event, 'screening', 'replied');
      return;
    case 'interview_scheduled':
    case 'interview_completed':
    case 'interview_advanced':
      setActiveState(state, event, 'interviewing', 'interviewing');
      return;
    case 'follow_up_sent':
      setActiveState(
        state,
        event,
        state.stage === 'created' || state.stage === 'applied' ? 'contacted' : state.stage,
        'greeted_unread',
      );
      state.followUpCount += 1;
      state.lastFollowUpAt = event.eventAt;
      return;
    case 'no_response_recorded':
      markMeaningful(state, event, event.payload.observedAsOf);
      return;
    case 'recruitment_paused':
    case 'recruitment_frozen':
      if (state.stage !== 'paused') {
        state.pausedStage = state.stage;
        state.pausedCommunicationStatus = state.communicationStatus;
      }
      setActiveState(state, event, 'paused', 'paused');
      return;
    case 'process_resumed':
      if (state.stage !== 'paused' || state.pausedStage === null || state.pausedCommunicationStatus === null) {
        warnings.push(warning('RESUME_WITHOUT_PAUSE', '没有可恢复的暂停前状态', event.id));
        markMeaningful(state, event);
        return;
      }
      setActiveState(state, event, state.pausedStage, state.pausedCommunicationStatus);
      state.pausedStage = null;
      state.pausedCommunicationStatus = null;
      return;
    case 'offer_received':
      setActiveState(state, event, 'offer', 'replied');
      return;
    case 'rejected':
      closeState(state, event, 'rejected', 'rejected');
      return;
    case 'user_withdrew':
      closeState(state, event, 'user_withdrew', 'closed');
      return;
    case 'position_closed':
      closeState(state, event, 'position_closed', 'closed');
      return;
    case 'marked_stale':
      closeState(state, event, 'stale', 'closed');
      return;
    case 'offer_declined':
      closeState(state, event, 'offer_declined', 'closed');
      return;
    case 'offer_accepted':
      closeState(state, event, 'offer_accepted', 'closed');
      return;
    case 'legacy_status_imported':
    case 'application_metadata_corrected':
    case 'application_voided':
    case 'event_voided':
      return;
  }
}

function canOverrideLegacyClosure(event: FeedbackEventRecord): boolean {
  return event.eventType !== 'application_created' && event.eventType !== 'no_response_recorded';
}

function baseProjection(
  state: ProjectionState,
  application: ApplicationRecord | null,
  warnings: ProjectionWarning[],
  errors: ProjectionError[],
): ApplicationProjection {
  const isVoided = application?.voidedAt !== null && application?.voidedAt !== undefined;
  const lastActionAt = maxNullable(state.lastGreetedAt, state.lastFollowUpAt);
  const projection: ApplicationProjection = {
    stage: isVoided ? 'closed' : state.stage,
    outcome: isVoided ? null : state.outcome,
    communicationStatus: isVoided ? 'closed' : state.communicationStatus,
    submissionState: state.submissionState,
    appliedAt: state.appliedAt,
    lastMeaningfulEventAt: state.lastMeaningfulEventAt,
    followUpCount: state.followUpCount,
    lastGreetedAt: state.lastGreetedAt,
    lastFollowUpAt: state.lastFollowUpAt,
    nextAllowedFollowUpAt: lastActionAt === null ? null : lastActionAt + FOLLOWUP_COOLDOWN_MS,
    isClosed: isVoided || state.isClosed,
    isVoided,
    statusSourceEventId: isVoided ? null : state.statusSourceEventId,
    projectionStatus: errors.length > 0 ? 'invalid' : warnings.length > 0 ? 'degraded' : 'valid',
    warnings,
    errors,
  };
  return projection;
}

export function projectApplication(
  applicationInput: ApplicationRecord,
  eventInputs: readonly FeedbackEventRecord[],
): ApplicationProjection {
  const warnings: ProjectionWarning[] = [];
  const errors: ProjectionError[] = [];
  const applicationResult = ApplicationRecordSchema.safeParse(applicationInput);
  const application = applicationResult.success ? applicationResult.data : null;
  if (application === null) {
    errors.push(error('INVALID_APPLICATION', `Application 校验失败：${issueText(applicationResult.error)}`));
  }

  const events: FeedbackEventRecord[] = [];
  const byId = new Map<string, FeedbackEventRecord>();
  const byIdempotencyKey = new Map<string, FeedbackEventRecord>();
  for (const input of eventInputs as readonly unknown[]) {
    const parsed = FeedbackEventRecordSchema.safeParse(input);
    if (!parsed.success) {
      const candidateId = typeof input === 'object' && input !== null && 'id' in input
        ? String((input as { id?: unknown }).id ?? '')
        : undefined;
      errors.push(error(
        'INVALID_EVENT',
        `FeedbackEvent 校验失败：${issueText(parsed.error)}`,
        candidateId || undefined,
      ));
      continue;
    }
    const event = parsed.data as FeedbackEventRecord;
    const sameId = byId.get(event.id);
    if (sameId !== undefined) {
      if (canonicalEvent(sameId) === canonicalEvent(event)) {
        warnings.push(warning('DUPLICATE_IDENTICAL_EVENT', '完全相同的重复事件已去重', event.id));
      } else {
        errors.push(error('DUPLICATE_EVENT_ID', '相同 Event ID 对应不同内容', event.id));
      }
      continue;
    }
    const sameKey = byIdempotencyKey.get(event.idempotencyKey);
    if (sameKey !== undefined) {
      if (canonicalEvent(sameKey) === canonicalEvent(event)) {
        warnings.push(warning(
          'DUPLICATE_IDENTICAL_IDEMPOTENCY_KEY',
          '完全相同的幂等事件已去重',
          event.id,
        ));
      } else {
        errors.push(error(
          'IDEMPOTENCY_KEY_CONFLICT',
          '相同 idempotencyKey 对应不同事件内容',
          event.id,
        ));
      }
      continue;
    }
    byId.set(event.id, event);
    byIdempotencyKey.set(event.idempotencyKey, event);
    events.push(event);
  }

  const applicationId = application?.id ?? (
    typeof applicationInput === 'object'
    && applicationInput !== null
    && 'id' in applicationInput
    && typeof applicationInput.id === 'string'
      ? applicationInput.id
      : ''
  );
  for (const event of events) {
    if (event.applicationId !== applicationId) {
      errors.push(error(
        'EVENT_APPLICATION_MISMATCH',
        '事件不属于目标 Application',
        event.id,
      ));
    }
  }

  const voidedEventIds = new Set<string>();
  const voidEvents = events
    .filter((event) => event.eventType === 'event_voided' && event.applicationId === applicationId)
    .sort(compareCreated);
  for (const voidEvent of voidEvents) {
    if (voidEvent.eventType !== 'event_voided') continue;
    const target = byId.get(voidEvent.targetEventId);
    if (target === undefined) {
      warnings.push(warning(
        'VOID_TARGET_NOT_FOUND',
        '作废事件引用的目标不存在',
        voidEvent.id,
        voidEvent.targetEventId,
      ));
      continue;
    }
    if (target.applicationId !== applicationId) {
      errors.push(error(
        'VOID_TARGET_OTHER_APPLICATION',
        '作废目标属于其他 Application',
        voidEvent.id,
        target.id,
      ));
      continue;
    }
    if (target.eventType === 'event_voided') {
      errors.push(error('VOID_TARGET_IS_VOID', '不能作废另一个 event_voided', voidEvent.id, target.id));
      continue;
    }
    if (voidEvent.payload.targetEventType !== target.eventType) {
      errors.push(error(
        'VOID_TARGET_TYPE_MISMATCH',
        'payload.targetEventType 与实际目标类型不一致',
        voidEvent.id,
        target.id,
      ));
      continue;
    }
    if (voidedEventIds.has(target.id)) {
      warnings.push(warning('DUPLICATE_VOID', '同一事件被重复作废，效果只应用一次', voidEvent.id, target.id));
      continue;
    }
    voidedEventIds.add(target.id);
  }

  const activeEvents = events.filter(
    (event) => event.applicationId === applicationId && !voidedEventIds.has(event.id),
  );
  const activeApplicationVoidAudits = activeEvents.filter(
    (event) => event.eventType === 'application_voided',
  );
  if (application?.voidedAt !== null && application?.voidedAt !== undefined && activeApplicationVoidAudits.length === 0) {
    warnings.push(warning(
      'APPLICATION_VOID_AUDIT_MISSING',
      'Application 行已作废，但缺少 application_voided 审计事件',
    ));
  }
  if ((application?.voidedAt === null || application === null) && activeApplicationVoidAudits.length > 0) {
    warnings.push(warning(
      'APPLICATION_VOID_AUDIT_WITHOUT_ROW',
      '存在 application_voided 审计事件，但 Application 行未作废',
      activeApplicationVoidAudits[0]?.id,
    ));
  }

  const state = emptyState();
  const legacySeeds = activeEvents
    .filter((event) => event.eventType === 'legacy_status_imported')
    .sort(compareCreated);
  const legacySeed = legacySeeds[0];
  if (legacySeed?.eventType === 'legacy_status_imported') {
    applyLegacySeed(state, legacySeed.payload, legacySeed.id);
    warnings.push(warning('LEGACY_SEED_APPLIED', '使用 weak/inferred legacy seed 建立兼容基线', legacySeed.id));
  }
  if (legacySeeds.length > 1) {
    warnings.push(warning(
      'MULTIPLE_LEGACY_SEEDS',
      '存在多个 legacy seed，按 createdAt/id 选择最早一条',
      legacySeed?.id,
    ));
  }

  const auditEventTypes = new Set<FeedbackEventRecord['eventType']>([
    'legacy_status_imported',
    'application_metadata_corrected',
    'application_voided',
    'event_voided',
  ]);
  const businessEvents = activeEvents
    .filter((event) => !auditEventTypes.has(event.eventType))
    .sort(compareBusinessTime);
  let legacyClosureActive = legacySeed !== undefined && state.isClosed;
  for (const event of businessEvents) {
    if (legacyClosureActive && canOverrideLegacyClosure(event)) {
      state.stage = 'created';
      state.outcome = null;
      state.communicationStatus = 'not_contacted';
      state.isClosed = false;
      state.statusSourceEventId = null;
      legacyClosureActive = false;
    }
    reduceBusinessEvent(state, event, warnings);
  }

  let projection = baseProjection(state, application, warnings, errors);
  const outputResult = ApplicationProjectionSchema.safeParse(projection);
  if (!outputResult.success) {
    errors.push(error(
      'INVALID_PROJECTION_OUTPUT',
      `投影输出校验失败：${issueText(outputResult.error)}`,
    ));
    projection = baseProjection(state, application, warnings, errors);
  }
  return projection;
}
