import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';
import type { RadarDecisionType } from './radarApi';

/** 与采集桥一致：所有请求携带自定义头，强制触发 CORS 预检并通过服务端安全网关。 */
const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const captureHeaders = { [CAPTURE_CLIENT_HEADER]: 'offerflow-web' };
function withHeaders<T extends { headers?: Record<string, string> } | undefined>(
  options: T,
): T & { headers: Record<string, string> } {
  return { ...(options ?? {} as T), headers: { ...captureHeaders, ...options?.headers } };
}

export type RelationStatus = 'suspected_duplicate' | 'needs_recheck' | 'confirmed_same' | 'confirmed_distinct';
export type EvidenceState = 'structured' | 'legacy_scalar' | 'corrupt';
export type OverrideState = 'none' | 'pass' | 'block';

export interface CandidateSummary {
  candidateId: string;
  activeCandidateVersionId: string | null;
  company: string | null;
  role: string | null;
  city: string | null;
  salaryMinK: number | null;
  salaryMaxK: number | null;
  salaryPeriod: string | null;
  experienceRequirement: string | null;
  educationRequirement: string | null;
  jdExcerpt: string;
  normalizedSourceUrl: string | null;
  sourceDomain: string | null;
}

export interface ChangedFieldView {
  fieldPath: string;
  before: string | number | boolean | string[] | null;
  after: string | number | boolean | string[] | null;
  classification: string;
  reason: string;
}

export interface CandidateDecisionDetail {
  candidateId: string;
  activeCandidateVersionId: string | null;
  decisionType: RadarDecisionType;
  analysisEligible: boolean;
  blockingIssues: string[];
  needsConfirmation: string[];
  conflictReason: string | null;
  changedFields: ChangedFieldView[];
  latestSnapshotId: string | null;
  currentVersion: CandidateSummary | null;
  previousVersion: CandidateSummary | null;
  sourceLinks: Array<{ sourceRecordId: string; linkReason: string; normalizedSourceUrl: string | null }>;
}

export interface RedactedSignals {
  companyNameSimilar?: boolean;
  roleTitleSimilar?: boolean;
  sameSourceDomain?: boolean;
  sameNormalizedUrlHost?: boolean;
  reason?: string;
}

export interface RelationListItem {
  relationId: string;
  candidateIdLow: string;
  candidateIdHigh: string;
  status: RelationStatus;
  reasonCode: string | null;
  signals: RedactedSignals;
  firstDetectedAt: number;
  lastDetectedAt: number;
  lowSummary: CandidateSummary;
  highSummary: CandidateSummary;
  hasPriorDecision: boolean;
}

export interface DecisionFeedItem {
  snapshotId: string;
  candidateId: string | null;
  activeCandidateVersionId: string | null;
  decisionType: RadarDecisionType;
  analysisEligible: boolean;
  blockingIssues: string[];
  needsConfirmation: string[];
  conflictReason: string | null;
  changedFieldPaths: string[];
  summary: CandidateSummary | null;
}

export interface RuleEvidenceView {
  assessmentId: string;
  ruleKey: string;
  evidenceState: EvidenceState;
  corruptReason: string | null;
  overrideState: OverrideState;
  ruleId: string | null;
  ruleVersion: string | null;
  outcome: string | null;
  matchedFieldPath: string | null;
  rawValue: string | number | boolean | null;
  normalizedValue: string | number | boolean | null;
  excerpt: string | null;
  explanation: string | null;
  confidence: number | null;
  blocking: boolean | null;
  matchedText: string | null;
}

export interface AdjudicationInput {
  relationId: string;
  reason: string;
  expectedCurrentStatus: RelationStatus;
  note?: string | null;
}
export interface RecheckInput extends AdjudicationInput {
  evidenceReason: 'new_material_version' | 'company_resolved_consistent' | 'new_stable_source_link' | 'external_identity_corrected' | 'user_reverted_decision';
}
export interface OverrideSetInput {
  assessmentId: string;
  overriddenValue: 'pass' | 'block';
  reason: string;
  expectedOverrideState: OverrideState;
}
export interface OverrideRevertInput {
  assessmentId: string;
  reason: string;
  expectedOverrideState: OverrideState;
}

const base = '/radar/review';

export const radarReviewApi = {
  listRelations(statuses?: RelationStatus[], options?: ReadOptions): Promise<RelationListItem[]> {
    const qs = statuses && statuses.length > 0 ? `?${statuses.map((s) => `statuses=${encodeURIComponent(s)}`).join('&')}` : '';
    return apiGet(`${base}/relations${qs}`, withHeaders(options));
  },
  listDecisionFeed(options?: ReadOptions): Promise<DecisionFeedItem[]> {
    return apiGet(`${base}/decision-feed`, withHeaders(options));
  },
  getCandidateDetail(candidateId: string, options?: ReadOptions): Promise<CandidateDecisionDetail> {
    return apiGet(`${base}/candidates/${encodeURIComponent(candidateId)}`, withHeaders(options));
  },
  listRuleEvidence(versionId: string, options?: ReadOptions): Promise<RuleEvidenceView[]> {
    return apiGet(`${base}/candidate-versions/${encodeURIComponent(versionId)}/rule-evidence`, withHeaders(options));
  },
  confirmSame(input: AdjudicationInput, options?: SendOptions) {
    return apiSend(`${base}/relations/confirm-same`, 'POST', input, withHeaders(options));
  },
  confirmDistinct(input: AdjudicationInput, options?: SendOptions) {
    return apiSend(`${base}/relations/confirm-distinct`, 'POST', input, withHeaders(options));
  },
  revert(input: AdjudicationInput, options?: SendOptions) {
    return apiSend(`${base}/relations/revert`, 'POST', input, withHeaders(options));
  },
  requestRecheck(input: RecheckInput, options?: SendOptions) {
    return apiSend(`${base}/relations/request-recheck`, 'POST', input, withHeaders(options));
  },
  setOverride(input: OverrideSetInput, options?: SendOptions) {
    return apiSend(`${base}/rule-overrides/set`, 'POST', input, withHeaders(options));
  },
  revertOverride(input: OverrideRevertInput, options?: SendOptions) {
    return apiSend(`${base}/rule-overrides/revert`, 'POST', input, withHeaders(options));
  },
};
