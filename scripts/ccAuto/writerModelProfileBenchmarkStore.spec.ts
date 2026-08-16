import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderExecutionResult, ProviderProfile } from './types';
import { WRITER_DECISION_FIXTURE } from './__fixtures__/writerDecisionFixture';
import { runWriterModelProfileBenchmark } from './writerModelProfileBenchmark';
import {
  saveWriterBenchmarkSample,
  WRITER_BENCHMARK_SAMPLE_SCHEMA_VERSION,
} from './writerModelProfileBenchmarkStore';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

const PROFILE: ProviderProfile = {
  id: 'profile-safe-store',
  displayName: 'Safe Store Profile',
  vendor: 'third-party',
  transport: 'openai-chat',
  credentialEnvVars: ['BENCHMARK_TEST_TOKEN'],
  runtimeEnvAllowlist: ['PATH'],
  defaultModelId: 'model-safe-store',
  models: [{
    logicalName: 'model-safe-store',
    requestedModelId: 'model-safe-store',
    acceptedReportedModelIds: ['model-safe-store'],
    displayName: 'Safe Store Model',
  }],
  pricing: {
    'model-safe-store': {
      inputPerMTokens: 1,
      outputPerMTokens: 2,
      cacheCreationPerMTokens: 1,
      cacheReadPerMTokens: 0.1,
      currency: 'CNY',
      source: 'test',
      updatedAt: '2026-08-16T00:00:00.000Z',
    },
  },
};

describe('Writer benchmark sample persistence', () => {
  it('atomically persists only the safe audit schema', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'writer-benchmark-store-'));
    cleanup.push(cwd);
    const forbiddenArgument = 'sk-abcdefghijklmnop';
    const result = await runWriterModelProfileBenchmark({
      fixture: WRITER_DECISION_FIXTURE,
      profile: PROFILE,
      logicalModelName: 'model-safe-store',
      executionRole: 'FAST_EXECUTOR',
      sampleIdFactory: () => 'writer-sample-safe-store-1',
      invocation: {
        resolveAdapterContract: () => ({
          adapterId: 'store-test-adapter',
          adapterContractVersion: 'store-test-adapter-v1',
          toolCallTranslationVersion: 'store-test-tool-translation-v1',
        }),
        invoke: async () => ({
          providerCallCount: 1,
          providerCompletion: {
            finishReason: 'tool_calls',
            outputTokenLimitHit: false,
            providerErrorCategory: null,
            providerErrorCode: null,
          },
          executionResult: {
            ok: true,
            usageRecord: {
              model: 'builder',
              requestedModelId: 'model-safe-store',
              reportedModel: 'model-safe-store',
              providerId: 'profile-safe-store',
              modelIdentityStatus: 'VERIFIED',
              pricingStatus: 'PRICED',
              usageStatus: 'AVAILABLE',
              costStatus: 'AVAILABLE',
              inputTokens: 10,
              outputTokens: 5,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 20,
              costRmbCustom: 0.001,
              costRmbOfficial: null,
              durationMs: 2,
              numTurns: 1,
              subtype: 'tool_calls',
              isError: false,
              toolUseCounts: null,
              toolErrorCounts: null,
              permissionDenialsCount: 0,
              executionRole: 'FAST_EXECUTOR',
            },
            content: '',
            toolCalls: [{
              id: 'call-safe-1',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: 'safe.ts', content: forbiddenArgument }),
              },
            }],
          } satisfies ProviderExecutionResult,
        }),
      },
    });

    const saved = saveWriterBenchmarkSample(cwd, result);
    const raw = readFileSync(saved.filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed.schemaVersion).toBe(WRITER_BENCHMARK_SAMPLE_SCHEMA_VERSION);
    expect(parsed.benchmarkSampleId).toBe('writer-sample-safe-store-1');
    expect(parsed.toolNames).toEqual(['write_file']);
    expect(parsed.actionClasses).toEqual(['WRITE']);
    expect(parsed.expectedActionClass).toBe('WRITE');
    expect(parsed.actualActionClass).toBe('WRITE');
    expect(parsed.cachedTokens).toBe(20);
    expect(parsed.totalTokens).toBe(35);
    expect(parsed.verdict).toBe('PASS_STRICT');
    expect(parsed.passed).toBe(true);
    expect(parsed.qualificationIdentity).toEqual(expect.objectContaining({
      benchmarkContractVersion: 'writer-model-profile-benchmark-v3',
      profileId: 'profile-safe-store',
      modelIdentifier: 'model-safe-store',
      qualificationPolicyVersion: 'writer-qualification-policy-v1',
    }));
    expect(parsed).not.toHaveProperty('rawActionSummary');
    expect(parsed).not.toHaveProperty('protocolError');
    expect(raw).not.toContain(forbiddenArgument);
    expect(raw).not.toContain('NEXT_ACTION_OBSERVATION');
    expect(raw).not.toContain('Authorization');
    expect(raw).not.toContain('recognizedFields');
  });
});
