import { describe, expect, it } from 'vitest';
import {
  classifyWriterDecisionAction,
  type WriterDecisionActionClass,
  type WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';
import {
  classifyWriterCapabilityActions,
  isPassingWriterVerdict,
  type WriterBenchmarkVerdict,
} from './writerModelProfileBenchmark';
import type { PersistedWriterBenchmarkSample } from './writerModelProfileBenchmarkStore';
import {
  evaluateWriterProfileQualification,
  selectLatestWriterBenchmarkSamplesByCell,
  WRITER_QUALIFICATION_POLICY_VERSION,
  type WriterQualificationEvaluationOptions,
  type WriterQualificationIdentityInput,
} from './writerProfileQualification';

interface SampleOptions {
  id: string;
  expected: WriterExpectedActionClass;
  toolNames?: string[];
  profileId?: string;
  providerIdentifier?: string;
  completedAt?: string;
  unavailable?: boolean;
  verdict?: WriterBenchmarkVerdict;
  protocolValid?: boolean | null;
}

const FIXTURES: Record<WriterExpectedActionClass, { fixtureId: string; fixtureVersion: string }> = {
  SEARCH: { fixtureId: 'fixture-search', fixtureVersion: 'v1' },
  READ: { fixtureId: 'fixture-read', fixtureVersion: 'v1' },
  WRITE: { fixtureId: 'fixture-write', fixtureVersion: 'v1' },
};

const COMPLETE_IDENTITY: WriterQualificationIdentityInput = {
  profileId: 'profile-under-test',
  modelIdentifier: 'model-version-1',
  providerProfileConfigFingerprint: 'provider-config-fingerprint-1',
  fixtureSet: (['SEARCH', 'READ', 'WRITE'] as const).map(expected => ({
    expectedActionClass: expected,
    ...FIXTURES[expected],
  })),
  toolSchemaAdapterContractFingerprint: 'tool-adapter-contract-1',
  writerSystemContractFingerprint: 'writer-system-contract-1',
  inferenceSettingsFingerprint: 'inference-settings-1',
  qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
};

function sample(options: SampleOptions): PersistedWriterBenchmarkSample {
  const profileId = options.profileId ?? 'profile-under-test';
  const unavailable = options.unavailable === true;
  const toolNames = options.toolNames ?? [];
  const actionClasses = toolNames.map(classifyWriterDecisionAction);
  const invalid = actionClasses.includes('INVALID');
  const capability = invalid
    ? { actualActionClass: 'INVALID' as const, verdict: 'INVALID_PROTOCOL' as const, reasonCode: 'INVALID' }
    : classifyWriterCapabilityActions(actionClasses, options.expected);
  const verdict = options.verdict
    ?? (unavailable ? 'BENCHMARK_UNAVAILABLE' : capability.verdict);
  const fixture = FIXTURES[options.expected];
  const truncated = verdict === 'OUTPUT_TRUNCATED_NO_ACTION';

  return {
    schemaVersion: 'writer-model-profile-benchmark-sample-v2',
    benchmarkSampleId: options.id,
    fixtureId: fixture.fixtureId,
    fixtureVersion: fixture.fixtureVersion,
    profileId,
    providerIdentifier: options.providerIdentifier ?? 'provider-a',
    executionRole: 'FAST_EXECUTOR',
    startedAt: '2026-08-16T00:00:00.000Z',
    completedAt: options.completedAt ?? '2026-08-16T00:00:01.000Z',
    latencyMs: 1_000,
    providerCallCount: unavailable ? 0 : 1,
    toolNames,
    actionClasses,
    toolCallCount: toolNames.length,
    containsRead: actionClasses.includes('READ'),
    containsSearch: actionClasses.includes('SEARCH'),
    containsWrite: actionClasses.includes('WRITE'),
    containsFinal: actionClasses.includes('FINAL'),
    containsInvalid: actionClasses.includes('INVALID'),
    expectedActionClass: options.expected,
    actualActionClass: capability.actualActionClass as WriterDecisionActionClass | null,
    protocolValid: options.protocolValid
      ?? (unavailable ? null : verdict === 'INVALID_PROTOCOL' ? false : true),
    verdict,
    reasonCode: unavailable
      ? 'PROVIDER_EXECUTION_FAILED:TRANSPORT'
      : truncated ? 'OUTPUT_TOKEN_LIMIT_WITHOUT_ACTION' : capability.reasonCode,
    passed: isPassingWriterVerdict(verdict),
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    totalTokens: null,
    costRmb: null,
    finishReason: unavailable ? null : truncated ? 'length' : 'tool_calls',
    outputTokenLimitHit: unavailable ? null : truncated,
    providerErrorCategory: unavailable ? 'TRANSPORT' : null,
    providerErrorCode: unavailable ? 'NETWORK_UNAVAILABLE' : null,
  };
}

function strictTool(expected: WriterExpectedActionClass): string {
  if (expected === 'SEARCH') return 'grep';
  if (expected === 'READ') return 'read_file';
  return 'write_file';
}

function redundantTools(expected: WriterExpectedActionClass): string[] {
  if (expected === 'SEARCH') return ['grep', 'read_file'];
  if (expected === 'READ') return ['read_file', 'glob'];
  return ['write_file', 'read_file'];
}

function threeStrict(expected: WriterExpectedActionClass, prefix = expected.toLowerCase()): PersistedWriterBenchmarkSample[] {
  return [1, 2, 3].map(index => sample({
    id: `${prefix}-strict-${index}`,
    expected,
    toolNames: [strictTool(expected)],
    completedAt: `2026-08-16T00:00:0${index}.000Z`,
  }));
}

function completeStrictEvidence(): PersistedWriterBenchmarkSample[] {
  return (['SEARCH', 'READ', 'WRITE'] as const).flatMap(expected => threeStrict(expected));
}

function evaluate(
  samples: PersistedWriterBenchmarkSample[],
  options: WriterQualificationEvaluationOptions = {},
) {
  return evaluateWriterProfileQualification('profile-under-test', samples, {
    identity: COMPLETE_IDENTITY,
    ...options,
  });
}

describe('Writer Qualification Policy v1', () => {
  it('qualifies complete evidence with two strict and one redundant pass per fixture', () => {
    const evidence = (['SEARCH', 'READ', 'WRITE'] as const).flatMap(expected => [
      ...threeStrict(expected).slice(0, 2),
      sample({ id: `${expected}-redundant`, expected, toolNames: redundantTools(expected) }),
    ]);

    const result = evaluate(evidence);

    expect(result.qualificationPolicyVersion).toBe('writer-qualification-policy-v1');
    expect(result.qualificationIdentity.complete).toBe(true);
    expect(result.status).toBe('QUALIFIED');
    expect(Object.values(result.capability.fixtureCoverage).every(
      fixture => fixture.gateStatus === 'PASS',
    )).toBe(true);
    expect(result.reasonCodes).toContain('EXPLORATION_REDUNDANCY_OBSERVED');
  });

  it('qualifies when all three samples pass with redundancy', () => {
    const evidence = (['SEARCH', 'READ', 'WRITE'] as const).flatMap(expected => (
      [1, 2, 3].map(index => sample({
        id: `${expected}-redundant-${index}`,
        expected,
        toolNames: redundantTools(expected),
      }))
    ));

    expect(evaluate(evidence).status).toBe('QUALIFIED');
  });

  it('fails a fixture with two redundant passes and one ordinary failure', () => {
    const evidence = [
      ...threeStrict('SEARCH'),
      ...threeStrict('READ'),
      sample({ id: 'write-redundant-1', expected: 'WRITE', toolNames: redundantTools('WRITE') }),
      sample({ id: 'write-redundant-2', expected: 'WRITE', toolNames: redundantTools('WRITE') }),
      sample({ id: 'write-wrong', expected: 'WRITE', toolNames: ['read_file'] }),
    ];

    const result = evaluate(evidence);

    expect(result.status).toBe('NOT_QUALIFIED');
    expect(result.capability.fixtureCoverage.WRITE.gateStatus).toBe('FAIL');
    expect(result.reasonCodes).toContain('FIXTURE_GATE_FAILED');
  });

  it('allows one ordinary wrong action when two strict samples pass', () => {
    const evidence = [
      ...threeStrict('SEARCH'),
      ...threeStrict('READ'),
      ...threeStrict('WRITE').slice(0, 2),
      sample({ id: 'write-wrong', expected: 'WRITE', toolNames: ['read_file'] }),
    ];

    const result = evaluate(evidence);

    expect(result.status).toBe('QUALIFIED');
    expect(result.capability.fixtureCoverage.WRITE.gateStatus).toBe('PASS');
    expect(result.reasonCodes).toContain('WRITE_TRANSITION_WEAKNESS_OBSERVED');
  });

  it('applies a single attributable premature-write safety veto', () => {
    const result = evaluate([
      sample({
        id: 'read-premature-write',
        expected: 'READ',
        toolNames: ['read_file', 'write_file'],
      }),
    ]);

    expect(result.status).toBe('NOT_QUALIFIED');
    expect(result.reasonCodes).toContain('PREMATURE_WRITE_SAFETY_VETO');
    expect(result.reasonCodes).toContain('PREMATURE_WRITE_OBSERVED');
  });

  it('returns insufficient evidence when any fixture has fewer than three capability samples', () => {
    const result = evaluate([
      ...threeStrict('SEARCH'),
      ...threeStrict('READ'),
      ...threeStrict('WRITE').slice(0, 2),
    ]);

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.reasonCodes).toContain('MINIMUM_EVIDENCE_NOT_MET');
    expect(result.capability.fixtureCoverage.WRITE.minimumEvidenceMet).toBe(false);
  });

  it('keeps Provider unavailability out of the capability denominator', () => {
    const result = evaluate([
      ...threeStrict('SEARCH'),
      ...threeStrict('READ'),
      ...threeStrict('WRITE').slice(0, 2),
      sample({ id: 'write-unavailable', expected: 'WRITE', unavailable: true }),
    ]);

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.capability.fixtureCoverage.WRITE.capabilitySampleIds).toHaveLength(2);
    expect(result.operationalReliability).toMatchObject({
      status: 'WARNING',
      unavailableResponses: 1,
    });
    expect(result.reasonCodes).toContain('PROVIDER_UNAVAILABLE_OBSERVED');
  });

  it('counts output truncation as capability negative evidence', () => {
    const result = evaluate([
      ...threeStrict('SEARCH'),
      ...threeStrict('READ'),
      ...threeStrict('WRITE').slice(0, 2),
      sample({
        id: 'write-truncated',
        expected: 'WRITE',
        verdict: 'OUTPUT_TRUNCATED_NO_ACTION',
      }),
    ]);

    expect(result.status).toBe('QUALIFIED');
    expect(result.capability.fixtureCoverage.WRITE.capabilitySampleIds).toHaveLength(3);
    expect(result.capability.fixtureCoverage.WRITE.negativeSampleIds).toContain('write-truncated');
    expect(result.reasonCodes).toContain('OUTPUT_TRUNCATION_OBSERVED');
    expect(result.operationalReliability.unavailableResponses).toBe(0);
  });

  it('returns insufficient evidence for unresolved INVALID_PROTOCOL attribution', () => {
    const result = evaluate([
      ...threeStrict('SEARCH').slice(0, 2),
      sample({
        id: 'search-invalid',
        expected: 'SEARCH',
        toolNames: ['unknown_tool'],
        verdict: 'INVALID_PROTOCOL',
        protocolValid: false,
      }),
      ...threeStrict('READ'),
      ...threeStrict('WRITE'),
    ]);

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.reasonCodes).toContain('PROTOCOL_ATTRIBUTION_UNRESOLVED');
    expect(result.capability.fixtureCoverage.SEARCH.capabilitySampleIds).toHaveLength(2);
  });

  it('counts model-attributable INVALID_PROTOCOL as ordinary negative evidence', () => {
    const invalid = sample({
      id: 'search-invalid-model',
      expected: 'SEARCH',
      toolNames: ['unknown_tool'],
      verdict: 'INVALID_PROTOCOL',
      protocolValid: false,
    });
    const result = evaluate([
      ...threeStrict('SEARCH').slice(0, 2),
      invalid,
      ...threeStrict('READ'),
      ...threeStrict('WRITE'),
    ], {
      protocolAttributionBySampleId: { [invalid.benchmarkSampleId]: 'MODEL' },
    });

    expect(result.status).toBe('QUALIFIED');
    expect(result.capability.fixtureCoverage.SEARCH.capabilitySampleIds).toHaveLength(3);
    expect(result.reasonCodes).toContain('PROTOCOL_INVALID_OBSERVED');
  });

  it('rejects mixed qualification identity evidence without blaming capability', () => {
    const evidence = completeStrictEvidence();
    const baseline = evaluate(evidence);
    const firstId = evidence[0].benchmarkSampleId;
    const result = evaluate(evidence, {
      sampleIdentityFingerprints: {
        [firstId]: `${baseline.qualificationIdentity.fingerprint}-different`,
      },
    });

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.reasonCodes).toContain('EVIDENCE_IDENTITY_MIXED');
  });

  it('marks legacy persisted evidence identity incomplete instead of inventing versions', () => {
    const result = evaluateWriterProfileQualification(
      'profile-under-test',
      completeStrictEvidence(),
    );

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.qualificationIdentity.complete).toBe(false);
    expect(result.qualificationIdentity.incompleteFields).toEqual(expect.arrayContaining([
      'modelIdentifier',
      'providerProfileConfigFingerprint',
      'toolSchemaAdapterContractFingerprint',
      'writerSystemContractFingerprint',
      'inferenceSettingsFingerprint',
    ]));
    expect(result.reasonCodes).toContain('QUALIFICATION_IDENTITY_INCOMPLETE');
  });

  it('does not change the policy decision when only providerIdentifier brand changes', () => {
    const evidenceA = completeStrictEvidence();
    const evidenceB = evidenceA.map(item => ({
      ...item,
      providerIdentifier: 'another-provider-brand',
    }));

    expect(evaluate(evidenceB)).toEqual(evaluate(evidenceA));
  });

  it('treats a Provider config fingerprint change as a new identity', () => {
    const evidence = completeStrictEvidence();
    const oldResult = evaluate(evidence);
    const newIdentity = {
      ...COMPLETE_IDENTITY,
      providerProfileConfigFingerprint: 'provider-config-fingerprint-2',
    };
    const result = evaluateWriterProfileQualification('profile-under-test', evidence, {
      identity: newIdentity,
      sampleIdentityFingerprints: {
        [evidence[0].benchmarkSampleId]: oldResult.qualificationIdentity.fingerprint,
      },
    });

    expect(result.qualificationIdentity.fingerprint)
      .not.toBe(oldResult.qualificationIdentity.fingerprint);
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.reasonCodes).toContain('EVIDENCE_IDENTITY_MIXED');
  });

  it('returns insufficient evidence for a mismatched policy version', () => {
    const result = evaluateWriterProfileQualification(
      'profile-under-test',
      completeStrictEvidence(),
      {
        identity: {
          ...COMPLETE_IDENTITY,
          qualificationPolicyVersion: 'writer-qualification-policy-v2',
        },
      },
    );

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.reasonCodes).toContain('POLICY_VERSION_MISMATCH');
  });

  it('is deterministic for the same evidence in a different input order', () => {
    const evidence = completeStrictEvidence();

    expect(evaluate([...evidence].reverse())).toEqual(evaluate(evidence));
  });

  it('selects one latest sample per profile/fixture cell deterministically', () => {
    const older = sample({
      id: 'search-older',
      expected: 'SEARCH',
      toolNames: ['grep'],
      completedAt: '2026-08-16T00:00:01.000Z',
    });
    const newer = sample({
      id: 'search-newer',
      expected: 'SEARCH',
      toolNames: ['glob'],
      completedAt: '2026-08-16T00:00:02.000Z',
    });

    expect(selectLatestWriterBenchmarkSamplesByCell([newer, older]))
      .toEqual([newer]);
  });
});
