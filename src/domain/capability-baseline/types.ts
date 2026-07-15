import { JOB_MATCH_CITY_CODES, type JobMatchCityCode } from '../job-match-profile';

export { JOB_MATCH_CITY_CODES };
export type { JobMatchCityCode };

export const CAPABILITY_EVIDENCE_POLARITIES = ['support', 'counter', 'neutral'] as const;
export type CapabilityEvidencePolarity = (typeof CAPABILITY_EVIDENCE_POLARITIES)[number];

export const CAPABILITY_EVIDENCE_STRENGTHS = ['strong', 'medium', 'weak'] as const;
export type CapabilityEvidenceStrength = (typeof CAPABILITY_EVIDENCE_STRENGTHS)[number];

export const CAPABILITY_EVIDENCE_SOURCE_TYPES = [
  'profile',
  'resume_version',
  'job',
  'application',
  'feedback_event',
  'user_input',
] as const;
export type CapabilityEvidenceSourceType = (typeof CAPABILITY_EVIDENCE_SOURCE_TYPES)[number];

export const CAPABILITY_TIME_PRECISIONS = ['exact', 'date', 'approximate', 'unknown'] as const;
export type CapabilityTimePrecision = (typeof CAPABILITY_TIME_PRECISIONS)[number];

export const CAPABILITY_SOURCE_CONFIDENCES = ['exact', 'approximate', 'recalled', 'inferred'] as const;
export type CapabilitySourceConfidence = (typeof CAPABILITY_SOURCE_CONFIDENCES)[number];

export const CAPABILITY_EVIDENCE_GENERATORS = ['manual', 'ai', 'system'] as const;
export type CapabilityEvidenceGenerator = (typeof CAPABILITY_EVIDENCE_GENERATORS)[number];

export const CAPABILITY_EVIDENCE_STATUSES = [
  'proposed',
  'accepted',
  'modified_and_accepted',
  'rejected',
  'deferred',
] as const;
export type CapabilityEvidenceStatus = (typeof CAPABILITY_EVIDENCE_STATUSES)[number];

/** 长期能力结论的成熟状态；越靠前证据越充分。 */
export const CAPABILITY_CONCLUSION_STATUSES = [
  'established',
  'supported',
  'exploratory',
  'insufficient',
  'contradicted',
] as const;
export type CapabilityConclusionStatus = (typeof CAPABILITY_CONCLUSION_STATUSES)[number];

/** 岗位可达性 / 外部门槛类型，必须与能力事实分离。 */
export const CAPABILITY_CONSTRAINT_KINDS = [
  'education',
  'age',
  'city_supply',
  'salary',
  'hiring_preference',
  'other',
] as const;
export type CapabilityConstraintKind = (typeof CAPABILITY_CONSTRAINT_KINDS)[number];

export const CAPABILITY_BASELINE_PROPOSAL_STATUSES = [
  'proposed',
  'accepted',
  'modified_and_accepted',
  'rejected',
  'deferred',
] as const;
export type CapabilityBaselineProposalStatus =
  (typeof CAPABILITY_BASELINE_PROPOSAL_STATUSES)[number];

export const CAPABILITY_COMMAND_TYPES = [
  'manual_evidence',
  'generate_evidence',
  'accept_evidence',
  'reject_evidence',
  'defer_evidence',
  'manual_baseline_proposal',
  'generate_baseline_proposal',
  'accept_baseline_proposal',
  'reject_baseline_proposal',
  'defer_baseline_proposal',
  'activate_baseline_version',
] as const;
export type CapabilityCommandType = (typeof CAPABILITY_COMMAND_TYPES)[number];

/** 候选证据可编辑内容（手工创建或修改后接受时用户可调整的字段）。 */
export interface CandidateEvidenceContent {
  capabilityKey: string;
  capabilityLabel: string;
  polarity: CapabilityEvidencePolarity;
  strength: CapabilityEvidenceStrength;
  sourceType: CapabilityEvidenceSourceType;
  sourceId: string | null;
  sourceLabel: string;
  city: JobMatchCityCode | null;
  summary: string;
  observedAt: number | null;
  timePrecision: CapabilityTimePrecision;
  sourceConfidence: CapabilitySourceConfidence;
}

export interface CandidateEvidence extends CandidateEvidenceContent {
  id: string;
  generatedBy: CapabilityEvidenceGenerator;
  status: CapabilityEvidenceStatus;
  /** 修改后接受时保存的最终内容；未修改或未接受时为 null。 */
  acceptedContent: CandidateEvidenceContent | null;
  /** 修改后接受时被改动的字段名列表。 */
  decisionDiff: string[];
  modelInfo: string | null;
  inputFingerprint: string | null;
  createdAt: number;
  decidedAt: number | null;
  decisionNote: string | null;
  expectedStateVersion: number;
}

/** 单个长期能力维度的正式结论。 */
export interface CapabilityDimension {
  key: string;
  label: string;
  conclusion: string;
  conclusionStatus: CapabilityConclusionStatus;
  supportingEvidenceRefs: string[];
  counterEvidenceRefs: string[];
  unverified: string[];
  largestUncertainty: string;
}

/** 外部门槛或可达性约束；不得与能力事实混同。 */
export interface CapabilityExternalConstraint {
  key: string;
  kind: CapabilityConstraintKind;
  label: string;
  summary: string;
  evidenceRefs: string[];
}

export interface CapabilityBaselineDraft {
  summary: string;
  capabilities: CapabilityDimension[];
  externalConstraints: CapabilityExternalConstraint[];
  overallConfidence: CapabilityConclusionStatus;
  largestUncertainties: string[];
}

export interface CapabilityBaselineSourceSnapshot {
  inputFingerprint: string;
  activeResumeVersionId: string | null;
  acceptedEvidenceCount: number;
  jobCount: number;
  applicationCount: number;
  feedbackEventCount: number;
  capturedAt: number;
}

export interface CapabilityBaselineVersion extends CapabilityBaselineDraft {
  id: string;
  version: number;
  status: 'active' | 'archived';
  sourceSnapshot: CapabilityBaselineSourceSnapshot;
  /** 该版本正式引用的已接受证据 id。 */
  evidenceRefs: string[];
  createdAt: number;
  activatedAt: number;
  supersedesVersionId: string | null;
  proposalId: string;
}

export interface CapabilityBaselineProposal {
  id: string;
  status: CapabilityBaselineProposalStatus;
  payload: CapabilityBaselineDraft;
  acceptedPayload: CapabilityBaselineDraft | null;
  decisionDiff: string[];
  inputFingerprint: string;
  generatedBy: 'ai' | 'manual';
  modelInfo: string | null;
  sourceSnapshot: CapabilityBaselineSourceSnapshot;
  /** 提案生成时快照里已接受证据的 id，用于校验正式版本引用一致。 */
  evidenceRefs: string[];
  createdAt: number;
  decidedAt: number | null;
  decisionNote: string | null;
  expectedStateVersion: number;
}

export interface CapabilityCommandReceipt {
  idempotencyKey: string;
  commandType: CapabilityCommandType;
  targetId: string | null;
  resultId: string | null;
  requestHash: string;
  createdAt: number;
}

export interface CapabilityBaselineState {
  stateVersion: number;
  activeVersionId: string | null;
  evidence: CandidateEvidence[];
  versions: CapabilityBaselineVersion[];
  proposals: CapabilityBaselineProposal[];
  commandReceipts: CapabilityCommandReceipt[];
}

export interface CapabilityBaselineView {
  state: CapabilityBaselineState;
  activeVersion: CapabilityBaselineVersion | null;
  llmConfigured: boolean;
}

/** 供 AI 只读消费的输入快照。 */
export interface CapabilityBaselineInputSnapshot {
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
  jobs: Array<{
    id: string;
    company: string;
    role: string;
    city: JobMatchCityCode | null;
    salaryRange: string;
    matchScore: string;
  }>;
  applications: Array<{
    id: string;
    jobId: string;
    city: JobMatchCityCode | null;
    stage: string;
    outcome: string | null;
  }>;
  feedbackEvents: Array<{
    id: string;
    applicationId: string;
    eventType: string;
    reasonCode: string | null;
    evidenceLevel: string;
    capabilitySignal: CapabilityEvidencePolarity;
  }>;
  acceptedEvidence: CandidateEvidenceContent[];
  activeJobMatchProfileSummary: string | null;
  activeCapabilityBaseline: CapabilityBaselineDraft | null;
}

export interface CapabilityBaselineSnapshotResult {
  snapshot: CapabilityBaselineInputSnapshot;
  inputFingerprint: string;
  sourceSnapshot: CapabilityBaselineSourceSnapshot;
}
