import type {
  ApplicationChannel,
  ApplicationStage,
  EventTimePrecision,
  FeedbackActor,
  OrdinaryFeedbackEventType,
  RecruitingEntityKind,
  SourceConfidence,
  EvidenceLevel,
} from '../job-memory';

export const HISTORICAL_IMPORT_SESSION_STATUSES = [
  'draft',
  'preview_generated',
  'confirmed',
  'discarded',
] as const;
export type HistoricalImportSessionStatus = (typeof HISTORICAL_IMPORT_SESSION_STATUSES)[number];

export interface HistoricalImportSession {
  id: string;
  status: HistoricalImportSessionStatus;
  createdAt: number;
  updatedAt: number;
  confirmedAt: number | null;
  discardedAt: number | null;
  rowVersion: number;
}

/** 补录草稿允许追加的事件类型：审计类事件只能由确认事务派生，不能由用户直接补录。 */
export const HISTORICAL_EVENT_DRAFT_TYPES = [
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
] as const satisfies readonly OrdinaryFeedbackEventType[];
export type HistoricalEventDraftType = (typeof HISTORICAL_EVENT_DRAFT_TYPES)[number];

export interface HistoricalBaselineDraftContent {
  company: string;
  role: string;
  city: string | null;
  actuallyApplied: boolean;
  appliedAt: number | null;
  timePrecision: EventTimePrecision;
  channel: ApplicationChannel;
  recruitingEntityKind: RecruitingEntityKind;
  recruitingEntityName: string | null;
  contactName: string | null;
  resumeVersionId: string | null;
  highestKnownStage: ApplicationStage | null;
  sourceConfidence: SourceConfidence;
  evidenceLevel: EvidenceLevel;
  notes: string | null;
  duplicateOfDraftId: string | null;
  keepAsIndependentProcess: boolean;
  independentProcessReason: string | null;
}

export interface HistoricalBaselineDraft extends HistoricalBaselineDraftContent {
  id: string;
  sessionId: string;
  createdJobId: string | null;
  createdApplicationId: string | null;
  createdAt: number;
  updatedAt: number;
  rowVersion: number;
}

export interface HistoricalEventDraftContent {
  eventType: HistoricalEventDraftType;
  eventAt: number | null;
  timePrecision: EventTimePrecision;
  actor: FeedbackActor;
  sourceConfidence: SourceConfidence;
  evidenceLevel: EvidenceLevel;
  channel: ApplicationChannel | null;
  reasonCode: string | null;
  note: string | null;
}

export interface HistoricalEventDraft extends HistoricalEventDraftContent {
  id: string;
  baselineDraftId: string;
  createdFeedbackEventId: string | null;
  createdAt: number;
  updatedAt: number;
  rowVersion: number;
}

export interface HistoricalBaselineDraftWithEvents {
  draft: HistoricalBaselineDraft;
  events: HistoricalEventDraft[];
}

export interface HistoricalImportSessionBundle {
  session: HistoricalImportSession;
  drafts: HistoricalBaselineDraftWithEvents[];
}

export type HistoricalImportConfirmOutcomeKind =
  | 'created_application'
  | 'kept_independent_no_application'
  | 'skipped_duplicate';

export interface HistoricalImportConfirmOutcome {
  baselineDraftId: string;
  kind: HistoricalImportConfirmOutcomeKind;
  jobId: string | null;
  applicationId: string | null;
}

export interface HistoricalImportConfirmResult {
  session: HistoricalImportSession;
  outcomes: HistoricalImportConfirmOutcome[];
}
