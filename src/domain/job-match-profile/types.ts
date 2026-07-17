export const JOB_MATCH_CITY_CODES = ['suzhou', 'wuxi', 'shanghai', 'hangzhou'] as const;

export type JobMatchCityCode = (typeof JOB_MATCH_CITY_CODES)[number];
export type JobMatchConfidence = 'insufficient' | 'exploratory' | 'actionable';
export type JobMatchProposalStatus =
  | 'proposed'
  | 'accepted'
  | 'modified_and_accepted'
  | 'rejected'
  | 'deferred';

export interface JobMatchSalaryRange {
  minK: number | null;
  maxK: number | null;
  note: string;
}

export interface JobMatchRoleBand {
  roleTitles: string[];
  roleFamilies: string[];
  salaryRange: JobMatchSalaryRange;
  companySizes: string[];
  companyTypes: string[];
  industries: string[];
  technicalFocus: string[];
  suitableReasons: string[];
  risks: string[];
}

export interface JobMatchCapability {
  key: string;
  label: string;
  level: 'core' | 'supporting' | 'to_validate';
  summary: string;
  evidenceRefs: string[];
}

export interface JobMatchConstraint {
  key: string;
  label: string;
  summary: string;
  evidenceRefs: string[];
}

export interface JobMatchEnvironment {
  companySizes: string[];
  companyTypes: string[];
  industries: string[];
  teamTraits: string[];
  description: string;
}

export interface JobMatchAcceptableRange {
  roleTitles: string[];
  cities: JobMatchCityCode[];
  salaryNote: string;
  companyTypes: string[];
  workModes: string[];
  notes: string[];
}

export type JobMatchEvidenceSourceType =
  | 'profile'
  | 'resume_version'
  | 'job'
  | 'application'
  | 'feedback_event'
  | 'user_input';

export interface JobMatchEvidenceRef {
  sourceType: JobMatchEvidenceSourceType;
  sourceId: string | null;
  label: string;
  polarity: 'support' | 'counter' | 'neutral';
  strength: 'strong' | 'medium' | 'weak';
  city: JobMatchCityCode | null;
  summary: string;
}

export interface JobMatchBorrowedEvidence {
  sourceCity: JobMatchCityCode;
  reason: string;
  discountNote: string;
  notApplicableTo: string[];
}

export interface JobMatchCityProfile {
  city: JobMatchCityCode;
  confidence: JobMatchConfidence;
  summary: string;
  highestReachableRole: string;
  stretchRoles: JobMatchRoleBand;
  primaryRoles: JobMatchRoleBand;
  safeRoles: JobMatchRoleBand;
  educationBarrier: string;
  salaryNote: string;
  preferredCompanyProfile: string[];
  supportingEvidence: JobMatchEvidenceRef[];
  counterEvidence: JobMatchEvidenceRef[];
  missingEvidence: string[];
  borrowedEvidence: JobMatchBorrowedEvidence[];
}

export interface JobMatchProfileDraft {
  northStarPositioning: string;
  highestReachableRole: string;
  primaryRoleFamilies: string[];
  stretchRoles: JobMatchRoleBand;
  primaryRoles: JobMatchRoleBand;
  safeRoles: JobMatchRoleBand;
  coreCapabilities: JobMatchCapability[];
  constraints: JobMatchConstraint[];
  idealEnvironment: JobMatchEnvironment;
  acceptableRange: JobMatchAcceptableRange;
  cityProfiles: JobMatchCityProfile[];
  supportingEvidence: JobMatchEvidenceRef[];
  counterEvidence: JobMatchEvidenceRef[];
  confidence: JobMatchConfidence;
  largestUncertainties: string[];
}

export interface JobMatchSourceSnapshot {
  inputFingerprint: string;
  activeResumeVersionId: string | null;
  jobCount: number;
  applicationCount: number;
  feedbackEventCount: number;
  cityApplicationCounts: Record<JobMatchCityCode, number>;
  capturedAt: number;
}

export interface JobMatchProfileVersion extends JobMatchProfileDraft {
  id: string;
  version: number;
  status: 'active' | 'archived';
  sourceSnapshot: JobMatchSourceSnapshot;
  createdAt: number;
  activatedAt: number;
  supersedesVersionId: string | null;
  proposalId: string;
}

export interface JobMatchProfileProposal {
  id: string;
  status: JobMatchProposalStatus;
  payload: JobMatchProfileDraft;
  acceptedPayload: JobMatchProfileDraft | null;
  decisionDiff: string[];
  inputFingerprint: string;
  generatedBy: 'ai' | 'manual';
  modelInfo: string | null;
  sourceSnapshot: JobMatchSourceSnapshot;
  createdAt: number;
  decidedAt: number | null;
  decisionNote: string | null;
  expectedProfileStateVersion: number;
}

export type JobMatchCommandType =
  | 'generate_proposal'
  | 'manual_proposal'
  | 'accept_proposal'
  | 'reject_proposal'
  | 'defer_proposal'
  | 'activate_version';

export interface JobMatchCommandReceipt {
  idempotencyKey: string;
  commandType: JobMatchCommandType;
  targetId: string | null;
  resultId: string | null;
  requestHash: string;
  createdAt: number;
}

export interface JobMatchProfileState {
  stateVersion: number;
  activeVersionId: string | null;
  versions: JobMatchProfileVersion[];
  proposals: JobMatchProfileProposal[];
  commandReceipts: JobMatchCommandReceipt[];
}

export interface JobMatchProfileView {
  state: JobMatchProfileState;
  activeVersion: JobMatchProfileVersion | null;
  llmConfigured: boolean;
}

export interface JobMatchProfileEventInput {
  id: string;
  eventType: string;
  eventAt: number | null;
  actor: string;
  sourceConfidence: string;
  evidenceLevel: string;
  note: string | null;
  reasonCode: string | null;
  capabilitySignal: 'support' | 'counter' | 'neutral';
}

export interface JobMatchProfileApplicationInput {
  id: string;
  jobId: string;
  resumeVersionId: string | null;
  channel: string;
  employerGroupKey: string | null;
  stage: string;
  outcome: string | null;
  submissionState: string;
  createdAt: number;
  events: JobMatchProfileEventInput[];
}

export interface JobMatchProfileOpportunityInput {
  sourceKey: string;
  jobId: string;
  company: string;
  role: string;
  city: JobMatchCityCode;
  salaryRange: string;
  jdText: string;
  matchScore: string;
  companyAssessment: unknown;
  opportunityAnalysis: unknown;
  applications: JobMatchProfileApplicationInput[];
}

export interface JobMatchProfileCityInput {
  city: JobMatchCityCode;
  opportunitySourceKeys: string[];
  applicationCount: number;
  feedbackEventCount: number;
  independentEmployerCount: number;
  missingEvidence: string[];
}

export interface JobMatchProfileInputSnapshot {
  profile: {
    resumeText: string;
    projectExperience: string;
    targetCity: string;
    targetRole: string;
    expectedSalary: string;
    acceptOutsourcing: boolean;
    acceptOvertime: boolean;
    jobSearchFocus: string;
    weaknessNote: string;
  };
  activeResumeVersion: {
    id: string;
    name: string;
    summary: string;
    resumeText: string;
    projectExperience: string;
  } | null;
  opportunities: JobMatchProfileOpportunityInput[];
  cityGroups: Record<JobMatchCityCode, JobMatchProfileCityInput>;
  activeProfileVersion: JobMatchProfileDraft | null;
}

export interface JobMatchProfileSnapshotResult {
  snapshot: JobMatchProfileInputSnapshot;
  inputFingerprint: string;
  sourceSnapshot: JobMatchSourceSnapshot;
}
