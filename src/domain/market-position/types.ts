import type { JobFamilyId } from '../funnel/jobFamily';
import { JOB_MATCH_CITY_CODES, type JobMatchCityCode } from '../job-match-profile/types';

/** 复用 G1 的四城市常量，避免与 job-match-profile 出现第二套城市口径。 */
export const MARKET_POSITION_CITY_CODES = JOB_MATCH_CITY_CODES;
export type MarketPositionCityCode = JobMatchCityCode;

export type MarketPositionScopeType = 'global' | 'city' | 'city_job_family';

export interface MarketPositionScope {
  scopeType: MarketPositionScopeType;
  city: MarketPositionCityCode | null;
  jobFamily: JobFamilyId | null;
}

export const EVIDENCE_LEVELS = ['insufficient', 'directional', 'supported'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/**
 * 计数字段的原始来源：applicationCount/validReplyCount/interviewCount/terminalOutcomeCount 与
 * confidence 相关计数均直接来自 aggregateFunnel 的 FunnelOverview（不重新实现漏斗聚合逻辑）；
 * companyCount/firstObservedAt/lastObservedAt 需要调用方在漏斗结果之外单独提供
 * （EvidenceSufficiency 引擎本身保持纯函数，不直接依赖 job-memory 存储层）。
 */
export interface EvidenceRawCounts {
  applicationCount: number;
  companyCount: number;
  validReplyCount: number;
  interviewCount: number;
  terminalOutcomeCount: number;
  exactCount: number;
  dateLevelCount: number;
  approximateCount: number;
  recalledCount: number;
  inferredCount: number;
  /** 毫秒时间戳；无样本时为 null。 */
  firstObservedAt: number | null;
  lastObservedAt: number | null;
}

export interface EvidenceSufficiency {
  scopeType: MarketPositionScopeType;
  city: MarketPositionCityCode | null;
  jobFamily: JobFamilyId | null;
  applicationCount: number;
  companyCount: number;
  validReplyCount: number;
  interviewCount: number;
  terminalOutcomeCount: number;
  exactCount: number;
  dateLevelCount: number;
  approximateCount: number;
  recalledCount: number;
  inferredCount: number;
  reliableEvidenceCount: number;
  recalledOrInferredShare: number | null;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
  observationSpanDays: number | null;
  evidenceLevel: EvidenceLevel;
  passedGates: string[];
  failedGates: string[];
  missingEvidence: string[];
  allowedClaims: string[];
  blockedClaims: string[];
}

export const DECISION_GATE_TYPES = [
  'role_positioning',
  'city_priority',
  'salary_positioning',
  'resume_effectiveness',
  'channel_effectiveness',
  'abandon_direction',
  'relocation_decision',
] as const;
export type DecisionGateType = (typeof DECISION_GATE_TYPES)[number];

export const DECISION_GATE_STATUSES = ['blocked', 'observe_only', 'decision_ready'] as const;
export type DecisionGateStatus = (typeof DECISION_GATE_STATUSES)[number];

export interface DecisionGate {
  gateType: DecisionGateType;
  status: DecisionGateStatus;
  rationale: string;
  supportingEvidence: string[];
  counterEvidence: string[];
  missingEvidence: string[];
  nextEvidenceActions: string[];
  reversibleActions: string[];
  prohibitedActions: string[];
}

export interface MarketPositionBorrowedEvidence {
  sourceScope: MarketPositionScope;
  sourceEvidenceId: string;
  borrowedReason: string;
  downweight: number;
  applicability: string;
  uncertainty: string;
}

export interface MarketPositionScopeProfile {
  scope: MarketPositionScope;
  headline: string;
  positioning: string;
  targetRoleFamilies: JobFamilyId[];
  observedStrengths: string[];
  observedWeaknesses: string[];
  marketSignals: string[];
  counterSignals: string[];
  uncertainties: string[];
  evidenceSufficiency: EvidenceSufficiency;
  decisionGates: DecisionGate[];
  nextEvidenceActions: string[];
  borrowedEvidence: MarketPositionBorrowedEvidence[];
}

export interface MarketPositionDraft {
  global: MarketPositionScopeProfile;
  cityProfiles: MarketPositionScopeProfile[];
  generatedFrom: {
    jobMatchProfileVersionId: string | null;
    capabilityBaselineVersionId: string | null;
    funnelCutoffAt: number;
  };
  dataCutoffAt: number;
}

export type MarketPositionProposalStatus =
  | 'proposed'
  | 'accepted'
  | 'modified_and_accepted'
  | 'rejected'
  | 'deferred';

export interface MarketPositionInputSnapshot {
  jobMatchProfileVersionId: string | null;
  capabilityBaselineVersionId: string | null;
  acceptedEvidenceIds: string[];
  funnelCutoffAt: number;
  funnelQueryFingerprint: string;
  inputHash: string;
  capturedAt: number;
}

export interface MarketPositionAiGenerationMetadata {
  provider: string;
  model: string;
  generatedAt: number;
  inputHash: string;
  promptVersion: string;
  deterministicRuleVersion: string;
}

export interface MarketPositionProposal {
  id: string;
  status: MarketPositionProposalStatus;
  payload: MarketPositionDraft;
  acceptedPayload: MarketPositionDraft | null;
  decisionDiff: string[];
  inputSnapshot: MarketPositionInputSnapshot;
  generatedBy: 'ai' | 'manual';
  modelInfo: string | null;
  aiGeneration: MarketPositionAiGenerationMetadata | null;
  createdAt: number;
  decidedAt: number | null;
  decisionNote: string | null;
  expectedStateVersion: number;
}

export interface MarketPositionVersion extends MarketPositionDraft {
  id: string;
  version: number;
  status: 'active' | 'archived';
  inputSnapshot: MarketPositionInputSnapshot;
  createdAt: number;
  activatedAt: number;
  supersedesVersionId: string | null;
  proposalId: string;
}

export type MarketPositionCommandType =
  | 'generate_proposal'
  | 'manual_proposal'
  | 'accept_proposal'
  | 'reject_proposal'
  | 'defer_proposal'
  | 'activate_version';

export interface MarketPositionCommandReceipt {
  idempotencyKey: string;
  commandType: MarketPositionCommandType;
  targetId: string | null;
  resultId: string | null;
  requestHash: string;
  createdAt: number;
}

export interface MarketPositionState {
  stateVersion: number;
  activeVersionId: string | null;
  versions: MarketPositionVersion[];
  proposals: MarketPositionProposal[];
  commandReceipts: MarketPositionCommandReceipt[];
}

export interface MarketPositionView {
  state: MarketPositionState;
  activeVersion: MarketPositionVersion | null;
  llmConfigured: boolean;
}
