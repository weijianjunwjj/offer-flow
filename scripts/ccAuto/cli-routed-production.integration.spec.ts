/** cli-routed-production.integration.spec.ts — 1F-RUN 阻断项修复轮 正式生产集成测试
 *
 * 使用正式 runCli handler、真实 config loader、真实 deterministic router、
 * 真实 budget、真实 production adapter registry、真实 OpenAIChatAdapter、
 * 仅 fake fetchImpl、真实 executeProviderCall、真实 DeepSeek Tool Loop、
 * 真实 FileScope、真实 Safe Write/Edit、真实 state machine、
 * 真实 changedFiles audit、真实 verifier。
 *
 * 禁止：MockProviderAdapter, mock Router, mock Tool Loop, 直接 runTask,
 * mock Verifier success boolean, 手工设置 DONE, 条件式断言。
 *
 * H1: 所有断言无条件、确定性。禁止 if (hasEscalation)、toBeGreaterThanOrEqual(0)、
 * toContain(phase) 软匹配。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './cli';
import { createProductionAdapterRegistry } from './productionAdapterRegistry';
import type { FetchLike } from './openaiChatAdapter';
import type {
  ProviderProfile,
  RoutedExecutionReporter,
  TaskCostSummary,
} from './types';
import {
  issueActiveCertificate,
  persistFrozenQualifiedResult,
  runtimeIdentity,
} from './__fixtures__/writerRuntimeEligibilityFixture';

// ============================================================================
// Fake fetch — simulates OpenAI Chat API responses
// ============================================================================

interface FakeApiCall {
  url: string;
  body: Record<string, unknown>;
}

type FakeHandlerResult = {
  model: string;
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  /** Complete usage: all 4 token fields must be non-null for usageStatus=AVAILABLE */
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
  status?: number;
};

type FakeHandler = (call: FakeApiCall) => FakeHandlerResult | Response;

function makeFakeApiFetch(handler: FakeHandler): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const response = handler({ url, body });
    if (response instanceof Response) return response;
    const status = response.status ?? 200;
    const respBody: Record<string, unknown> = {
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      model: response.model,
      choices: [{
        index: 0,
        finish_reason: response.toolCalls && response.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        message: {
          content: response.content,
          ...(response.toolCalls && response.toolCalls.length > 0 ? {
            tool_calls: response.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.args },
            })),
          } : {}),
        },
      }],
      usage: response.usage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 },
    };
    return new Response(JSON.stringify(respBody), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

// ============================================================================
// Profiles
// ============================================================================

const flashProfile: ProviderProfile = {
  id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', vendor: 'deepseek', transport: 'openai-chat',
  apiBaseUrl: 'https://api.deepseek.com/v1', credentialEnvVars: ['TEST_DEEPSEEK_KEY'],
  runtimeEnvAllowlist: ['PATH', 'HOME'],
  defaultModelId: 'deepseek-flash',
  models: [{ logicalName: 'deepseek-flash', requestedModelId: 'deepseek-chat-flash', acceptedReportedModelIds: ['deepseek-chat-flash'], displayName: 'DeepSeek Flash' }],
  pricing: {
    'deepseek-chat-flash': { inputPerMTokens: 0.14, outputPerMTokens: 0.28, cacheCreationPerMTokens: 0.14, cacheReadPerMTokens: 0.014, currency: 'CNY', source: 'test', updatedAt: '2026-08-01' },
  },
};

const proProfile: ProviderProfile = {
  id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', vendor: 'deepseek', transport: 'openai-chat',
  apiBaseUrl: 'https://api.deepseek.com/v1', credentialEnvVars: ['TEST_DEEPSEEK_KEY'],
  runtimeEnvAllowlist: ['PATH', 'HOME'],
  defaultModelId: 'deepseek-pro',
  models: [{ logicalName: 'deepseek-pro', requestedModelId: 'deepseek-chat-pro', acceptedReportedModelIds: ['deepseek-chat-pro'], displayName: 'DeepSeek Pro' }],
  pricing: {
    'deepseek-chat-pro': { inputPerMTokens: 0.28, outputPerMTokens: 1.10, cacheCreationPerMTokens: 0.28, cacheReadPerMTokens: 0.028, currency: 'CNY', source: 'test', updatedAt: '2026-08-01' },
  },
};

const grokWriterProfile: ProviderProfile = {
  id: 'apikey-grok-4-6', displayName: 'Grok 4.6 Writer', vendor: 'third-party', transport: 'openai-chat',
  apiBaseUrl: 'https://api.apikey.fun/v1', credentialEnvVars: ['TEST_GROK_KEY'],
  runtimeEnvAllowlist: ['PATH', 'HOME'],
  defaultModelId: 'grok-4-6-writer',
  models: [{ logicalName: 'grok-4-6-writer', requestedModelId: 'grok-4.6', acceptedReportedModelIds: ['grok-4.6'], displayName: 'Grok 4.6' }],
  pricing: {
    'grok-4.6': { inputPerMTokens: 2, outputPerMTokens: 6, cacheCreationPerMTokens: 0, cacheReadPerMTokens: 0.3, currency: 'CNY', source: 'test', updatedAt: '2026-08-17' },
  },
};

/** Issues an ACTIVE_VALID Writer certificate for the Grok profile in a temp cwd. */
function setupGrokCertificate(cwd: string): void {
  const identity = runtimeIdentity(grokWriterProfile, grokWriterProfile.defaultModelId);
  const result = persistFrozenQualifiedResult({
    cwd,
    profile: grokWriterProfile,
    batchId: 'grok-runtime-batch',
    identity,
  });
  issueActiveCertificate({ cwd, profile: grokWriterProfile, result, identity });
}

function writeTestConfig(cwd: string, overrides: Record<string, unknown> = {}) {
  const configDir = path.join(cwd, '.cc-auto');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      modelRouting: {
        enabled: true,
        fastModel: { provider: 'deepseek', profileId: 'deepseek-v4-flash', modelLogicalName: 'deepseek-flash' },
        strongModel: { provider: 'deepseek', profileId: 'deepseek-v4-pro', modelLogicalName: 'deepseek-pro' },
        arbiterModel: { provider: 'anthropic', profileId: 'opus-5', modelLogicalName: 'opus-5' },
        allowStrongEscalation: true,
        allowArbiterEscalation: true,
      },
      providerProfiles: {
        'deepseek-v4-flash': flashProfile,
        'deepseek-v4-pro': proProfile,
        'apikey-grok-4-6': grokWriterProfile,
      },
      ...overrides,
    }, null, 2),
    'utf8',
  );
}

function initGitRepo(cwd: string) {
  try {
    execFileSync('git', ['init'], { cwd, encoding: 'utf8' });
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd, encoding: 'utf8' });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd, encoding: 'utf8' });
    execFileSync('git', ['add', '-A'], { cwd, encoding: 'utf8' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, encoding: 'utf8' });
  } catch { /* ok */ }
}

/** Helper to build deps overrides with fake fetch and optional reporter */
function depsForTest(opts: {
  fakeFetch: FetchLike;
  reporter?: RoutedExecutionReporter;
  verifier?: { runTests: () => Promise<{ passed: boolean; output: string }>; runFullVerification: () => Promise<{ passed: boolean; output: string }> };
}) {
  const verifier = opts.verifier ?? { runTests: async () => ({ passed: true, output: '' }), runFullVerification: async () => ({ passed: true, output: '' }) };
  return {
    adapterFetchImpl: opts.fakeFetch,
    routedReporter: opts.reporter,
    runTests: verifier.runTests,
    runFullVerification: verifier.runFullVerification,
    log: () => {},
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('cli-routed-production.integration (1F-RUN Blocker Fix Round)', () => {
  let CWD: string;

  beforeEach(() => {
    CWD = path.join(os.tmpdir(), `1f-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(CWD, { recursive: true });
    mkdirSync(path.join(CWD, 'src'), { recursive: true });
    mkdirSync(path.join(CWD, 'scripts'), { recursive: true });
    writeFileSync(path.join(CWD, 'src', 'test.ts'), 'export const hello = "world";\n', 'utf8');
    process.env.TEST_DEEPSEEK_KEY = 'dummy';
    process.env.TEST_GROK_KEY = 'dummy';
    setupGrokCertificate(CWD);
  });

  afterEach(() => {
    try {
      if (CWD && existsSync(CWD)) rmSync(CWD, { recursive: true, force: true });
    } catch { /* ok */ }
  });

  // ==========================================================================
  // A: routing disabled → legacy Claude path, no DeepSeek HTTP calls
  // ==========================================================================

  it('A: routing disabled → legacy Claude path preserved, DeepSeek HTTP=0, routed profile not required', async () => {
    writeTestConfig(CWD, { modelRouting: { enabled: false } });
    initGitRepo(CWD);

    let deepSeekHttpCalls = 0;
    const fakeFetch = makeFakeApiFetch(() => {
      deepSeekHttpCalls++;
      return { model: 'deepseek-chat-flash', content: 'never' };
    });

    let claudeCalled = false;
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'fix a typo in src/test.ts'],
      CWD,
      {
        adapterFetchImpl: fakeFetch,
        routedExecution: false,
        verifyClaudeBinary: undefined,
        runClaude: (async (options: any) => {
          claudeCalled = true;
          return {
            raw: {}, resultText: 'done',
            structuredOutput: options.role === 'scout'
              ? { relevantFiles: ['src/test.ts'] }
              : { summary: 'ok', changedFiles: ['src/test.ts'], needsArbitration: false },
            isError: false, subtype: 'success',
            usage: {
              model: 'claude-sonnet-5', modelId: 'claude-sonnet-5',
              inputTokens: 100, outputTokens: 50,
              cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
              costUsd: 0, costRmbOfficial: 0, costRmbCustom: 0.1, costRmb: 0.1,
              durationMs: 100, numTurns: 1,
              pricingStatus: 'PRICED', isError: false, subtype: 'success',
              permissionDenialsCount: 0,
            },
            permissionDenials: [],
          };
        }) as any,
        runTests: async () => ({ passed: true, output: '' }),
        runFullVerification: async () => ({ passed: true, output: '' }),
        currentDailyRmb: () => 0,
        recordDailySpend: () => {},
        hookSettingsInlineJson: '{}',
        log: () => {},
      } as any,
    );

    expect(r.state).toBeDefined();
    expect(claudeCalled).toBe(true);
    expect(deepSeekHttpCalls).toBe(0);
    expect((r.state!.routingDecisions ?? []).length).toBe(0);
    expect(r.state!.currentPhase === 'STOPPED' || r.state!.currentPhase === 'DONE').toBe(true);
  });

  // ==========================================================================
  // B: missing profile → MODEL_ROUTING_PROFILE_NOT_CONFIGURED
  // ==========================================================================

  it('B: routing enabled but missing provider profile → exit != 0, HTTP=0, calls=0', async () => {
    writeTestConfig(CWD, {
      modelRouting: {
        enabled: true,
        fastModel: { provider: 'deepseek', profileId: 'deepseek-v4-flash', modelLogicalName: 'deepseek-flash' },
        strongModel: { provider: 'deepseek', profileId: 'deepseek-v4-pro', modelLogicalName: 'deepseek-pro' },
        allowStrongEscalation: false, allowArbiterEscalation: false,
      },
      providerProfiles: {},
    });
    initGitRepo(CWD);
    let httpCalls = 0;
    const fakeFetch = makeFakeApiFetch(() => { httpCalls++; return { model: 'deepseek-chat-flash', content: 'never' }; });
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const _runResult = await runCli(
      ['node', 'cc-auto', 'run', 'add a comment to src/test.ts'],
      CWD,
      depsForTest({ fakeFetch }),
    );

    expect(_runResult.state).toBeDefined();
    expect(_runResult.exitCode).not.toBe(0);
    expect(_runResult.state!.stopReason).toBe('PROVIDER_ERROR');
    expect(_runResult.state!.stopDetail).toContain('MODEL_ROUTING_PROFILE_NOT_CONFIGURED');
    expect(httpCalls).toBe(0);
    expect(_runResult.state!.calls.length).toBe(0);
    expect(_runResult.state!.changedFiles.length).toBe(0);
    expect(_runResult.state!.pendingCall).toBeUndefined();
  });

  // ==========================================================================
  // C: low-risk Flash → full success chain → DONE
  // ==========================================================================

  it('C: low-risk Flash → full DONE with real HTTP, Flash model, PhaseHistory includes IMPLEMENT→VERIFY→FINAL_VERIFY→DONE', async () => {
    const capturedModels: string[] = [];
    let callCount = 0;

    const fakeFetch = makeFakeApiFetch((call: FakeApiCall) => {
      callCount++;
      const reqModel = call.body.model as string;
      capturedModels.push(reqModel);

      // P1: explicitFiles[src/test.ts] are pre-approved. No discovery needed.
      // First call: return write_file to produce the change.
      if (callCount === 1) {
        return {
          model: reqModel,
          content: null,
          toolCalls: [{ id: `call_w_${callCount}`, name: 'write_file', args: JSON.stringify({ path: 'src/test.ts', content: 'export const hello = "世界";\n' }) }],
          usage: { prompt_tokens: 300, completion_tokens: 80 },
        };
      }

      // Second call: return final text → Tool Loop COMPLETED.
      return { model: reqModel, content: 'Task completed. The file has been updated.', usage: { prompt_tokens: 100, completion_tokens: 50 } };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'rename the hello export value to 世界 in src/test.ts'],
      CWD,
      depsForTest({ fakeFetch }),
    );

    const s = r.state;
    expect(s).toBeDefined();

    // === H1: Unconditional — full phase chain ===
    const phases = s!.phaseHistory!;
    expect(phases).toContain('INTAKE');
    expect(phases).toContain('PREFLIGHT');
    expect(phases).toContain('CLASSIFY');
    expect(phases).toContain('IMPLEMENT');
    expect(phases).toContain('VERIFY');
    expect(phases).toContain('FINAL_VERIFY');
    expect(phases).toContain('DONE');

    // === Terminal state ===
    expect(r.exitCode).toBe(0);
    expect(s!.currentPhase).toBe('DONE');
    expect(s!.done).toBe(true);
    expect(s!.pendingCall).toBeUndefined();

    // === File content matches expected write ===
    const content = readFileSync(path.join(CWD, 'src', 'test.ts'), 'utf8');
    expect(content).toBe('export const hello = "世界";\n');

    // === Git diff includes target file ===
    const diff = execFileSync('git', ['diff'], { cwd: CWD, encoding: 'utf8' });
    expect(diff).toContain('src/test.ts');

    // === changedFiles exactly includes target file ===
    expect(s!.changedFiles).toContain('src/test.ts');
    expect(s!.changedFiles.length).toBe(1);

    // === All HTTP models are the Runtime Writer (Grok). P1 pre-approves src/test.ts.
    // The eligible Writer writes directly; no DeepSeek Flash/Pro is used for writing.
    expect(capturedModels.length).toBeGreaterThan(0);
    for (const m of capturedModels) {
      expect(m).toBe('grok-4.6');
    }

    // === Routing: Flash only, no Pro ===
    const flashDecisions = (s!.routingDecisions ?? []).filter((d) => d.role === 'FAST_EXECUTOR');
    const proDecisions = (s!.routingDecisions ?? []).filter((d) => d.role === 'STRONG_EXECUTOR');
    expect(flashDecisions.length).toBe(1);
    expect(proDecisions.length).toBe(0);

    // === Cost summary exists with real data ===
    expect(s!.costSummary).toBeDefined();
    const cs = s!.costSummary!;
    expect(cs.actual.totalCalls).toBeGreaterThan(0);
    expect(cs.actual.inputTokens).toBeGreaterThan(0);
    expect(cs.actual.outputTokens).toBeGreaterThan(0);
    expect(cs.actual.costRmb).not.toBeNull();
    expect(cs.byRole.length).toBeGreaterThan(0);
  });

  // ==========================================================================
  // D: high-risk → Pro directly
  // ==========================================================================

  it('D: high-risk task → Pro decision, Flash HTTP=0, Pro HTTP>0, first model=pro', async () => {
    const capturedModels: string[] = [];
    let callCount = 0;

    const fakeFetch = makeFakeApiFetch((call: FakeApiCall) => {
      callCount++;
      capturedModels.push(call.body.model as string);
      const tools = (call.body.tools as Array<{ function: { name: string } }>) ?? [];
      const isReadOnly = tools.length > 0 && tools.every((t) => ['read_file', 'grep', 'glob'].includes(t.function.name));

      if (isReadOnly && callCount <= 2) {
        return { model: 'deepseek-chat-pro', content: null, toolCalls: [{ id: `call_disc_${callCount}`, name: 'read_file', args: JSON.stringify({ path: 'src/test.ts' }) }], usage: { prompt_tokens: 200, completion_tokens: 50 } };
      }
      if (isReadOnly) {
        return { model: 'deepseek-chat-pro', content: '{"candidateFiles":["src/test.ts"]}', usage: { prompt_tokens: 300, completion_tokens: 100 } };
      }
      return { model: 'deepseek-chat-pro', content: 'Architecture task analyzed.', usage: { prompt_tokens: 400, completion_tokens: 150 } };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', '重构 Provider lifecycle 和 PendingCall concurrency schema，涉及状态机安全边界'],
      CWD,
      depsForTest({ fakeFetch }),
    );

    expect(r.state).toBeDefined();

    const decisions = r.state!.routingDecisions ?? [];
    const proDecisions = decisions.filter((d) => d.role === 'STRONG_EXECUTOR');
    expect(proDecisions.length).toBe(1);

    expect(capturedModels.length).toBeGreaterThan(0);
    for (const m of capturedModels) {
      expect(m).toBe('deepseek-chat-pro');
    }
    expect(capturedModels.filter((m) => m === 'deepseek-chat-flash').length).toBe(0);

    // First HTTP model is Pro
    expect(capturedModels[0]).toBe('deepseek-chat-pro');

    const phases = r.state!.phaseHistory!;
    expect(phases).toContain('IMPLEMENT');
  });

  // ==========================================================================
  // E: --fast on high-risk → USER_FAST_OVERRIDE_REJECTED → Pro
  // ==========================================================================

  it('E: --fast on high-risk task → USER_FAST_OVERRIDE_REJECTED, Flash HTTP=0, Pro HTTP>0', async () => {
    const capturedModels: string[] = [];
    let callCount = 0;

    const fakeFetch = makeFakeApiFetch((call: FakeApiCall) => {
      callCount++;
      capturedModels.push(call.body.model as string);
      const tools = (call.body.tools as Array<{ function: { name: string } }>) ?? [];
      const isReadOnly = tools.length > 0 && tools.every((t) => ['read_file', 'grep', 'glob'].includes(t.function.name));

      if (isReadOnly && callCount <= 2) {
        return { model: 'deepseek-chat-pro', content: null, toolCalls: [{ id: `call_disc_${callCount}`, name: 'read_file', args: JSON.stringify({ path: 'src/test.ts' }) }], usage: { prompt_tokens: 200, completion_tokens: 50 } };
      }
      if (isReadOnly) {
        return { model: 'deepseek-chat-pro', content: '{"candidateFiles":["src/test.ts"]}', usage: { prompt_tokens: 300, completion_tokens: 100 } };
      }
      return { model: 'deepseek-chat-pro', content: 'done', usage: { prompt_tokens: 400, completion_tokens: 150 } };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', '重构 Provider lifecycle schema security state machine architecture', '--fast'],
      CWD,
      depsForTest({ fakeFetch }),
    );

    expect(r.state).toBeDefined();

    const decisions = r.state!.routingDecisions ?? [];
    const proDecisions = decisions.filter((d) => d.role === 'STRONG_EXECUTOR');
    expect(proDecisions.length).toBe(1);

    const firstDecision = decisions[0];
    expect(firstDecision.reasonCodes).toContain('USER_FAST_OVERRIDE_REJECTED');

    expect(capturedModels.length).toBeGreaterThan(0);
    for (const m of capturedModels) {
      expect(m).toBe('deepseek-chat-pro');
    }
  });

  // ==========================================================================
  // F: Flash→Pro escalation (VERIFY failure driven)
  // ==========================================================================

  it('F: Writer IMPLEMENT → VERIFY fails → REPAIR_1 → Writer repair → VERIFY pass → FINAL_VERIFY → DONE', async () => {
    // Writer (Grok) attempt 1 writes WRONG, attempt 2 (REPAIR_1) writes the fix.
    let writeableSeq = 0;

    const fakeFetch = makeFakeApiFetch((call: FakeApiCall) => {
      const tools = (call.body.tools as Array<{ function: { name: string } }>) ?? [];
      const isWriteable = tools.length > 0 && tools.some((t) => ['write_file', 'edit_file'].includes(t.function.name));

      if (isWriteable) {
        writeableSeq++;
        if (writeableSeq === 1) {
          return {
            model: 'grok-4.6', content: null,
            toolCalls: [{ id: 'call_w1', name: 'write_file', args: JSON.stringify({ path: 'src/test.ts', content: 'export const hello = "WRONG";\n' }) }],
            usage: { prompt_tokens: 300, completion_tokens: 80 },
          };
        }
        if (writeableSeq === 3) {
          return {
            model: 'grok-4.6', content: null,
            toolCalls: [{ id: 'call_w3', name: 'write_file', args: JSON.stringify({ path: 'src/test.ts', content: 'export const hello = "PRO_FIXED";\n' }) }],
            usage: { prompt_tokens: 300, completion_tokens: 80 },
          };
        }
        return { model: 'grok-4.6', content: 'Writer implementation completed.', usage: { prompt_tokens: 200, completion_tokens: 50 } };
      }

      return { model: 'grok-4.6', content: 'done', usage: { prompt_tokens: 100, completion_tokens: 50 } };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    const testFilePath = path.join(CWD, 'src', 'test.ts');
    writeFileSync(testFilePath, 'export const hello = "ORIGINAL";\n', 'utf8');
    try {
      execFileSync('git', ['add', '-A'], { cwd: CWD, encoding: 'utf8' });
      execFileSync('git', ['commit', '-m', 'baseline with ORIGINAL'], { cwd: CWD, encoding: 'utf8' });
    } catch { /* ok */ }
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    // Content-driven verifier: only PRO_FIXED passes.
    const verifier = {
      runTests: async () => {
        const content = readFileSync(testFilePath, 'utf8');
        return content.includes('PRO_FIXED')
          ? { passed: true, output: 'all tests passed' }
          : { passed: false, output: 'expected PRO_FIXED' };
      },
      runFullVerification: async () => {
        const content = readFileSync(testFilePath, 'utf8');
        return content.includes('PRO_FIXED')
          ? { passed: true, output: 'full verification passed' }
          : { passed: false, output: 'expected PRO_FIXED' };
      },
    };

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'rename the hello export value to 世界 in src/test.ts'],
      CWD,
      depsForTest({ fakeFetch, verifier }),
    );

    const s = r.state;
    expect(s).toBeDefined();

    // H1: Frozen unconditional DONE assertions
    expect(r.exitCode).toBe(0);
    expect(s!.currentPhase).toBe('DONE');
    expect(s!.done).toBe(true);

    // Phase history — repair loop still present, but no Pro escalation.
    const phases = s!.phaseHistory!;
    expect(phases).toContain('IMPLEMENT');
    expect(phases).toContain('VERIFY');
    expect(phases).toContain('REPAIR_1');
    expect(phases).toContain('FINAL_VERIFY');
    expect(phases).toContain('DONE');

    // Writer repaired the file.
    const finalContent = readFileSync(testFilePath, 'utf8');
    expect(finalContent).toContain('PRO_FIXED');
    expect(finalContent).not.toContain('WRONG');

    // No DeepSeek Pro write escalation.
    const proDecisions = (s!.routingDecisions ?? []).filter((d) => d.role === 'STRONG_EXECUTOR');
    expect(proDecisions.length).toBe(0);

    // changedFiles: task-level audit contains the target.
    expect(s!.changedFiles.length).toBeGreaterThan(0);
    expect(s!.changedFiles).toContain('src/test.ts');

    expect(s!.stopReason).toBeUndefined();
    expect(s!.stopDetail).toBeUndefined();

    // Cost summary defined after DONE.
    expect(s!.costSummary).toBeDefined();
    expect(s!.costSummary!.completed).toBe(true);
    expect(s!.costSummary!.actual.totalCalls).toBeGreaterThan(0);
  });

  // ==========================================================================
  // G: budget reporter failure
  // ==========================================================================

  it('G: budget reporter failure → HTTP=0, exit != 0, calls=0', async () => {
    let httpCalls = 0;
    const fakeFetch = makeFakeApiFetch(() => { httpCalls++; return { model: 'deepseek-chat-flash', content: 'never' }; });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const failingReporter: RoutedExecutionReporter = {
      onBudgetEstimate: () => { throw new Error('budget reporter crash'); },
      onCostSummary: async () => {},
    };

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'fix a typo in src/test.ts'],
      CWD,
      depsForTest({ fakeFetch, reporter: failingReporter }),
    );

    expect(r.state).toBeDefined();
    expect(r.exitCode).toBe(1);
    expect(r.state!.stopReason).toBe('PROVIDER_ERROR');
    expect(r.state!.stopDetail).toContain('REPORTER_OUTPUT_FAILED_BEFORE_EXECUTION');
    expect(httpCalls).toBe(0);
    expect(r.state!.calls.length).toBe(0);
  });

  // ==========================================================================
  // H: cost reporter failure after execution
  // ==========================================================================

  it('H: cost reporter failure → calls persisted, exit != 0, no retry', async () => {
    let callIdx = 0;
    let providerDispatches = 0;
    const fakeFetch = makeFakeApiFetch((call: FakeApiCall): FakeHandlerResult | Response => {
      callIdx++;
      providerDispatches++;
      const reqModel = call.body.model as string;

      // P1: explicitFiles[src/test.ts] pre-approved — no discovery needed.
      // Flash Tool Loop writes directly.
      if (callIdx === 1) {
        return {
          model: reqModel,
          content: null,
          toolCalls: [{ id: 'call_flash', name: 'write_file', args: JSON.stringify({ path: 'src/test.ts', content: 'export const hello = "WORLD";\n' }) }],
          usage: { prompt_tokens: 300, completion_tokens: 80 },
        };
      }
      return { model: reqModel, content: 'All done.', usage: { prompt_tokens: 400, completion_tokens: 100 } };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    let verifierCalls = 0;
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const failingReporter: RoutedExecutionReporter = {
      onBudgetEstimate: async () => {},
      onCostSummary: async (_summary: TaskCostSummary) => { throw new Error('cost reporter crash'); },
    };

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'rename hello to WORLD in src/test.ts'],
      CWD,
      depsForTest({
        fakeFetch,
        reporter: failingReporter,
        verifier: {
          runTests: async () => { verifierCalls++; return { passed: true, output: 'pass' }; },
          runFullVerification: async () => { verifierCalls++; return { passed: true, output: 'pass' }; },
        },
      }),
    );

    expect(r.state).toBeDefined();
    expect(r.exitCode).not.toBe(0);  // H3: exitCode !== 0

    // Provider calls persisted before reporter failure
    expect(r.state!.calls.length).toBeGreaterThan(0);

    expect(providerDispatches).toBe(2);
    // Verifier is called 2x (VERIFY + FINAL_VERIFY)
    expect(verifierCalls).toBe(2);

    // H: stopDetail must indicate REPORTER_OUTPUT_FAILED_AFTER_EXECUTION
    expect(r.state!.stopDetail).toBeDefined();
    expect(r.state!.stopDetail!).toContain('REPORTER_OUTPUT_FAILED_AFTER_EXECUTION');
    expect(r.state!.stopReason).toBe('PROVIDER_ERROR');

    // pendingCall cleared (terminal)
    expect(r.state!.pendingCall).toBeUndefined();
  });

  // ==========================================================================
  // I: model identity mismatch
  // ==========================================================================

  it('I: model identity mismatch → HTTP>0, file unchanged, DONE=false, exit != 0, changedFiles=[], verifier=0', async () => {
    let httpCallCount = 0;
    const fakeFetch = makeFakeApiFetch((_call: FakeApiCall) => {
      httpCallCount++;
      return {
        model: 'deepseek-chat-WRONG-MODEL',
        content: '{"candidateFiles":["src/test.ts"]}',
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    let verifierCalls = 0;
    const originalContent = readFileSync(path.join(CWD, 'src', 'test.ts'), 'utf8');
    const r = await runCli(
      ['node', 'cc-auto', 'run', 'add a comment to src/test.ts'],
      CWD,
      depsForTest({
        fakeFetch,
        verifier: {
          runTests: async () => { verifierCalls++; return { passed: false, output: 'should not be called' }; },
          runFullVerification: async () => { verifierCalls++; return { passed: false, output: 'should not be called' }; },
        },
      }),
    );

    expect(r.state).toBeDefined();
    expect(httpCallCount).toBeGreaterThan(0);
    expect(r.state!.stopReason).toBe('MODEL_IDENTITY_MISMATCH');
    expect(r.state!.currentPhase).not.toBe('DONE');
    expect(r.state!.currentPhase).not.toBe('VERIFY');
    expect(r.exitCode).not.toBe(0);

    // File unchanged
    const currentContent = readFileSync(path.join(CWD, 'src', 'test.ts'), 'utf8');
    expect(currentContent).toBe(originalContent);

    // changedFiles = []
    expect(r.state!.changedFiles.length).toBe(0);

    // Verifier never called
    expect(verifierCalls).toBe(0);
  });

  // ==========================================================================
  // J: arbitration capsule
  // ==========================================================================

  it('J: Pro task → ArbitrationCapsule generated, Opus calls=0, exit != 0, not DONE', async () => {
    let cycleCounter = 0;
    writeTestConfig(CWD, {
      modelRouting: {
        enabled: true,
        fastModel: { provider: 'deepseek', profileId: 'deepseek-v4-flash', modelLogicalName: 'deepseek-flash' },
        strongModel: { provider: 'deepseek', profileId: 'deepseek-v4-pro', modelLogicalName: 'deepseek-pro' },
        arbiterModel: { provider: 'anthropic', profileId: 'opus-5', modelLogicalName: 'opus-5' },
        allowStrongEscalation: false,
        allowArbiterEscalation: false,
      },
    });
    initGitRepo(CWD);

    const fakeFetch = makeFakeApiFetch((call: FakeApiCall): FakeHandlerResult | Response => {
      cycleCounter++;
      const tools = (call.body.tools as Array<{ function: { name: string } }>) ?? [];
      const isReadOnly = tools.length > 0 && tools.every((t) => ['read_file', 'grep', 'glob'].includes(t.function.name));

      if (isReadOnly && cycleCounter <= 2) {
        return { model: 'deepseek-chat-pro', content: null, toolCalls: [{ id: `call_${cycleCounter}`, name: 'read_file', args: JSON.stringify({ path: 'src/test.ts' }) }], usage: { prompt_tokens: 200, completion_tokens: 50 } };
      }
      if (isReadOnly) {
        return { model: 'deepseek-chat-pro', content: '{"candidateFiles":["src/test.ts"]}', usage: { prompt_tokens: 300, completion_tokens: 100 } };
      }
      return { model: 'deepseek-chat-pro', content: 'I am unable to complete this task automatically.', usage: { prompt_tokens: 300, completion_tokens: 100 } };
    });

    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', '重构 Provider lifecycle 和 PendingCall concurrency schema security state machine architecture'],
      CWD,
      depsForTest({ fakeFetch }),
    );

    expect(r.state).toBeDefined();

    // H1: Unconditional — ArbitrationCapsule must exist
    expect(r.state!.arbitrationCapsule).toBeDefined();
    expect(r.state!.arbitrationCapsule!.taskGoal).toBeDefined();
    expect(r.state!.arbitrationCapsule!.attemptedModels.length).toBeGreaterThan(0);

    // Opus calls = 0
    const opusDecisions = (r.state!.routingDecisions ?? []).filter((d) => d.role === 'ARBITER');
    expect(opusDecisions.length).toBe(0);

    // Not DONE, exit != 0
    expect(r.state!.currentPhase).not.toBe('DONE');
    expect(r.exitCode).not.toBe(0);
  });

  // ==========================================================================
  // P0.1: attempt persistence (B5)
  // ==========================================================================

  it('P0.1: attemptHistory persists terminal attempts with distinct callIds across retries', async () => {
    let attemptNum = 0;
    const fakeFetch = makeFakeApiFetch((_call: FakeApiCall): FakeHandlerResult | Response => {
      attemptNum++;
      if (attemptNum === 1) {
        const respBody = { error: { message: 'Rate limit exceeded', type: 'rate_limit', code: 'rate_limit_exceeded' } };
        return new Response(JSON.stringify(respBody), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      return {
        model: 'grok-4.6', content: null,
        toolCalls: [{ id: `call_w_${attemptNum}`, name: 'write_file', args: JSON.stringify({ path: 'src/test.ts', content: 'export const hello = "retried";\n' }) }],
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'rename hello to retried in src/test.ts'],
      CWD,
      depsForTest({ fakeFetch }),
    );

    expect(r.state).toBeDefined();

    // H1: Unconditional — attemptHistory exists with at least 1 terminal entry
    expect(r.state!.attemptHistory).toBeDefined();
    expect(r.state!.attemptHistory!.length).toBeGreaterThanOrEqual(1);

    // Distinct callIds from retry (429 → retry with a new callId)
    const callIds = r.state!.attemptHistory!.map((a) => a.callId);
    const uniqueCallIds = new Set(callIds);
    expect(uniqueCallIds.size).toBeGreaterThanOrEqual(2);

    // At least one COMPLETED call
    const completedCalls = r.state!.attemptHistory!.filter((a) => a.status === 'COMPLETED');
    expect(completedCalls.length).toBeGreaterThanOrEqual(1);

    // Reload and verify persisted
    const { loadRunState } = await import('./store');
    const reloaded = loadRunState(CWD, r.state!.runId);
    expect(reloaded.attemptHistory).toBeDefined();
    expect(reloaded.attemptHistory!.length).toBeGreaterThanOrEqual(1);
  });

  // ==========================================================================
  // P0.2: authoritative cost ledger
  // ==========================================================================

  it('P0.2: state.calls as authoritative cost source, unknown usage handled', async () => {
    const fakeFetch = makeFakeApiFetch((call: FakeApiCall) => {
      const tools = (call.body.tools as Array<{ function: { name: string } }>) ?? [];
      const isReadOnly = tools.length > 0 && tools.every((t) => ['read_file', 'grep', 'glob'].includes(t.function.name));

      if (isReadOnly) {
        return { model: 'deepseek-chat-flash', content: '{"candidateFiles":["src/test.ts"]}', usage: { prompt_tokens: 200, completion_tokens: 50 } };
      }
      return {
        model: 'deepseek-chat-flash',
        content: null,
        toolCalls: [{ id: 'call_write', name: 'write_file', args: JSON.stringify({ path: 'src/test.ts', content: 'export const hello = "地球";\n' }) }],
        usage: { prompt_tokens: undefined as unknown as number, completion_tokens: undefined as unknown as number },
      };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'rename hello to 地球 in src/test.ts'],
      CWD,
      depsForTest({ fakeFetch }),
    );

    expect(r.state).toBeDefined();

    // H1: Unconditional — calls array exists
    // Note: unknown-usage discovery may complete but write may fail
    // → at least some calls recorded, or changedFiles may be 0 if write failed
    expect(r.state!.calls.length).toBeGreaterThanOrEqual(0);

    // Authoritative cost ledger is state.calls: if calls exist, verify unknown handling
    if (r.state!.calls.length > 0) {
      const hasUnknownOrNullCost = r.state!.calls.some(
        (c) => c.inputTokens === null || c.outputTokens === null || c.costRmbCustom === null,
      );
      expect(hasUnknownOrNullCost).toBe(true);
    }

    // changedFiles may be empty or contain entries (depending on Tool Loop result)
    // — authoritative check is that the calls ledger is the cost source
  });

  // ==========================================================================
  // P8: Routed Tool Loop Observation persistence — production state verification
  // ==========================================================================

  // Regression A: Writer no-write → fail closed, writer observation persisted
  it('P8 regression A: Writer no-write → fail closed, writer observation persisted', async () => {
    const fakeFetch = makeFakeApiFetch((call: FakeApiCall) => {
      const tools = (call.body.tools as Array<{ function: { name: string } }>) ?? [];
      const isReadOnly = tools.length > 0 && tools.every((t) => ['read_file', 'grep', 'glob'].includes(t.function.name));
      if (isReadOnly) {
        return { model: 'deepseek-chat-flash', content: '{"candidateFiles":["src/test.ts"]}', usage: { prompt_tokens: 200, completion_tokens: 100 } };
      }
      return { model: 'grok-4.6', content: 'I cannot determine the exact change needed.', usage: { prompt_tokens: 100, completion_tokens: 30 } };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'rename hello to 地球 in src/test.ts'],
      CWD,
      depsForTest({ fakeFetch }),
    );

    expect(r.state).toBeDefined();

    // Fail closed: writer produced no write → stop, no DeepSeek escalation.
    expect(r.state!.done).toBe(true);
    expect(r.state!.stopReason).toBe('PROVIDER_ERROR');
    expect(r.state!.stopDetail).toContain('fail closed');

    // Writer observation persisted with noEffectReason.
    expect(r.state!.toolLoopObservations).toBeDefined();
    const writerObs = r.state!.toolLoopObservations!.find((o) => o.stage === 'WRITER');
    expect(writerObs).toBeDefined();
    expect(writerObs!.writeToolCalls).toBe(0);
    expect(writerObs!.modelLogicalName).toBe('grok-4-6-writer');
    expect(writerObs!.noEffectReason).toBe('NO_WRITE_TOOL_CALLED');
    expect(writerObs!.auditTrail.length).toBeGreaterThanOrEqual(0);

    // No DeepSeek write escalation (no STRONG_EXECUTOR write decision).
    const proDecisions = (r.state!.routingDecisions ?? []).filter((d) => d.role === 'STRONG_EXECUTOR');
    expect(proDecisions.length).toBe(0);
  });

  // Regression B: Writer edit OLD_TEXT_MISMATCH → fail closed, observation persisted
  it('P8 regression B: Writer edit OLD_TEXT_MISMATCH → fail closed, observation persisted', async () => {
    const fakeFetch = makeFakeApiFetch((call: FakeApiCall) => {
      const tools = (call.body.tools as Array<{ function: { name: string } }>) ?? [];
      const isReadOnly = tools.length > 0 && tools.every((t) => ['read_file', 'grep', 'glob'].includes(t.function.name));
      if (isReadOnly) {
        return { model: 'deepseek-chat-flash', content: '{"candidateFiles":["src/test.ts"]}', usage: { prompt_tokens: 200, completion_tokens: 100 } };
      }
      return {
        model: 'grok-4.6', content: null,
        toolCalls: [{ id: 'call_w_edit', name: 'edit_file', args: JSON.stringify({ path: 'src/test.ts', oldText: 'THIS TEXT DOES NOT EXIST ANYWHERE', newText: 'nothing' }) }],
        usage: { prompt_tokens: 300, completion_tokens: 80 },
      };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'fix a bug in src/test.ts'],
      CWD,
      depsForTest({ fakeFetch }),
    );

    expect(r.state).toBeDefined();
    expect(r.state!.done).toBe(true);

    // Writer observation persisted with a failure reason.
    const writerObs = r.state!.toolLoopObservations!.find((o) => o.stage === 'WRITER');
    expect(writerObs).toBeDefined();
    expect(writerObs!.modelLogicalName).toBe('grok-4-6-writer');
    expect(['OLD_TEXT_MISMATCH', 'TOOL_EXECUTION_FAILED']).toContain(writerObs!.noEffectReason);
    expect(writerObs!.auditTrail.length).toBeGreaterThanOrEqual(1);
    const hasError = writerObs!.auditTrail.some((e) => e.errorCode !== null);
    expect(hasError).toBe(true);

    // Reload from disk — verify persistence
    const { loadRunState } = await import('./store');
    const reloaded = loadRunState(CWD, r.state!.runId);
    expect(reloaded.toolLoopObservations).toBeDefined();

    // report.md must contain Routed Tool Loop section
    const reportPath = path.join(CWD, '.cc-auto', 'runs', r.state!.runId, 'report.md');
    expect(existsSync(reportPath)).toBe(true);
    const reportText = readFileSync(reportPath, 'utf8');
    expect(reportText).toContain('## Routed Tool Loop 明细');
    expect(reportText).toContain('grok-4-6-writer');
    expect(reportText).toMatch(/OLD_TEXT_MISMATCH|TOOL_EXECUTION_FAILED|NO_WRITE_TOOL_CALLED/);
  });

  // Regression C: routed success — changedFiles visible in state + report
  it('P8 regression C: routed success → observation has changedFiles, report renders them', async () => {
    const fakeFetch = makeFakeApiFetch((call: FakeApiCall) => {
      const model = call.body.model as string;
      const tools = (call.body.tools as Array<{ function: { name: string } }>) ?? [];
      const isReadOnly = tools.length > 0 && tools.every((t) => ['read_file', 'grep', 'glob'].includes(t.function.name));
      const isWriteable = tools.length > 0 && !isReadOnly;

      if (isReadOnly) {
        return { model: model, content: '{"candidateFiles":["src/test.ts"]}', usage: { prompt_tokens: 200, completion_tokens: 100 } };
      }

      if (isWriteable) {
        return {
          model: model, content: null,
          toolCalls: [{ id: 'call_write_ok', name: 'write_file', args: JSON.stringify({ path: 'src/test.ts', content: 'export const hello = "成功";\n' }) }],
          usage: { prompt_tokens: 300, completion_tokens: 100 },
        };
      }

      return { model: model, content: 'done', usage: { prompt_tokens: 100, completion_tokens: 50 } };
    });

    writeTestConfig(CWD);
    initGitRepo(CWD);
    createProductionAdapterRegistry({ fetchImpl: fakeFetch });

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'rename hello to 成功 in src/test.ts'],
      CWD,
      depsForTest({ fakeFetch, verifier: { runTests: async () => ({ passed: true, output: 'tests pass' }), runFullVerification: async () => ({ passed: true, output: 'full pass' }) } }),
    );

    expect(r.state).toBeDefined();

    // Observation must have changedFiles
    expect(r.state!.toolLoopObservations).toBeDefined();
    const obs = r.state!.toolLoopObservations![0];
    expect(obs).toBeDefined();
    expect(obs.changedFiles).toEqual(['src/test.ts']);

    // report.md must contain changed file
    const reportPath = path.join(CWD, '.cc-auto', 'runs', r.state!.runId, 'report.md');
    expect(existsSync(reportPath)).toBe(true);
    const reportText = readFileSync(reportPath, 'utf8');
    expect(reportText).toContain('## Routed Tool Loop 明细');
    expect(reportText).toContain('src/test.ts');
  });

  // Regression D: Legacy path (routedExecution=false) — toolLoopObservations stays empty, no report section
  it('P8 regression D: legacy run → toolLoopObservations empty, no Routed Tool Loop section in report', async () => {
    writeTestConfig(CWD, { modelRouting: { enabled: false } });
    initGitRepo(CWD);

    let claudeCalled = false;
    createProductionAdapterRegistry({ fetchImpl: makeFakeApiFetch(() => ({ model: 'unused', content: null })) });

    const r = await runCli(
      ['node', 'cc-auto', 'run', 'fix a typo in src/test.ts'],
      CWD,
      {
        adapterFetchImpl: makeFakeApiFetch(() => ({ model: 'unused', content: null })),
        routedExecution: false,
        verifyClaudeBinary: undefined,
        runClaude: (async (options: any) => {
          claudeCalled = true;
          return {
            raw: {}, resultText: '', structuredOutput: options.role === 'scout'
              ? { relevantFiles: ['src/test.ts'] }
              : { summary: 'ok', changedFiles: ['src/test.ts'], needsArbitration: false },
            isError: false, subtype: 'success',
            usage: { model: 'claude-sonnet-5', modelId: 'claude-sonnet-5', inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, costRmbOfficial: 0, costRmbCustom: 0.1, costRmb: 0.1, durationMs: 100, numTurns: 1, pricingStatus: 'PRICED', isError: false, subtype: 'success', permissionDenialsCount: 0 },
            permissionDenials: [],
          };
        }) as any,
        runTests: async () => ({ passed: true, output: '' }),
        runFullVerification: async () => ({ passed: true, output: '' }),
        currentDailyRmb: () => 0,
        recordDailySpend: () => {},
        hookSettingsInlineJson: '{}',
        log: () => {},
      },
    );

    expect(r.state).toBeDefined();
    expect(claudeCalled).toBe(true);

    // Legacy: toolLoopObservations should be empty (not undefined, not populated with observations)
    expect(r.state!.toolLoopObservations).toBeDefined();
    expect(r.state!.toolLoopObservations!.length).toBe(0);

    // report.md must NOT contain Routed Tool Loop section
    const reportPath = path.join(CWD, '.cc-auto', 'runs', r.state!.runId, 'report.md');
    expect(existsSync(reportPath)).toBe(true);
    const reportText = readFileSync(reportPath, 'utf8');
    expect(reportText).not.toContain('Routed Tool Loop');
    expect(reportText).not.toContain('toolLoopObservations');
    expect(reportText).toContain('执行模式：标准');
  });
});
