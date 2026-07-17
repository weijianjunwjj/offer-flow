import {
  FeedbackEventRecordSchema,
  type FeedbackEventRecord,
} from '../../src/domain/job-memory';
import type { UserFeedbackEventInput } from './dtoSchemas';
import type { JobMemoryServiceDeps } from './jobMemoryService';
import type { StoredFeedbackEvent } from './rowMappers';

export interface FeedbackEventFactoryOptions {
  applicationId: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
  requestHash: string;
  createdAt: number;
}

export function makeFeedbackEvent(
  deps: JobMemoryServiceDeps,
  options: FeedbackEventFactoryOptions,
): StoredFeedbackEvent {
  const input = options.input;
  const targetEventId = input.eventType === 'event_voided'
    ? input.targetEventId
    : null;
  const record = FeedbackEventRecordSchema.parse({
    id: deps.createId(),
    applicationId: options.applicationId,
    ...input,
    recordedBy: 'user',
    targetEventId,
    idempotencyKey: options.idempotencyKey,
    createdAt: options.createdAt,
  }) as FeedbackEventRecord;
  return { record, requestHash: options.requestHash };
}

export function makeUserFeedbackEvent(
  deps: JobMemoryServiceDeps,
  applicationId: string,
  input: UserFeedbackEventInput,
  idempotencyKey: string,
  requestHash: string,
): StoredFeedbackEvent {
  return makeFeedbackEvent(deps, {
    applicationId,
    input,
    idempotencyKey,
    requestHash,
    createdAt: deps.now(),
  });
}
