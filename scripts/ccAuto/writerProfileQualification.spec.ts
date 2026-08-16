import { describe, expect, it } from 'vitest';
import {
  classifyWriterDecisionAction,
  type WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';
import {
  classifyWriterCapabilityActions,
  isPassingWriterVerdict,
} from './writerModelProfileBenchmark';
import type { PersistedWriterBenchmarkSample } from './writerModelProfileBenchmarkStore';
import {
  evaluateWriterProfileQualification,
  selectLatestWriterBenchmarkSamplesByCell,
} from './writerProfileQualification';

interface SampleOptions {
  id: string;
  expected: WriterExpectedActionClass;
  toolNames?: string[];
  providerIdentifier?: string;
  completedAt?: string;
  unavailable?: boolean;
}

function sample(options: SampleOptions): PersistedWriterBenchmarkSample {
  const toolNames = options.toolNames ?? [];
  const actionClasses = toolNames.map(classifyWriterDecisionAction);
  const capability = classifyWriterCapabilityActions(actionClasses, options.expected);
  const unavailable = options.unavailable === true;
  const verdict = unavailable ? 'BENCHMARK_UNAVAILABLE' : capability.verdict;
  return {
    schemaVersion: 'writer-model-profile-benchmark-sample-v2',
    benchmarkSampleId: options.id,
    fixtureId: `fixture-${options.expected.toLowerCase()}`,
    fixtureVersion: 'v1',
    profileId: 'profile-under-test',
    providerIdentifier: options.providerIdentifier ?? 'provider-a',
    executionRole: 'FAST_EXECUTOR',
    startedAt: '2026-08-16T00:00:00.000Z',
    completedAt: options.completedAt ?? '2026-08-16T00:00:01.000Z',
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
    expectedActionClass: options.expected,
    actualActionClass: capability.actualActionClass,
    protocolValid: unavailable ? null : true,
    verdict,
    reasonCode: unavailable ? 'PROVIDER_EXECUTION_FAILED:TRANSPORT' : capability.reasonCode,
    passed: unavailable ? false : isPassingWriterVerdict(verdict),
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    totalTokens: null,
    costRmb: null,
    finishReason: unavailable ? null : 'tool_calls',
    outputTokenLimitHit: unavailable ? null : false,
    providerErrorCategory: unavailable ? 'TRANSPORT' : null,
    providerErrorCode: unavailable ? 'NETWORK_UNAVAILABLE' : null,
  };
}

function passingSearchAndRead(): PersistedWriterBenchmarkSample[] {
  return [
    sample({ id: 'search-pass', expected: 'SEARCH', toolNames: ['grep'] }),
    sample({ id: 'read-pass', expected: 'READ', toolNames: ['read_file'] }),
  ];
}

describe('Writer Profile Qualification Contract', () => {
  it('returns insufficient evidence when WRITE coverage is missing', () => {
    const result = evaluateWriterProfileQualification(
      'profile-under-test',
      passingSearchAndRead(),
    );

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.reasonCodes).toContain('FIXTURE_COVERAGE_INCOMPLETE');
    expect(result.evidence.fixtureCoverage.SEARCH.expectedBehaviorObserved).toBe(true);
    expect(result.evidence.fixtureCoverage.READ.expectedBehaviorObserved).toBe(true);
    expect(result.evidence.fixtureCoverage.WRITE.capabilitySampleIds).toEqual([]);
  });

  it('keeps Provider unavailability out of capability failures', () => {
    const result = evaluateWriterProfileQualification('profile-under-test', [
      ...passingSearchAndRead(),
      sample({ id: 'write-unavailable', expected: 'WRITE', unavailable: true }),
    ]);

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.evidence.unavailableSamples).toBe(1);
    expect(result.evidence.capabilitySamples).toBe(2);
    expect(result.evidence.fixtureCoverage.WRITE.wrongActionObserved).toBe(false);
    expect(result.reasonCodes).toContain('PROVIDER_UNAVAILABLE_OBSERVED');
    expect(result.reasonCodes).not.toContain('WRITE_TRANSITION_WEAKNESS_OBSERVED');
  });

  it('records READ instead of WRITE as transition-to-write weakness', () => {
    const result = evaluateWriterProfileQualification('profile-under-test', [
      ...passingSearchAndRead(),
      sample({ id: 'write-read', expected: 'WRITE', toolNames: ['read_file'] }),
    ]);

    expect(result.evidence.fixtureCoverage.WRITE.wrongActionObserved).toBe(true);
    expect(result.reasonCodes).toContain('WRITE_TRANSITION_WEAKNESS_OBSERVED');
  });

  it('treats READ plus SEARCH as observed READ behavior with redundancy', () => {
    const result = evaluateWriterProfileQualification('profile-under-test', [
      sample({ id: 'read-redundant', expected: 'READ', toolNames: ['read_file', 'glob'] }),
    ]);
    const read = result.evidence.fixtureCoverage.READ;

    expect(read.expectedBehaviorObserved).toBe(true);
    expect(read.redundancyObserved).toBe(true);
    expect(read.wrongActionObserved).toBe(false);
    expect(result.reasonCodes).toContain('EXPLORATION_REDUNDANCY_OBSERVED');
  });

  it('records premature WRITE as a dangerous negative observation', () => {
    const result = evaluateWriterProfileQualification('profile-under-test', [
      sample({ id: 'read-premature-write', expected: 'READ', toolNames: ['read_file', 'write_file'] }),
    ]);

    expect(result.evidence.fixtureCoverage.READ.prematureWriteObserved).toBe(true);
    expect(result.reasonCodes).toContain('PREMATURE_WRITE_OBSERVED');
  });

  it('does not change evaluation when only providerIdentifier changes', () => {
    const evidenceA = passingSearchAndRead();
    const evidenceB = evidenceA.map(item => ({ ...item, providerIdentifier: 'provider-b' }));

    expect(evaluateWriterProfileQualification('profile-under-test', evidenceB))
      .toEqual(evaluateWriterProfileQualification('profile-under-test', evidenceA));
  });

  it('is deterministic for the same evidence in a different input order', () => {
    const evidence = [
      ...passingSearchAndRead(),
      sample({ id: 'write-read', expected: 'WRITE', toolNames: ['read_file'] }),
    ];

    expect(evaluateWriterProfileQualification('profile-under-test', [...evidence].reverse()))
      .toEqual(evaluateWriterProfileQualification('profile-under-test', evidence));
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
