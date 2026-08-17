/**
 * Writer Runtime Eligibility gate — Provider-neutral, deterministic.
 *
 * Answers exactly one question: is this Writer Profile currently allowed to
 * enter the Runtime Candidate Pool?
 *
 * It is NOT a router, NOT a WriterAuthorization, and NOT a model ranking.
 * ELIGIBLE only means "may enter the candidate pool" — it grants no
 * workspaceWrite permission.
 *
 * v1 checks (no dynamic health score; transport reliability is already covered
 * by the bounded connect-timeout retry policy):
 *   A. Certificate applicability === ACTIVE_VALID
 *   B. Pricing readiness === READY
 *   C. Provider Profile === VALID
 *   D. Transport Adapter === AVAILABLE
 *   E. Qualification Candidate binding still resolvable
 *   F. Current Profile / Identity matches the certificate binding
 *   G. Credential requirement satisfiable (required env configured; no secret output)
 */
import type {
  ProviderAdapterResolver,
  ProviderProfile,
} from './types';
import {
  evaluateCurrentWriterQualificationCertificate,
  type WriterQualificationCertificate,
  type WriterQualificationCertificateApplicability,
} from './writerQualificationCertificate';
import {
  WRITER_BENCHMARK_CONTRACT_VERSION,
  type WriterQualificationIdentitySnapshot,
} from './writerBenchmarkIdentity';
import { resolveWriterQualificationIdentitySnapshot } from './writerModelProfileBenchmark';
import { WRITER_QUALIFICATION_POLICY_VERSION } from './writerQualificationPolicyContract';
import { TRANSPORT_CONNECT_RETRY_POLICY_VERSION } from './transportRetryPolicy';

export type WriterRuntimeEligibilityStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE';

export type WriterRuntimeEligibilityReasonCode =
  | 'CERTIFICATE_NOT_FOUND'
  | 'CERTIFICATE_REVOKED'
  | 'CERTIFICATE_RESULT_NOT_QUALIFIED'
  | 'CERTIFICATE_BINDING_UNRESOLVABLE'
  | 'CERTIFICATE_STALE'
  | 'IDENTITY_MISMATCH'
  | 'PRICING_NOT_READY'
  | 'PROFILE_INVALID'
  | 'ADAPTER_UNAVAILABLE'
  | 'CREDENTIAL_NOT_CONFIGURED'
  | 'TRANSPORT_POLICY_UNAVAILABLE';

const REASON_ORDER: readonly WriterRuntimeEligibilityReasonCode[] = [
  'CERTIFICATE_NOT_FOUND',
  'CERTIFICATE_REVOKED',
  'CERTIFICATE_RESULT_NOT_QUALIFIED',
  'CERTIFICATE_BINDING_UNRESOLVABLE',
  'CERTIFICATE_STALE',
  'IDENTITY_MISMATCH',
  'PRICING_NOT_READY',
  'PROFILE_INVALID',
  'ADAPTER_UNAVAILABLE',
  'CREDENTIAL_NOT_CONFIGURED',
  'TRANSPORT_POLICY_UNAVAILABLE',
];

/** Result of the full (I/O-aware) runtime eligibility evaluation. */
export interface WriterRuntimeEligibilityResult {
  profileId: string;
  logicalModelName: string;
  status: WriterRuntimeEligibilityStatus;
  reasonCodes: WriterRuntimeEligibilityReasonCode[];
  certificateApplicability: WriterQualificationCertificateApplicability | null;
  certificateId: string | null;
  resultId: string | null;
  batchId: string | null;
  qualificationIdentityFingerprint: string | null;
  pricingReady: boolean;
  adapterAvailable: boolean;
  credentialConfigured: boolean;
  transportPolicyAvailable: boolean;
}

/** Pure assessment input — no I/O, no provider calls, no brand logic. */
export interface WriterRuntimeEligibilityAssessmentInput {
  profileValid: boolean;
  pricingReady: boolean;
  adapterAvailable: boolean;
  credentialConfigured: boolean;
  transportPolicyAvailable: boolean;
  /** null means no certificate could be resolved (never issued). */
  certificateApplicability: WriterQualificationCertificateApplicability | null;
}

/** I/O-aware evaluation context. */
export interface WriterRuntimeEligibilityContext {
  cwd: string;
  profile: ProviderProfile | null;
  logicalModelName: string;
  adapterRegistry: ProviderAdapterResolver;
  parentEnv: NodeJS.ProcessEnv;
  /** Defaults to the compile-time connect-timeout-retry-v1 constant. */
  transportPolicyVersion?: string;
}

/** Maps a certificate applicability verdict to its eligibility reason code. */
function mapCertificateApplicability(
  applicability: WriterQualificationCertificateApplicability | null,
): WriterRuntimeEligibilityReasonCode | null {
  switch (applicability) {
    case null:
      return 'CERTIFICATE_NOT_FOUND';
    case 'ACTIVE_VALID':
      return null;
    case 'REVOKED':
      return 'CERTIFICATE_REVOKED';
    case 'IDENTITY_MISMATCH':
      return 'IDENTITY_MISMATCH';
    case 'POLICY_VERSION_MISMATCH':
    case 'BENCHMARK_VERSION_MISMATCH':
      return 'CERTIFICATE_STALE';
    case 'RESULT_NOT_FOUND':
    case 'RESULT_BINDING_MISMATCH':
      return 'CERTIFICATE_BINDING_UNRESOLVABLE';
    case 'RESULT_NOT_QUALIFIED':
      return 'CERTIFICATE_RESULT_NOT_QUALIFIED';
  }
}

/**
 * Pure, deterministic eligibility assessment. Produces a stable reason-code
 * list regardless of which Provider profile supplied the inputs.
 */
export function assessWriterRuntimeEligibility(
  input: WriterRuntimeEligibilityAssessmentInput,
): { status: WriterRuntimeEligibilityStatus; reasonCodes: WriterRuntimeEligibilityReasonCode[] } {
  const reasons = new Set<WriterRuntimeEligibilityReasonCode>();

  if (!input.profileValid) reasons.add('PROFILE_INVALID');
  const certificateReason = mapCertificateApplicability(input.certificateApplicability);
  if (certificateReason) reasons.add(certificateReason);
  if (!input.pricingReady) reasons.add('PRICING_NOT_READY');
  if (!input.adapterAvailable) reasons.add('ADAPTER_UNAVAILABLE');
  if (!input.credentialConfigured) reasons.add('CREDENTIAL_NOT_CONFIGURED');
  if (!input.transportPolicyAvailable) reasons.add('TRANSPORT_POLICY_UNAVAILABLE');

  const reasonCodes = REASON_ORDER.filter((reason) => reasons.has(reason));
  return {
    status: reasonCodes.length === 0 ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
    reasonCodes,
  };
}

/** True when the model's pricing exists and (if context-tiered) covers 0→infinity. */
export function isPricingReady(profile: ProviderProfile, logicalModelName: string): boolean {
  const model = profile.models.find((item) => item.logicalName === logicalModelName);
  if (!model) return false;
  const pricing = profile.pricing[model.requestedModelId];
  if (!pricing) return false;
  if (pricing.pricingType !== 'context-tiered') return true;

  const tiers = [...pricing.tiers].sort((a, b) => a.fromInclusive - b.fromInclusive);
  if (tiers.length === 0) return false;
  if (tiers[0].fromInclusive !== 0) return false;
  let expected = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i];
    if (tier.fromInclusive !== expected) return false;
    if (tier.upToInclusive === null) {
      return i === tiers.length - 1; // catch-all must be the last tier
    }
    expected = tier.upToInclusive + 1;
  }
  return false; // no catch-all tier
}

function credentialConfigured(profile: ProviderProfile, parentEnv: NodeJS.ProcessEnv): boolean {
  return profile.credentialEnvVars.every((name) => {
    const value = parentEnv[name];
    return typeof value === 'string' && value.length > 0;
  });
}

function adapterAvailable(
  profile: ProviderProfile,
  adapterRegistry: ProviderAdapterResolver,
): boolean {
  const adapter = adapterRegistry.resolve(profile.transport);
  return adapter !== null && adapter.qualificationContract !== undefined;
}

function resolveIdentity(
  profile: ProviderProfile,
  logicalModelName: string,
  adapterRegistry: ProviderAdapterResolver,
): WriterQualificationIdentitySnapshot | null {
  const adapter = adapterRegistry.resolve(profile.transport);
  if (!adapter?.qualificationContract) return null;
  try {
    return resolveWriterQualificationIdentitySnapshot({
      profile,
      logicalModelName,
      adapterContract: adapter.qualificationContract,
    });
  } catch {
    return null;
  }
}

/**
 * Full runtime eligibility evaluation. Reads persisted governance truth
 * (certificate + frozen result) and current profile/config; never invokes a
 * Provider and never emits secrets.
 */
export function evaluateWriterRuntimeEligibility(
  ctx: WriterRuntimeEligibilityContext,
): WriterRuntimeEligibilityResult {
  const profile = ctx.profile;

  const profileValid = profile !== null
    && profile.models.some((item) => item.logicalName === ctx.logicalModelName);
  const pricingReady = profile !== null && isPricingReady(profile, ctx.logicalModelName);
  const adapterAvail = profile !== null && adapterAvailable(profile, ctx.adapterRegistry);
  const credConfigured = profile !== null && credentialConfigured(profile, ctx.parentEnv);
  const transportPolicyAvailable = (ctx.transportPolicyVersion
    ?? TRANSPORT_CONNECT_RETRY_POLICY_VERSION) === TRANSPORT_CONNECT_RETRY_POLICY_VERSION;

  let certificate: WriterQualificationCertificate | null = null;
  let applicability: WriterQualificationCertificateApplicability | null = null;
  let identityFingerprint: string | null = null;

  if (profile !== null) {
    const identity = resolveIdentity(profile, ctx.logicalModelName, ctx.adapterRegistry);
    if (identity === null) {
      applicability = 'IDENTITY_MISMATCH';
    } else {
      identityFingerprint = identity.qualificationIdentityFingerprint;
      try {
        const evaluated = evaluateCurrentWriterQualificationCertificate(
          ctx.cwd,
          profile.id,
          identity,
          WRITER_QUALIFICATION_POLICY_VERSION,
          WRITER_BENCHMARK_CONTRACT_VERSION,
        );
        certificate = evaluated.certificate;
        applicability = evaluated.applicability === 'CERTIFICATE_NOT_FOUND'
          ? null
          : evaluated.applicability;
      } catch {
        applicability = 'RESULT_BINDING_MISMATCH';
      }
    }
  }

  const assessment = assessWriterRuntimeEligibility({
    profileValid,
    pricingReady,
    adapterAvailable: adapterAvail,
    credentialConfigured: credConfigured,
    transportPolicyAvailable,
    certificateApplicability: applicability,
  });

  return {
    profileId: profile?.id ?? '',
    logicalModelName: ctx.logicalModelName,
    status: assessment.status,
    reasonCodes: assessment.reasonCodes,
    certificateApplicability: applicability,
    certificateId: certificate?.certificateId ?? null,
    resultId: certificate?.resultId ?? null,
    batchId: certificate?.batchId ?? null,
    qualificationIdentityFingerprint: identityFingerprint,
    pricingReady,
    adapterAvailable: adapterAvail,
    credentialConfigured: credConfigured,
    transportPolicyAvailable,
  };
}
