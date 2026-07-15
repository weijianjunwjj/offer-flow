import { z } from 'zod';
import {
  CAPABILITY_COMMAND_TYPES,
  CAPABILITY_CONCLUSION_STATUSES,
  CAPABILITY_CONSTRAINT_KINDS,
  CAPABILITY_EVIDENCE_GENERATORS,
  CAPABILITY_EVIDENCE_POLARITIES,
  CAPABILITY_EVIDENCE_SOURCE_TYPES,
  CAPABILITY_EVIDENCE_STATUSES,
  CAPABILITY_EVIDENCE_STRENGTHS,
  CAPABILITY_SOURCE_CONFIDENCES,
  CAPABILITY_TIME_PRECISIONS,
  JOB_MATCH_CITY_CODES,
  type CandidateEvidence,
  type CapabilityBaselineDraft,
  type CapabilityBaselineProposal,
  type CapabilityBaselineState,
  type CapabilityBaselineVersion,
} from './types';

const nonBlank = z.string().trim().min(1);
const stringList = z.array(nonBlank);
const cityCode = z.enum(JOB_MATCH_CITY_CODES);
const conclusionStatus = z.enum(CAPABILITY_CONCLUSION_STATUSES);
const observedAt = z.number().finite().int().nonnegative().nullable();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

export const CandidateEvidenceContentSchema = z.strictObject({
  capabilityKey: nonBlank,
  capabilityLabel: nonBlank,
  polarity: z.enum(CAPABILITY_EVIDENCE_POLARITIES),
  strength: z.enum(CAPABILITY_EVIDENCE_STRENGTHS),
  sourceType: z.enum(CAPABILITY_EVIDENCE_SOURCE_TYPES),
  sourceId: nonBlank.nullable(),
  sourceLabel: nonBlank,
  city: cityCode.nullable(),
  summary: nonBlank,
  observedAt,
  timePrecision: z.enum(CAPABILITY_TIME_PRECISIONS),
  sourceConfidence: z.enum(CAPABILITY_SOURCE_CONFIDENCES),
});

export const CandidateEvidenceSchema: z.ZodType<CandidateEvidence> = z.strictObject({
  capabilityKey: nonBlank,
  capabilityLabel: nonBlank,
  polarity: z.enum(CAPABILITY_EVIDENCE_POLARITIES),
  strength: z.enum(CAPABILITY_EVIDENCE_STRENGTHS),
  sourceType: z.enum(CAPABILITY_EVIDENCE_SOURCE_TYPES),
  sourceId: nonBlank.nullable(),
  sourceLabel: nonBlank,
  city: cityCode.nullable(),
  summary: nonBlank,
  observedAt,
  timePrecision: z.enum(CAPABILITY_TIME_PRECISIONS),
  sourceConfidence: z.enum(CAPABILITY_SOURCE_CONFIDENCES),
  id: nonBlank,
  generatedBy: z.enum(CAPABILITY_EVIDENCE_GENERATORS),
  status: z.enum(CAPABILITY_EVIDENCE_STATUSES),
  acceptedContent: CandidateEvidenceContentSchema.nullable(),
  decisionDiff: stringList,
  modelInfo: nonBlank.nullable(),
  inputFingerprint: fingerprint.nullable(),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().nullable(),
  decisionNote: z.string().nullable(),
  expectedStateVersion: z.number().int().nonnegative(),
});

const capabilityDimensionSchema = z.strictObject({
  key: nonBlank,
  label: nonBlank,
  conclusion: nonBlank,
  conclusionStatus,
  supportingEvidenceRefs: stringList,
  counterEvidenceRefs: stringList,
  unverified: stringList,
  largestUncertainty: nonBlank,
});

const externalConstraintSchema = z.strictObject({
  key: nonBlank,
  kind: z.enum(CAPABILITY_CONSTRAINT_KINDS),
  label: nonBlank,
  summary: nonBlank,
  evidenceRefs: stringList,
});

const capabilityBaselineDraftShape = {
  summary: nonBlank,
  capabilities: z.array(capabilityDimensionSchema),
  externalConstraints: z.array(externalConstraintSchema),
  overallConfidence: conclusionStatus,
  largestUncertainties: stringList,
};

export const CapabilityBaselineDraftSchema: z.ZodType<CapabilityBaselineDraft> =
  z.strictObject(capabilityBaselineDraftShape);

const sourceSnapshotSchema = z.strictObject({
  inputFingerprint: fingerprint,
  activeResumeVersionId: nonBlank.nullable(),
  acceptedEvidenceCount: z.number().int().nonnegative(),
  jobCount: z.number().int().nonnegative(),
  applicationCount: z.number().int().nonnegative(),
  feedbackEventCount: z.number().int().nonnegative(),
  capturedAt: z.number().int().nonnegative(),
});

export const CapabilityBaselineProposalSchema: z.ZodType<CapabilityBaselineProposal> =
  z.strictObject({
    id: nonBlank,
    status: z.enum(CAPABILITY_EVIDENCE_STATUSES),
    payload: CapabilityBaselineDraftSchema,
    acceptedPayload: CapabilityBaselineDraftSchema.nullable(),
    decisionDiff: stringList,
    inputFingerprint: fingerprint,
    generatedBy: z.enum(['ai', 'manual']),
    modelInfo: nonBlank.nullable(),
    sourceSnapshot: sourceSnapshotSchema,
    evidenceRefs: stringList,
    createdAt: z.number().int().nonnegative(),
    decidedAt: z.number().int().nonnegative().nullable(),
    decisionNote: z.string().nullable(),
    expectedStateVersion: z.number().int().nonnegative(),
  });

export const CapabilityBaselineVersionSchema: z.ZodType<CapabilityBaselineVersion> =
  z.strictObject({
    ...capabilityBaselineDraftShape,
    id: nonBlank,
    version: z.number().int().positive(),
    status: z.enum(['active', 'archived']),
    sourceSnapshot: sourceSnapshotSchema,
    evidenceRefs: stringList,
    createdAt: z.number().int().nonnegative(),
    activatedAt: z.number().int().nonnegative(),
    supersedesVersionId: nonBlank.nullable(),
    proposalId: nonBlank,
  });

export const CapabilityBaselineStateSchema: z.ZodType<CapabilityBaselineState> = z
  .strictObject({
    stateVersion: z.number().int().nonnegative(),
    activeVersionId: nonBlank.nullable(),
    evidence: z.array(CandidateEvidenceSchema),
    versions: z.array(CapabilityBaselineVersionSchema),
    proposals: z.array(CapabilityBaselineProposalSchema),
    commandReceipts: z.array(z.strictObject({
      idempotencyKey: nonBlank,
      commandType: z.enum(CAPABILITY_COMMAND_TYPES),
      targetId: nonBlank.nullable(),
      resultId: nonBlank.nullable(),
      requestHash: fingerprint,
      createdAt: z.number().int().nonnegative(),
    })),
  })
  .superRefine((state, context) => {
    const activeVersions = state.versions.filter(({ status }) => status === 'active');
    if (state.activeVersionId === null && activeVersions.length !== 0) {
      context.addIssue({ code: 'custom', path: ['activeVersionId'], message: '无 active 指针时不得存在 active 版本' });
    }
    if (
      state.activeVersionId !== null
      && (activeVersions.length !== 1 || activeVersions[0]?.id !== state.activeVersionId)
    ) {
      context.addIssue({ code: 'custom', path: ['activeVersionId'], message: '必须且只能指向一个 active 版本' });
    }
  });

export const CapabilityBaselineViewSchema = z.strictObject({
  state: CapabilityBaselineStateSchema,
  activeVersion: CapabilityBaselineVersionSchema.nullable(),
  llmConfigured: z.boolean(),
});

export const CapabilityCommandBaseSchema = z.strictObject({
  idempotencyKey: nonBlank.max(200),
  expectedStateVersion: z.number().int().nonnegative(),
});

export const CapabilityManualEvidenceRequestSchema = CapabilityCommandBaseSchema.extend({
  content: CandidateEvidenceContentSchema,
});

export const CapabilityGenerateRequestSchema = CapabilityCommandBaseSchema;

export const CapabilityEvidenceDecisionRequestSchema = CapabilityCommandBaseSchema.extend({
  decisionNote: z.string().max(2000).nullable().optional(),
});

export const CapabilityEvidenceAcceptRequestSchema = CapabilityEvidenceDecisionRequestSchema.extend({
  modifiedContent: CandidateEvidenceContentSchema.optional(),
});

export const CapabilityManualBaselineProposalRequestSchema = CapabilityCommandBaseSchema.extend({
  payload: CapabilityBaselineDraftSchema,
});

export const CapabilityBaselineAcceptRequestSchema = CapabilityEvidenceDecisionRequestSchema.extend({
  modifiedPayload: CapabilityBaselineDraftSchema.optional(),
});

export const CapabilityActivateRequestSchema = CapabilityCommandBaseSchema.extend({
  confirmed: z.literal(true),
});
