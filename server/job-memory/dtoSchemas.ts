import { z } from 'zod';
import {
  ApplicationChannelSchema,
  ApplicationOriginSchema,
  CityContextSchema,
  ContactSnapshotSchema,
  RecruitingEntitySnapshotSchema,
  ResumeContentSnapshotSchema,
} from '../../src/domain/job-memory';

const nonBlankString = z.string().trim().min(1);
const nullableNonBlankString = nonBlankString.nullable();
const timestamp = z.number().finite().int().nonnegative();
const positiveInteger = z.number().finite().int().positive();

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

const NormalizedResumeContentSnapshotSchema = ResumeContentSnapshotSchema.transform((snapshot) => ({
  resumeText: normalizeLineEndings(snapshot.resumeText),
  projectExperience: normalizeLineEndings(snapshot.projectExperience),
}));

export const IdParamsSchema = z.strictObject({ id: nonBlankString });

export const CreateResumeVersionRequestSchema = z.strictObject({
  idempotencyKey: nonBlankString,
  name: nonBlankString,
  source: z.enum(['profile_snapshot', 'pasted_text', 'imported_file_text']),
  summary: z.string().trim(),
  contentSnapshot: NormalizedResumeContentSnapshotSchema,
});

export const UpdateResumeVersionMetadataRequestSchema = z.strictObject({
  expectedVersion: positiveInteger,
  name: nonBlankString.optional(),
  summary: z.string().trim().optional(),
}).refine((request) => request.name !== undefined || request.summary !== undefined, {
  message: '至少提供 name 或 summary',
});

export const ActivateResumeVersionRequestSchema = z.strictObject({
  expectedVersion: positiveInteger,
});

export const ArchiveResumeVersionRequestSchema = z.strictObject({
  expectedVersion: positiveInteger,
  replacementResumeVersionId: nonBlankString.optional(),
  clearActive: z.boolean().optional(),
}).superRefine((request, context) => {
  if (request.replacementResumeVersionId !== undefined && request.clearActive === true) {
    context.addIssue({
      code: 'custom',
      message: 'replacementResumeVersionId 与 clearActive=true 不能同时提供',
    });
  }
});

const feedbackEventCommonShape = {
  eventAt: timestamp.nullable(),
  timePrecision: z.enum(['exact', 'date', 'approximate', 'unknown']),
  actor: z.enum(['user', 'hr', 'interviewer', 'recruiter']),
  sourceConfidence: z.enum(['exact', 'approximate', 'recalled', 'inferred']),
  evidenceLevel: z.enum(['strong', 'medium', 'weak']),
  channel: ApplicationChannelSchema.nullable(),
  note: nullableNonBlankString,
  reasonCode: nullableNonBlankString,
};

const emptyPayload = z.strictObject({});
const hrContactedPayload = z.strictObject({
  submissionState: z.enum(['not_applied', 'unknown']),
});
const noResponsePayload = z.strictObject({ observedAsOf: timestamp });

function eventInput<Type extends string>(
  eventType: Type,
  payload: z.ZodType,
) {
  return z.strictObject({
    eventType: z.literal(eventType),
    ...feedbackEventCommonShape,
    payload,
  });
}

export const UserFeedbackEventInputSchema = z.discriminatedUnion('eventType', [
  eventInput('applied', emptyPayload),
  eventInput('hr_contacted', hrContactedPayload),
  eventInput('greeting_sent', emptyPayload),
  eventInput('message_viewed', emptyPayload),
  eventInput('hr_replied', emptyPayload),
  eventInput('resume_requested', emptyPayload),
  eventInput('phone_screen', emptyPayload),
  eventInput('interview_scheduled', emptyPayload),
  eventInput('interview_completed', emptyPayload),
  eventInput('interview_advanced', emptyPayload),
  eventInput('follow_up_sent', emptyPayload),
  eventInput('no_response_recorded', noResponsePayload),
  eventInput('rejected', emptyPayload),
  eventInput('user_withdrew', emptyPayload),
  eventInput('offer_received', emptyPayload),
  eventInput('offer_declined', emptyPayload),
  eventInput('offer_accepted', emptyPayload),
  eventInput('recruitment_paused', emptyPayload),
  eventInput('recruitment_frozen', emptyPayload),
  eventInput('process_resumed', emptyPayload),
  eventInput('position_closed', emptyPayload),
  eventInput('marked_stale', emptyPayload),
]).superRefine((event, context) => {
  if (event.eventAt === null && event.timePrecision !== 'unknown') {
    context.addIssue({
      code: 'custom',
      path: ['timePrecision'],
      message: 'eventAt 为空时 timePrecision 必须为 unknown',
    });
  }
});

export const CreateApplicationRequestSchema = z.strictObject({
  idempotencyKey: nonBlankString,
  resumeVersionId: nullableNonBlankString,
  origin: ApplicationOriginSchema,
  channel: ApplicationChannelSchema,
  channelOtherLabel: nullableNonBlankString,
  recruitingEntity: RecruitingEntitySnapshotSchema,
  primaryContact: ContactSnapshotSchema.nullable(),
  cityContext: CityContextSchema,
  draftMessageText: nullableNonBlankString.optional().default(null),
  initialEvent: UserFeedbackEventInputSchema.nullable().optional().default(null),
}).superRefine((request, context) => {
  if (request.channel === 'other' && request.channelOtherLabel === null) {
    context.addIssue({
      code: 'custom',
      path: ['channelOtherLabel'],
      message: 'channel=other 时必须提供 channelOtherLabel',
    });
  }
  if (request.channel !== 'other' && request.channelOtherLabel !== null) {
    context.addIssue({
      code: 'custom',
      path: ['channelOtherLabel'],
      message: '非 other channel 不得携带 channelOtherLabel',
    });
  }
});

const correctableApplicationFields = [
  'resumeVersionId',
  'channel',
  'channelOtherLabel',
  'recruitingEntity',
  'primaryContact',
  'cityContext',
  'draftMessageText',
] as const;

export const UpdateApplicationMetadataRequestSchema = z.strictObject({
  expectedVersion: positiveInteger,
  reason: nonBlankString,
  resumeVersionId: nullableNonBlankString.optional(),
  channel: ApplicationChannelSchema.optional(),
  channelOtherLabel: nullableNonBlankString.optional(),
  recruitingEntity: RecruitingEntitySnapshotSchema.optional(),
  primaryContact: ContactSnapshotSchema.nullable().optional(),
  cityContext: CityContextSchema.optional(),
  draftMessageText: nullableNonBlankString.optional(),
}).refine(
  (request) => correctableApplicationFields.some((field) => request[field] !== undefined),
  { message: '至少提供一个可纠正字段' },
);

export const VoidApplicationRequestSchema = z.strictObject({
  expectedVersion: positiveInteger,
  reason: nonBlankString,
  supersededByApplicationId: nullableNonBlankString.optional().default(null),
});

export const AppendFeedbackEventRequestSchema = z.strictObject({
  idempotencyKey: nonBlankString,
  expectedApplicationVersion: positiveInteger,
  event: UserFeedbackEventInputSchema,
});

export const VoidFeedbackEventRequestSchema = z.strictObject({
  idempotencyKey: nonBlankString,
  expectedApplicationVersion: positiveInteger,
  reason: nonBlankString,
  replacementEvent: UserFeedbackEventInputSchema.nullable().optional().default(null),
});

export type CreateResumeVersionRequest = z.infer<typeof CreateResumeVersionRequestSchema>;
export type UpdateResumeVersionMetadataRequest = z.infer<typeof UpdateResumeVersionMetadataRequestSchema>;
export type ActivateResumeVersionRequest = z.infer<typeof ActivateResumeVersionRequestSchema>;
export type ArchiveResumeVersionRequest = z.infer<typeof ArchiveResumeVersionRequestSchema>;
export type UserFeedbackEventInput = z.infer<typeof UserFeedbackEventInputSchema>;
export type CreateApplicationRequest = z.infer<typeof CreateApplicationRequestSchema>;
export type UpdateApplicationMetadataRequest = z.infer<typeof UpdateApplicationMetadataRequestSchema>;
export type VoidApplicationRequest = z.infer<typeof VoidApplicationRequestSchema>;
export type AppendFeedbackEventRequest = z.infer<typeof AppendFeedbackEventRequestSchema>;
export type VoidFeedbackEventRequest = z.infer<typeof VoidFeedbackEventRequestSchema>;
