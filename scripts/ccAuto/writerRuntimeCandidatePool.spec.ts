import { describe, expect, it } from 'vitest';
import { createProductionAdapterRegistry } from './productionAdapterRegistry';
import { buildWriterRuntimeCandidatePool } from './writerRuntimeCandidatePool';
import type { ProviderProfile } from './types';
import {
  createFixtureCwd,
  issueActiveCertificate,
  persistFrozenQualifiedResult,
  runtimeIdentity,
  testProfile,
} from './__fixtures__/writerRuntimeEligibilityFixture';

function issueCertificateFor(cwd: string, profile: ProviderProfile, batchId: string): void {
  const identity = runtimeIdentity(profile, profile.defaultModelId);
  const result = persistFrozenQualifiedResult({ cwd, profile, batchId, identity });
  issueActiveCertificate({ cwd, profile, result, identity });
}

describe('Writer Runtime Candidate Pool', () => {
  it('only the eligible profile enters the pool (A)', () => {
    const fixture = createFixtureCwd();
    const grok = testProfile({ id: 'grok-writer' });
    const deepseek = testProfile({ id: 'deepseek-writer' });
    issueCertificateFor(fixture.cwd, grok, 'batch-grok');

    const pool = buildWriterRuntimeCandidatePool({
      cwd: fixture.cwd,
      profiles: { [grok.id]: grok, [deepseek.id]: deepseek },
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
    });

    expect(pool.eligibleCandidates.map((c) => c.profileId)).toEqual(['grok-writer']);
    expect(pool.assessments.find((a) => a.profileId === 'deepseek-writer')?.status)
      .toBe('NOT_ELIGIBLE');
    fixture.cleanup();
  });

  it('returns an empty pool when all profiles are ineligible (B)', () => {
    const fixture = createFixtureCwd();
    const a = testProfile({ id: 'a' });
    const b = testProfile({ id: 'b' });

    const pool = buildWriterRuntimeCandidatePool({
      cwd: fixture.cwd,
      profiles: { [a.id]: a, [b.id]: b },
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
    });

    expect(pool.eligibleCandidates).toEqual([]);
    expect(pool.assessments.every((x) => x.status === 'NOT_ELIGIBLE')).toBe(true);
    fixture.cleanup();
  });

  it('keeps only eligible profiles in a mixed set (C)', () => {
    const fixture = createFixtureCwd();
    const eligible = testProfile({ id: 'eligible' });
    const ineligible = testProfile({ id: 'ineligible' });
    issueCertificateFor(fixture.cwd, eligible, 'batch-eligible');

    const pool = buildWriterRuntimeCandidatePool({
      cwd: fixture.cwd,
      profiles: { [eligible.id]: eligible, [ineligible.id]: ineligible },
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
    });

    expect(pool.eligibleCandidates.map((c) => c.profileId)).toEqual(['eligible']);
    fixture.cleanup();
  });

  it('does not decide membership by provider brand (D)', () => {
    const fixture = createFixtureCwd();
    const brandX = testProfile({ id: 'brand-x', vendor: 'third-party' });
    const brandY = testProfile({ id: 'brand-y', vendor: 'deepseek' });
    issueCertificateFor(fixture.cwd, brandX, 'batch-x');
    issueCertificateFor(fixture.cwd, brandY, 'batch-y');

    const pool = buildWriterRuntimeCandidatePool({
      cwd: fixture.cwd,
      profiles: { [brandX.id]: brandX, [brandY.id]: brandY },
      adapterRegistry: createProductionAdapterRegistry(),
      parentEnv: { WRITER_TEST_API_KEY: 'secret-value' },
    });

    expect(pool.eligibleCandidates.map((c) => c.profileId).sort()).toEqual(['brand-x', 'brand-y']);
    fixture.cleanup();
  });
});
