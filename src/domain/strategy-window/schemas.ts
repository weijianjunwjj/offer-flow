import { z } from 'zod';
import { JOB_FAMILIES } from '../funnel/jobFamily';
import {
  DECISION_GATE_STATUSES,
  DECISION_GATE_TYPES,
  EVIDENCE_LEVELS,
} from '../market-position';
import {
  STRATEGY_ACTION_TYPES,
  STRATEGY_CITY_CODES,
  STRATEGY_WINDOW_TYPES,
} from './types';

const nonBlank = z.string().trim().min(1);
const text = z.string();
const hashHex64 = z.string().regex(/^[a-f0-9]{64}$/);
const cityCode = z.enum(STRATEGY_CITY_CODES);
const jobFamily = z.enum(JOB_FAMILIES);
const timestamp = z.number().int().nonnegative();

const DecisionGateSnapshotEntrySchema = z.strictObject({
  gateType: z.enum(DECISION_GATE_TYPES),
  status: z.enum(DECISION_GATE_STATUSES),
});

const SourceVersionIdsSchema = z.strictObject({
  jobMatchProfileVersionId: z.string().nullable(),
  capabilityBaselineVersionId: z.string().nullable(),
  marketPositionVersionId: z.string().nullable(),
});

export const StrategyActionSchema = z.strictObject({
  id: nonBlank,
  actionType: z.enum(STRATEGY_ACTION_TYPES),
  title: nonBlank,
  rationale: text,
  scope: z.enum(['global', 'city', 'city_job_family']),
  city: cityCode.nullable(),
  jobFamily: jobFamily.nullable(),
  priority: z.enum(['high', 'medium', 'low']),
  targetCount: z.number().int().nonnegative(),
  allocationShare: z.number().min(0).max(100),
  startAt: timestamp,
  reviewAt: timestamp,
  successSignals: z.array(text).max(10),
  failureSignals: z.array(text).max(10),
  stopConditions: z.array(text).max(10),
  evidenceTargets: z.array(text).max(10),
  reversible: z.boolean(),
  expectedCost: z.enum(['low', 'medium', 'high']),
  prohibitedInterpretations: z.array(text).max(10),
  sourceDecisionGate: z.enum(DECISION_GATE_TYPES).nullable(),
  sourceEvidenceIds: z.array(z.string().trim().min(1).max(200)).max(20),
});

export const StrategyExperimentSchema = z.strictObject({
  id: nonBlank,
  actionType: z.enum(STRATEGY_ACTION_TYPES),
  title: nonBlank,
  variable: nonBlank,
  variantA: nonBlank,
  variantB: nonBlank,
  sampleTarget: z.number().int().positive(),
  observationMetric: text,
  endCondition: text,
  reversible: z.boolean(),
});

export const StrategyAllocationPlanSchema = z.strictObject({
  dimension: z.enum(['city', 'job_family', 'channel']),
  title: text,
  note: text,
  entries: z.array(z.strictObject({
    key: nonBlank,
    label: text,
    share: z.number().min(0).max(100),
    exploratory: z.boolean(),
  })).max(20),
});

export const StrategyProposalDraftSchema = z.strictObject({
  headline: nonBlank,
  objective: text,
  summary: text,
  horizonDays: z.number().int().min(1).max(60),
  allocationPlans: z.array(StrategyAllocationPlanSchema).max(10),
  actions: z.array(StrategyActionSchema).max(40),
  experiments: z.array(StrategyExperimentSchema).max(20),
  evidenceTargets: z.array(text).max(20),
  reviewTriggers: z.array(text).max(20),
  stopConditions: z.array(text).max(20),
  reversibleActions: z.array(text).max(40),
  prohibitedActions: z.array(text).max(20),
  uncertainties: z.array(text).max(20),
});

export const StrategyWindowSchema = z.strictObject({
  id: nonBlank,
  windowType: z.enum(STRATEGY_WINDOW_TYPES),
  startsAt: timestamp,
  reviewAt: timestamp,
  expiresAt: timestamp,
  sourceVersionIds: SourceVersionIdsSchema,
  inputHash: hashHex64,
  dataCutoffAt: timestamp,
  evidenceLevel: z.enum(EVIDENCE_LEVELS),
  decisionGateSnapshot: z.array(DecisionGateSnapshotEntrySchema),
  allowedActionTypes: z.array(z.enum(STRATEGY_ACTION_TYPES)),
  observeOnlyActionTypes: z.array(z.enum(STRATEGY_ACTION_TYPES)),
  blockedActionTypes: z.array(z.enum(STRATEGY_ACTION_TYPES)),
  requiredEvidenceTargets: z.array(text),
  reviewTriggers: z.array(text),
  stopConditions: z.array(text),
  allowedClaims: z.array(text),
  blockedClaims: z.array(text),
  createdAt: timestamp,
  ruleVersion: nonBlank,
});

export const StrategyInputSnapshotSchema = z.strictObject({
  jobMatchProfileVersionId: z.string().nullable(),
  capabilityBaselineVersionId: z.string().nullable(),
  marketPositionVersionId: z.string().nullable(),
  acceptedEvidenceIds: z.array(z.string()),
  funnelCutoffAt: timestamp,
  funnelQueryFingerprint: hashHex64,
  evidenceLevel: z.enum(EVIDENCE_LEVELS),
  decisionGateStatuses: z.array(DecisionGateSnapshotEntrySchema),
  allowedClaims: z.array(text),
  blockedClaims: z.array(text),
  inputHash: hashHex64,
  capturedAt: timestamp,
});

const StrategyAiGenerationMetadataSchema = z.strictObject({
  provider: nonBlank,
  model: nonBlank,
  generatedAt: timestamp,
  inputHash: hashHex64,
  promptVersion: nonBlank,
  deterministicRuleVersion: nonBlank,
});

export const StrategyProposalSchema = z.strictObject({
  id: nonBlank,
  status: z.enum(['proposed', 'accepted', 'modified_and_accepted', 'rejected', 'deferred']),
  window: StrategyWindowSchema,
  payload: StrategyProposalDraftSchema,
  acceptedPayload: StrategyProposalDraftSchema.nullable(),
  decisionDiff: z.array(text),
  inputSnapshot: StrategyInputSnapshotSchema,
  generatedBy: z.enum(['ai', 'manual']),
  modelInfo: z.string().nullable(),
  aiGeneration: StrategyAiGenerationMetadataSchema.nullable(),
  createdAt: timestamp,
  decidedAt: timestamp.nullable(),
  decisionNote: z.string().nullable(),
  expectedStateVersion: z.number().int().nonnegative(),
  stale: z.boolean().default(false),
});

export const StrategyVersionSchema = z.strictObject({
  id: nonBlank,
  version: z.number().int().positive(),
  status: z.enum(['active', 'archived']),
  window: StrategyWindowSchema,
  payload: StrategyProposalDraftSchema,
  inputSnapshot: StrategyInputSnapshotSchema,
  generationMode: z.enum(['ai', 'manual']),
  decisionDiff: z.array(text),
  createdAt: timestamp,
  activatedAt: timestamp,
  supersedesVersionId: z.string().nullable(),
  proposalId: nonBlank,
});

const StrategyCommandReceiptSchema = z.strictObject({
  idempotencyKey: nonBlank,
  commandType: z.enum([
    'generate_proposal', 'manual_proposal', 'accept_proposal',
    'reject_proposal', 'defer_proposal', 'activate_version',
  ]),
  targetId: z.string().nullable(),
  resultId: z.string().nullable(),
  requestHash: nonBlank,
  createdAt: timestamp,
});

export const StrategyStateSchema = z.strictObject({
  stateVersion: z.number().int().nonnegative(),
  activeVersionId: z.string().nullable(),
  versions: z.array(StrategyVersionSchema),
  proposals: z.array(StrategyProposalSchema),
  commandReceipts: z.array(StrategyCommandReceiptSchema),
}).superRefine((value, context) => {
  if (value.activeVersionId === null) {
    if (value.versions.some((version) => version.status === 'active')) {
      context.addIssue({ code: 'custom', path: ['activeVersionId'], message: '无 active 版本时不得存在 status=active 的版本' });
    }
    return;
  }
  const active = value.versions.filter((version) => version.status === 'active');
  if (active.length !== 1 || active[0]?.id !== value.activeVersionId) {
    context.addIssue({ code: 'custom', path: ['activeVersionId'], message: 'activeVersionId 必须恰好对应一个 status=active 的版本' });
  }
});

export const StrategyViewSchema = z.strictObject({
  state: StrategyStateSchema,
  activeVersion: StrategyVersionSchema.nullable(),
  currentWindow: StrategyWindowSchema.nullable(),
  inputReady: z.boolean(),
  llmConfigured: z.boolean(),
  reused: z.boolean().default(false),
});

const StrategyCommandBaseSchema = z.strictObject({
  idempotencyKey: nonBlank.max(200),
  expectedStateVersion: z.number().int().nonnegative(),
});

export const StrategyManualProposalRequestSchema = StrategyCommandBaseSchema.extend({
  payload: StrategyProposalDraftSchema,
});

export const StrategyGenerateProposalRequestSchema = StrategyCommandBaseSchema.extend({
  expectedInputHash: hashHex64.nullable().optional(),
});

export const StrategyDecisionRequestSchema = StrategyCommandBaseSchema.extend({
  decisionNote: z.string().max(2000).nullable().optional(),
});

export const StrategyAcceptRequestSchema = StrategyDecisionRequestSchema.extend({
  modifiedPayload: StrategyProposalDraftSchema.optional(),
});

export const StrategyActivateRequestSchema = StrategyCommandBaseSchema.extend({
  confirmed: z.literal(true),
});
