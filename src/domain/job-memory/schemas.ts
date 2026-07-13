import { z } from 'zod';
import { FEEDBACK_EVENT_TYPES } from './types';
import type {
  ApplicationMemory,
  ApplicationCorrectableField,
  ApplicationProjection,
  ApplicationRecord,
  ApplicationSummary,
  FeedbackEventRecord,
  JobDetailBundleV2,
  JobMemoryBundle,
  JobSummary,
  OrdinaryFeedbackEventType,
  ProjectionErrorCode,
  ProjectionWarningCode,
  ActiveResumeVersionResult,
  ResumeVersionListResponse,
  ResumeVersionRecord,
} from './types';
import type { JobRecord, JobSeekerProfile } from '../../storage/types';

const nonBlankString = z.string().trim().min(1);
const nullableNonBlankString = nonBlankString.nullable();
const timestamp = z.number().finite().int().nonnegative();
const nullableTimestamp = timestamp.nullable();
const positiveInteger = z.number().finite().int().positive();

export const ApplicationOriginSchema = z.enum(['outbound', 'inbound', 'unknown']);
export const ApplicationChannelSchema = z.enum([
  'boss', 'official_site', 'referral', 'headhunter', 'email', 'wechat', 'other', 'unknown',
]);
export const WorkModeSchema = z.enum(['onsite', 'hybrid', 'remote', 'unknown']);
export const RecruitingEntityKindSchema = z.enum([
  'direct_employer', 'outsourcing_vendor', 'staffing_agency', 'headhunter', 'unknown',
]);
export const ContactRoleSchema = z.enum([
  'company_hr', 'hiring_manager', 'headhunter', 'platform_recruiter', 'unknown',
]);

export const CityContextSchema = z.strictObject({
  jobCity: nullableNonBlankString,
  marketCity: nullableNonBlankString,
  workMode: WorkModeSchema,
});

export const RecruitingEntitySnapshotSchema = z.strictObject({
  kind: RecruitingEntityKindSchema,
  name: nullableNonBlankString,
  employerGroupKey: nullableNonBlankString,
  endClientName: nullableNonBlankString,
});

export const ContactSnapshotSchema = z.strictObject({
  displayName: nullableNonBlankString,
  role: ContactRoleSchema,
  platformId: nullableNonBlankString,
});

export const ApplicationRecordSchema: z.ZodType<ApplicationRecord> = z.strictObject({
  id: nonBlankString,
  jobId: nonBlankString,
  resumeVersionId: nullableNonBlankString,
  origin: ApplicationOriginSchema,
  channel: ApplicationChannelSchema,
  channelOtherLabel: nullableNonBlankString,
  recruitingEntity: RecruitingEntitySnapshotSchema,
  primaryContact: ContactSnapshotSchema.nullable(),
  cityContext: CityContextSchema,
  draftMessageText: nullableNonBlankString,
  createdAt: timestamp,
  updatedAt: timestamp,
  voidedAt: nullableTimestamp,
  voidReason: nullableNonBlankString,
  supersededByApplicationId: nullableNonBlankString,
  rowVersion: positiveInteger,
}).superRefine((application, context) => {
  if (application.channel === 'other' && application.channelOtherLabel === null) {
    context.addIssue({
      code: 'custom',
      path: ['channelOtherLabel'],
      message: 'channel=other 时必须提供 channelOtherLabel',
    });
  }
  if (application.channel !== 'other' && application.channelOtherLabel !== null) {
    context.addIssue({
      code: 'custom',
      path: ['channelOtherLabel'],
      message: '非 other channel 不得携带 channelOtherLabel',
    });
  }
  if (application.updatedAt < application.createdAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt 不得早于 createdAt' });
  }
  if (application.voidedAt !== null && application.voidedAt < application.createdAt) {
    context.addIssue({ code: 'custom', path: ['voidedAt'], message: 'voidedAt 不得早于 createdAt' });
  }
  if ((application.voidedAt === null) !== (application.voidReason === null)) {
    context.addIssue({
      code: 'custom',
      path: ['voidReason'],
      message: 'voidedAt 与 voidReason 必须同时存在或同时为空',
    });
  }
  if (application.supersededByApplicationId === application.id) {
    context.addIssue({
      code: 'custom',
      path: ['supersededByApplicationId'],
      message: 'Application 不能取代自身',
    });
  }
});

export const ResumeContentSnapshotSchema = z.strictObject({
  resumeText: z.string(),
  projectExperience: z.string(),
});

export const ResumeVersionRecordSchema: z.ZodType<ResumeVersionRecord> = z.strictObject({
  id: nonBlankString,
  name: nonBlankString,
  source: z.enum(['profile_snapshot', 'pasted_text', 'imported_file_text']),
  contentHash: nonBlankString,
  summary: z.string(),
  contentSnapshot: ResumeContentSnapshotSchema,
  createdAt: timestamp,
  archivedAt: nullableTimestamp,
  rowVersion: positiveInteger,
}).superRefine((resumeVersion, context) => {
  if (resumeVersion.archivedAt !== null && resumeVersion.archivedAt < resumeVersion.createdAt) {
    context.addIssue({ code: 'custom', path: ['archivedAt'], message: 'archivedAt 不得早于 createdAt' });
  }
});

export const ResumeVersionListResponseSchema: z.ZodType<ResumeVersionListResponse> = z.strictObject({
  resumeVersions: z.array(ResumeVersionRecordSchema),
  activeResumeVersionId: nullableNonBlankString,
});

export const ActiveResumeVersionResultSchema: z.ZodType<ActiveResumeVersionResult> = z.strictObject({
  resumeVersion: ResumeVersionRecordSchema,
  activeResumeVersionId: nullableNonBlankString,
});

const ApplicationCorrectableFieldSchema = z.enum([
  'resumeVersionId',
  'origin',
  'channel',
  'channelOtherLabel',
  'recruitingEntity',
  'primaryContact',
  'cityContext',
  'draftMessageText',
] satisfies readonly ApplicationCorrectableField[]);

const ApplicationCorrectableSnapshotSchema = z.strictObject({
  resumeVersionId: nullableNonBlankString.optional(),
  origin: ApplicationOriginSchema.optional(),
  channel: ApplicationChannelSchema.optional(),
  channelOtherLabel: nullableNonBlankString.optional(),
  recruitingEntity: RecruitingEntitySnapshotSchema.optional(),
  primaryContact: ContactSnapshotSchema.nullable().optional(),
  cityContext: CityContextSchema.optional(),
  draftMessageText: nullableNonBlankString.optional(),
});

const emptyPayload = z.strictObject({});
const legacyPayload = z.strictObject({
  legacyStatus: z.enum([
    'not_contacted', 'greeted_unread', 'greeted_read_no_reply', 'replied',
    'interviewing', 'paused', 'closed', 'rejected',
  ]),
  lastGreetedAt: nullableTimestamp,
  lastFollowupAt: nullableTimestamp,
  followupCount: z.number().finite().int().nonnegative(),
  note: nullableNonBlankString,
  migrationKey: nonBlankString.optional(),
});
const noResponsePayload = z.strictObject({ observedAsOf: timestamp });
const hrContactedPayload = z.strictObject({
  submissionState: z.enum(['not_applied', 'unknown']),
});
const applicationVoidedPayload = z.strictObject({ reason: nonBlankString });

const correctableSnapshotKeys = new Set<string>(ApplicationCorrectableFieldSchema.options);
const metadataCorrectedPayload = z.strictObject({
  correctedFields: z.array(ApplicationCorrectableFieldSchema).min(1),
  before: ApplicationCorrectableSnapshotSchema,
  after: ApplicationCorrectableSnapshotSchema,
  reason: nonBlankString,
}).superRefine((payload, context) => {
  const uniqueFields = new Set(payload.correctedFields);
  if (uniqueFields.size !== payload.correctedFields.length) {
    context.addIssue({ code: 'custom', path: ['correctedFields'], message: 'correctedFields 不得重复' });
  }
  for (const field of uniqueFields) {
    if (
      !Object.prototype.hasOwnProperty.call(payload.before, field)
      || !Object.prototype.hasOwnProperty.call(payload.after, field)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['correctedFields'],
        message: `before/after 必须同时包含 ${field}`,
      });
    }
  }
  for (const key of [...Object.keys(payload.before), ...Object.keys(payload.after)]) {
    if (!correctableSnapshotKeys.has(key) || !uniqueFields.has(key as ApplicationCorrectableField)) {
      context.addIssue({ code: 'custom', message: `未声明的纠正字段：${key}` });
    }
  }
});

const ordinaryEventTypes = FEEDBACK_EVENT_TYPES.filter(
  (eventType): eventType is OrdinaryFeedbackEventType => eventType !== 'event_voided',
) as [OrdinaryFeedbackEventType, ...OrdinaryFeedbackEventType[]];
const eventVoidedPayload = z.strictObject({
  targetEventId: nonBlankString,
  targetEventType: z.enum(ordinaryEventTypes),
  reason: nonBlankString,
});

const commonEventShape = {
  id: nonBlankString,
  applicationId: nonBlankString,
  eventAt: nullableTimestamp,
  timePrecision: z.enum(['exact', 'date', 'approximate', 'unknown']),
  actor: z.enum(['user', 'hr', 'interviewer', 'recruiter', 'system']),
  recordedBy: z.enum(['user', 'system_migration']),
  sourceConfidence: z.enum(['exact', 'approximate', 'recalled', 'inferred']),
  evidenceLevel: z.enum(['strong', 'medium', 'weak']),
  channel: ApplicationChannelSchema.nullable(),
  note: nullableNonBlankString,
  reasonCode: nullableNonBlankString,
  idempotencyKey: nonBlankString,
  createdAt: timestamp,
};

function regularEventSchema<Type extends OrdinaryFeedbackEventType>(
  eventType: Type,
  payload: z.ZodType,
) {
  return z.strictObject({
    ...commonEventShape,
    eventType: z.literal(eventType),
    payload,
    targetEventId: z.null(),
  });
}

const feedbackEventUnion = z.discriminatedUnion('eventType', [
  regularEventSchema('application_created', emptyPayload),
  regularEventSchema('applied', emptyPayload),
  regularEventSchema('greeting_sent', emptyPayload),
  regularEventSchema('message_viewed', emptyPayload),
  regularEventSchema('hr_replied', emptyPayload),
  regularEventSchema('resume_requested', emptyPayload),
  regularEventSchema('phone_screen', emptyPayload),
  regularEventSchema('interview_scheduled', emptyPayload),
  regularEventSchema('interview_completed', emptyPayload),
  regularEventSchema('interview_advanced', emptyPayload),
  regularEventSchema('follow_up_sent', emptyPayload),
  regularEventSchema('rejected', emptyPayload),
  regularEventSchema('user_withdrew', emptyPayload),
  regularEventSchema('offer_received', emptyPayload),
  regularEventSchema('offer_declined', emptyPayload),
  regularEventSchema('offer_accepted', emptyPayload),
  regularEventSchema('recruitment_paused', emptyPayload),
  regularEventSchema('recruitment_frozen', emptyPayload),
  regularEventSchema('process_resumed', emptyPayload),
  regularEventSchema('position_closed', emptyPayload),
  regularEventSchema('marked_stale', emptyPayload),
  regularEventSchema('hr_contacted', hrContactedPayload),
  regularEventSchema('no_response_recorded', noResponsePayload),
  regularEventSchema('legacy_status_imported', legacyPayload),
  regularEventSchema('application_metadata_corrected', metadataCorrectedPayload),
  regularEventSchema('application_voided', applicationVoidedPayload),
  z.strictObject({
    ...commonEventShape,
    eventType: z.literal('event_voided'),
    payload: eventVoidedPayload,
    targetEventId: nonBlankString,
  }),
]);

export const FeedbackEventRecordSchema = feedbackEventUnion.superRefine((event, context) => {
  if (event.eventAt === null && event.timePrecision !== 'unknown') {
    context.addIssue({
      code: 'custom',
      path: ['timePrecision'],
      message: 'eventAt 为空时 timePrecision 必须为 unknown',
    });
  }
  if (event.eventType === 'event_voided' && event.targetEventId !== event.payload.targetEventId) {
    context.addIssue({
      code: 'custom',
      path: ['targetEventId'],
      message: '顶层 targetEventId 必须与 payload.targetEventId 一致',
    });
  }
  if (event.eventType === 'legacy_status_imported') {
    if (
      event.actor !== 'system' ||
      event.recordedBy !== 'system_migration' ||
      event.sourceConfidence !== 'inferred' ||
      event.evidenceLevel !== 'weak'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'legacy_status_imported 必须标记为 system_migration/inferred/weak',
      });
    }
  }
}) as z.ZodType<FeedbackEventRecord>;

const warningCodes = [
  'DUPLICATE_IDENTICAL_EVENT',
  'DUPLICATE_IDENTICAL_IDEMPOTENCY_KEY',
  'VOID_TARGET_NOT_FOUND',
  'DUPLICATE_VOID',
  'MULTIPLE_LEGACY_SEEDS',
  'LEGACY_SEED_APPLIED',
  'RESUME_WITHOUT_PAUSE',
  'EVENT_AFTER_CLOSED',
  'APPLICATION_VOID_AUDIT_MISSING',
  'APPLICATION_VOID_AUDIT_WITHOUT_ROW',
] satisfies readonly ProjectionWarningCode[];
const errorCodes = [
  'INVALID_APPLICATION',
  'INVALID_EVENT',
  'DUPLICATE_EVENT_ID',
  'EVENT_APPLICATION_MISMATCH',
  'IDEMPOTENCY_KEY_CONFLICT',
  'VOID_TARGET_OTHER_APPLICATION',
  'VOID_TARGET_IS_VOID',
  'VOID_TARGET_TYPE_MISMATCH',
  'INVALID_PROJECTION_OUTPUT',
] satisfies readonly ProjectionErrorCode[];

const projectionIssueShape = {
  message: nonBlankString,
  eventId: nonBlankString.optional(),
  targetEventId: nonBlankString.optional(),
};

export const ApplicationProjectionSchema: z.ZodType<ApplicationProjection> = z.strictObject({
  stage: z.enum(['created', 'applied', 'contacted', 'screening', 'interviewing', 'offer', 'paused', 'closed']),
  outcome: z.enum([
    'rejected', 'user_withdrew', 'position_closed', 'stale', 'offer_declined', 'offer_accepted',
  ]).nullable(),
  communicationStatus: z.enum([
    'not_contacted', 'greeted_unread', 'greeted_read_no_reply', 'replied',
    'interviewing', 'paused', 'closed', 'rejected',
  ]),
  submissionState: z.enum(['applied', 'not_applied', 'unknown']),
  appliedAt: nullableTimestamp,
  lastMeaningfulEventAt: nullableTimestamp,
  followUpCount: z.number().finite().int().nonnegative(),
  lastGreetedAt: nullableTimestamp,
  lastFollowUpAt: nullableTimestamp,
  nextAllowedFollowUpAt: nullableTimestamp,
  isClosed: z.boolean(),
  isVoided: z.boolean(),
  statusSourceEventId: nullableNonBlankString,
  projectionStatus: z.enum(['valid', 'degraded', 'invalid']),
  warnings: z.array(z.strictObject({ code: z.enum(warningCodes), ...projectionIssueShape })),
  errors: z.array(z.strictObject({ code: z.enum(errorCodes), ...projectionIssueShape })),
}).superRefine((projection, context) => {
  const expectedStatus = projection.errors.length > 0
    ? 'invalid'
    : projection.warnings.length > 0
      ? 'degraded'
      : 'valid';
  if (projection.projectionStatus !== expectedStatus) {
    context.addIssue({
      code: 'custom',
      path: ['projectionStatus'],
      message: `projectionStatus 应为 ${expectedStatus}`,
    });
  }
  if (projection.isClosed !== (projection.stage === 'closed')) {
    context.addIssue({
      code: 'custom',
      path: ['isClosed'],
      message: 'isClosed 必须与 stage=closed 一致',
    });
  }
  if (
    projection.isVoided
    && (projection.stage !== 'closed'
      || projection.outcome !== null
      || projection.communicationStatus !== 'closed')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['isVoided'],
      message: 'voided 投影必须为 closed/null/closed',
    });
  }
});

const JobReportSchema = z.strictObject({
  jobType: z.string(),
  keywords: z.string(),
  techStackMatch: z.string(),
  projectMatch: z.string(),
  strengths: z.string(),
  risks: z.string(),
  resumeAdvice: z.string(),
  interviewChecklist: z.string(),
  applyAdvice: z.enum(['strongly', 'ok', 'cautious', 'skip', '']),
  greetingMessage: z.string(),
});

const CompanyInputSchema = z.strictObject({
  sizeTier: z.enum(['giant', 'large', 'medium', 'small', 'micro', 'unknown']),
  staffRange: z.string(),
  companyType: z.string(),
  financingStage: z.string(),
  commuteTime: z.string(),
  commuteWay: z.string(),
  companyNote: z.string(),
  opportunityNote: z.string(),
});

const CompanyAssessmentSchema = z.strictObject({
  sizeTier: z.enum(['giant', 'large', 'medium', 'small', 'micro', 'unknown']),
  staffRange: z.string(),
  companyType: z.string(),
  financingStage: z.string(),
  stabilityLevel: z.enum(['high', 'medium', 'low', 'unknown']),
  growthPotential: z.enum(['high', 'medium', 'low', 'unknown']),
  summary: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});

const OpportunityAnalysisSchema = z.strictObject({
  opportunityScore: z.number().finite(),
  opportunityRadar: z.strictObject({
    salaryScore: z.number().finite(),
    stabilityScore: z.number().finite(),
    growthScore: z.number().finite(),
    matchScore: z.number().finite(),
    commuteScore: z.number().finite(),
    riskControlScore: z.number().finite(),
  }),
  applyAdvice: z.enum(['strongly', 'ok', 'cautious', 'skip', '']),
  riskLevel: z.enum(['low', 'medium', 'high', 'unknown']),
  decisionSummary: z.string(),
  interviewFocus: z.array(z.string()),
  bossGreeting: z.string(),
});

const JobImportSourceSchema = z.strictObject({
  sourceType: z.string(),
  sourceImagePath: z.string().optional(),
  dedupeKey: z.string(),
  importedAt: timestamp,
});

const ImportedJdDraftSchema = z.strictObject({
  recommendedCategory: z.string(),
  reason: z.string(),
  confidence: z.number().finite().nullable(),
  riskFlags: z.array(z.string()),
  warnings: z.array(z.string()),
  missingFields: z.array(z.string()),
  rawText: z.string(),
  sourceCreatedAt: z.string().optional(),
});

export const JobRecordSchema: z.ZodType<JobRecord> = z.strictObject({
  id: nonBlankString,
  createdAt: timestamp,
  updatedAt: timestamp,
  company: z.string(),
  role: z.string(),
  city: z.string(),
  salaryRange: z.string(),
  jdText: z.string(),
  promptText: z.string(),
  aiRawResult: z.string(),
  aiPastedAt: nullableTimestamp,
  parseStatus: z.enum(['none', 'parsed', 'unparsed']),
  report: JobReportSchema.nullable(),
  matchScore: z.string(),
  companyInput: CompanyInputSchema,
  companyAssessment: CompanyAssessmentSchema.nullable(),
  opportunityAnalysis: OpportunityAnalysisSchema.nullable(),
  communicationStatus: z.enum([
    'not_contacted', 'greeted_unread', 'greeted_read_no_reply', 'replied',
    'interviewing', 'paused', 'closed', 'rejected',
  ]),
  lastGreetedAt: timestamp.optional(),
  followupCount: z.number().finite().int().nonnegative(),
  lastFollowupAt: timestamp.optional(),
  lastCommunicationNote: z.string().optional(),
  highValueSignal: z.boolean().optional(),
  strategyOverride: z.enum(['main_attack', 'low_cost_probe', 'cautious_watch', 'cut_loss']).optional(),
  draftMessageText: z.string().optional(),
  importStatus: z.enum(['draft', 'imported_draft']).optional(),
  reviewStatus: z.enum(['pending_review', 'confirmed', 'deferred', 'rejected']).optional(),
  importSource: JobImportSourceSchema.optional(),
  importedDraft: ImportedJdDraftSchema.optional(),
});

export const JobSeekerProfileSchema: z.ZodType<JobSeekerProfile> = z.strictObject({
  resumeText: z.string(),
  projectExperience: z.string(),
  targetCity: z.string(),
  targetRole: z.string(),
  expectedSalary: z.string(),
  acceptOutsourcing: z.boolean(),
  acceptOvertime: z.boolean(),
  jobSearchFocus: z.enum(['stability', 'raise', 'resume', 'growth']),
  weaknessNote: z.string(),
});

export const ApplicationMemorySchema: z.ZodType<ApplicationMemory> = z.strictObject({
  record: ApplicationRecordSchema,
  events: z.array(FeedbackEventRecordSchema),
  projection: ApplicationProjectionSchema,
});

export const JobMemoryBundleSchema: z.ZodType<JobMemoryBundle> = z.strictObject({
  applications: z.array(ApplicationMemorySchema),
  resumeVersions: z.array(ResumeVersionRecordSchema),
  activeResumeVersionId: nullableNonBlankString,
});

export const ApplicationSummarySchema: z.ZodType<ApplicationSummary> = z.strictObject({
  record: ApplicationRecordSchema,
  projection: ApplicationProjectionSchema,
});

const ProjectionDiagnosticSchema = z.strictObject({
  applicationId: nonBlankString,
  projectionStatus: z.enum(['valid', 'degraded', 'invalid']),
  warnings: z.array(z.strictObject({ code: z.enum(warningCodes), ...projectionIssueShape })),
  errors: z.array(z.strictObject({ code: z.enum(errorCodes), ...projectionIssueShape })),
});

export const JobSummarySchema: z.ZodType<JobSummary> = z.strictObject({
  job: JobRecordSchema,
  applicationCount: z.number().finite().int().nonnegative(),
  activeApplicationCount: z.number().finite().int().nonnegative(),
  defaultApplication: ApplicationSummarySchema.nullable(),
  defaultResumeVersionName: z.string().trim().min(1).nullable(),
  projectionDiagnostics: z.array(ProjectionDiagnosticSchema),
});

export const JobSummariesResponseSchema = z.array(JobSummarySchema);

export const JobDetailBundleV2Schema: z.ZodType<JobDetailBundleV2> = z.strictObject({
  jobId: nonBlankString,
  job: JobRecordSchema,
  profile: JobSeekerProfileSchema.nullable(),
  allJobs: z.array(JobRecordSchema),
  applicationSummariesByJob: z.record(z.string(), z.array(ApplicationSummarySchema)),
  memory: JobMemoryBundleSchema,
}).superRefine((bundle, context) => {
  if (bundle.jobId !== bundle.job.id) {
    context.addIssue({ code: 'custom', path: ['jobId'], message: 'jobId 必须与 job.id 一致' });
  }
});

export function parseFeedbackEvent(value: unknown): FeedbackEventRecord {
  return FeedbackEventRecordSchema.parse(value) as FeedbackEventRecord;
}
