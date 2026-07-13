import type { CommunicationStatus } from '../../storage/types';

export type ApplicationOrigin = 'outbound' | 'inbound' | 'unknown';

export type ApplicationChannel =
  | 'boss'
  | 'official_site'
  | 'referral'
  | 'headhunter'
  | 'email'
  | 'wechat'
  | 'other'
  | 'unknown';

export type WorkMode = 'onsite' | 'hybrid' | 'remote' | 'unknown';

export interface CityContext {
  jobCity: string | null;
  marketCity: string | null;
  workMode: WorkMode;
}

export type RecruitingEntityKind =
  | 'direct_employer'
  | 'outsourcing_vendor'
  | 'staffing_agency'
  | 'headhunter'
  | 'unknown';

export interface RecruitingEntitySnapshot {
  kind: RecruitingEntityKind;
  name: string | null;
  employerGroupKey: string | null;
  endClientName: string | null;
}

export type ContactRole =
  | 'company_hr'
  | 'hiring_manager'
  | 'headhunter'
  | 'platform_recruiter'
  | 'unknown';

export interface ContactSnapshot {
  displayName: string | null;
  role: ContactRole;
  platformId: string | null;
}

export interface ApplicationRecord {
  id: string;
  jobId: string;
  resumeVersionId: string | null;
  origin: ApplicationOrigin;
  channel: ApplicationChannel;
  channelOtherLabel: string | null;
  recruitingEntity: RecruitingEntitySnapshot;
  primaryContact: ContactSnapshot | null;
  cityContext: CityContext;
  draftMessageText: string | null;
  createdAt: number;
  updatedAt: number;
  voidedAt: number | null;
  voidReason: string | null;
  supersededByApplicationId: string | null;
  rowVersion: number;
}

export type ResumeVersionSource = 'profile_snapshot' | 'pasted_text' | 'imported_file_text';

export interface ResumeContentSnapshot {
  resumeText: string;
  projectExperience: string;
}

export interface ResumeVersionRecord {
  id: string;
  name: string;
  source: ResumeVersionSource;
  contentHash: string;
  summary: string;
  contentSnapshot: ResumeContentSnapshot;
  createdAt: number;
  archivedAt: number | null;
  rowVersion: number;
}

export interface ResumeVersionListResponse {
  resumeVersions: ResumeVersionRecord[];
  activeResumeVersionId: string | null;
}

export interface ActiveResumeVersionResult {
  resumeVersion: ResumeVersionRecord;
  activeResumeVersionId: string | null;
}

export const FEEDBACK_EVENT_TYPES = [
  'application_created',
  'applied',
  'hr_contacted',
  'greeting_sent',
  'message_viewed',
  'hr_replied',
  'resume_requested',
  'phone_screen',
  'interview_scheduled',
  'interview_completed',
  'interview_advanced',
  'follow_up_sent',
  'no_response_recorded',
  'rejected',
  'user_withdrew',
  'offer_received',
  'offer_declined',
  'offer_accepted',
  'recruitment_paused',
  'recruitment_frozen',
  'process_resumed',
  'position_closed',
  'marked_stale',
  'legacy_status_imported',
  'application_metadata_corrected',
  'application_voided',
  'event_voided',
] as const;

export type FeedbackEventType = (typeof FEEDBACK_EVENT_TYPES)[number];
export type OrdinaryFeedbackEventType = Exclude<FeedbackEventType, 'event_voided'>;

export type EventTimePrecision = 'exact' | 'date' | 'approximate' | 'unknown';
export type FeedbackActor = 'user' | 'hr' | 'interviewer' | 'recruiter' | 'system';
export type FeedbackRecordedBy = 'user' | 'system_migration';
export type SourceConfidence = 'exact' | 'approximate' | 'recalled' | 'inferred';
export type EvidenceLevel = 'strong' | 'medium' | 'weak';

export type EmptyEventPayload = Record<string, never>;

export type ApplicationCorrectableField =
  | 'resumeVersionId'
  | 'origin'
  | 'channel'
  | 'channelOtherLabel'
  | 'recruitingEntity'
  | 'primaryContact'
  | 'cityContext'
  | 'draftMessageText';

export type ApplicationCorrectableSnapshot = Partial<
  Pick<ApplicationRecord, ApplicationCorrectableField>
>;

export interface LegacyStatusImportedPayload {
  legacyStatus: CommunicationStatus;
  lastGreetedAt: number | null;
  lastFollowupAt: number | null;
  followupCount: number;
  note: string | null;
  migrationKey?: string;
}

export interface EventVoidedPayload {
  targetEventId: string;
  targetEventType: OrdinaryFeedbackEventType;
  reason: string;
}

export interface ApplicationMetadataCorrectedPayload {
  correctedFields: ApplicationCorrectableField[];
  before: ApplicationCorrectableSnapshot;
  after: ApplicationCorrectableSnapshot;
  reason: string;
}

export interface NoResponseRecordedPayload {
  observedAsOf: number;
}

export interface HrContactedPayload {
  submissionState: 'not_applied' | 'unknown';
}

export interface ApplicationVoidedPayload {
  reason: string;
}

export interface FeedbackEventPayloadByType {
  application_created: EmptyEventPayload;
  applied: EmptyEventPayload;
  hr_contacted: HrContactedPayload;
  greeting_sent: EmptyEventPayload;
  message_viewed: EmptyEventPayload;
  hr_replied: EmptyEventPayload;
  resume_requested: EmptyEventPayload;
  phone_screen: EmptyEventPayload;
  interview_scheduled: EmptyEventPayload;
  interview_completed: EmptyEventPayload;
  interview_advanced: EmptyEventPayload;
  follow_up_sent: EmptyEventPayload;
  no_response_recorded: NoResponseRecordedPayload;
  rejected: EmptyEventPayload;
  user_withdrew: EmptyEventPayload;
  offer_received: EmptyEventPayload;
  offer_declined: EmptyEventPayload;
  offer_accepted: EmptyEventPayload;
  recruitment_paused: EmptyEventPayload;
  recruitment_frozen: EmptyEventPayload;
  process_resumed: EmptyEventPayload;
  position_closed: EmptyEventPayload;
  marked_stale: EmptyEventPayload;
  legacy_status_imported: LegacyStatusImportedPayload;
  application_metadata_corrected: ApplicationMetadataCorrectedPayload;
  application_voided: ApplicationVoidedPayload;
  event_voided: EventVoidedPayload;
}

interface FeedbackEventBase {
  id: string;
  applicationId: string;
  eventAt: number | null;
  timePrecision: EventTimePrecision;
  actor: FeedbackActor;
  recordedBy: FeedbackRecordedBy;
  sourceConfidence: SourceConfidence;
  evidenceLevel: EvidenceLevel;
  channel: ApplicationChannel | null;
  note: string | null;
  reasonCode: string | null;
  idempotencyKey: string;
  createdAt: number;
}

export type FeedbackEventRecord = {
  [Type in FeedbackEventType]: FeedbackEventBase & {
    eventType: Type;
    payload: FeedbackEventPayloadByType[Type];
    targetEventId: Type extends 'event_voided' ? string : null;
  };
}[FeedbackEventType];

export type ApplicationStage =
  | 'created'
  | 'applied'
  | 'contacted'
  | 'screening'
  | 'interviewing'
  | 'offer'
  | 'paused'
  | 'closed';

export type ApplicationOutcome =
  | 'rejected'
  | 'user_withdrew'
  | 'position_closed'
  | 'stale'
  | 'offer_declined'
  | 'offer_accepted'
  | null;

export type SubmissionState = 'applied' | 'not_applied' | 'unknown';
export type ProjectionStatus = 'valid' | 'degraded' | 'invalid';

export type ProjectionWarningCode =
  | 'DUPLICATE_IDENTICAL_EVENT'
  | 'DUPLICATE_IDENTICAL_IDEMPOTENCY_KEY'
  | 'VOID_TARGET_NOT_FOUND'
  | 'DUPLICATE_VOID'
  | 'MULTIPLE_LEGACY_SEEDS'
  | 'LEGACY_SEED_APPLIED'
  | 'RESUME_WITHOUT_PAUSE'
  | 'EVENT_AFTER_CLOSED'
  | 'APPLICATION_VOID_AUDIT_MISSING'
  | 'APPLICATION_VOID_AUDIT_WITHOUT_ROW';

export type ProjectionErrorCode =
  | 'INVALID_APPLICATION'
  | 'INVALID_EVENT'
  | 'DUPLICATE_EVENT_ID'
  | 'EVENT_APPLICATION_MISMATCH'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'VOID_TARGET_OTHER_APPLICATION'
  | 'VOID_TARGET_IS_VOID'
  | 'VOID_TARGET_TYPE_MISMATCH'
  | 'INVALID_PROJECTION_OUTPUT';

export interface ProjectionIssue<Code extends string> {
  code: Code;
  message: string;
  eventId?: string;
  targetEventId?: string;
}

export type ProjectionWarning = ProjectionIssue<ProjectionWarningCode>;
export type ProjectionError = ProjectionIssue<ProjectionErrorCode>;

export interface ApplicationProjection {
  stage: ApplicationStage;
  outcome: ApplicationOutcome;
  communicationStatus: CommunicationStatus;
  submissionState: SubmissionState;
  appliedAt: number | null;
  lastMeaningfulEventAt: number | null;
  followUpCount: number;
  lastGreetedAt: number | null;
  lastFollowUpAt: number | null;
  nextAllowedFollowUpAt: number | null;
  isClosed: boolean;
  isVoided: boolean;
  statusSourceEventId: string | null;
  projectionStatus: ProjectionStatus;
  warnings: ProjectionWarning[];
  errors: ProjectionError[];
}

export interface ApplicationWithProjection {
  application: ApplicationRecord;
  projection: ApplicationProjection;
}
