import type {
  ApplicationRecord,
  FeedbackEventPayloadByType,
  FeedbackEventRecord,
  FeedbackEventType,
} from './types';

export function makeApplication(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    id: 'application-1',
    jobId: 'job-1',
    resumeVersionId: null,
    origin: 'unknown',
    channel: 'unknown',
    channelOtherLabel: null,
    recruitingEntity: {
      kind: 'unknown',
      name: null,
      employerGroupKey: null,
      endClientName: null,
    },
    primaryContact: null,
    cityContext: { jobCity: null, marketCity: null, workMode: 'unknown' },
    draftMessageText: null,
    createdAt: 100,
    updatedAt: 100,
    voidedAt: null,
    voidReason: null,
    supersededByApplicationId: null,
    rowVersion: 1,
    ...overrides,
  };
}

function defaultPayload<Type extends FeedbackEventType>(
  eventType: Type,
): FeedbackEventPayloadByType[Type] {
  switch (eventType) {
    case 'hr_contacted':
      return { submissionState: 'unknown' } as FeedbackEventPayloadByType[Type];
    case 'no_response_recorded':
      return { observedAsOf: 1_000 } as FeedbackEventPayloadByType[Type];
    case 'legacy_status_imported':
      return {
        legacyStatus: 'not_contacted',
        lastGreetedAt: null,
        lastFollowupAt: null,
        followupCount: 0,
        note: null,
      } as FeedbackEventPayloadByType[Type];
    case 'application_metadata_corrected':
      return {
        correctedFields: ['channel'],
        before: { channel: 'unknown' },
        after: { channel: 'boss' },
        reason: '修正渠道',
      } as FeedbackEventPayloadByType[Type];
    case 'application_voided':
      return { reason: '误录' } as FeedbackEventPayloadByType[Type];
    case 'event_voided':
      return {
        targetEventId: 'target-event',
        targetEventType: 'greeting_sent',
        reason: '误录',
      } as FeedbackEventPayloadByType[Type];
    default:
      return {} as FeedbackEventPayloadByType[Type];
  }
}

type EventOverrides<Type extends FeedbackEventType> = Partial<Pick<
  FeedbackEventRecord,
  | 'id'
  | 'applicationId'
  | 'eventAt'
  | 'timePrecision'
  | 'actor'
  | 'recordedBy'
  | 'sourceConfidence'
  | 'evidenceLevel'
  | 'channel'
  | 'note'
  | 'reasonCode'
  | 'idempotencyKey'
  | 'createdAt'
>> & {
  payload?: FeedbackEventPayloadByType[Type];
};

export function makeEvent<Type extends FeedbackEventType>(
  eventType: Type,
  overrides: EventOverrides<Type> = {},
): Extract<FeedbackEventRecord, { eventType: Type }> {
  const payload = overrides.payload ?? defaultPayload(eventType);
  const targetEventId = eventType === 'event_voided'
    ? (payload as FeedbackEventPayloadByType['event_voided']).targetEventId
    : null;
  return {
    id: `event-${eventType}`,
    applicationId: 'application-1',
    eventType,
    eventAt: 1_000,
    timePrecision: 'exact',
    actor: 'user',
    recordedBy: 'user',
    sourceConfidence: 'exact',
    evidenceLevel: 'medium',
    channel: 'boss',
    note: null,
    reasonCode: null,
    idempotencyKey: `key-${eventType}`,
    createdAt: 1_000,
    ...overrides,
    payload,
    targetEventId,
  } as Extract<FeedbackEventRecord, { eventType: Type }>;
}

export function makeLegacyEvent(
  overrides: EventOverrides<'legacy_status_imported'> = {},
): Extract<FeedbackEventRecord, { eventType: 'legacy_status_imported' }> {
  return makeEvent('legacy_status_imported', {
    id: 'event-legacy',
    actor: 'system',
    recordedBy: 'system_migration',
    sourceConfidence: 'inferred',
    evidenceLevel: 'weak',
    timePrecision: 'unknown',
    eventAt: null,
    ...overrides,
  });
}

export function makeVoidEvent(
  target: FeedbackEventRecord,
  overrides: EventOverrides<'event_voided'> = {},
): Extract<FeedbackEventRecord, { eventType: 'event_voided' }> {
  return makeEvent('event_voided', {
    id: `void-${target.id}`,
    idempotencyKey: `void-key-${target.id}`,
    applicationId: target.applicationId,
    payload: {
      targetEventId: target.id,
      targetEventType: target.eventType === 'event_voided' ? 'application_created' : target.eventType,
      reason: '修正误录事件',
    },
    createdAt: target.createdAt + 1,
    eventAt: target.eventAt,
    timePrecision: target.eventAt === null ? 'unknown' : target.timePrecision,
    ...overrides,
  });
}
