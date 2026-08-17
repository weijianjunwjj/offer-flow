import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import { createProductionAdapterRegistry } from './productionAdapterRegistry';
import { revokeWriterQualificationCertificate } from './writerQualificationCertificate';
import {
  preflightRuntimeWriter,
  resolveRuntimeWriter,
} from './writerRuntimeOnboarding';
import type { CcAutoConfig } from './config';
import type { ProviderProfile } from './types';
import {
  createFixtureCwd,
  issueActiveCertificate,
  persistFrozenQualifiedResult,
  runtimeIdentity,
  testProfile,
} from './__fixtures__/writerRuntimeEligibilityFixture';

function issueCertificateFor(cwd: string, profile: ProviderProfile, batchId: string): string {
  const identity = runtimeIdentity(profile, profile.defaultModelId);
  const result = persistFrozenQualifiedResult({ cwd, profile, batchId, identity });
  return issueActiveCertificate({ cwd, profile, result, identity });
}

function configWith(...profiles: ProviderProfile[]): CcAutoConfig {
  const providerProfiles: Record<string, unknown> = {};
  for (const profile of profiles) providerProfiles[profile.id] = profile;
  return { ...DEFAULT_CONFIG, providerProfiles };
}

const parentEnv = { WRITER_TEST_API_KEY: 'secret-value' };

describe('resolveRuntimeWriter', () => {
  it('resolves the eligible selected writer with executionRole WRITER (A)', () => {
    const fixture = createFixtureCwd();
    const grok = testProfile({ id: 'grok-writer' });
    issueCertificateFor(fixture.cwd, grok, 'batch-grok');

    const resolution = resolveRuntimeWriter({
      cwd: fixture.cwd,
      config: configWith(grok),
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
    });

    expect(resolution.status).toBe('RESOLVED');
    if (resolution.status === 'RESOLVED') {
      expect(resolution.writer.assignment).toEqual({
        executionRole: 'WRITER',
        profileId: 'grok-writer',
        providerIdentifier: 'grok-writer',
      });
      expect(resolution.writer.candidate.logicalModelName).toBe('writer-model');
      expect(resolution.writer.profile.id).toBe('grok-writer');
    }
    fixture.cleanup();
  });

  it('fails closed with NO_ELIGIBLE_WRITER when no profile is eligible (B)', () => {
    const fixture = createFixtureCwd();
    const deepseek = testProfile({ id: 'deepseek-writer' });

    const resolution = resolveRuntimeWriter({
      cwd: fixture.cwd,
      config: configWith(deepseek),
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
    });

    expect(resolution.status).toBe('NO_ELIGIBLE_WRITER');
    fixture.cleanup();
  });

  it('fails closed AMBIGUOUS with multiple eligible writers and no preference (C)', () => {
    const fixture = createFixtureCwd();
    const a = testProfile({ id: 'writer-a' });
    const b = testProfile({ id: 'writer-b' });
    issueCertificateFor(fixture.cwd, a, 'batch-a');
    issueCertificateFor(fixture.cwd, b, 'batch-b');

    const resolution = resolveRuntimeWriter({
      cwd: fixture.cwd,
      config: configWith(a, b),
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
    });

    expect(resolution.status).toBe('AMBIGUOUS_ELIGIBLE_WRITERS');
    fixture.cleanup();
  });

  it('selects a valid explicit preference (D)', () => {
    const fixture = createFixtureCwd();
    const a = testProfile({ id: 'writer-a' });
    const b = testProfile({ id: 'writer-b' });
    issueCertificateFor(fixture.cwd, a, 'batch-a');
    issueCertificateFor(fixture.cwd, b, 'batch-b');

    const resolution = resolveRuntimeWriter({
      cwd: fixture.cwd,
      config: configWith(a, b),
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
      preference: { profileId: 'writer-b' },
    });

    expect(resolution.status).toBe('RESOLVED');
    if (resolution.status === 'RESOLVED') {
      expect(resolution.writer.candidate.profileId).toBe('writer-b');
    }
    fixture.cleanup();
  });

  it('rejects a preference pointing at an ineligible profile (E)', () => {
    const fixture = createFixtureCwd();
    const eligible = testProfile({ id: 'eligible' });
    issueCertificateFor(fixture.cwd, eligible, 'batch-eligible');

    const resolution = resolveRuntimeWriter({
      cwd: fixture.cwd,
      config: configWith(eligible),
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
      preference: { profileId: 'deepseek-v4-pro' },
    });

    expect(resolution.status).toBe('PREFERENCE_NOT_ELIGIBLE');
    fixture.cleanup();
  });
});

describe('preflightRuntimeWriter (TOCTOU)', () => {
  it('passes when the selection is unchanged', () => {
    const fixture = createFixtureCwd();
    const grok = testProfile({ id: 'grok-writer' });
    issueCertificateFor(fixture.cwd, grok, 'batch-grok');

    const resolution = resolveRuntimeWriter({
      cwd: fixture.cwd,
      config: configWith(grok),
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
    });
    if (resolution.status !== 'RESOLVED') throw new Error('unexpected');

    const preflight = preflightRuntimeWriter({
      cwd: fixture.cwd,
      candidate: resolution.writer.candidate,
      profile: resolution.writer.profile,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
    });
    expect(preflight.ok).toBe(true);
    expect(preflight.reasonCodes).toEqual([]);
    fixture.cleanup();
  });

  it('rejects when the certificate is revoked after selection', () => {
    const fixture = createFixtureCwd();
    const grok = testProfile({ id: 'grok-writer' });
    const certificateId = issueCertificateFor(fixture.cwd, grok, 'batch-grok');

    const resolution = resolveRuntimeWriter({
      cwd: fixture.cwd,
      config: configWith(grok),
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
    });
    if (resolution.status !== 'RESOLVED') throw new Error('unexpected');

    revokeWriterQualificationCertificate(fixture.cwd, grok.id, certificateId, 'MANUAL_REVOKE');
    const preflight = preflightRuntimeWriter({
      cwd: fixture.cwd,
      candidate: resolution.writer.candidate,
      profile: resolution.writer.profile,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.reasonCodes).toContain('CERTIFICATE_REVOKED');
    fixture.cleanup();
  });

  it('rejects when the profile identity drifts after selection', () => {
    const fixture = createFixtureCwd();
    const grok = testProfile({ id: 'grok-writer' });
    issueCertificateFor(fixture.cwd, grok, 'batch-grok');

    const resolution = resolveRuntimeWriter({
      cwd: fixture.cwd,
      config: configWith(grok),
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
    });
    if (resolution.status !== 'RESOLVED') throw new Error('unexpected');

    const drifted = testProfile({
      id: 'grok-writer',
      models: [{
        logicalName: 'writer-model',
        requestedModelId: 'model-z',
        acceptedReportedModelIds: ['model-z'],
        displayName: 'Model Z',
      }],
    });
    const preflight = preflightRuntimeWriter({
      cwd: fixture.cwd,
      candidate: resolution.writer.candidate,
      profile: drifted,
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv,
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.reasonCodes).toContain('IDENTITY_MISMATCH');
    fixture.cleanup();
  });
});
