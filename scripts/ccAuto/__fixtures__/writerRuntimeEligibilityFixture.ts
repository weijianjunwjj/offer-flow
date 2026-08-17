/**
 * Shared hermetic fixture for Writer Runtime Eligibility / Candidate Pool /
 * Onboarding specs. Builds a qualified frozen result + ACTIVE certificate for
 * an arbitrary ProviderProfile, using the same runtime identity resolver the
 * eligibility gate uses — so the certificate binding matches at runtime.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProductionAdapterRegistry } from '../productionAdapterRegistry';
import type { ProviderProfile } from '../types';
import { resolveWriterQualificationIdentitySnapshot } from '../writerModelProfileBenchmark';
import {
  sha256Canonical,
  WRITER_BENCHMARK_CONTRACT_VERSION,
  type WriterQualificationIdentitySnapshot,
} from '../writerBenchmarkIdentity';
import { WRITER_QUALIFICATION_POLICY_VERSION } from '../writerQualificationPolicyContract';
import type {
  WriterQualificationBatch,
  WriterQualificationResultArtifact,
} from '../writerQualificationArtifact';
import { issueWriterQualificationCertificate } from '../writerQualificationCertificate';

export interface FixtureCwd {
  cwd: string;
  cleanup: () => void;
}

export function createFixtureCwd(): FixtureCwd {
  const cwd = mkdtempSync(path.join(tmpdir(), 'writer-runtime-eligibility-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** Runtime identity — matches what the eligibility gate itself resolves. */
export function runtimeIdentity(
  profile: ProviderProfile,
  logicalModelName: string,
): WriterQualificationIdentitySnapshot {
  const adapter = createProductionAdapterRegistry().resolve(profile.transport);
  if (!adapter?.qualificationContract) {
    throw new Error(`adapter contract missing for transport ${profile.transport}`);
  }
  return resolveWriterQualificationIdentitySnapshot({
    profile,
    logicalModelName,
    adapterContract: adapter.qualificationContract,
  });
}

export function persistFrozenQualifiedResult(input: {
  cwd: string;
  profile: ProviderProfile;
  batchId: string;
  identity: WriterQualificationIdentitySnapshot;
}): WriterQualificationResultArtifact {
  const { cwd, profile, batchId, identity } = input;
  const formalSampleIds = {
    SEARCH: ['search-1', 'search-2', 'search-3'],
    READ: ['read-1', 'read-2', 'read-3'],
    WRITE: ['write-1', 'write-2', 'write-3'],
  };
  const batch: WriterQualificationBatch = {
    schemaVersion: 'writer-qualification-batch-v1',
    batchId,
    qualificationIdentityFingerprint: identity.qualificationIdentityFingerprint,
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    benchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    profileId: profile.id,
    startedAt: '2026-08-17T00:00:00.000Z',
    completedAt: '2026-08-17T00:01:00.000Z',
    status: 'COMPLETE',
    formalSampleIds,
    expectedFixtureCoverage: { SEARCH: 3, READ: 3, WRITE: 3 },
    actualFixtureCoverage: { SEARCH: 3, READ: 3, WRITE: 3 },
  };
  const resultId = `writer-qualification-result-${sha256Canonical({
    batchId,
    qualificationIdentityFingerprint: identity.qualificationIdentityFingerprint,
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
  }).slice(0, 24)}`;
  const fixture = (expectedActionClass: 'SEARCH' | 'READ' | 'WRITE') => ({
    expectedActionClass,
    formalSampleIds: [...formalSampleIds[expectedActionClass]],
    capabilitySampleIds: [...formalSampleIds[expectedActionClass]],
    strictPassSampleIds: [...formalSampleIds[expectedActionClass]],
    redundantPassSampleIds: [],
    negativeSampleIds: [],
    unavailableSampleIds: [],
    gateStatus: 'PASS' as const,
  });
  const result: WriterQualificationResultArtifact = {
    schemaVersion: 'writer-qualification-result-v1',
    resultId,
    batchId,
    profileId: profile.id,
    qualificationIdentityFingerprint: identity.qualificationIdentityFingerprint,
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    benchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    status: 'QUALIFIED',
    reasonCodes: [],
    fixtureResults: {
      SEARCH: fixture('SEARCH'),
      READ: fixture('READ'),
      WRITE: fixture('WRITE'),
    },
    safetyResult: { prematureWriteSampleIds: [], safetyVeto: false },
    formalOperationalSummary: {
      status: 'SUFFICIENT',
      logicalInvocations: 9,
      availableInvocations: 9,
      unavailableInvocations: 0,
      transportAttempts: 9,
      transportRetries: 0,
      retryRecoveries: 0,
      failureCategories: {},
      totalCostRmb: 0.01,
    },
    evaluatedAt: '2026-08-17T00:01:01.000Z',
  };
  const directory = path.join(cwd, '.cc-auto', 'qualification', 'writer', profile.id, batchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'batch.json'), JSON.stringify(batch));
  writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result));
  return result;
}

export function issueActiveCertificate(input: {
  cwd: string;
  profile: ProviderProfile;
  result: WriterQualificationResultArtifact;
  identity: WriterQualificationIdentitySnapshot;
}): string {
  const certificate = issueWriterQualificationCertificate(input.cwd, {
    profileId: input.profile.id,
    batchId: input.result.batchId,
    resultId: input.result.resultId,
    currentQualificationIdentity: input.identity,
    requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
  });
  return certificate.certificateId;
}

export function testProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'writer-profile',
    displayName: 'Writer profile',
    vendor: 'third-party',
    transport: 'openai-chat',
    apiBaseUrl: 'https://provider.invalid/v1',
    credentialEnvVars: ['WRITER_TEST_API_KEY'],
    runtimeEnvAllowlist: ['PATH'],
    defaultModelId: 'writer-model',
    models: [{
      logicalName: 'writer-model',
      requestedModelId: 'model-a',
      acceptedReportedModelIds: ['model-a'],
      displayName: 'Model A',
    }],
    pricing: {
      'model-a': {
        inputPerMTokens: 1,
        outputPerMTokens: 2,
        cacheCreationPerMTokens: 0,
        cacheReadPerMTokens: 0,
        currency: 'CNY',
        source: 'test',
        updatedAt: '2026-08-17',
      },
    },
    ...overrides,
  };
}
