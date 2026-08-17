/**
 * Writer Runtime Onboarding — ties eligibility, candidate pool, and selection
 * into a single resolution used by the routed WRITER execution seam.
 *
 * Also provides the runtime preflight (TOCTOU) re-check: selection and
 * execution are bound by profileId + qualificationIdentityFingerprint +
 * certificateId, so a profile/certificate drift between selection and
 * execution is rejected.
 */
import { loadProviderProfiles } from './provider';
import type { CcAutoConfig } from './config';
import type {
  ProviderAdapterResolver,
  ProviderProfile,
  WriterAssignment,
} from './types';
import {
  buildWriterRuntimeCandidatePool,
  type WriterRuntimeCandidate,
  type WriterRuntimeCandidateAssessment,
} from './writerRuntimeCandidatePool';
import {
  selectRuntimeWriter,
  type WriterSelectionPreference,
} from './writerSelectionPolicy';
import {
  evaluateWriterRuntimeEligibility,
  type WriterRuntimeEligibilityReasonCode,
} from './writerRuntimeEligibility';

export interface ResolvedRuntimeWriter {
  candidate: WriterRuntimeCandidate;
  profile: ProviderProfile;
  assignment: WriterAssignment;
}

export type RuntimeWriterResolution =
  | { status: 'RESOLVED'; writer: ResolvedRuntimeWriter }
  | { status: 'NO_ELIGIBLE_WRITER'; assessments: WriterRuntimeCandidateAssessment[] }
  | { status: 'AMBIGUOUS_ELIGIBLE_WRITERS'; candidates: WriterRuntimeCandidate[] }
  | { status: 'PREFERENCE_NOT_ELIGIBLE'; preferenceProfileId: string }
  | { status: 'PROVIDER_PROFILES_UNAVAILABLE'; detail: string };

/**
 * Resolves the Runtime Writer: loads profiles → eligibility gate → candidate
 * pool → deterministic selection. Provider-brand logic is never consulted.
 */
export function resolveRuntimeWriter(input: {
  cwd: string;
  config: CcAutoConfig;
  adapterRegistry: ProviderAdapterResolver;
  parentEnv: NodeJS.ProcessEnv;
  preference?: WriterSelectionPreference | null;
}): RuntimeWriterResolution {
  const loaded = loadProviderProfiles(input.config);
  if (!loaded.ok || !loaded.profiles) {
    return { status: 'PROVIDER_PROFILES_UNAVAILABLE', detail: loaded.error ?? 'providerProfiles 加载失败' };
  }

  const pool = buildWriterRuntimeCandidatePool({
    cwd: input.cwd,
    profiles: loaded.profiles,
    adapterRegistry: input.adapterRegistry,
    parentEnv: input.parentEnv,
  });

  const selection = selectRuntimeWriter(pool.eligibleCandidates, input.preference);
  switch (selection.status) {
    case 'SELECTED': {
      const profile = loaded.profiles[selection.candidate.profileId];
      if (!profile) {
        return { status: 'NO_ELIGIBLE_WRITER', assessments: pool.assessments };
      }
      return {
        status: 'RESOLVED',
        writer: {
          candidate: selection.candidate,
          profile,
          assignment: {
            executionRole: 'WRITER',
            profileId: selection.candidate.profileId,
            providerIdentifier: selection.candidate.providerIdentifier,
          },
        },
      };
    }
    case 'NO_ELIGIBLE_WRITER':
      return { status: 'NO_ELIGIBLE_WRITER', assessments: pool.assessments };
    case 'AMBIGUOUS_ELIGIBLE_WRITERS':
      return { status: 'AMBIGUOUS_ELIGIBLE_WRITERS', candidates: selection.candidates };
    case 'PREFERENCE_NOT_ELIGIBLE':
      return { status: 'PREFERENCE_NOT_ELIGIBLE', preferenceProfileId: selection.preferenceProfileId };
  }
}

export interface RuntimeWriterPreflightResult {
  ok: boolean;
  reasonCodes: WriterRuntimeEligibilityReasonCode[];
}

/**
 * Fail-closed preflight immediately before the first real Writer invocation.
 * Re-evaluates eligibility and verifies the certificate/identity binding has
 * not drifted since selection.
 */
export function preflightRuntimeWriter(input: {
  cwd: string;
  candidate: WriterRuntimeCandidate;
  profile: ProviderProfile;
  adapterRegistry: ProviderAdapterResolver;
  parentEnv: NodeJS.ProcessEnv;
}): RuntimeWriterPreflightResult {
  const result = evaluateWriterRuntimeEligibility({
    cwd: input.cwd,
    profile: input.profile,
    logicalModelName: input.candidate.logicalModelName,
    adapterRegistry: input.adapterRegistry,
    parentEnv: input.parentEnv,
  });

  const reasons = [...result.reasonCodes];
  if (result.status !== 'ELIGIBLE') {
    return { ok: false, reasonCodes: reasons };
  }
  // TOCTOU binding: certificate + identity must be unchanged from selection.
  if (result.certificateId !== input.candidate.certificateId) {
    return { ok: false, reasonCodes: ['CERTIFICATE_BINDING_UNRESOLVABLE'] };
  }
  if (result.qualificationIdentityFingerprint !== input.candidate.qualificationIdentityFingerprint) {
    return { ok: false, reasonCodes: ['IDENTITY_MISMATCH'] };
  }
  return { ok: true, reasonCodes: [] };
}
