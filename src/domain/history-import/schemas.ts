import { z } from 'zod';
import {
  ApplicationChannelSchema,
  RecruitingEntityKindSchema,
} from '../job-memory';
import {
  HISTORICAL_EVENT_DRAFT_TYPES,
  HISTORICAL_IMPORT_SESSION_STATUSES,
} from './types';
import type {
  HistoricalBaselineDraft,
  HistoricalEventDraft,
  HistoricalImportConfirmOutcome,
  HistoricalImportConfirmResult,
  HistoricalImportSession,
} from './types';

const nonBlankString = z.string().trim().min(1);
const nullableNonBlankString = nonBlankString.nullable();
const timestamp = z.number().finite().int().nonnegative();
const nullableTimestamp = timestamp.nullable();
const positiveInteger = z.number().finite().int().positive();

export const HistoricalImportSessionStatusSchema = z.enum(HISTORICAL_IMPORT_SESSION_STATUSES);
export const HistoricalEventDraftTypeSchema = z.enum(HISTORICAL_EVENT_DRAFT_TYPES);

const EventTimePrecisionSchema = z.enum(['exact', 'date', 'approximate', 'unknown']);
const FeedbackActorSchema = z.enum(['user', 'hr', 'interviewer', 'recruiter', 'system']);
const SourceConfidenceSchema = z.enum(['exact', 'approximate', 'recalled', 'inferred']);
const EvidenceLevelSchema = z.enum(['strong', 'medium', 'weak']);
const ApplicationStageSchema = z.enum([
  'created', 'applied', 'contacted', 'screening', 'interviewing', 'offer', 'paused', 'closed',
]);

export const HistoricalImportSessionSchema: z.ZodType<HistoricalImportSession> = z.strictObject({
  id: nonBlankString,
  status: HistoricalImportSessionStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  confirmedAt: nullableTimestamp,
  discardedAt: nullableTimestamp,
  rowVersion: positiveInteger,
}).superRefine((session, context) => {
  if (session.updatedAt < session.createdAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt 不得早于 createdAt' });
  }
  if (session.status === 'confirmed' && session.confirmedAt === null) {
    context.addIssue({ code: 'custom', path: ['confirmedAt'], message: 'confirmed 状态必须有 confirmedAt' });
  }
  if (session.status === 'discarded' && session.discardedAt === null) {
    context.addIssue({ code: 'custom', path: ['discardedAt'], message: 'discarded 状态必须有 discardedAt' });
  }
  if (session.confirmedAt !== null && session.discardedAt !== null) {
    context.addIssue({ code: 'custom', message: 'confirmedAt 与 discardedAt 不得同时存在' });
  }
}) as z.ZodType<HistoricalImportSession>;

export const HistoricalBaselineDraftSchema: z.ZodType<HistoricalBaselineDraft> = z.strictObject({
  id: nonBlankString,
  sessionId: nonBlankString,
  company: nonBlankString,
  role: nonBlankString,
  city: nullableNonBlankString,
  actuallyApplied: z.boolean(),
  appliedAt: nullableTimestamp,
  timePrecision: EventTimePrecisionSchema,
  channel: ApplicationChannelSchema,
  recruitingEntityKind: RecruitingEntityKindSchema,
  recruitingEntityName: nullableNonBlankString,
  contactName: nullableNonBlankString,
  resumeVersionId: nullableNonBlankString,
  highestKnownStage: ApplicationStageSchema.nullable(),
  sourceConfidence: SourceConfidenceSchema,
  evidenceLevel: EvidenceLevelSchema,
  notes: nullableNonBlankString,
  duplicateOfDraftId: nullableNonBlankString,
  keepAsIndependentProcess: z.boolean(),
  independentProcessReason: nullableNonBlankString,
  createdJobId: nullableNonBlankString,
  createdApplicationId: nullableNonBlankString,
  createdAt: timestamp,
  updatedAt: timestamp,
  rowVersion: positiveInteger,
}).superRefine((draft, context) => {
  if (draft.updatedAt < draft.createdAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt 不得早于 createdAt' });
  }
  if (draft.appliedAt === null && draft.timePrecision !== 'unknown') {
    context.addIssue({
      code: 'custom',
      path: ['timePrecision'],
      message: 'appliedAt 为空时 timePrecision 必须为 unknown',
    });
  }
  if (draft.duplicateOfDraftId === draft.id) {
    context.addIssue({ code: 'custom', path: ['duplicateOfDraftId'], message: '不能标记为自身重复' });
  }
  if (draft.keepAsIndependentProcess && draft.independentProcessReason === null) {
    context.addIssue({
      code: 'custom',
      path: ['independentProcessReason'],
      message: 'keepAsIndependentProcess=true 时必须提供理由',
    });
  }
  if (!draft.keepAsIndependentProcess && draft.independentProcessReason !== null) {
    context.addIssue({
      code: 'custom',
      path: ['independentProcessReason'],
      message: 'keepAsIndependentProcess=false 时不得携带理由',
    });
  }
  if (!draft.actuallyApplied && draft.createdApplicationId !== null) {
    context.addIssue({
      code: 'custom',
      path: ['createdApplicationId'],
      message: 'actuallyApplied=false 时不得创建 Application',
    });
  }
}) as z.ZodType<HistoricalBaselineDraft>;

export const HistoricalEventDraftSchema: z.ZodType<HistoricalEventDraft> = z.strictObject({
  id: nonBlankString,
  baselineDraftId: nonBlankString,
  eventType: HistoricalEventDraftTypeSchema,
  eventAt: nullableTimestamp,
  timePrecision: EventTimePrecisionSchema,
  actor: FeedbackActorSchema,
  sourceConfidence: SourceConfidenceSchema,
  evidenceLevel: EvidenceLevelSchema,
  channel: ApplicationChannelSchema.nullable(),
  reasonCode: nullableNonBlankString,
  note: nullableNonBlankString,
  createdFeedbackEventId: nullableNonBlankString,
  createdAt: timestamp,
  updatedAt: timestamp,
  rowVersion: positiveInteger,
}).superRefine((draft, context) => {
  if (draft.updatedAt < draft.createdAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt 不得早于 createdAt' });
  }
  if (draft.eventAt === null && draft.timePrecision !== 'unknown') {
    context.addIssue({
      code: 'custom',
      path: ['timePrecision'],
      message: 'eventAt 为空时 timePrecision 必须为 unknown',
    });
  }
}) as z.ZodType<HistoricalEventDraft>;

const HistoricalImportConfirmOutcomeSchema: z.ZodType<HistoricalImportConfirmOutcome> = z.strictObject({
  baselineDraftId: nonBlankString,
  kind: z.enum(['created_application', 'kept_independent_no_application', 'skipped_duplicate']),
  jobId: nullableNonBlankString,
  applicationId: nullableNonBlankString,
});

export const HistoricalImportConfirmResultSchema: z.ZodType<HistoricalImportConfirmResult> = z.strictObject({
  session: HistoricalImportSessionSchema,
  outcomes: z.array(HistoricalImportConfirmOutcomeSchema),
});
