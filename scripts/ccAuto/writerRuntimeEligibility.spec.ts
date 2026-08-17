import { describe, expect, it } from 'vitest';
import { createProductionAdapterRegistry } from './productionAdapterRegistry';
import {
  assessWriterRuntimeEligibility,
  evaluateWriterRuntimeEligibility,
  isPricingReady,
} from './writerRuntimeEligibility';
import { revokeWriterQualificationCertificate } from './writerQualificationCertificate';
import {
  createFixtureCwd,
  issueActiveCertificate,
  persistFrozenQualifiedResult,
  runtimeIdentity,
  testProfile,
} from './__fixtures__/writerRuntimeEligibilityFixture';

function validAssessment(overrides: Partial<Parameters<typeof assessWriterRuntimeEligibility>[0]> = {}) {
  return assessWriterRuntimeEligibility({
    profileValid: true,
    pricingReady: true,
    adapterAvailable: true,
    credentialConfigured: true,
    transportPolicyAvailable: true,
    certificateApplicability: 'ACTIVE_VALID',
    ...overrides,
  });
}

describe('Writer Runtime Eligibility (pure assessment)', () => {
  it('ELIGIBLE when all minimum conditions hold (A)', () => {
    expect(validAssessment()).toEqual({ status: 'ELIGIBLE', reasonCodes: [] });
  });

  it('NOT_ELIGIBLE with CERTIFICATE_NOT_FOUND when no certificate (B)', () => {
    expect(validAssessment({ certificateApplicability: null })).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['CERTIFICATE_NOT_FOUND'],
    });
  });

  it('NOT_ELIGIBLE with CERTIFICATE_REVOKED when the certificate is revoked (C)', () => {
    expect(validAssessment({ certificateApplicability: 'REVOKED' })).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['CERTIFICATE_REVOKED'],
    });
  });

  it('NOT_ELIGIBLE with IDENTITY_MISMATCH on identity drift (D)', () => {
    expect(validAssessment({ certificateApplicability: 'IDENTITY_MISMATCH' })).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['IDENTITY_MISMATCH'],
    });
  });

  it('NOT_ELIGIBLE with PRICING_NOT_READY (E)', () => {
    expect(validAssessment({ pricingReady: false })).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['PRICING_NOT_READY'],
    });
  });

  it('NOT_ELIGIBLE with ADAPTER_UNAVAILABLE (F)', () => {
    expect(validAssessment({ adapterAvailable: false })).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['ADAPTER_UNAVAILABLE'],
    });
  });

  it('NOT_ELIGIBLE with CREDENTIAL_NOT_CONFIGURED (G)', () => {
    expect(validAssessment({ credentialConfigured: false })).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['CREDENTIAL_NOT_CONFIGURED'],
    });
  });

  it('NOT_ELIGIBLE with PROFILE_INVALID', () => {
    expect(validAssessment({ profileValid: false })).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['PROFILE_INVALID'],
    });
  });

  it('NOT_ELIGIBLE with TRANSPORT_POLICY_UNAVAILABLE', () => {
    expect(validAssessment({ transportPolicyAvailable: false })).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['TRANSPORT_POLICY_UNAVAILABLE'],
    });
  });

  it('maps certificate staleness and binding failures to distinct codes', () => {
    expect(validAssessment({ certificateApplicability: 'POLICY_VERSION_MISMATCH' }).reasonCodes)
      .toEqual(['CERTIFICATE_STALE']);
    expect(validAssessment({ certificateApplicability: 'BENCHMARK_VERSION_MISMATCH' }).reasonCodes)
      .toEqual(['CERTIFICATE_STALE']);
    expect(validAssessment({ certificateApplicability: 'RESULT_NOT_FOUND' }).reasonCodes)
      .toEqual(['CERTIFICATE_BINDING_UNRESOLVABLE']);
    expect(validAssessment({ certificateApplicability: 'RESULT_BINDING_MISMATCH' }).reasonCodes)
      .toEqual(['CERTIFICATE_BINDING_UNRESOLVABLE']);
    expect(validAssessment({ certificateApplicability: 'RESULT_NOT_QUALIFIED' }).reasonCodes)
      .toEqual(['CERTIFICATE_RESULT_NOT_QUALIFIED']);
  });

  it('accumulates all reasons in a stable order', () => {
    expect(validAssessment({
      profileValid: false,
      pricingReady: false,
      adapterAvailable: false,
      credentialConfigured: false,
      transportPolicyAvailable: false,
      certificateApplicability: 'REVOKED',
    }).reasonCodes).toEqual([
      'CERTIFICATE_REVOKED',
      'PRICING_NOT_READY',
      'PROFILE_INVALID',
      'ADAPTER_UNAVAILABLE',
      'CREDENTIAL_NOT_CONFIGURED',
      'TRANSPORT_POLICY_UNAVAILABLE',
    ]);
  });
});

describe('Writer Runtime Eligibility (I/O resolution)', () => {
  it('resolves ELIGIBLE for a profile with an ACTIVE_VALID certificate', () => {
    const fixture = createFixtureCwd();
    const profile = testProfile();
    const logicalModelName = profile.defaultModelId;
    const identity = runtimeIdentity(profile, logicalModelName);
    const result = persistFrozenQualifiedResult({ cwd: fixture.cwd, profile, batchId: 'batch-a', identity });
    issueActiveCertificate({ cwd: fixture.cwd, profile, result, identity });

    const outcome = evaluateWriterRuntimeEligibility({
      cwd: fixture.cwd,
      profile,
      logicalModelName,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
    });

    expect(outcome.status).toBe('ELIGIBLE');
    expect(outcome.reasonCodes).toEqual([]);
    expect(outcome.certificateApplicability).toBe('ACTIVE_VALID');
    expect(outcome.certificateId).toBeTruthy();
    expect(outcome.pricingReady).toBe(true);
    expect(outcome.adapterAvailable).toBe(true);
    expect(outcome.credentialConfigured).toBe(true);
    fixture.cleanup();
  });

  it('NOT_ELIGIBLE with CERTIFICATE_NOT_FOUND when no certificate exists', () => {
    const fixture = createFixtureCwd();
    const profile = testProfile();

    const outcome = evaluateWriterRuntimeEligibility({
      cwd: fixture.cwd,
      profile,
      logicalModelName: profile.defaultModelId,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
    });

    expect(outcome.status).toBe('NOT_ELIGIBLE');
    expect(outcome.reasonCodes).toContain('CERTIFICATE_NOT_FOUND');
    fixture.cleanup();
  });

  it('NOT_ELIGIBLE with CERTIFICATE_REVOKED after explicit revocation', () => {
    const fixture = createFixtureCwd();
    const profile = testProfile();
    const logicalModelName = profile.defaultModelId;
    const identity = runtimeIdentity(profile, logicalModelName);
    const result = persistFrozenQualifiedResult({ cwd: fixture.cwd, profile, batchId: 'batch-revoke', identity });
    const certificateId = issueActiveCertificate({ cwd: fixture.cwd, profile, result, identity });
    revokeWriterQualificationCertificate(fixture.cwd, profile.id, certificateId, 'MANUAL_REVOKE');

    const outcome = evaluateWriterRuntimeEligibility({
      cwd: fixture.cwd,
      profile,
      logicalModelName,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
    });

    expect(outcome.status).toBe('NOT_ELIGIBLE');
    expect(outcome.reasonCodes).toContain('CERTIFICATE_REVOKED');
    fixture.cleanup();
  });

  it('NOT_ELIGIBLE with IDENTITY_MISMATCH after a model binding change', () => {
    const fixture = createFixtureCwd();
    const profile = testProfile();
    const logicalModelName = profile.defaultModelId;
    const identity = runtimeIdentity(profile, logicalModelName);
    const result = persistFrozenQualifiedResult({ cwd: fixture.cwd, profile, batchId: 'batch-identity', identity });
    issueActiveCertificate({ cwd: fixture.cwd, profile, result, identity });

    const changedProfile = testProfile({
      models: [{
        logicalName: 'writer-model',
        requestedModelId: 'model-b',
        acceptedReportedModelIds: ['model-b'],
        displayName: 'Model B',
      }],
    });
    const outcome = evaluateWriterRuntimeEligibility({
      cwd: fixture.cwd,
      profile: changedProfile,
      logicalModelName,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
    });

    expect(outcome.status).toBe('NOT_ELIGIBLE');
    expect(outcome.reasonCodes).toContain('IDENTITY_MISMATCH');
    fixture.cleanup();
  });

  it('NOT_ELIGIBLE with CREDENTIAL_NOT_CONFIGURED when the required env is absent', () => {
    const fixture = createFixtureCwd();
    const profile = testProfile();
    const logicalModelName = profile.defaultModelId;
    const identity = runtimeIdentity(profile, logicalModelName);
    const result = persistFrozenQualifiedResult({ cwd: fixture.cwd, profile, batchId: 'batch-cred', identity });
    issueActiveCertificate({ cwd: fixture.cwd, profile, result, identity });

    const outcome = evaluateWriterRuntimeEligibility({
      cwd: fixture.cwd,
      profile,
      logicalModelName,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: {}, // credential missing
    });

    expect(outcome.status).toBe('NOT_ELIGIBLE');
    expect(outcome.reasonCodes).toContain('CREDENTIAL_NOT_CONFIGURED');
    expect(JSON.stringify(outcome)).not.toContain('secret');
    fixture.cleanup();
  });

  it('NOT_ELIGIBLE with ADAPTER_UNAVAILABLE for an unregistered transport', () => {
    const fixture = createFixtureCwd();
    const profile = testProfile({ transport: 'anthropic-messages' });

    const outcome = evaluateWriterRuntimeEligibility({
      cwd: fixture.cwd,
      profile,
      logicalModelName: profile.defaultModelId,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
    });

    expect(outcome.status).toBe('NOT_ELIGIBLE');
    expect(outcome.reasonCodes).toContain('ADAPTER_UNAVAILABLE');
    fixture.cleanup();
  });

  it('NOT_ELIGIBLE with PROFILE_INVALID for a null profile', () => {
    const outcome = evaluateWriterRuntimeEligibility({
      cwd: createFixtureCwd().cwd,
      profile: null,
      logicalModelName: 'writer-model',
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: {},
    });
    expect(outcome.status).toBe('NOT_ELIGIBLE');
    expect(outcome.reasonCodes).toContain('PROFILE_INVALID');
  });

  it('NOT_ELIGIBLE with TRANSPORT_POLICY_UNAVAILABLE for an unknown policy version', () => {
    const fixture = createFixtureCwd();
    const profile = testProfile();
    const outcome = evaluateWriterRuntimeEligibility({
      cwd: fixture.cwd,
      profile,
      logicalModelName: profile.defaultModelId,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
      transportPolicyVersion: 'some-other-policy-v1',
    });
    expect(outcome.status).toBe('NOT_ELIGIBLE');
    expect(outcome.reasonCodes).toContain('TRANSPORT_POLICY_UNAVAILABLE');
    fixture.cleanup();
  });
});

describe('isPricingReady', () => {
  it('accepts flat pricing', () => {
    expect(isPricingReady(testProfile(), 'writer-model')).toBe(true);
  });

  it('accepts context-tiered pricing that covers 0→infinity', () => {
    const profile = testProfile({
      pricing: {
        'model-a': {
          pricingType: 'context-tiered',
          thresholdBasis: 'REQUEST_CONTEXT_TOKENS',
          tiers: [
            { id: 'base', fromInclusive: 0, upToInclusive: 200_000, rates: { inputPerMTokens: 1, outputPerMTokens: 2, cacheCreationPerMTokens: 0, cacheReadPerMTokens: 0 } },
            { id: 'high', fromInclusive: 200_001, upToInclusive: null, rates: { inputPerMTokens: 2, outputPerMTokens: 4, cacheCreationPerMTokens: 0, cacheReadPerMTokens: 0 } },
          ],
          currency: 'CNY',
          source: 'test',
          updatedAt: '2026-08-17',
        },
      },
    });
    expect(isPricingReady(profile, 'writer-model')).toBe(true);
  });

  it('rejects tiered pricing without a catch-all tier', () => {
    const profile = testProfile({
      pricing: {
        'model-a': {
          pricingType: 'context-tiered',
          thresholdBasis: 'REQUEST_CONTEXT_TOKENS',
          tiers: [
            { id: 'base', fromInclusive: 0, upToInclusive: 200_000, rates: { inputPerMTokens: 1, outputPerMTokens: 2, cacheCreationPerMTokens: 0, cacheReadPerMTokens: 0 } },
          ],
          currency: 'CNY',
          source: 'test',
          updatedAt: '2026-08-17',
        },
      },
    });
    expect(isPricingReady(profile, 'writer-model')).toBe(false);
  });

  it('rejects tiered pricing with a coverage gap', () => {
    const profile = testProfile({
      pricing: {
        'model-a': {
          pricingType: 'context-tiered',
          thresholdBasis: 'REQUEST_CONTEXT_TOKENS',
          tiers: [
            { id: 'base', fromInclusive: 0, upToInclusive: 100_000, rates: { inputPerMTokens: 1, outputPerMTokens: 2, cacheCreationPerMTokens: 0, cacheReadPerMTokens: 0 } },
            { id: 'high', fromInclusive: 200_001, upToInclusive: null, rates: { inputPerMTokens: 2, outputPerMTokens: 4, cacheCreationPerMTokens: 0, cacheReadPerMTokens: 0 } },
          ],
          currency: 'CNY',
          source: 'test',
          updatedAt: '2026-08-17',
        },
      },
    });
    expect(isPricingReady(profile, 'writer-model')).toBe(false);
  });
});
