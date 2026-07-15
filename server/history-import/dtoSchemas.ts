import { z } from 'zod';
import {
  ApplicationChannelSchema,
  RecruitingEntityKindSchema,
} from '../../src/domain/job-memory';
import {
  HISTORICAL_EVENT_DRAFT_TYPES,
} from '../../src/domain/history-import';

const nonBlankString = z.string().trim().min(1);
const nullableNonBlankString = nonBlankString.nullable();
const timestamp = z.number().finite().int().nonnegative();
const nullableTimestamp = timestamp.nullable();
const positiveInteger = z.number().finite().int().positive();

const TimePrecisionSchema = z.enum(['exact', 'date', 'approximate', 'unknown']);
const SourceConfidenceSchema = z.enum(['exact', 'approximate', 'recalled', 'inferred']);
const EvidenceLevelSchema = z.enum(['strong', 'medium', 'weak']);
const ApplicationStageSchema = z.enum([
  'created', 'applied', 'contacted', 'screening', 'interviewing', 'offer', 'paused', 'closed',
]);
const FeedbackActorSchema = z.enum(['user', 'hr', 'interviewer', 'recruiter', 'system']);

export const IdParamsSchema = z.strictObject({ id: nonBlankString });

export const CreateBaselineDraftRequestSchema = z.strictObject({
  company: nonBlankString,
  role: nonBlankString,
  city: nullableNonBlankString.optional().default(null),
  actuallyApplied: z.boolean(),
  appliedAt: nullableTimestamp,
  timePrecision: TimePrecisionSchema,
  channel: ApplicationChannelSchema,
  recruitingEntityKind: RecruitingEntityKindSchema,
  recruitingEntityName: nullableNonBlankString.optional().default(null),
  contactName: nullableNonBlankString.optional().default(null),
  resumeVersionId: nullableNonBlankString.optional().default(null),
  highestKnownStage: ApplicationStageSchema.nullable().optional().default(null),
  sourceConfidence: SourceConfidenceSchema,
  evidenceLevel: EvidenceLevelSchema,
  notes: nullableNonBlankString.optional().default(null),
  duplicateOfDraftId: nullableNonBlankString.optional().default(null),
  keepAsIndependentProcess: z.boolean().optional().default(false),
  independentProcessReason: nullableNonBlankString.optional().default(null),
}).superRefine((request, context) => {
  if (request.appliedAt === null && request.timePrecision !== 'unknown') {
    context.addIssue({
      code: 'custom',
      path: ['timePrecision'],
      message: 'appliedAt 为空时 timePrecision 必须为 unknown',
    });
  }
  if (request.keepAsIndependentProcess && request.independentProcessReason === null) {
    context.addIssue({
      code: 'custom',
      path: ['independentProcessReason'],
      message: 'keepAsIndependentProcess=true 时必须提供理由',
    });
  }
  if (!request.keepAsIndependentProcess && request.independentProcessReason !== null) {
    context.addIssue({
      code: 'custom',
      path: ['independentProcessReason'],
      message: 'keepAsIndependentProcess=false 时不得携带理由',
    });
  }
});

export const UpdateBaselineDraftRequestSchema = CreateBaselineDraftRequestSchema.and(
  z.strictObject({ expectedVersion: positiveInteger }),
);

export const CreateEventDraftRequestSchema = z.strictObject({
  eventType: z.enum(HISTORICAL_EVENT_DRAFT_TYPES),
  eventAt: nullableTimestamp,
  timePrecision: TimePrecisionSchema,
  actor: FeedbackActorSchema,
  sourceConfidence: SourceConfidenceSchema,
  evidenceLevel: EvidenceLevelSchema,
  channel: ApplicationChannelSchema.nullable().optional().default(null),
  reasonCode: nullableNonBlankString.optional().default(null),
  note: nullableNonBlankString.optional().default(null),
}).superRefine((request, context) => {
  if (request.eventAt === null && request.timePrecision !== 'unknown') {
    context.addIssue({
      code: 'custom',
      path: ['timePrecision'],
      message: 'eventAt 为空时 timePrecision 必须为 unknown',
    });
  }
});

export const UpdateEventDraftRequestSchema = CreateEventDraftRequestSchema.and(
  z.strictObject({ expectedVersion: positiveInteger }),
);

export const ConfirmSessionRequestSchema = z.strictObject({
  idempotencyKey: nonBlankString,
  expectedVersion: positiveInteger,
});

export const DiscardSessionRequestSchema = z.strictObject({
  expectedVersion: positiveInteger,
});

export type CreateBaselineDraftRequest = z.infer<typeof CreateBaselineDraftRequestSchema>;
export type UpdateBaselineDraftRequest = z.infer<typeof UpdateBaselineDraftRequestSchema>;
export type CreateEventDraftRequest = z.infer<typeof CreateEventDraftRequestSchema>;
export type UpdateEventDraftRequest = z.infer<typeof UpdateEventDraftRequestSchema>;
export type ConfirmSessionRequest = z.infer<typeof ConfirmSessionRequestSchema>;
export type DiscardSessionRequest = z.infer<typeof DiscardSessionRequestSchema>;
