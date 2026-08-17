/**
 * Writer Runtime Candidate Pool — Provider-neutral.
 *
 * Consumes existing governance truth only. It never re-runs benchmarks,
 * never re-samples, and never re-evaluates qualification. Each configured
 * Provider Profile is passed through the Runtime Eligibility gate; only
 * ELIGIBLE profiles enter the pool.
 */
import type { ProviderAdapterResolver, ProviderProfile } from './types';
import {
  evaluateWriterRuntimeEligibility,
  type WriterRuntimeEligibilityReasonCode,
  type WriterRuntimeEligibilityResult,
} from './writerRuntimeEligibility';

export interface WriterRuntimeCandidate {
  profileId: string;
  logicalModelName: string;
  /** Opaque, Provider-neutral identifier derived from the profile config (profile id). */
  providerIdentifier: string;
  certificateId: string | null;
  resultId: string | null;
  batchId: string | null;
  qualificationIdentityFingerprint: string | null;
  pricingReady: boolean;
}

export interface WriterRuntimeCandidateAssessment {
  profileId: string;
  status: WriterRuntimeEligibilityResult['status'];
  reasonCodes: WriterRuntimeEligibilityReasonCode[];
}

export interface WriterRuntimeCandidatePool {
  eligibleCandidates: WriterRuntimeCandidate[];
  assessments: WriterRuntimeCandidateAssessment[];
}

export function toWriterRuntimeCandidate(
  result: WriterRuntimeEligibilityResult,
  profile: ProviderProfile,
): WriterRuntimeCandidate {
  return {
    profileId: result.profileId,
    logicalModelName: result.logicalModelName,
    providerIdentifier: profile.id,
    certificateId: result.certificateId,
    resultId: result.resultId,
    batchId: result.batchId,
    qualificationIdentityFingerprint: result.qualificationIdentityFingerprint,
    pricingReady: result.pricingReady,
  };
}

/**
 * Builds the eligible Writer candidate pool from configured profiles.
 * Provider brand is never used to decide membership — only the eligibility
 * gate's deterministic result.
 */
export function buildWriterRuntimeCandidatePool(input: {
  cwd: string;
  profiles: Readonly<Record<string, ProviderProfile>>;
  adapterRegistry: ProviderAdapterResolver;
  parentEnv: NodeJS.ProcessEnv;
  transportPolicyVersion?: string;
}): WriterRuntimeCandidatePool {
  const eligibleCandidates: WriterRuntimeCandidate[] = [];
  const assessments: WriterRuntimeCandidateAssessment[] = [];

  for (const profile of Object.values(input.profiles)) {
    const result = evaluateWriterRuntimeEligibility({
      cwd: input.cwd,
      profile,
      logicalModelName: profile.defaultModelId,
      adapterRegistry: input.adapterRegistry,
      parentEnv: input.parentEnv,
      transportPolicyVersion: input.transportPolicyVersion,
    });
    assessments.push({
      profileId: result.profileId,
      status: result.status,
      reasonCodes: result.reasonCodes,
    });
    if (result.status === 'ELIGIBLE') {
      eligibleCandidates.push(toWriterRuntimeCandidate(result, profile));
    }
  }

  return { eligibleCandidates, assessments };
}
