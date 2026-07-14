import { z } from 'zod';
import {
  JOB_MATCH_CITY_CODES,
  type JobMatchProfileDraft,
  type JobMatchProfileProposal,
  type JobMatchProfileState,
  type JobMatchProfileVersion,
} from './types';

const nonBlank = z.string().trim().min(1);
const stringList = z.array(nonBlank);
const nullableK = z.number().finite().nonnegative().nullable();
const cityCode = z.enum(JOB_MATCH_CITY_CODES);
const confidence = z.enum(['insufficient', 'exploratory', 'actionable']);

export const JobMatchEvidenceRefSchema = z.strictObject({
  sourceType: z.enum(['profile', 'resume_version', 'job', 'application', 'feedback_event', 'user_input']),
  sourceId: nonBlank.nullable(),
  label: nonBlank,
  polarity: z.enum(['support', 'counter', 'neutral']),
  strength: z.enum(['strong', 'medium', 'weak']),
  city: cityCode.nullable(),
  summary: nonBlank,
});

export const JobMatchRoleBandSchema = z.strictObject({
  roleTitles: stringList,
  roleFamilies: stringList,
  salaryRange: z.strictObject({ minK: nullableK, maxK: nullableK, note: z.string() })
    .superRefine((salary, context) => {
      if (salary.minK !== null && salary.maxK !== null && salary.minK > salary.maxK) {
        context.addIssue({ code: 'custom', message: '最低薪资不能高于最高薪资', path: ['minK'] });
      }
    }),
  companySizes: stringList,
  companyTypes: stringList,
  industries: stringList,
  technicalFocus: stringList,
  suitableReasons: stringList,
  risks: stringList,
});

const capabilitySchema = z.strictObject({
  key: nonBlank,
  label: nonBlank,
  level: z.enum(['core', 'supporting', 'to_validate']),
  summary: nonBlank,
  evidenceRefs: stringList,
});

const constraintSchema = z.strictObject({
  key: nonBlank,
  label: nonBlank,
  summary: nonBlank,
  evidenceRefs: stringList,
});

const cityProfileSchema = z.strictObject({
  city: cityCode,
  confidence,
  summary: nonBlank,
  highestReachableRole: nonBlank,
  stretchRoles: JobMatchRoleBandSchema,
  primaryRoles: JobMatchRoleBandSchema,
  safeRoles: JobMatchRoleBandSchema,
  educationBarrier: nonBlank,
  salaryNote: nonBlank,
  preferredCompanyProfile: stringList,
  supportingEvidence: z.array(JobMatchEvidenceRefSchema),
  counterEvidence: z.array(JobMatchEvidenceRefSchema),
  missingEvidence: stringList,
  borrowedEvidence: z.array(z.strictObject({
    sourceCity: cityCode,
    reason: nonBlank,
    discountNote: nonBlank,
    notApplicableTo: stringList,
  })),
});

function requireFourCities(
  value: { cityProfiles: Array<{ city: string }> },
  context: z.RefinementCtx,
): void {
  const cities = value.cityProfiles.map(({ city }) => city);
  for (const city of JOB_MATCH_CITY_CODES) {
    if (cities.filter((candidate) => candidate === city).length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['cityProfiles'],
        message: `城市 ${city} 必须且只能出现一次`,
      });
    }
  }
}

const profileDraftShape = {
  northStarPositioning: nonBlank,
  highestReachableRole: nonBlank,
  primaryRoleFamilies: stringList,
  stretchRoles: JobMatchRoleBandSchema,
  primaryRoles: JobMatchRoleBandSchema,
  safeRoles: JobMatchRoleBandSchema,
  coreCapabilities: z.array(capabilitySchema),
  constraints: z.array(constraintSchema),
  idealEnvironment: z.strictObject({
    companySizes: stringList,
    companyTypes: stringList,
    industries: stringList,
    teamTraits: stringList,
    description: nonBlank,
  }),
  acceptableRange: z.strictObject({
    roleTitles: stringList,
    cities: z.array(cityCode),
    salaryNote: nonBlank,
    companyTypes: stringList,
    workModes: stringList,
    notes: stringList,
  }),
  cityProfiles: z.array(cityProfileSchema).length(4),
  supportingEvidence: z.array(JobMatchEvidenceRefSchema),
  counterEvidence: z.array(JobMatchEvidenceRefSchema),
  confidence,
  largestUncertainties: stringList,
};

export const JobMatchProfileDraftSchema: z.ZodType<JobMatchProfileDraft> = z
  .strictObject(profileDraftShape)
  .superRefine(requireFourCities);

const sourceSnapshotSchema = z.strictObject({
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  activeResumeVersionId: nonBlank.nullable(),
  jobCount: z.number().int().nonnegative(),
  applicationCount: z.number().int().nonnegative(),
  feedbackEventCount: z.number().int().nonnegative(),
  cityApplicationCounts: z.strictObject({
    suzhou: z.number().int().nonnegative(),
    wuxi: z.number().int().nonnegative(),
    shanghai: z.number().int().nonnegative(),
    hangzhou: z.number().int().nonnegative(),
  }),
  capturedAt: z.number().int().nonnegative(),
});

export const JobMatchProfileProposalSchema: z.ZodType<JobMatchProfileProposal> = z.strictObject({
  id: nonBlank,
  status: z.enum(['proposed', 'accepted', 'modified_and_accepted', 'rejected', 'deferred']),
  payload: JobMatchProfileDraftSchema,
  acceptedPayload: JobMatchProfileDraftSchema.nullable(),
  decisionDiff: stringList,
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  generatedBy: z.enum(['ai', 'manual']),
  modelInfo: nonBlank.nullable(),
  sourceSnapshot: sourceSnapshotSchema,
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().nullable(),
  decisionNote: z.string().nullable(),
  expectedProfileStateVersion: z.number().int().nonnegative(),
});

export const JobMatchProfileVersionSchema: z.ZodType<JobMatchProfileVersion> = z.strictObject({
    ...profileDraftShape,
    id: nonBlank,
    version: z.number().int().positive(),
    status: z.enum(['active', 'archived']),
    sourceSnapshot: sourceSnapshotSchema,
    createdAt: z.number().int().nonnegative(),
    activatedAt: z.number().int().nonnegative(),
    supersedesVersionId: nonBlank.nullable(),
    proposalId: nonBlank,
  }).superRefine(requireFourCities);

export const JobMatchProfileStateSchema: z.ZodType<JobMatchProfileState> = z.strictObject({
  stateVersion: z.number().int().nonnegative(),
  activeVersionId: nonBlank.nullable(),
  versions: z.array(JobMatchProfileVersionSchema),
  proposals: z.array(JobMatchProfileProposalSchema),
  commandReceipts: z.array(z.strictObject({
    idempotencyKey: nonBlank,
    commandType: z.enum([
      'generate_proposal', 'manual_proposal', 'accept_proposal',
      'reject_proposal', 'defer_proposal', 'activate_version',
    ]),
    targetId: nonBlank.nullable(),
    resultId: nonBlank.nullable(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
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

export const JobMatchProfileViewSchema = z.strictObject({
  state: JobMatchProfileStateSchema,
  activeVersion: JobMatchProfileVersionSchema.nullable(),
  llmConfigured: z.boolean(),
});

export const JobMatchCommandBaseSchema = z.strictObject({
  idempotencyKey: nonBlank.max(200),
  expectedProfileStateVersion: z.number().int().nonnegative(),
});

export const JobMatchManualProposalRequestSchema = JobMatchCommandBaseSchema.extend({
  payload: JobMatchProfileDraftSchema,
});

export const JobMatchDecisionRequestSchema = JobMatchCommandBaseSchema.extend({
  decisionNote: z.string().max(2000).nullable().optional(),
});

export const JobMatchAcceptRequestSchema = JobMatchDecisionRequestSchema.extend({
  modifiedPayload: JobMatchProfileDraftSchema.optional(),
});

export const JobMatchActivateRequestSchema = JobMatchCommandBaseSchema.extend({
  confirmed: z.literal(true),
});
