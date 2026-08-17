import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyWriterDecisionAction,
  type WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';
import {
  classifyWriterCapabilityActions,
  isPassingWriterVerdict,
  type WriterBenchmarkVerdict,
} from './writerModelProfileBenchmark';
import type { PersistedWriterBenchmarkSampleV3 } from './writerModelProfileBenchmarkStore';
import {
  computeWriterQualificationIdentityFingerprint,
  WRITER_BENCHMARK_CONTRACT_VERSION,
  WRITER_QUALIFICATION_IDENTITY_SCHEMA_VERSION,
  type WriterQualificationIdentitySnapshot,
} from './writerBenchmarkIdentity';
import { evaluateWriterProfileQualification } from './writerProfileQualification';
import { WRITER_QUALIFICATION_POLICY_VERSION } from './writerQualificationPolicyContract';
import {
  createWriterQualificationBatch,
  createWriterQualificationResultArtifact,
  evaluateWriterQualificationBatch,
  loadWriterQualificationBatch,
  loadWriterQualificationResultArtifact,
  saveWriterQualificationBatch,
  saveWriterQualificationResultArtifact,
  type CreateWriterQualificationBatchInput,
} from './writerQualificationArtifact';

const PROFILE_ID = 'profile-under-test';
const FIXTURES: Record<WriterExpectedActionClass, { fixtureId: string; fixtureVersion: string }> = {
  SEARCH: { fixtureId: 'fixture-search', fixtureVersion: 'v1' },
  READ: { fixtureId: 'fixture-read', fixtureVersion: 'v1' },
  WRITE: { fixtureId: 'fixture-write', fixtureVersion: 'v1' },
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identitySnapshot(
  overrides: Partial<Omit<WriterQualificationIdentitySnapshot, 'qualificationIdentityFingerprint'>> = {},
): WriterQualificationIdentitySnapshot {
  const input = {
    benchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    profileId: PROFILE_ID,
    modelIdentifier: 'model-version-1',
    providerProfileFingerprint: '1'.repeat(64),
    fixtureSet: (['SEARCH', 'READ', 'WRITE'] as const).map(expected => ({
      expectedActionClass: expected,
      ...FIXTURES[expected],
    })),
    toolSchemaAdapterContractFingerprint: '2'.repeat(64),
    writerSystemContractFingerprint: '3'.repeat(64),
    inferenceSettingsFingerprint: '4'.repeat(64),
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    ...overrides,
  };
  return {
    identitySchemaVersion: WRITER_QUALIFICATION_IDENTITY_SCHEMA_VERSION,
    ...input,
    qualificationIdentityFingerprint: computeWriterQualificationIdentityFingerprint(input),
  };
}

const IDENTITY = identitySnapshot();

function strictTool(expected: WriterExpectedActionClass): string {
  if (expected === 'SEARCH') return 'grep';
  if (expected === 'READ') return 'read_file';
  return 'write_file';
}

function sample(input: {
  id: string;
  expected: WriterExpectedActionClass;
  toolNames?: string[];
  unavailable?: boolean;
  identity?: WriterQualificationIdentitySnapshot;
  completedAt?: string;
  transportAttempts?: number;
  transportRetryCount?: number;
  costRmb?: number | null;
}): PersistedWriterBenchmarkSampleV3 {
  const toolNames = input.toolNames ?? [strictTool(input.expected)];
  const actionClasses = toolNames.map(classifyWriterDecisionAction);
  const classified = classifyWriterCapabilityActions(actionClasses, input.expected);
  const unavailable = input.unavailable === true;
  const verdict: WriterBenchmarkVerdict = unavailable
    ? 'BENCHMARK_UNAVAILABLE'
    : classified.verdict;
  return {
    schemaVersion: 'writer-model-profile-benchmark-sample-v3',
    benchmarkSampleId: input.id,
    fixtureId: FIXTURES[input.expected].fixtureId,
    fixtureVersion: FIXTURES[input.expected].fixtureVersion,
    profileId: PROFILE_ID,
    providerIdentifier: 'provider-a',
    qualificationIdentity: input.identity ?? IDENTITY,
    executionRole: 'WRITER',
    startedAt: '2026-08-17T00:00:00.000Z',
    completedAt: input.completedAt ?? '2026-08-17T00:00:01.000Z',
    latencyMs: 1_000,
    providerCallCount: 1,
    toolNames,
    actionClasses,
    toolCallCount: toolNames.length,
    containsRead: actionClasses.includes('READ'),
    containsSearch: actionClasses.includes('SEARCH'),
    containsWrite: actionClasses.includes('WRITE'),
    containsFinal: actionClasses.includes('FINAL'),
    containsInvalid: actionClasses.includes('INVALID'),
    expectedActionClass: input.expected,
    actualActionClass: unavailable ? null : classified.actualActionClass,
    protocolValid: unavailable ? null : true,
    verdict,
    reasonCode: unavailable ? 'PROVIDER_EXECUTION_FAILED:TRANSPORT' : classified.reasonCode,
    passed: isPassingWriterVerdict(verdict),
    inputTokens: unavailable ? null : 100,
    outputTokens: unavailable ? null : 20,
    cachedTokens: unavailable ? null : 10,
    totalTokens: unavailable ? null : 130,
    costRmb: input.costRmb === undefined ? unavailable ? null : 0.001 : input.costRmb,
    finishReason: unavailable ? null : 'tool_calls',
    outputTokenLimitHit: unavailable ? null : false,
    providerErrorCategory: unavailable ? 'TRANSPORT' : null,
    providerErrorCode: unavailable ? 'NETWORK_UNAVAILABLE' : null,
    transportRetryPolicyVersion: 'connect-timeout-retry-v1',
    transportAttempts: input.transportAttempts ?? 1,
    transportRetryCount: input.transportRetryCount ?? 0,
    transportRetryReasons: input.transportRetryCount ? ['UND_ERR_CONNECT_TIMEOUT'] : [],
  };
}

function strictEvidence(prefix = 'formal'): PersistedWriterBenchmarkSampleV3[] {
  return (['SEARCH', 'READ', 'WRITE'] as const).flatMap(expected => (
    [1, 2, 3].map(index => sample({
      id: `${prefix}-${expected.toLowerCase()}-${index}`,
      expected,
      transportAttempts: expected === 'SEARCH' && index === 1 ? 2 : 1,
      transportRetryCount: expected === 'SEARCH' && index === 1 ? 1 : 0,
    }))
  ));
}

function formalIds(samples: readonly PersistedWriterBenchmarkSampleV3[]) {
  return Object.fromEntries((['SEARCH', 'READ', 'WRITE'] as const).map(expected => [
    expected,
    samples.filter(item => item.expectedActionClass === expected)
      .map(item => item.benchmarkSampleId),
  ])) as Record<WriterExpectedActionClass, string[]>;
}

function batchInput(
  batchId: string,
  samples: readonly PersistedWriterBenchmarkSampleV3[],
  overrides: Partial<CreateWriterQualificationBatchInput> = {},
): CreateWriterQualificationBatchInput {
  return {
    batchId,
    qualificationIdentityFingerprint: IDENTITY.qualificationIdentityFingerprint,
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    benchmarkContractVersion: WRITER_BENCHMARK_CONTRACT_VERSION,
    profileId: PROFILE_ID,
    startedAt: '2026-08-17T00:00:00.000Z',
    completedAt: '2026-08-17T00:01:00.000Z',
    status: 'COMPLETE',
    formalSampleIds: formalIds(samples),
    ...overrides,
  };
}

describe('Frozen Writer Qualification artifacts', () => {
  it('keeps a formal result unchanged after a later diagnostic sample', () => {
    const formal = strictEvidence();
    const batch = createWriterQualificationBatch(batchInput('batch-a', formal), formal);
    const first = createWriterQualificationResultArtifact(batch, formal);
    const diagnostic = sample({
      id: 'later-write-diagnostic',
      expected: 'WRITE',
      toolNames: ['read_file'],
      completedAt: '2026-08-18T00:00:00.000Z',
    });
    const second = createWriterQualificationResultArtifact(batch, [...formal, diagnostic]);

    expect(first).toEqual(second);
    expect(first.status).toBe('QUALIFIED');
    expect(first.reasonCodes).toEqual([]);
    expect(first.fixtureResults.WRITE.formalSampleIds).not.toContain(diagnostic.benchmarkSampleId);
  });

  it('excludes historical WRITE weakness from a strict formal WRITE gate', () => {
    const formal = strictEvidence();
    const historical = sample({
      id: 'historical-write-wrong',
      expected: 'WRITE',
      toolNames: ['read_file'],
      completedAt: '2026-08-16T00:00:00.000Z',
    });
    const pool = [historical, ...formal];
    const batch = createWriterQualificationBatch(batchInput('batch-history-write', formal), pool);
    const frozen = createWriterQualificationResultArtifact(batch, pool);
    const lifetime = evaluateWriterProfileQualification(PROFILE_ID, pool);

    expect(frozen.status).toBe('QUALIFIED');
    expect(frozen.reasonCodes).not.toContain('WRITE_TRANSITION_WEAKNESS_OBSERVED');
    expect(frozen.fixtureResults.WRITE.strictPassSampleIds).toHaveLength(3);
    expect(lifetime.reasonCodes).toContain('WRITE_TRANSITION_WEAKNESS_OBSERVED');
  });

  it('keeps historical unavailability out of formal operational reliability', () => {
    const formal = strictEvidence();
    const historicalUnavailable = sample({
      id: 'historical-unavailable',
      expected: 'WRITE',
      unavailable: true,
      completedAt: '2026-08-16T00:00:00.000Z',
    });
    const pool = [historicalUnavailable, ...formal];
    const batch = createWriterQualificationBatch(batchInput('batch-history-operational', formal), pool);
    const frozen = createWriterQualificationResultArtifact(batch, pool);

    expect(frozen.formalOperationalSummary).toMatchObject({
      status: 'SUFFICIENT',
      logicalInvocations: 9,
      availableInvocations: 9,
      unavailableInvocations: 0,
      transportAttempts: 10,
      transportRetries: 1,
      retryRecoveries: 1,
    });
    expect(evaluateWriterProfileQualification(PROFILE_ID, pool).operationalReliability.status)
      .toBe('WARNING');
  });

  it('fails closed when a formal sample belongs to another identity', () => {
    const formal = strictEvidence();
    const changedIdentity = identitySnapshot({ modelIdentifier: 'model-version-2' });
    formal[0] = { ...formal[0], qualificationIdentity: changedIdentity };

    expect(() => createWriterQualificationBatch(
      batchInput('batch-mixed-identity', formal),
      formal,
    )).toThrowError('FORMAL_SAMPLE_IDENTITY_MISMATCH');
  });

  it('fails closed when formal membership repeats a sample ID', () => {
    const formal = strictEvidence();
    const ids = formalIds(formal);
    ids.READ[0] = ids.SEARCH[0];

    expect(() => createWriterQualificationBatch(batchInput('batch-duplicate', formal, {
      formalSampleIds: ids,
    }), formal)).toThrowError('FORMAL_SAMPLE_ID_DUPLICATE');
  });

  it('rejects incomplete COMPLETE coverage and allows an auditable ABORTED batch', () => {
    const incomplete = strictEvidence().filter(item => !(
      item.expectedActionClass === 'WRITE' && item.benchmarkSampleId.endsWith('-3')
    ));
    expect(() => createWriterQualificationBatch(
      batchInput('batch-incomplete-complete', incomplete),
      incomplete,
    )).toThrowError('COMPLETE_BATCH_FIXTURE_COVERAGE_INVALID');

    const aborted = createWriterQualificationBatch(batchInput('batch-incomplete-aborted', incomplete, {
      status: 'ABORTED',
    }), incomplete);
    expect(aborted.actualFixtureCoverage.WRITE).toBe(2);
    expect(() => evaluateWriterQualificationBatch(aborted, incomplete))
      .toThrowError('BATCH_NOT_COMPLETE');
  });

  it('keeps two batches under the same identity independent', () => {
    const firstEvidence = strictEvidence('first');
    const secondEvidence = strictEvidence('second').map(item => (
      item.expectedActionClass === 'WRITE'
        ? sample({
            id: item.benchmarkSampleId,
            expected: 'WRITE',
            toolNames: ['read_file'],
          })
        : item
    ));
    const firstBatch = createWriterQualificationBatch(
      batchInput('batch-first', firstEvidence),
      [...firstEvidence, ...secondEvidence],
    );
    const secondBatch = createWriterQualificationBatch(
      batchInput('batch-second', secondEvidence),
      [...firstEvidence, ...secondEvidence],
    );
    const firstResult = createWriterQualificationResultArtifact(
      firstBatch,
      [...firstEvidence, ...secondEvidence],
    );
    const secondResult = createWriterQualificationResultArtifact(
      secondBatch,
      [...firstEvidence, ...secondEvidence],
    );

    expect(firstResult.status).toBe('QUALIFIED');
    expect(secondResult.status).toBe('NOT_QUALIFIED');
    expect(firstResult.resultId).not.toBe(secondResult.resultId);
  });

  it('persists safe artifacts atomically and refuses overwrite', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'writer-qualification-artifact-'));
    tempDirs.push(cwd);
    const evidence = strictEvidence();
    const batch = createWriterQualificationBatch(batchInput('batch-persisted', evidence), evidence);
    const result = createWriterQualificationResultArtifact(batch, evidence, {
      evaluatedAt: '2026-08-17T00:01:01.000Z',
    });
    const batchFile = saveWriterQualificationBatch(cwd, batch, evidence);
    expect(() => saveWriterQualificationResultArtifact(cwd, {
      ...result,
      status: 'NOT_QUALIFIED',
    }, evidence)).toThrowError('RESULT_CONTENT_MISMATCH');
    const resultFile = saveWriterQualificationResultArtifact(cwd, result, evidence);

    expect(loadWriterQualificationBatch(cwd, PROFILE_ID, batch.batchId)).toEqual(batch);
    expect(loadWriterQualificationResultArtifact(cwd, PROFILE_ID, batch.batchId)).toEqual(result);
    expect(readFileSync(batchFile, 'utf8')).not.toContain('prompt');
    expect(readFileSync(resultFile, 'utf8')).not.toContain('tool args');
    expect(() => saveWriterQualificationBatch(cwd, batch, evidence))
      .toThrowError('IMMUTABLE_ARTIFACT_ALREADY_EXISTS');
    expect(() => saveWriterQualificationResultArtifact(cwd, result, evidence))
      .toThrowError('IMMUTABLE_ARTIFACT_ALREADY_EXISTS');
  });
});
