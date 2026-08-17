import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WRITER_DECISION_FIXTURES } from './__fixtures__/writerDecisionFixture';
import type { ProviderProfile, ProviderToolDefinition } from './types';
import {
  buildWriterQualificationIdentitySnapshot,
  sha256Canonical,
  WRITER_BENCHMARK_CONTRACT_VERSION,
  type WriterQualificationIdentitySnapshot,
} from './writerBenchmarkIdentity';
import type {
  WriterQualificationBatch,
  WriterQualificationResultArtifact,
} from './writerQualificationArtifact';
import {
  evaluatePersistedWriterQualificationCertificate,
  evaluateWriterQualificationCertificate,
  getCurrentWriterQualificationCertificate,
  issueWriterQualificationCertificate,
  loadWriterQualificationCertificate,
  replaceWriterQualificationCertificate,
  revokeWriterQualificationCertificate,
} from './writerQualificationCertificate';
import { WRITER_QUALIFICATION_POLICY_VERSION } from './writerQualificationPolicyContract';

const PROFILE_ID = 'profile-under-test';
const LOGICAL_MODEL_NAME = 'writer-model';
const tempDirs: string[] = [];

const PROFILE: ProviderProfile = {
  id: PROFILE_ID,
  displayName: 'Writer profile',
  vendor: 'third-party',
  transport: 'openai-chat',
  apiBaseUrl: 'https://provider.invalid/v1',
  credentialEnvVars: ['WRITER_TEST_API_KEY'],
  runtimeEnvAllowlist: ['PATH'],
  defaultModelId: LOGICAL_MODEL_NAME,
  models: [{
    logicalName: LOGICAL_MODEL_NAME,
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
};

const TOOLS: ProviderToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
  },
}];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createCwd(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'writer-certificate-'));
  tempDirs.push(cwd);
  return cwd;
}

function identity(
  overrides: {
    profile?: ProviderProfile;
    tools?: ProviderToolDefinition[];
    system?: string;
    maxOutputTokens?: number;
    policy?: string;
    benchmark?: string;
    credentialValue?: string;
  } = {},
): WriterQualificationIdentitySnapshot {
  void overrides.credentialValue;
  return buildWriterQualificationIdentitySnapshot({
    profile: overrides.profile ?? PROFILE,
    logicalModelName: LOGICAL_MODEL_NAME,
    qualificationFixtures: WRITER_DECISION_FIXTURES,
    adapterContract: {
      adapterId: 'test-adapter',
      adapterContractVersion: 'test-adapter-v1',
      toolCallTranslationVersion: 'test-tool-translation-v1',
    },
    tools: overrides.tools ?? TOOLS,
    toolMode: 'enabled',
    writerSystemContract: overrides.system ?? 'writer-system-v1',
    maxOutputTokens: overrides.maxOutputTokens ?? 4_096,
    qualificationPolicyVersion: overrides.policy ?? WRITER_QUALIFICATION_POLICY_VERSION,
    benchmarkContractVersion: overrides.benchmark ?? WRITER_BENCHMARK_CONTRACT_VERSION,
  });
}

function persistFrozenResult(
  cwd: string,
  batchId: string,
  qualificationIdentity: WriterQualificationIdentitySnapshot,
  status: WriterQualificationResultArtifact['status'],
): WriterQualificationResultArtifact {
  const formalSampleIds = {
    SEARCH: ['search-1', 'search-2', 'search-3'],
    READ: ['read-1', 'read-2', 'read-3'],
    WRITE: ['write-1', 'write-2', 'write-3'],
  };
  const batch: WriterQualificationBatch = {
    schemaVersion: 'writer-qualification-batch-v1',
    batchId,
    qualificationIdentityFingerprint:
      qualificationIdentity.qualificationIdentityFingerprint,
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    benchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    profileId: PROFILE_ID,
    startedAt: '2026-08-17T00:00:00.000Z',
    completedAt: '2026-08-17T00:01:00.000Z',
    status: 'COMPLETE',
    formalSampleIds,
    expectedFixtureCoverage: { SEARCH: 3, READ: 3, WRITE: 3 },
    actualFixtureCoverage: { SEARCH: 3, READ: 3, WRITE: 3 },
  };
  const resultId = `writer-qualification-result-${sha256Canonical({
    batchId,
    qualificationIdentityFingerprint: qualificationIdentity.qualificationIdentityFingerprint,
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
  }).slice(0, 24)}`;
  const fixture = (expectedActionClass: 'SEARCH' | 'READ' | 'WRITE') => ({
    expectedActionClass,
    formalSampleIds: [...formalSampleIds[expectedActionClass]],
    capabilitySampleIds: [...formalSampleIds[expectedActionClass]],
    strictPassSampleIds: status === 'QUALIFIED' ? [...formalSampleIds[expectedActionClass]] : [],
    redundantPassSampleIds: [],
    negativeSampleIds: status === 'NOT_QUALIFIED' ? [...formalSampleIds[expectedActionClass]] : [],
    unavailableSampleIds: [],
    gateStatus: status === 'QUALIFIED' ? 'PASS' as const : 'FAIL' as const,
  });
  const result: WriterQualificationResultArtifact = {
    schemaVersion: 'writer-qualification-result-v1',
    resultId,
    batchId,
    profileId: PROFILE_ID,
    qualificationIdentityFingerprint: qualificationIdentity.qualificationIdentityFingerprint,
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    benchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    status,
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
  const directory = path.join(cwd, '.cc-auto', 'qualification', 'writer', PROFILE_ID, batchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'batch.json'), JSON.stringify(batch));
  writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result));
  return result;
}

function issuanceInput(
  result: WriterQualificationResultArtifact,
  currentQualificationIdentity: WriterQualificationIdentitySnapshot,
  issuedAt = '2026-08-17T01:00:00.000Z',
) {
  return {
    profileId: PROFILE_ID,
    batchId: result.batchId,
    resultId: result.resultId,
    currentQualificationIdentity,
    requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    issuedAt,
  };
}

describe('Writer Qualification Certificate v1', () => {
  it('explicitly issues only a QUALIFIED frozen result and selects it as current', () => {
    const cwd = createCwd();
    const currentIdentity = identity();
    const result = persistFrozenResult(cwd, 'batch-qualified', currentIdentity, 'QUALIFIED');

    expect(getCurrentWriterQualificationCertificate(cwd, PROFILE_ID)).toBeNull();
    const certificate = issueWriterQualificationCertificate(
      cwd,
      issuanceInput(result, currentIdentity),
    );

    expect(certificate).toMatchObject({
      schemaVersion: 'writer-qualification-certificate-v1',
      executionRole: 'WRITER',
      profileId: PROFILE_ID,
      batchId: result.batchId,
      resultId: result.resultId,
      qualificationIdentityFingerprint: currentIdentity.qualificationIdentityFingerprint,
      status: 'ACTIVE',
    });
    expect(getCurrentWriterQualificationCertificate(cwd, PROFILE_ID)?.certificateId)
      .toBe(certificate.certificateId);
    expect(evaluatePersistedWriterQualificationCertificate(cwd, {
      certificateId: certificate.certificateId,
      profileId: PROFILE_ID,
      currentQualificationIdentity: currentIdentity,
      requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
      requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    })).toBe('ACTIVE_VALID');
  });

  it.each(['NOT_QUALIFIED', 'INSUFFICIENT_EVIDENCE'] as const)(
    'fails closed when issuing a %s result',
    (status) => {
      const cwd = createCwd();
      const currentIdentity = identity();
      const result = persistFrozenResult(cwd, `batch-${status.toLowerCase()}`, currentIdentity, status);

      expect(() => issueWriterQualificationCertificate(
        cwd,
        issuanceInput(result, currentIdentity),
      )).toThrowError('RESULT_NOT_QUALIFIED');
      expect(getCurrentWriterQualificationCertificate(cwd, PROFILE_ID)).toBeNull();
    },
  );

  it('does not issue when the current resolved identity no longer matches the result', () => {
    const cwd = createCwd();
    const qualifiedIdentity = identity();
    const result = persistFrozenResult(cwd, 'batch-stale-before-issue', qualifiedIdentity, 'QUALIFIED');
    const changedProfile = structuredClone(PROFILE);
    changedProfile.models[0].requestedModelId = 'model-b';
    changedProfile.models[0].acceptedReportedModelIds = ['model-b'];

    expect(() => issueWriterQualificationCertificate(
      cwd,
      issuanceInput(result, identity({ profile: changedProfile })),
    )).toThrowError('IDENTITY_MISMATCH');
    expect(getCurrentWriterQualificationCertificate(cwd, PROFILE_ID)).toBeNull();
  });

  it('keeps the certificate applicable across API key value rotation', () => {
    const cwd = createCwd();
    const before = identity({ credentialValue: 'credential-a' });
    const after = identity({ credentialValue: 'credential-b' });
    const result = persistFrozenResult(cwd, 'batch-key-rotation', before, 'QUALIFIED');
    const certificate = issueWriterQualificationCertificate(cwd, issuanceInput(result, before));

    expect(after.qualificationIdentityFingerprint).toBe(before.qualificationIdentityFingerprint);
    expect(evaluateWriterQualificationCertificate({
      certificate,
      frozenResult: result,
      currentQualificationIdentity: after,
      requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
      requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    })).toBe('ACTIVE_VALID');
  });

  it('fails applicability after model or endpoint changes', () => {
    const currentIdentity = identity();
    const cwd = createCwd();
    const result = persistFrozenResult(cwd, 'batch-profile-change', currentIdentity, 'QUALIFIED');
    const certificate = issueWriterQualificationCertificate(cwd, issuanceInput(result, currentIdentity));
    const modelChanged = structuredClone(PROFILE);
    modelChanged.models[0].requestedModelId = 'model-b';
    modelChanged.models[0].acceptedReportedModelIds = ['model-b'];
    const endpointChanged = { ...PROFILE, apiBaseUrl: 'https://other.invalid/v1' };

    expect(evaluateWriterQualificationCertificate({
      certificate,
      frozenResult: result,
      currentQualificationIdentity: identity({ profile: modelChanged }),
      requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
      requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    })).toBe('IDENTITY_MISMATCH');
    expect(evaluateWriterQualificationCertificate({
      certificate,
      frozenResult: result,
      currentQualificationIdentity: identity({ profile: endpointChanged }),
      requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
      requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    })).toBe('IDENTITY_MISMATCH');
  });

  it('fails applicability after tool, system, or inference contract changes', () => {
    const currentIdentity = identity();
    const cwd = createCwd();
    const result = persistFrozenResult(cwd, 'batch-contract-change', currentIdentity, 'QUALIFIED');
    const certificate = issueWriterQualificationCertificate(cwd, issuanceInput(result, currentIdentity));
    const changedTool = structuredClone(TOOLS);
    changedTool[0].function.description = 'Changed tool contract.';
    const changedIdentities = [
      identity({ tools: changedTool }),
      identity({ system: 'writer-system-v2' }),
      identity({ maxOutputTokens: 8_192 }),
    ];

    for (const changed of changedIdentities) {
      expect(evaluateWriterQualificationCertificate({
        certificate,
        frozenResult: result,
        currentQualificationIdentity: changed,
        requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
        requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
      })).toBe('IDENTITY_MISMATCH');
    }
  });

  it('fails closed when the required Policy or benchmark contract version changes', () => {
    const currentIdentity = identity();
    const cwd = createCwd();
    const result = persistFrozenResult(cwd, 'batch-version-change', currentIdentity, 'QUALIFIED');
    const certificate = issueWriterQualificationCertificate(cwd, issuanceInput(result, currentIdentity));
    const base = {
      certificate,
      frozenResult: result,
      currentQualificationIdentity: currentIdentity,
    };

    expect(evaluateWriterQualificationCertificate({
      ...base,
      requiredQualificationPolicyVersion: 'writer-qualification-policy-v2',
      requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    })).toBe('POLICY_VERSION_MISMATCH');
    expect(evaluateWriterQualificationCertificate({
      ...base,
      requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
      requiredBenchmarkContractVersion: 'writer-model-profile-benchmark-v4',
    })).toBe('BENCHMARK_VERSION_MISMATCH');
  });

  it('does not change current selection when newer results appear', () => {
    const cwd = createCwd();
    const currentIdentity = identity();
    const resultA = persistFrozenResult(cwd, 'batch-a', currentIdentity, 'QUALIFIED');
    const certificateA = issueWriterQualificationCertificate(cwd, issuanceInput(resultA, currentIdentity));

    persistFrozenResult(cwd, 'batch-b', currentIdentity, 'QUALIFIED');
    expect(getCurrentWriterQualificationCertificate(cwd, PROFILE_ID)?.certificateId)
      .toBe(certificateA.certificateId);
    persistFrozenResult(cwd, 'batch-c', currentIdentity, 'NOT_QUALIFIED');
    expect(getCurrentWriterQualificationCertificate(cwd, PROFILE_ID)?.certificateId)
      .toBe(certificateA.certificateId);
  });

  it('requires explicit replacement and leaves only the new certificate active', () => {
    const cwd = createCwd();
    const currentIdentity = identity();
    const resultA = persistFrozenResult(cwd, 'batch-replace-a', currentIdentity, 'QUALIFIED');
    const certificateA = issueWriterQualificationCertificate(cwd, issuanceInput(resultA, currentIdentity));
    const resultB = persistFrozenResult(cwd, 'batch-replace-b', currentIdentity, 'QUALIFIED');

    expect(() => issueWriterQualificationCertificate(
      cwd,
      issuanceInput(resultB, currentIdentity),
    )).toThrowError('ACTIVE_CERTIFICATE_EXISTS');
    const replaced = replaceWriterQualificationCertificate(cwd, {
      ...issuanceInput(resultB, currentIdentity, '2026-08-17T02:00:00.000Z'),
      expectedCurrentCertificateId: certificateA.certificateId,
    });

    expect(replaced.activeCertificate.resultId).toBe(resultB.resultId);
    expect(replaced.revokedCertificate.status).toBe('REVOKED');
    expect(getCurrentWriterQualificationCertificate(cwd, PROFILE_ID)?.certificateId)
      .toBe(replaced.activeCertificate.certificateId);
    expect(loadWriterQualificationCertificate(cwd, PROFILE_ID, certificateA.certificateId).status)
      .toBe('REVOKED');
  });

  it('revokes explicitly without modifying the immutable certificate artifact', () => {
    const cwd = createCwd();
    const currentIdentity = identity();
    const result = persistFrozenResult(cwd, 'batch-revoke', currentIdentity, 'QUALIFIED');
    const certificate = issueWriterQualificationCertificate(cwd, issuanceInput(result, currentIdentity));
    const certificateFile = path.join(
      cwd,
      '.cc-auto',
      'qualification',
      'writer',
      PROFILE_ID,
      'certificates',
      `${certificate.certificateId}.json`,
    );
    const before = readFileSync(certificateFile, 'utf8');

    const revoked = revokeWriterQualificationCertificate(
      cwd,
      PROFILE_ID,
      certificate.certificateId,
      'MANUAL_REVOKE',
      '2026-08-17T03:00:00.000Z',
    );

    expect(revoked.status).toBe('REVOKED');
    expect(readFileSync(certificateFile, 'utf8')).toBe(before);
    expect(getCurrentWriterQualificationCertificate(cwd, PROFILE_ID)).toBeNull();
    expect(evaluatePersistedWriterQualificationCertificate(cwd, {
      certificateId: certificate.certificateId,
      profileId: PROFILE_ID,
      currentQualificationIdentity: currentIdentity,
      requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
      requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    })).toBe('REVOKED');
  });

  it('fails closed for tampered result binding and a missing result', () => {
    const cwd = createCwd();
    const currentIdentity = identity();
    const result = persistFrozenResult(cwd, 'batch-integrity', currentIdentity, 'QUALIFIED');
    const certificate = issueWriterQualificationCertificate(cwd, issuanceInput(result, currentIdentity));

    expect(evaluateWriterQualificationCertificate({
      certificate,
      frozenResult: { ...result, batchId: 'tampered-batch' },
      currentQualificationIdentity: currentIdentity,
      requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
      requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    })).toBe('RESULT_BINDING_MISMATCH');

    rmSync(path.join(
      cwd,
      '.cc-auto',
      'qualification',
      'writer',
      PROFILE_ID,
      result.batchId,
      'result.json',
    ));
    expect(evaluatePersistedWriterQualificationCertificate(cwd, {
      certificateId: certificate.certificateId,
      profileId: PROFILE_ID,
      currentQualificationIdentity: currentIdentity,
      requiredQualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
      requiredBenchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    })).toBe('RESULT_NOT_FOUND');
  });
});
