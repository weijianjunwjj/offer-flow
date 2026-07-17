import type { JobFamilyId } from '../funnel/jobFamily';
import {
  DECISION_GATE_TYPES,
  MARKET_POSITION_CITY_CODES,
  type DecisionGateStatus,
  type DecisionGateType,
  type EvidenceLevel,
  type MarketPositionCityCode,
} from '../market-position';

/** 复用 G4/G1 的城市与决策门口径，不新建第二套。 */
export const STRATEGY_CITY_CODES = MARKET_POSITION_CITY_CODES;
export type StrategyCityCode = MarketPositionCityCode;
export { DECISION_GATE_TYPES };
export type { DecisionGateType, DecisionGateStatus, EvidenceLevel };

/** 策略窗口类型：由 G4 全局 evidenceLevel 确定性映射，AI 不可修改。 */
export const STRATEGY_WINDOW_TYPES = [
  'evidence_collection',
  'controlled_experiment',
  'limited_optimization',
] as const;
export type StrategyWindowType = (typeof STRATEGY_WINDOW_TYPES)[number];

/** 策略动作类型（§5）。 */
export const STRATEGY_ACTION_TYPES = [
  'collect_market_evidence',
  'increase_reliable_applications',
  'complete_outcome_records',
  'city_sample_experiment',
  'role_family_experiment',
  'resume_ab_test',
  'channel_ab_test',
  'salary_probe',
  'portfolio_evidence_improvement',
  'interview_story_improvement',
  'follow_up_hygiene',
  'stale_process_review',
  'relocation_feasibility_research',
  'reduce_exposure',
  'maintain_current_strategy',
] as const;
export type StrategyActionType = (typeof STRATEGY_ACTION_TYPES)[number];

export type StrategyActionScopeType = 'global' | 'city' | 'city_job_family';
export type StrategyActionPriority = 'high' | 'medium' | 'low';
export type StrategyActionCost = 'low' | 'medium' | 'high';

export interface StrategyAction {
  id: string;
  actionType: StrategyActionType;
  title: string;
  rationale: string;
  scope: StrategyActionScopeType;
  city: StrategyCityCode | null;
  jobFamily: JobFamilyId | null;
  priority: StrategyActionPriority;
  targetCount: number;
  allocationShare: number;
  startAt: number;
  reviewAt: number;
  successSignals: string[];
  failureSignals: string[];
  stopConditions: string[];
  evidenceTargets: string[];
  reversible: boolean;
  expectedCost: StrategyActionCost;
  prohibitedInterpretations: string[];
  sourceDecisionGate: DecisionGateType | null;
  sourceEvidenceIds: string[];
}

/** 受控 A/B 实验：必须单变量、可逆、有样本目标与结束条件。 */
export interface StrategyExperiment {
  id: string;
  actionType: StrategyActionType;
  title: string;
  variable: string;
  variantA: string;
  variantB: string;
  sampleTarget: number;
  observationMetric: string;
  endCondition: string;
  reversible: boolean;
}

export type StrategyAllocationDimension = 'city' | 'job_family' | 'channel';

export interface StrategyAllocationEntry {
  key: string;
  label: string;
  share: number;
  /** 无证据时只能是探索性均衡样本，不得表述为优先级结论。 */
  exploratory: boolean;
}

export interface StrategyAllocationPlan {
  dimension: StrategyAllocationDimension;
  title: string;
  note: string;
  entries: StrategyAllocationEntry[];
}

export interface StrategyDecisionGateSnapshotEntry {
  gateType: DecisionGateType;
  status: DecisionGateStatus;
}

export interface StrategySourceVersionIds {
  jobMatchProfileVersionId: string | null;
  capabilityBaselineVersionId: string | null;
  marketPositionVersionId: string | null;
}

/**
 * StrategyWindow：完全由确定性规则生成的策略允许范围，AI 不得修改任何字段。
 */
export interface StrategyWindow {
  id: string;
  windowType: StrategyWindowType;
  startsAt: number;
  reviewAt: number;
  expiresAt: number;
  sourceVersionIds: StrategySourceVersionIds;
  inputHash: string;
  dataCutoffAt: number;
  evidenceLevel: EvidenceLevel;
  decisionGateSnapshot: StrategyDecisionGateSnapshotEntry[];
  allowedActionTypes: StrategyActionType[];
  observeOnlyActionTypes: StrategyActionType[];
  blockedActionTypes: StrategyActionType[];
  requiredEvidenceTargets: string[];
  reviewTriggers: string[];
  stopConditions: string[];
  allowedClaims: string[];
  blockedClaims: string[];
  createdAt: number;
  ruleVersion: string;
}

/** StrategyProposalDraft：提案中可编辑/可与 AI 叙事合并的部分。 */
export interface StrategyProposalDraft {
  headline: string;
  objective: string;
  summary: string;
  horizonDays: number;
  allocationPlans: StrategyAllocationPlan[];
  actions: StrategyAction[];
  experiments: StrategyExperiment[];
  evidenceTargets: string[];
  reviewTriggers: string[];
  stopConditions: string[];
  reversibleActions: string[];
  prohibitedActions: string[];
  uncertainties: string[];
}

export type StrategyGenerationMode = 'ai' | 'manual';

export interface StrategyInputSnapshot {
  jobMatchProfileVersionId: string | null;
  capabilityBaselineVersionId: string | null;
  marketPositionVersionId: string | null;
  acceptedEvidenceIds: string[];
  funnelCutoffAt: number;
  funnelQueryFingerprint: string;
  evidenceLevel: EvidenceLevel;
  decisionGateStatuses: StrategyDecisionGateSnapshotEntry[];
  allowedClaims: string[];
  blockedClaims: string[];
  inputHash: string;
  capturedAt: number;
}

export interface StrategyAiGenerationMetadata {
  provider: string;
  model: string;
  generatedAt: number;
  inputHash: string;
  promptVersion: string;
  deterministicRuleVersion: string;
}

export type StrategyProposalStatus =
  | 'proposed'
  | 'accepted'
  | 'modified_and_accepted'
  | 'rejected'
  | 'deferred';

export interface StrategyProposal {
  id: string;
  status: StrategyProposalStatus;
  window: StrategyWindow;
  payload: StrategyProposalDraft;
  acceptedPayload: StrategyProposalDraft | null;
  decisionDiff: string[];
  inputSnapshot: StrategyInputSnapshot;
  generatedBy: StrategyGenerationMode;
  modelInfo: string | null;
  aiGeneration: StrategyAiGenerationMetadata | null;
  createdAt: number;
  decidedAt: number | null;
  decisionNote: string | null;
  expectedStateVersion: number;
  /** 派生字段：读取时按当前输入与窗口到期状态计算，不持久化。 */
  stale: boolean;
}

export interface StrategyVersion {
  id: string;
  version: number;
  status: 'active' | 'archived';
  window: StrategyWindow;
  payload: StrategyProposalDraft;
  inputSnapshot: StrategyInputSnapshot;
  generationMode: StrategyGenerationMode;
  decisionDiff: string[];
  createdAt: number;
  activatedAt: number;
  supersedesVersionId: string | null;
  proposalId: string;
}

export type StrategyCommandType =
  | 'generate_proposal'
  | 'manual_proposal'
  | 'accept_proposal'
  | 'reject_proposal'
  | 'defer_proposal'
  | 'activate_version';

export interface StrategyCommandReceipt {
  idempotencyKey: string;
  commandType: StrategyCommandType;
  targetId: string | null;
  resultId: string | null;
  requestHash: string;
  createdAt: number;
}

export interface StrategyState {
  stateVersion: number;
  activeVersionId: string | null;
  versions: StrategyVersion[];
  proposals: StrategyProposal[];
  commandReceipts: StrategyCommandReceipt[];
}

export interface StrategyView {
  state: StrategyState;
  activeVersion: StrategyVersion | null;
  /** 当前确定性策略窗口；G4 尚无 active 版本时为 null。 */
  currentWindow: StrategyWindow | null;
  inputReady: boolean;
  llmConfigured: boolean;
  reused: boolean;
}
