import { z } from 'zod';
import { JOB_FAMILIES } from '../funnel/jobFamily';
import {
  DECISION_GATE_STATUSES,
  DECISION_GATE_TYPES,
  EVIDENCE_LEVELS,
  MARKET_POSITION_CITY_CODES,
  type MarketPositionDraft,
  type MarketPositionProposal,
  type MarketPositionState,
  type MarketPositionVersion,
} from './types';

const nonBlank = z.string().trim().min(1);
const stringList = z.array(nonBlank);
const cityCode = z.enum(MARKET_POSITION_CITY_CODES);
const jobFamily = z.enum(JOB_FAMILIES);
const hashHex64 = z.string().regex(/^[a-f0-9]{64}$/);

const scopeTypeSchema = z.enum(['global', 'city', 'city_job_family']);

export const MarketPositionScopeSchema = z.strictObject({
  scopeType: scopeTypeSchema,
  city: cityCode.nullable(),
  jobFamily: jobFamily.nullable(),
}).superRefine((scope, context) => {
  if (scope.scopeType === 'global' && (scope.city !== null || scope.jobFamily !== null)) {
    context.addIssue({ code: 'custom', message: 'global 范围不能绑定城市或岗位族', path: ['scopeType'] });
  }
  if (scope.scopeType === 'city' && (scope.city === null || scope.jobFamily !== null)) {
    context.addIssue({ code: 'custom', message: 'city 范围必须绑定城市且不能绑定岗位族', path: ['scopeType'] });
  }
  if (scope.scopeType === 'city_job_family' && (scope.city === null || scope.jobFamily === null)) {
    context.addIssue({ code: 'custom', message: 'city_job_family 范围必须同时绑定城市与岗位族', path: ['scopeType'] });
  }
});

export const EvidenceSufficiencySchema = z.strictObject({
  scopeType: scopeTypeSchema,
  city: cityCode.nullable(),
  jobFamily: jobFamily.nullable(),
  applicationCount: z.number().int().nonnegative(),
  companyCount: z.number().int().nonnegative(),
  validReplyCount: z.number().int().nonnegative(),
  interviewCount: z.number().int().nonnegative(),
  terminalOutcomeCount: z.number().int().nonnegative(),
  exactCount: z.number().int().nonnegative(),
  dateLevelCount: z.number().int().nonnegative(),
  approximateCount: z.number().int().nonnegative(),
  recalledCount: z.number().int().nonnegative(),
  inferredCount: z.number().int().nonnegative(),
  reliableEvidenceCount: z.number().int().nonnegative(),
  recalledOrInferredShare: z.number().min(0).max(1).nullable(),
  firstObservedAt: z.number().int().nonnegative().nullable(),
  lastObservedAt: z.number().int().nonnegative().nullable(),
  observationSpanDays: z.number().nonnegative().nullable(),
  evidenceLevel: z.enum(EVIDENCE_LEVELS),
  passedGates: stringList,
  failedGates: stringList,
  missingEvidence: stringList,
  allowedClaims: stringList,
  blockedClaims: stringList,
});

export const DecisionGateSchema = z.strictObject({
  gateType: z.enum(DECISION_GATE_TYPES),
  status: z.enum(DECISION_GATE_STATUSES),
  rationale: nonBlank,
  supportingEvidence: stringList,
  counterEvidence: stringList,
  missingEvidence: stringList,
  nextEvidenceActions: stringList,
  reversibleActions: stringList,
  prohibitedActions: stringList,
});

function requireAllGateTypes(
  value: { decisionGates: Array<{ gateType: string }> },
  context: z.RefinementCtx,
): void {
  const types = value.decisionGates.map(({ gateType }) => gateType);
  for (const gateType of DECISION_GATE_TYPES) {
    if (types.filter((candidate) => candidate === gateType).length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['decisionGates'],
        message: `决策门 ${gateType} 必须且只能出现一次`,
      });
    }
  }
}

export const MarketPositionBorrowedEvidenceSchema = z.strictObject({
  sourceScope: MarketPositionScopeSchema,
  sourceEvidenceId: nonBlank,
  borrowedReason: nonBlank,
  downweight: z.number().min(0).max(1),
  applicability: nonBlank,
  uncertainty: nonBlank,
});

export const MarketPositionScopeProfileSchema = z.strictObject({
  scope: MarketPositionScopeSchema,
  headline: nonBlank,
  positioning: nonBlank,
  targetRoleFamilies: z.array(jobFamily),
  observedStrengths: stringList,
  observedWeaknesses: stringList,
  marketSignals: stringList,
  counterSignals: stringList,
  uncertainties: stringList,
  evidenceSufficiency: EvidenceSufficiencySchema,
  decisionGates: z.array(DecisionGateSchema).length(DECISION_GATE_TYPES.length),
  nextEvidenceActions: stringList,
  borrowedEvidence: z.array(MarketPositionBorrowedEvidenceSchema),
}).superRefine(requireAllGateTypes);

function requireFourCityProfiles(
  value: { cityProfiles: Array<{ scope: { city: string | null } }> },
  context: z.RefinementCtx,
): void {
  const cities = value.cityProfiles.map(({ scope }) => scope.city);
  for (const city of MARKET_POSITION_CITY_CODES) {
    if (cities.filter((candidate) => candidate === city).length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['cityProfiles'],
        message: `城市 ${city} 必须且只能出现一次`,
      });
    }
  }
}

const draftShape = {
  global: MarketPositionScopeProfileSchema,
  cityProfiles: z.array(MarketPositionScopeProfileSchema).length(MARKET_POSITION_CITY_CODES.length),
  generatedFrom: z.strictObject({
    jobMatchProfileVersionId: nonBlank.nullable(),
    capabilityBaselineVersionId: nonBlank.nullable(),
    funnelCutoffAt: z.number().int().nonnegative(),
  }),
  dataCutoffAt: z.number().int().nonnegative(),
};

export const MarketPositionDraftSchema: z.ZodType<MarketPositionDraft> = z
  .strictObject(draftShape)
  .superRefine(requireFourCityProfiles);

const inputSnapshotSchema = z.strictObject({
  jobMatchProfileVersionId: nonBlank.nullable(),
  capabilityBaselineVersionId: nonBlank.nullable(),
  acceptedEvidenceIds: stringList,
  funnelCutoffAt: z.number().int().nonnegative(),
  funnelQueryFingerprint: hashHex64,
  inputHash: hashHex64,
  capturedAt: z.number().int().nonnegative(),
});

export const MarketPositionProposalSchema: z.ZodType<MarketPositionProposal> = z.strictObject({
  id: nonBlank,
  status: z.enum(['proposed', 'accepted', 'modified_and_accepted', 'rejected', 'deferred']),
  payload: MarketPositionDraftSchema,
  acceptedPayload: MarketPositionDraftSchema.nullable(),
  decisionDiff: stringList,
  inputSnapshot: inputSnapshotSchema,
  generatedBy: z.enum(['ai', 'manual']),
  modelInfo: nonBlank.nullable(),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().nullable(),
  decisionNote: z.string().nullable(),
  expectedStateVersion: z.number().int().nonnegative(),
});

export const MarketPositionVersionSchema: z.ZodType<MarketPositionVersion> = z.strictObject({
    ...draftShape,
    id: nonBlank,
    version: z.number().int().positive(),
    status: z.enum(['active', 'archived']),
    inputSnapshot: inputSnapshotSchema,
    createdAt: z.number().int().nonnegative(),
    activatedAt: z.number().int().nonnegative(),
    supersedesVersionId: nonBlank.nullable(),
    proposalId: nonBlank,
  }).superRefine(requireFourCityProfiles);

export const MarketPositionStateSchema: z.ZodType<MarketPositionState> = z.strictObject({
  stateVersion: z.number().int().nonnegative(),
  activeVersionId: nonBlank.nullable(),
  versions: z.array(MarketPositionVersionSchema),
  proposals: z.array(MarketPositionProposalSchema),
  commandReceipts: z.array(z.strictObject({
    idempotencyKey: nonBlank,
    commandType: z.enum([
      'generate_proposal', 'manual_proposal', 'accept_proposal',
      'reject_proposal', 'defer_proposal', 'activate_version',
    ]),
    targetId: nonBlank.nullable(),
    resultId: nonBlank.nullable(),
    requestHash: hashHex64,
    createdAt: z.number().int().nonnegative(),
  })),
}).superRefine((state, context) => {
  const activeVersions = state.versions.filter(({ status }) => status === 'active');
  if (state.activeVersionId === null && activeVersions.length !== 0) {
    context.addIssue({ code: 'custom', path: ['activeVersionId'], message: '空指针不得存在 active 版本' });
  }
  if (
    state.activeVersionId !== null
    && (activeVersions.length !== 1 || activeVersions[0]?.id !== state.activeVersionId)
  ) {
    context.addIssue({ code: 'custom', path: ['activeVersionId'], message: '必须且只能指向一个 active 版本' });
  }
});

export const MarketPositionViewSchema = z.strictObject({
  state: MarketPositionStateSchema,
  activeVersion: MarketPositionVersionSchema.nullable(),
  llmConfigured: z.boolean(),
});

export const MarketPositionCommandBaseSchema = z.strictObject({
  idempotencyKey: nonBlank.max(200),
  expectedStateVersion: z.number().int().nonnegative(),
});

export const MarketPositionManualProposalRequestSchema = MarketPositionCommandBaseSchema.extend({
  payload: MarketPositionDraftSchema,
});

export const MarketPositionDecisionRequestSchema = MarketPositionCommandBaseSchema.extend({
  decisionNote: z.string().max(2000).nullable().optional(),
});

export const MarketPositionAcceptRequestSchema = MarketPositionDecisionRequestSchema.extend({
  modifiedPayload: MarketPositionDraftSchema.optional(),
});

export const MarketPositionActivateRequestSchema = MarketPositionCommandBaseSchema.extend({
  confirmed: z.literal(true),
});
