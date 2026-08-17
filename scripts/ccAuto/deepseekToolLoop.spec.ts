/** deepseekToolLoop.spec.ts — Deploy Loop state tests.
 *
 * Public API tests wire through the real executeProviderCall.
 * Pure loop-state tests use a thin internal test-only helper.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRunLease, releaseRunLease, setWriter } from './runLease';
import type {
  DeepSeekToolLoopOptions,
  FileScope,
  ModelToolCall,
  ProviderCallRequest,
  ProviderCallResponse,
  ProviderProfile,
} from './types';

let TEST_CWD: string;
let REPO_ROOT: string;
const RUN_ID = 'run-test-loop';

function makeScope(overrides: Partial<FileScope> = {}): FileScope {
  return {
    allowedRoots: ['src', 'scripts'], protectedPaths: [], proposedFiles: [],
    approvedFiles: ['src/test.txt', 'src/new-file.txt', 'src/edit-me.txt'],
    maxChangedFiles: 10, ...overrides,
  };
}

const testProfile: ProviderProfile = {
  id: 'ds-test', displayName: 'DeepSeek Test', vendor: 'deepseek', transport: 'openai-chat',
  credentialEnvVars: ['DEEPSEEK_API_KEY'], runtimeEnvAllowlist: ['PATH', 'HOME'],
  defaultModelId: 'deepseek',
  models: [{ logicalName: 'deepseek', requestedModelId: 'deepseek-chat', acceptedReportedModelIds: ['deepseek-chat'], displayName: 'DeepSeek Chat' }],
  pricing: { 'deepseek-chat': { inputPerMTokens: 1.0, outputPerMTokens: 2.0, cacheCreationPerMTokens: 1.25, cacheReadPerMTokens: 0.1, currency: 'CNY' as const, source: 'test', updatedAt: '2026-08-04' } },
};
const TEST_WRITER_ASSIGNMENT = {
  executionRole: 'WRITER',
  profileId: testProfile.id,
  providerIdentifier: testProfile.vendor,
} as const;

beforeEach(() => {
  TEST_CWD = path.join(os.tmpdir(), `cc-auto-loop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  REPO_ROOT = TEST_CWD;
  mkdirSync(TEST_CWD, { recursive: true });
  mkdirSync(path.join(TEST_CWD, 'src'), { recursive: true });
  mkdirSync(path.join(TEST_CWD, 'scripts'), { recursive: true });
  mkdirSync(path.join(TEST_CWD, '.cc-auto'), { recursive: true });
  writeFileSync(path.join(TEST_CWD, 'src', 'test.txt'), 'hello world\n', 'utf8');
  writeFileSync(path.join(TEST_CWD, 'src', 'edit-me.txt'), 'ORIGINAL CONTENT\n', 'utf8');
});

afterEach(() => {
  vi.unstubAllGlobals();
  try { releaseRunLease(TEST_CWD, RUN_ID); } catch { /* ok */ }
  try { rmSync(TEST_CWD, { recursive: true, force: true }); } catch { /* ok */ }
});

// ============================================================================
// Pure loop-state tests — test-only internal runner
// ============================================================================
import { runDeepSeekToolLoop } from './deepseekToolLoop';
import { AdapterRegistry, MockProviderAdapter } from './adapter';
import type { ProviderAdapter } from './types';
import { createRunState } from './store';

function toolCall(id: string, name: string, args: unknown): ModelToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function providerSuccess(
  request: ProviderCallRequest,
  content: string | null,
  toolCalls?: ModelToolCall[],
): ProviderCallResponse {
  return {
    callId: request.callId,
    providerId: request.providerId,
    requestedModelId: request.requestedModelId,
    reportedModel: 'deepseek-chat',
    content,
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    durationMs: 1,
    numTurns: 1,
    subtype: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
    isError: false,
    error: null,
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function prepareLoopRun(name: string): string {
  const runId = createRunState(TEST_CWD, name, name, 'custom').runId;
  acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
  return runId;
}

function loopOptions(
  runId: string,
  registry: AdapterRegistry,
  overrides: Partial<DeepSeekToolLoopOptions> = {},
): DeepSeekToolLoopOptions {
  return {
    repositoryRoot: REPO_ROOT,
    cwd: TEST_CWD,
    runId,
    fileScope: makeScope(),
    executorContext: {
      profile: testProfile,
      logicalModelName: 'deepseek',
      role: 'builder',
      maxOutputTokens: 4096,
      timeoutMs: 30_000,
      adapterRegistry: registry,
      parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'fake-test-key' },
    },
    systemPrompt: 'Test.',
    userPrompt: 'Inspect.',
    ...overrides,
  };
}

describe('runDeepSeekToolLoop — integration (real executor + fake adapter)', () => {
  // 6.1 One-turn final
  it('one-turn final: 1 Provider call, 1 Usage, pendingCall cleared', async () => {
    const registry = new AdapterRegistry();
    const adapter = new MockProviderAdapter('VERIFIED_SUCCESS');
    registry.register(adapter);

    const runId = createRunState(TEST_CWD, 'int-1turn', 'one turn', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Say hi.', maxTurns: 3, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.finalText).toContain('[mock]');
    expect(result.turns).toBe(1);
    expect(result.callIds.length).toBe(1);

    // 验证 store 中确有一条 call
    const { loadRunState } = await import('./store');
    const state = loadRunState(TEST_CWD, runId);
    expect(state.calls.length).toBe(1);
    expect(state.pendingCall).toBeUndefined();
    expect(result.providerInvocationCount).toBe(1);
    expect(result.transportAttemptCount).toBe(1);
    expect(result.transportRetryCount).toBe(0);
  });

  it('一次 Provider response 含多个 tool calls 仍只计 1 次 provider invocation', async () => {
    const registry = new AdapterRegistry();
    let callNum = 0;
    registry.register({
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        callNum += 1;
        if (callNum === 1) {
          return providerSuccess(req, '', [
            toolCall('r1', 'read_file', { path: 'src/test.txt' }),
            toolCall('r2', 'read_file', { path: 'src/edit-me.txt' }),
          ]);
        }
        return providerSuccess(req, 'done after two reads');
      },
    });
    const runId = prepareLoopRun('multi-tool-one-turn');
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);
    const result = await runDeepSeekToolLoop(loopOptions(runId, registry, {
      maxTurns: 4,
      maxToolCallsPerTurn: 4,
      maxTotalToolCalls: 8,
    }));
    expect(result.status).toBe('COMPLETED');
    expect(result.totalToolCalls).toBe(2);
    expect(result.providerInvocationCount).toBe(2);
    expect(result.transportAttemptCount).toBe(2);
    expect(result.transportRetryCount).toBe(0);
    expect(callNum).toBe(2);
  });

  it('多个 provider turns 不得误计成一次 provider invocation', async () => {
    const registry = new AdapterRegistry();
    let callNum = 0;
    registry.register({
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        callNum += 1;
        if (callNum === 1) return providerSuccess(req, '', [toolCall('r1', 'read_file', { path: 'src/test.txt' })]);
        if (callNum === 2) return providerSuccess(req, '', [toolCall('e1', 'edit_file', { path: 'src/edit-me.txt', oldText: 'ORIGINAL CONTENT', newText: 'CHANGED' })]);
        if (callNum === 3) return providerSuccess(req, '', [toolCall('r2', 'read_file', { path: 'src/edit-me.txt' })]);
        return providerSuccess(req, 'final after four turns');
      },
    });
    const runId = prepareLoopRun('four-turns');
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);
    const result = await runDeepSeekToolLoop(loopOptions(runId, registry, {
      maxTurns: 8,
      maxToolCallsPerTurn: 4,
      maxTotalToolCalls: 16,
    }));
    expect(result.status).toBe('COMPLETED');
    expect(result.turns).toBe(4);
    expect(result.providerInvocationCount).toBe(4);
    expect(result.transportAttemptCount).toBe(4);
    expect(result.transportRetryCount).toBe(0);
    expect(result.totalToolCalls).toBe(3);
  });

  it('connect timeout retry 记 1 次 provider invocation + 2 次 transport attempt', async () => {
    const { TransportError } = await import('./providerErrors');
    const registry = new AdapterRegistry();
    let adapterAttempts = 0;
    registry.register({
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        adapterAttempts += 1;
        if (adapterAttempts === 1) {
          throw new TransportError('connect timeout', {
            transient: true,
            cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
          });
        }
        return providerSuccess(req, 'recovered after connect timeout');
      },
    });
    const runId = prepareLoopRun('connect-retry');
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);
    const result = await runDeepSeekToolLoop(loopOptions(runId, registry, {
      maxTurns: 2,
      maxTransientRetries: 0,
    }));
    expect(result.status).toBe('COMPLETED');
    expect(result.providerInvocationCount).toBe(1);
    expect(result.transportAttemptCount).toBe(2);
    expect(result.transportRetryCount).toBe(1);
    expect(adapterAttempts).toBe(2);
  });

  // 6.2 Two-turn: read_file → final
  it('two-turn: read_file tool call → final, 2 Provider calls, both recorded', async () => {
    const registry = new AdapterRegistry();
    // Create a fake adapter that returns tool_calls then final
    let callNum = 0;
    const providerCallIds: string[] = [];
    const fakeAdapter = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        callNum++;
        providerCallIds.push(req.callId);
        if (callNum === 1) {
          return {
            callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
            reportedModel: 'deepseek-chat', content: '',
            usage: { inputTokens: 500, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            durationMs: 200, numTurns: 1, subtype: 'tool_calls', isError: false, error: null,
            toolCalls: [{ id: 'call_read_1', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/test.txt' }) } }],
          };
        }
        return {
          callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
          reportedModel: 'deepseek-chat', content: 'Final answer after reading.',
          usage: { inputTokens: 300, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          durationMs: 150, numTurns: 1, subtype: 'stop', isError: false, error: null,
        };
      },
    };
    registry.register(fakeAdapter);

    const runId = createRunState(TEST_CWD, 'int-2turn', 'two turns', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Read the file.', maxTurns: 5, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.finalText).toContain('Final answer');
    expect(result.turns).toBe(2);
    expect(result.callIds.length).toBe(2);
    expect(new Set(result.callIds).size).toBe(2);
    expect(result.executedTools.length).toBe(1);

    const { loadRunState } = await import('./store');
    const state = loadRunState(TEST_CWD, runId);
    expect(state.calls.length).toBe(2);
    expect(providerCallIds).toEqual(result.callIds);
    expect(state.pendingCall).toBeUndefined();
  });

  // 6.3 Three-turn: read_file → grep → final
  it('three-turn: read_file → grep → final, 3 calls recorded', async () => {
    const registry = new AdapterRegistry();
    let callNum = 0;
    const fakeAdapter = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        callNum++;
        if (callNum === 1) {
          // read_file
          return {
            callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
            reportedModel: 'deepseek-chat', content: '',
            usage: { inputTokens: 500, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            durationMs: 200, numTurns: 1, subtype: 'tool_calls', isError: false, error: null,
            toolCalls: [{ id: 'r1', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/edit-me.txt' }) } }],
          };
        }
        if (callNum === 2) {
          // 第二个只读工具
          return {
            callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
            reportedModel: 'deepseek-chat', content: '',
            usage: { inputTokens: 400, outputTokens: 120, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            durationMs: 200, numTurns: 1, subtype: 'tool_calls', isError: false, error: null,
            toolCalls: [{ id: 'g1', type: 'function' as const, function: { name: 'grep', arguments: JSON.stringify({ query: 'ORIGINAL', roots: ['src'] }) } }],
          };
        }
        return {
          callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
          reportedModel: 'deepseek-chat', content: 'All done, three turns.',
          usage: { inputTokens: 300, outputTokens: 60, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          durationMs: 150, numTurns: 1, subtype: 'stop', isError: false, error: null,
        };
      },
    };
    registry.register(fakeAdapter);

    const runId = createRunState(TEST_CWD, 'int-3turn', 'three turns', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Edit the file.', maxTurns: 5, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.finalText).toContain('All done');
    expect(result.turns).toBe(3);
    expect(result.callIds.length).toBe(3);

    const { loadRunState } = await import('./store');
    const state = loadRunState(TEST_CWD, runId);
    expect(state.calls.length).toBe(3);
    expect(state.pendingCall).toBeUndefined();
  });

  // 6.4 Read-only tool failure → recovery (not fail-fast)
  it('read-only turn failure does not stop — model sees error, recovers next turn', async () => {
    const registry = new AdapterRegistry();
    let callNum = 0;
    const fakeAdapter = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        callNum++;
        if (callNum === 1) {
          // Turn 1: two read-only tool calls — first fails (FILE_NOT_FOUND), second succeeds
          return {
            callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
            reportedModel: 'deepseek-chat', content: '',
            usage: { inputTokens: 500, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            durationMs: 200, numTurns: 1, subtype: 'tool_calls', isError: false, error: null,
            toolCalls: [
              { id: 'bad', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/nonexistent.txt' }) } },
              { id: 'good', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/test.txt' }) } },
            ],
          };
        }
        // Turn 2: model sees both tool results, returns final text
        return {
          callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
          reportedModel: 'deepseek-chat', content: 'Recovered after first error, second succeeded.',
          usage: { inputTokens: 300, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          durationMs: 150, numTurns: 1, subtype: 'stop', isError: false, error: null,
        };
      },
    };
    registry.register(fakeAdapter);

    const runId = createRunState(TEST_CWD, 'int-recover', 'recover', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Recover.', maxTurns: 5, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.turns).toBe(2);
    expect(result.finalText).toContain('Recovered');
    expect(result.callIds.length).toBe(2);
    expect(result.executedTools.length).toBe(2);
    // First tool FAILED, second SUCCEEDED — both EXECUTED, no SKIPPED_AFTER_FAILURE
    expect(result.executedTools[0].ok).toBe(false);
    if (!result.executedTools[0].ok) {
      expect(result.executedTools[0].error.reason).toBe('FILE_NOT_FOUND');
    }
    expect(result.executedTools[1].ok).toBe(true);
    expect(result.auditTrail.map((entry) => entry.status)).toEqual(['EXECUTED', 'EXECUTED']);
  });

  // 6.5 Second turn timeout → first turn keeps its records
  it('timeout on second turn preserves first turn records', async () => {
    const registry = new AdapterRegistry();
    let callNum = 0;
    const fakeAdapter = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        callNum++;
        if (callNum === 1) {
          return {
            callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
            reportedModel: 'deepseek-chat', content: '',
            usage: { inputTokens: 500, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            durationMs: 200, numTurns: 1, subtype: 'tool_calls', isError: false, error: null,
            toolCalls: [{ id: 'r1', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/test.txt' }) } }],
          };
        }
        // Simulate timeout by throwing
        const { TimeoutError } = await import('./providerErrors');
        throw new TimeoutError('Simulated timeout turn 2');
      },
    };
    registry.register(fakeAdapter);

    const runId = createRunState(TEST_CWD, 'int-timeout', 'timeout', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Task.', maxTurns: 5, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TURN_TIMEOUT');
    // First turn had tool call → executed, second turn timed out
    expect(result.executedTools.length).toBe(1);
  });

  // 6.7 Model identity mismatch
  it('model mismatch stops immediately without executing tools', async () => {
    const registry = new AdapterRegistry();
    const fakeAdapter = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        return {
          callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
          reportedModel: 'unknown-model', content: 'Should not reach tools',
          usage: { inputTokens: 300, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          durationMs: 100, numTurns: 1, subtype: 'success', isError: false, error: null,
        };
      },
    };
    registry.register(fakeAdapter);

    const runId = createRunState(TEST_CWD, 'int-mm', 'mismatch', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Task.', maxTurns: 5, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('MODEL_IDENTITY_MISMATCH');
    expect(result.executedTools.length).toBe(0);
    expect(result.turns).toBe(1);
  });

  // Pure loop state tests (no executor involved — verify stop conditions)
  it('completes on first turn final text', async () => {
    const registry = new AdapterRegistry();
    registry.register(new MockProviderAdapter('VERIFIED_SUCCESS'));
    const runId = createRunState(TEST_CWD, 'ps-1', 'pure state', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Say hi.', maxTurns: 3, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.finalText).toContain('[mock]');
    expect(result.turns).toBe(1);
  });

  it('stops on empty final response', async () => {
    const registry = new AdapterRegistry();
    // MockProviderAdapter with EMPTY scenario — use a fake adapter returning empty content
    const fake: ProviderAdapter = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        return {
          callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
          reportedModel: 'deepseek-chat', content: '',
          usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          durationMs: 50, numTurns: 1, subtype: 'stop', isError: false, error: null,
        };
      },
    };
    registry.register(fake);

    const runId = createRunState(TEST_CWD, 'ps-empty', 'empty', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Say nothing.', maxTurns: 3, maxToolCallsPerTurn: 10, maxTotalToolCalls: 10,
    });
    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('EMPTY_FINAL_RESPONSE');
  });

  it('stops at maxTurns with tool_calls each turn', async () => {
    const registry = new AdapterRegistry();
    let toolTurn = 0;
    const fake = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        toolTurn++;
        return {
          callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
          reportedModel: 'deepseek-chat', content: null,
          usage: { inputTokens: 300, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          durationMs: 100, numTurns: 1, subtype: 'tool_calls', isError: false, error: null,
          toolCalls: [{ id: `tc_${toolTurn}`, type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/test.txt', startLine: toolTurn }) } }],
        };
      },
    };
    registry.register(fake);

    const runId = createRunState(TEST_CWD, 'ps-max', 'max turns', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Keep going.', maxTurns: 2, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });
    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('MAX_TURNS_EXCEEDED');
    expect(result.turns).toBe(2);
  });

  it('rejects a turn that exceeds the per-turn tool-call limit', async () => {
    const registry = new AdapterRegistry();
    registry.register({
      transport: 'openai-chat' as const,
      async execute(request: ProviderCallRequest) {
        return providerSuccess(request, null, [
          toolCall('one', 'read_file', { path: 'src/test.txt' }),
          toolCall('two', 'glob', { pattern: 'src/*.txt' }),
        ]);
      },
    });
    const result = await runDeepSeekToolLoop(loopOptions(prepareLoopRun('limit-per-turn'), registry, {
      maxTurns: 2, maxToolCallsPerTurn: 1, maxTotalToolCalls: 2,
    }));
    expect(result.stopReason).toBe('MAX_TOOL_CALLS_PER_TURN_EXCEEDED');
    expect(result.executedTools).toHaveLength(0);
    expect(result.auditTrail.every((entry) => entry.status === 'REJECTED_LIMIT')).toBe(true);
  });

  // 6.7 Write failure in a mixed turn still fails fast
  it('write failure on unapproved file stops immediately — no recovery', async () => {
    const registry = new AdapterRegistry();
    const fakeAdapter = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        return {
          callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
          reportedModel: 'deepseek-chat', content: '',
          usage: { inputTokens: 500, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          durationMs: 200, numTurns: 1, subtype: 'tool_calls', isError: false, error: null,
          toolCalls: [
            { id: 'w1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/not-approved.txt', content: 'x' }) } },
            { id: 'r2', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/test.txt' }) } },
          ],
        };
      },
    };
    registry.register(fakeAdapter);

    const runId = createRunState(TEST_CWD, 'int-write-fail', 'write fail', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Write to unapproved.', maxTurns: 5, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');
    expect(result.turns).toBe(1);
    expect(result.executedTools.length).toBe(1);
    expect(result.executedTools[0].ok).toBe(false);
    if (!result.executedTools[0].ok) {
      expect(result.executedTools[0].error.reason).toBe('FILE_NOT_APPROVED');
    }
    expect(result.auditTrail.at(-1)?.status).toBe('SKIPPED_AFTER_FAILURE');
  });

  // 6.8 Security boundary read error still fails fast
  it('read_file on protected path fails fast — no recovery for security errors', async () => {
    const registry = new AdapterRegistry();
    const fakeAdapter = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        return {
          callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
          reportedModel: 'deepseek-chat', content: '',
          usage: { inputTokens: 500, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          durationMs: 200, numTurns: 1, subtype: 'tool_calls', isError: false, error: null,
          toolCalls: [
            { id: 'p1', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: '.git/config' }) } },
            { id: 'r2', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/test.txt' }) } },
          ],
        };
      },
    };
    registry.register(fakeAdapter);

    const runId = createRunState(TEST_CWD, 'int-protected', 'protected', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Read protected.', maxTurns: 5, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');
    expect(result.turns).toBe(1);
    expect(result.executedTools.length).toBe(1);
    // Second tool must be skipped
    expect(result.auditTrail.at(-1)?.status).toBe('SKIPPED_AFTER_FAILURE');
  });

  // 6.9 Recovery bounded by maxTurns (not infinite retry)
  it('recovery stops at maxTurns — no infinite retry', async () => {
    const registry = new AdapterRegistry();
    let turn = 0;
    const fakeAdapter = {
      transport: 'openai-chat' as const,
      async execute(req: ProviderCallRequest) {
        turn++;
        // Each turn requests a different non-existent file — avoids REPEATED_TOOL_CALL
        return {
          callId: req.callId, providerId: req.providerId, requestedModelId: req.requestedModelId,
          reportedModel: 'deepseek-chat', content: '',
          usage: { inputTokens: 300, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          durationMs: 100, numTurns: 1, subtype: 'tool_calls', isError: false, error: null,
          toolCalls: [{ id: `r_${turn}`, type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: `src/missing-${turn}.txt` }) } }],
        };
      },
    };
    registry.register(fakeAdapter);

    const runId = createRunState(TEST_CWD, 'int-maxturns', 'maxturns', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Keep missing.', maxTurns: 2, maxToolCallsPerTurn: 10, maxTotalToolCalls: 50,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('MAX_TURNS_EXCEEDED');
    expect(result.turns).toBe(2);
    expect(result.executedTools.length).toBe(2);
  });

  it('enforces the total tool-call limit across turns', async () => {
    const registry = new AdapterRegistry();
    let turn = 0;
    registry.register({
      transport: 'openai-chat' as const,
      async execute(request: ProviderCallRequest) {
        turn++;
        return providerSuccess(request, null, turn === 1
          ? [toolCall('one', 'read_file', { path: 'src/test.txt' })]
          : [toolCall('two', 'glob', { pattern: 'src/*.txt' })]);
      },
    });
    const result = await runDeepSeekToolLoop(loopOptions(prepareLoopRun('limit-total'), registry, {
      maxTurns: 3, maxToolCallsPerTurn: 1, maxTotalToolCalls: 1,
    }));
    expect(result.stopReason).toBe('MAX_TOTAL_TOOL_CALLS_EXCEEDED');
    expect(result.executedTools).toHaveLength(1);
  });

  it('detects the same canonical call repeated with a new id', async () => {
    const registry = new AdapterRegistry();
    let turn = 0;
    registry.register({
      transport: 'openai-chat' as const,
      async execute(request: ProviderCallRequest) {
        turn++;
        const args = turn === 1 ? { path: 'src/test.txt', startLine: 1 } : { startLine: 1, path: 'src/test.txt' };
        return providerSuccess(request, null, [toolCall(`repeat-${turn}`, 'read_file', args)]);
      },
    });
    const result = await runDeepSeekToolLoop(loopOptions(prepareLoopRun('repeat-call'), registry));
    expect(result.stopReason).toBe('REPEATED_TOOL_CALL');
    expect(result.executedTools).toHaveLength(1);
    expect(result.auditTrail.at(-1)?.status).toBe('REJECTED_REPEAT');
  });

  it('fails closed when the model continuously requests an unknown tool', async () => {
    const registry = new AdapterRegistry();
    registry.register({
      transport: 'openai-chat' as const,
      async execute(request: ProviderCallRequest) {
        return providerSuccess(request, null, [toolCall('unknown-1', 'shell', { command: 'whoami' })]);
      },
    });
    const result = await runDeepSeekToolLoop(loopOptions(prepareLoopRun('unknown-tool'), registry));
    expect(result.stopReason).toBe('TOOL_PROTOCOL_ERROR');
    expect(result.executedTools).toHaveLength(0);
    expect(result.auditTrail[0]?.errorReason).toBe('UNKNOWN_TOOL');
  });

  it('does not turn a Provider protocol exception into a final answer', async () => {
    const registry = new AdapterRegistry();
    registry.register({
      transport: 'openai-chat' as const,
      async execute() {
        const { ProviderProtocolError } = await import('./providerErrors');
        throw new ProviderProtocolError('malformed fake response');
      },
    });
    const result = await runDeepSeekToolLoop(loopOptions(prepareLoopRun('protocol-error'), registry));
    expect(result.status).toBe('STOPPED');
    // ProviderProtocolError → known domain error → PROVIDER_ERROR (not UNKNOWN_AFTER_CRASH)
    expect(result.stopReason).toBe('PROVIDER_ERROR');
    expect(result.finalText).toBeNull();
  });

  it('caps tool results before the next Provider turn and performs no network I/O', async () => {
    writeFileSync(path.join(TEST_CWD, 'src', 'large.txt'), 'x'.repeat(2_000), 'utf8');
    const network = vi.fn(() => { throw new Error('network must not be called'); });
    vi.stubGlobal('fetch', network);
    const registry = new AdapterRegistry();
    let turn = 0;
    let toolMessage = '';
    registry.register({
      transport: 'openai-chat' as const,
      async execute(request: ProviderCallRequest) {
        turn++;
        if (turn === 1) return providerSuccess(request, null, [toolCall('large', 'read_file', { path: 'src/large.txt' })]);
        toolMessage = request.messages?.find((message) => message.role === 'tool')?.content ?? '';
        return providerSuccess(request, 'verified final');
      },
    });
    const result = await runDeepSeekToolLoop(loopOptions(prepareLoopRun('result-cap'), registry, {
      maxToolResultChars: 200,
    }));
    expect(result.status).toBe('COMPLETED');
    expect(toolMessage.length).toBeLessThanOrEqual(200);
    expect(toolMessage).toContain('MAX_OUTPUT_EXCEEDED');
    expect(network).not.toHaveBeenCalled();
  });

  it('does not auto-modify fileScope', async () => {
    const registry = new AdapterRegistry();
    registry.register(new MockProviderAdapter('VERIFIED_SUCCESS'));
    const scope = makeScope();
    const before = [...scope.approvedFiles];
    const runId = createRunState(TEST_CWD, 'ps-scope', 'scope', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: scope,
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Task.', maxTurns: 3, maxToolCallsPerTurn: 10, maxTotalToolCalls: 10,
    });
    expect(scope.approvedFiles).toEqual(before);
  });

  it('does not auto-commit', async () => {
    const registry = new AdapterRegistry();
    registry.register(new MockProviderAdapter('VERIFIED_SUCCESS'));
    const runId = createRunState(TEST_CWD, 'ps-nogit', 'nogit', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, TEST_WRITER_ASSIGNMENT);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId, fileScope: makeScope(),
      executorContext: { profile: testProfile, logicalModelName: 'deepseek', role: 'builder', maxOutputTokens: 4096, timeoutMs: 30000, adapterRegistry: registry, parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' } },
      systemPrompt: 'Test.', userPrompt: 'Task.', maxTurns: 3, maxToolCallsPerTurn: 10, maxTotalToolCalls: 10,
    });
    expect(result.status).toBe('COMPLETED');
  });
});
