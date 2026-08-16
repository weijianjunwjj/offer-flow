import { describe, expect, it } from 'vitest';
import type {
  WriterDecisionActionClass,
  WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';
import type { WriterBenchmarkVerdict } from './writerModelProfileBenchmark';
import {
  reclassifyWriterBenchmarkSample,
  summarizeWriterBenchmarkSamples,
} from './writerModelProfileBenchmark.run';
import type { PersistedWriterBenchmarkSample } from './writerModelProfileBenchmarkStore';

function sample(options: {
  profileId: string;
  executionRole: PersistedWriterBenchmarkSample['executionRole'];
  expected: WriterExpectedActionClass;
  actual: WriterDecisionActionClass | null;
  verdict: WriterBenchmarkVerdict;
  reasonCode: string;
  costRmb?: number | null;
}): PersistedWriterBenchmarkSample {
  const actionClasses = options.actual === null ? [] : [options.actual];
  const toolNameByAction: Partial<Record<WriterDecisionActionClass, string>> = {
    SEARCH: 'grep',
    READ: 'read_file',
    WRITE: 'edit_file',
  };
  return {
    schemaVersion: 'writer-model-profile-benchmark-sample-v2',
    benchmarkSampleId: `writer-sample-${options.profileId}-${options.expected}`,
    fixtureId: `fixture-${options.expected.toLowerCase()}-v1`,
    fixtureVersion: 'v1',
    profileId: options.profileId,
    providerIdentifier: 'third-party',
    executionRole: options.executionRole,
    startedAt: '2026-08-16T00:00:00.000Z',
    completedAt: '2026-08-16T00:00:01.000Z',
    latencyMs: 1000,
    providerCallCount: 1,
    toolNames: options.actual === null ? [] : [toolNameByAction[options.actual] ?? 'unknown_tool'],
    actionClasses,
    toolCallCount: actionClasses.length,
    containsRead: options.actual === 'READ',
    containsSearch: options.actual === 'SEARCH',
    containsWrite: options.actual === 'WRITE',
    containsFinal: options.actual === 'FINAL',
    containsInvalid: options.actual === 'INVALID',
    expectedActionClass: options.expected,
    actualActionClass: options.actual,
    protocolValid: options.verdict === 'BENCHMARK_UNAVAILABLE'
      ? null
      : options.verdict !== 'INVALID_PROTOCOL',
    verdict: options.verdict,
    reasonCode: options.reasonCode,
    passed: options.verdict === 'PASS_STRICT' || options.verdict === 'PASS_WITH_REDUNDANCY',
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    totalTokens: 15,
    costRmb: options.costRmb ?? 0.001,
    finishReason: options.verdict === 'OUTPUT_TRUNCATED_NO_ACTION' ? 'length' : 'tool_calls',
    outputTokenLimitHit: options.verdict === 'OUTPUT_TRUNCATED_NO_ACTION',
    providerErrorCategory: options.verdict === 'BENCHMARK_UNAVAILABLE' ? 'HTTP' : null,
    providerErrorCode: options.verdict === 'BENCHMARK_UNAVAILABLE' ? 'HTTP_500' : null,
  };
}

describe('Writer benchmark behavior matrix summary', () => {
  it('groups one SEARCH / READ / WRITE calibration cell per profile', () => {
    const summaries = summarizeWriterBenchmarkSamples([
      sample({
        profileId: 'fast-profile', executionRole: 'FAST_EXECUTOR',
        expected: 'SEARCH', actual: 'WRITE', verdict: 'FAIL_PREMATURE_WRITE',
        reasonCode: 'EXPECTED_SEARCH_GOT_WRITE',
      }),
      sample({
        profileId: 'fast-profile', executionRole: 'FAST_EXECUTOR',
        expected: 'READ', actual: 'READ', verdict: 'PASS_STRICT',
        reasonCode: 'ALL_ACTIONS_MATCH_EXPECTED_READ',
      }),
      sample({
        profileId: 'fast-profile', executionRole: 'FAST_EXECUTOR',
        expected: 'WRITE', actual: 'WRITE', verdict: 'PASS_STRICT',
        reasonCode: 'ALL_ACTIONS_MATCH_EXPECTED_WRITE',
      }),
      sample({
        profileId: 'strong-profile', executionRole: 'STRONG_EXECUTOR',
        expected: 'SEARCH', actual: 'SEARCH', verdict: 'PASS_STRICT',
        reasonCode: 'ALL_ACTIONS_MATCH_EXPECTED_SEARCH', costRmb: 0.002,
      }),
      sample({
        profileId: 'strong-profile', executionRole: 'STRONG_EXECUTOR',
        expected: 'READ', actual: 'READ', verdict: 'PASS_STRICT',
        reasonCode: 'ALL_ACTIONS_MATCH_EXPECTED_READ', costRmb: 0.002,
      }),
      sample({
        profileId: 'strong-profile', executionRole: 'STRONG_EXECUTOR',
        expected: 'WRITE', actual: null, verdict: 'OUTPUT_TRUNCATED_NO_ACTION',
        reasonCode: 'OUTPUT_TOKEN_LIMIT_WITHOUT_ACTION', costRmb: 0.002,
      }),
    ]);

    expect(summaries[0]).toMatchObject({
      profileId: 'fast-profile',
      executionRole: 'FAST_EXECUTOR',
      passedFixtures: 2,
      totalFixtures: 3,
      providerCallCount: 3,
      totalCostRmb: 0.003,
      behavior: {
        SEARCH: {
          expected: 'SEARCH', actual: 'WRITE', verdict: 'FAIL_PREMATURE_WRITE',
          reasonCode: 'EXPECTED_SEARCH_WITH_PREMATURE_WRITE', passed: false, costRmb: 0.001,
        },
        READ: {
          expected: 'READ', actual: 'READ', verdict: 'PASS_STRICT', passed: true,
        },
        WRITE: {
          expected: 'WRITE', actual: 'WRITE', verdict: 'PASS_STRICT', passed: true,
        },
      },
    });
    expect(summaries[1]).toMatchObject({
      profileId: 'strong-profile',
      executionRole: 'STRONG_EXECUTOR',
      passedFixtures: 2,
      totalFixtures: 3,
      providerCallCount: 3,
      totalCostRmb: 0.006,
      behavior: {
        SEARCH: { actual: 'SEARCH', verdict: 'PASS_STRICT' },
        READ: { actual: 'READ', verdict: 'PASS_STRICT' },
        WRITE: { actual: null, verdict: 'OUTPUT_TRUNCATED_NO_ACTION' },
      },
    });
  });

  it('offline reclassifies valid multi-action samples without mutating raw history', () => {
    const raw = sample({
      profileId: 'fast-profile', executionRole: 'FAST_EXECUTOR',
      expected: 'READ', actual: null, verdict: 'INVALID_PROTOCOL',
      reasonCode: 'MULTIPLE_ACTIONS_RETURNED',
    });
    raw.toolNames = ['read_file', 'glob'];
    raw.actionClasses = ['READ', 'SEARCH'];
    raw.toolCallCount = 2;
    raw.containsRead = true;
    raw.containsSearch = true;
    raw.protocolValid = false;

    const reclassified = reclassifyWriterBenchmarkSample(raw);

    expect(reclassified).toMatchObject({
      actionClasses: ['READ', 'SEARCH'],
      actualActionClass: null,
      protocolValid: true,
      verdict: 'PASS_WITH_REDUNDANCY',
      reasonCode: 'EXPECTED_READ_WITH_REDUNDANCY',
      passed: true,
    });
    expect(raw).toMatchObject({
      protocolValid: false,
      verdict: 'INVALID_PROTOCOL',
      reasonCode: 'MULTIPLE_ACTIONS_RETURNED',
    });
  });

  it('keeps provider-unavailable cells unavailable during offline reclassification', () => {
    const raw = sample({
      profileId: 'fast-profile', executionRole: 'FAST_EXECUTOR',
      expected: 'WRITE', actual: null, verdict: 'BENCHMARK_UNAVAILABLE',
      reasonCode: 'PROVIDER_EXECUTION_FAILED:PROVIDER_ERROR',
    });

    expect(reclassifyWriterBenchmarkSample(raw)).toMatchObject({
      actualActionClass: null,
      protocolValid: null,
      verdict: 'BENCHMARK_UNAVAILABLE',
      passed: false,
    });
  });
});
