import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, createMockAdapterRegistry } from './adapter';
import type {
  ModelToolCall,
  ProviderAdapter,
  ProviderAdapterQualificationContract,
  ProviderCallResponse,
  ProviderExecutionResult,
  ProviderProfile,
  UsageRecord,
} from './types';
import {
  WRITER_DECISION_FIXTURE,
  WRITER_READ_DECISION_FIXTURE,
  WRITER_SEARCH_DECISION_FIXTURE,
  type WriterDecisionFixture,
} from './__fixtures__/writerDecisionFixture';
import {
  createProviderBenchmarkInvocation,
  runWriterModelProfileBenchmark,
  type WriterBenchmarkInvocationCapability,
  type WriterBenchmarkProviderCompletion,
} from './writerModelProfileBenchmark';

const PROFILE: ProviderProfile = {
  id: 'profile-a',
  displayName: 'Profile A',
  vendor: 'third-party',
  transport: 'openai-chat',
  apiBaseUrl: 'https://provider.invalid/v1',
  credentialEnvVars: ['BENCHMARK_TEST_TOKEN'],
  runtimeEnvAllowlist: ['PATH'],
  defaultModelId: 'model-a',
  models: [{
    logicalName: 'model-a',
    requestedModelId: 'model-a',
    acceptedReportedModelIds: ['model-a'],
    displayName: 'Model A',
  }],
  pricing: {
    'model-a': {
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

const ADAPTER_CONTRACT: ProviderAdapterQualificationContract = {
  adapterId: 'benchmark-test-adapter',
  adapterContractVersion: 'benchmark-test-adapter-v1',
  toolCallTranslationVersion: 'benchmark-test-tool-translation-v1',
};

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    model: 'builder',
    requestedModelId: 'model-a',
    reportedModel: 'model-a',
    providerId: 'profile-a',
    modelIdentityStatus: 'VERIFIED',
    pricingStatus: 'PRICED',
    usageStatus: 'AVAILABLE',
    costStatus: 'AVAILABLE',
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costRmbCustom: 0.00014,
    costRmbOfficial: null,
    durationMs: 10,
    numTurns: 1,
    subtype: 'tool_calls',
    isError: false,
    toolUseCounts: null,
    toolErrorCounts: null,
    permissionDenialsCount: 0,
    executionRole: 'FAST_EXECUTOR',
    ...overrides,
  };
}

function toolCall(name: string, args: Record<string, unknown>, id: string = 'call-1'): ModelToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function actionCall(action: 'SEARCH' | 'READ' | 'WRITE', id: string = 'call-1'): ModelToolCall {
  if (action === 'SEARCH') return toolCall('grep', { query: 'formatDisplayName', roots: ['src'] }, id);
  if (action === 'READ') return toolCall('read_file', { path: 'src/utils/formatDisplayName.spec.ts' }, id);
  return toolCall('edit_file', {
    path: 'src/utils/formatDisplayName.spec.ts',
    oldText: 'private-old-content',
    newText: 'private-new-content',
  }, id);
}

function successfulInvocation(
  calls: ModelToolCall[],
  content: string | null = '',
  providerCompletion?: WriterBenchmarkProviderCompletion,
): WriterBenchmarkInvocationCapability {
  return {
    resolveAdapterContract: () => ({ ...ADAPTER_CONTRACT }),
    invoke: vi.fn(async () => ({
      providerCallCount: 1,
      providerCompletion,
      executionResult: {
        ok: true,
        usageRecord: usage(),
        content,
        toolCalls: calls,
      } satisfies ProviderExecutionResult,
    })),
  };
}

async function benchmark(
  fixture: WriterDecisionFixture,
  actual: 'SEARCH' | 'READ' | 'WRITE',
) {
  return runWriterModelProfileBenchmark({
    fixture,
    profile: PROFILE,
    logicalModelName: 'model-a',
    executionRole: 'FAST_EXECUTOR',
    invocation: successfulInvocation([actionCall(actual)]),
  });
}

describe('Writer Model Profile Behavior Benchmark', () => {
  it.each([
    ['SEARCH', WRITER_SEARCH_DECISION_FIXTURE],
    ['READ', WRITER_READ_DECISION_FIXTURE],
    ['WRITE', WRITER_DECISION_FIXTURE],
  ] as const)('passes the %s fixture only when actual matches expected', async (expected, fixture) => {
    const result = await benchmark(fixture, expected);

    expect(result).toMatchObject({
      fixtureId: fixture.id,
      expectedActionClass: expected,
      actualActionClass: expected,
      actionClasses: [expected],
      verdict: 'PASS_STRICT',
      reasonCode: `ALL_ACTIONS_MATCH_EXPECTED_${expected}`,
      passed: true,
      providerCallCount: 1,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 0,
      totalTokens: 120,
      costRmb: 0.00014,
      finishReason: 'tool_calls',
      outputTokenLimitHit: false,
      toolProtocolValid: true,
    });
  });

  it.each([
    [WRITER_READ_DECISION_FIXTURE, 'SEARCH', 'FAIL_WRONG_ACTION', 'EXPECTED_READ_NOT_RETURNED'],
    [WRITER_READ_DECISION_FIXTURE, 'WRITE', 'FAIL_PREMATURE_WRITE', 'EXPECTED_READ_WITH_PREMATURE_WRITE'],
    [WRITER_SEARCH_DECISION_FIXTURE, 'READ', 'FAIL_WRONG_ACTION', 'EXPECTED_SEARCH_NOT_RETURNED'],
    [WRITER_SEARCH_DECISION_FIXTURE, 'WRITE', 'FAIL_PREMATURE_WRITE', 'EXPECTED_SEARCH_WITH_PREMATURE_WRITE'],
    [WRITER_DECISION_FIXTURE, 'READ', 'FAIL_WRONG_ACTION', 'EXPECTED_WRITE_NOT_RETURNED'],
    [WRITER_DECISION_FIXTURE, 'SEARCH', 'FAIL_WRONG_ACTION', 'EXPECTED_WRITE_NOT_RETURNED'],
  ] as const)('uses one cross-fixture verdict system', async (fixture, actual, verdict, reasonCode) => {
    const result = await benchmark(fixture, actual);

    expect(result).toMatchObject({
      expectedActionClass: fixture.expectedNextActionClass,
      actualActionClass: actual,
      verdict,
      reasonCode,
      passed: false,
    });
  });

  it('keeps expected metadata out of the model observation and leaves the token limit unchanged', async () => {
    const invoke = successfulInvocation([actionCall('WRITE')]);
    await runWriterModelProfileBenchmark({
      fixture: WRITER_DECISION_FIXTURE,
      profile: PROFILE,
      logicalModelName: 'model-a',
      executionRole: 'FAST_EXECUTOR',
      invocation: invoke,
    });

    const request = vi.mocked(invoke.invoke).mock.calls[0][0];
    expect(request.userPrompt).not.toContain('expectedNextActionClass');
    expect(request.userPrompt).not.toContain('observedNextAction');
    expect(request.userPrompt).toContain('observationState');
    expect(request.maxOutputTokens).toBe(4_096);
    expect(request.tools.map(item => item.function.name)).toEqual([
      'read_file', 'grep', 'glob', 'write_file', 'edit_file',
    ]);
  });

  it('classifies FINAL as no progress for every expected action', async () => {
    const result = await runWriterModelProfileBenchmark({
      fixture: WRITER_READ_DECISION_FIXTURE,
      profile: PROFILE,
      logicalModelName: 'model-a',
      executionRole: 'FAST_EXECUTOR',
      invocation: successfulInvocation([], 'The task is complete.'),
    });

    expect(result).toMatchObject({
      actionClasses: ['FINAL'],
      actualActionClass: 'FINAL',
      verdict: 'FAIL_NO_PROGRESS',
      reasonCode: 'EXPECTED_READ_GOT_FINAL',
      passed: false,
    });
  });

  it('preserves truncation and empty-action diagnostics', async () => {
    const truncated = await runWriterModelProfileBenchmark({
      fixture: WRITER_DECISION_FIXTURE,
      profile: PROFILE,
      logicalModelName: 'model-a',
      executionRole: 'STRONG_EXECUTOR',
      invocation: successfulInvocation([], 'partial reasoning', {
        finishReason: 'length',
        outputTokenLimitHit: true,
        providerErrorCategory: null,
        providerErrorCode: null,
      }),
    });
    expect(truncated).toMatchObject({
      actualActionClass: null,
      verdict: 'OUTPUT_TRUNCATED_NO_ACTION',
      reasonCode: 'OUTPUT_TOKEN_LIMIT_WITHOUT_ACTION',
      finishReason: 'length',
      outputTokenLimitHit: true,
    });

    const noAction = await runWriterModelProfileBenchmark({
      fixture: WRITER_DECISION_FIXTURE,
      profile: PROFILE,
      logicalModelName: 'model-a',
      executionRole: 'STRONG_EXECUTOR',
      invocation: successfulInvocation([], ''),
    });
    expect(noAction).toMatchObject({
      actualActionClass: null,
      verdict: 'NO_ACTION_RETURNED',
      reasonCode: 'EMPTY_MODEL_ACTION',
    });
  });

  it.each([
    ['malformed', [toolCall('edit_file', { path: 'only-path' })], 'ARGUMENT_FIELD_MISSING'],
    ['unknown', [toolCall('unknown_tool', { path: 'a.ts' })], 'UNKNOWN_TOOL'],
  ] as const)('classifies %s action output as INVALID_PROTOCOL', async (_label, calls, protocolError) => {
    const result = await runWriterModelProfileBenchmark({
      fixture: WRITER_DECISION_FIXTURE,
      profile: PROFILE,
      logicalModelName: 'model-a',
      executionRole: 'FAST_EXECUTOR',
      invocation: successfulInvocation([...calls]),
    });

    expect(result).toMatchObject({
      verdict: 'INVALID_PROTOCOL',
      passed: false,
      invalidToolCall: true,
      toolProtocolValid: false,
      protocolError,
    });
  });

  it.each([
    [WRITER_SEARCH_DECISION_FIXTURE, ['SEARCH', 'SEARCH'], 'PASS_STRICT', 'ALL_ACTIONS_MATCH_EXPECTED_SEARCH'],
    [WRITER_READ_DECISION_FIXTURE, ['READ', 'SEARCH'], 'PASS_WITH_REDUNDANCY', 'EXPECTED_READ_WITH_REDUNDANCY'],
    [WRITER_DECISION_FIXTURE, ['WRITE', 'READ'], 'PASS_WITH_REDUNDANCY', 'EXPECTED_WRITE_WITH_REDUNDANCY'],
    [WRITER_DECISION_FIXTURE, ['READ', 'SEARCH'], 'FAIL_WRONG_ACTION', 'EXPECTED_WRITE_NOT_RETURNED'],
    [WRITER_READ_DECISION_FIXTURE, ['READ', 'WRITE'], 'FAIL_PREMATURE_WRITE', 'EXPECTED_READ_WITH_PREMATURE_WRITE'],
  ] as const)('classifies valid multi-action output independently from protocol validity', async (
    fixture,
    actions,
    verdict,
    reasonCode,
  ) => {
    const calls = actions.map((action, index) => actionCall(action, `call-${index + 1}`));
    const result = await runWriterModelProfileBenchmark({
      fixture,
      profile: PROFILE,
      logicalModelName: 'model-a',
      executionRole: 'FAST_EXECUTOR',
      invocation: successfulInvocation(calls),
    });

    expect(result).toMatchObject({
      actionClasses: [...actions],
      actualActionClass: null,
      verdict,
      reasonCode,
      passed: verdict === 'PASS_STRICT' || verdict === 'PASS_WITH_REDUNDANCY',
      invalidToolCall: false,
      toolProtocolValid: true,
      protocolError: null,
    });
  });

  it('keeps provider failure out of behavior and protocol attribution', async () => {
    const result = await runWriterModelProfileBenchmark({
      fixture: WRITER_DECISION_FIXTURE,
      profile: PROFILE,
      logicalModelName: 'model-a',
      executionRole: 'FAST_EXECUTOR',
      invocation: {
        resolveAdapterContract: () => ({ ...ADAPTER_CONTRACT }),
        invoke: async () => ({
          providerCallCount: 1,
          executionResult: {
            ok: false,
            stopReason: 'PROVIDER_ERROR',
            requiresHumanConfirmation: false,
            usageRecord: null,
            identityConfirmationContext: null,
            message: 'safe failure',
            errorKind: 'RATE_LIMIT',
            httpStatus: 429,
          },
        }),
      },
    });

    expect(result).toMatchObject({
      actualActionClass: null,
      verdict: 'BENCHMARK_UNAVAILABLE',
      reasonCode: 'PROVIDER_EXECUTION_FAILED:PROVIDER_ERROR',
      toolProtocolValid: null,
      providerErrorCategory: 'RATE_LIMIT',
      providerErrorCode: 'HTTP_429',
    });
  });

  it('uses the standard adapter boundary once without routing or a tool loop', async () => {
    let adapterCalls = 0;
    const adapter: ProviderAdapter = {
      transport: 'openai-chat',
      qualificationContract: ADAPTER_CONTRACT,
      async execute(request): Promise<ProviderCallResponse> {
        adapterCalls += 1;
        return {
          callId: request.callId,
          providerId: request.providerId,
          requestedModelId: request.requestedModelId,
          reportedModel: request.requestedModelId,
          content: '',
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          durationMs: 5,
          numTurns: 1,
          subtype: 'tool_calls',
          isError: false,
          error: null,
          toolCalls: [actionCall('WRITE')],
        };
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const result = await runWriterModelProfileBenchmark({
      fixture: WRITER_DECISION_FIXTURE,
      profile: PROFILE,
      logicalModelName: 'model-a',
      executionRole: 'FAST_EXECUTOR',
      invocation: createProviderBenchmarkInvocation({
        adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', BENCHMARK_TEST_TOKEN: 'not-recorded' },
        cwd: process.cwd(),
        callIdFactory: () => 'benchmark-call-1',
      }),
    });

    expect(adapterCalls).toBe(1);
    expect(result.providerCallCount).toBe(1);
    expect(result.verdict).toBe('PASS_STRICT');
    expect(JSON.stringify(result)).not.toContain('not-recorded');
  });

  it('keeps qualification identity stable across API key rotation', async () => {
    const runWithCredential = async (credential: string) => {
      const { registry } = createMockAdapterRegistry('VERIFIED_SUCCESS');
      return runWriterModelProfileBenchmark({
        fixture: WRITER_DECISION_FIXTURE,
        profile: PROFILE,
        logicalModelName: 'model-a',
        executionRole: 'FAST_EXECUTOR',
        invocation: createProviderBenchmarkInvocation({
          adapterRegistry: registry,
          parentEnv: { PATH: process.env.PATH ?? '', BENCHMARK_TEST_TOKEN: credential },
          cwd: process.cwd(),
        }),
      });
    };
    const oldKey = 'credential-rotation-old-private';
    const newKey = 'credential-rotation-new-private';
    const [before, after] = await Promise.all([
      runWithCredential(oldKey),
      runWithCredential(newKey),
    ]);

    expect(after.qualificationIdentity.qualificationIdentityFingerprint)
      .toBe(before.qualificationIdentity.qualificationIdentityFingerprint);
    expect(JSON.stringify([before, after])).not.toContain(oldKey);
    expect(JSON.stringify([before, after])).not.toContain(newKey);
  });

  it('freezes identity before invocation and does not recompute it from later profile mutation', async () => {
    const mutableProfile = structuredClone(PROFILE);
    const invocation = successfulInvocation([actionCall('WRITE')]);
    const invoke = invocation.invoke;
    invocation.invoke = async (request) => {
      request.profile.models[0].requestedModelId = 'mutated-after-snapshot';
      return invoke(request);
    };

    const result = await runWriterModelProfileBenchmark({
      fixture: WRITER_DECISION_FIXTURE,
      profile: mutableProfile,
      logicalModelName: 'model-a',
      executionRole: 'FAST_EXECUTOR',
      invocation,
    });

    expect(result.qualificationIdentity.modelIdentifier).toBe('model-a');
    expect(mutableProfile.models[0].requestedModelId).toBe('mutated-after-snapshot');
  });

  it('fails before Provider execution when Adapter qualification metadata is missing', async () => {
    const execute = vi.fn<ProviderAdapter['execute']>();
    const registry = new AdapterRegistry();
    registry.register({ transport: 'openai-chat', execute });

    await expect(runWriterModelProfileBenchmark({
      fixture: WRITER_DECISION_FIXTURE,
      profile: PROFILE,
      logicalModelName: 'model-a',
      executionRole: 'FAST_EXECUTOR',
      invocation: createProviderBenchmarkInvocation({
        adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', BENCHMARK_TEST_TOKEN: 'private' },
        cwd: process.cwd(),
      }),
    })).rejects.toThrow('ADAPTER_QUALIFICATION_CONTRACT_MISSING:openai-chat');
    expect(execute).not.toHaveBeenCalled();
  });
});
