/** preflight.spec.ts —— 预检骨架集成测试 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runPreflight } from './preflight';
import { mkdirSync, rmSync } from 'node:fs';
import { readRunLease, releaseRunLease } from './runLease';
import { loadRunState } from './store';
import type { CcAutoConfig } from './config';
import path from 'node:path';

const FIXTURE_CWD = path.join(__dirname, '..', '..', '.cc-auto-test-pf');

function makeTestConfig(providerEntries?: Record<string, unknown>): CcAutoConfig {
  return {
    budget: { simpleTaskRmb: 3, normalTaskRmb: 10, complexTaskRmb: 25, absoluteTaskMaxRmb: 30, dailyMaxRmb: 50, opusShareMax: 0.15 },
    limits: { maxRepairCycles: 2, maxOpusCalls: 1, maxHandoffs: 1, maxContextFiles: 12, maxChangedFiles: 15 },
    models: {
      scout: { model: 'x', effort: 'low', maxTurns: 1 },
      builderDefault: { model: 'x', effort: 'medium', maxTurns: 1 },
      builderHighRisk: { model: 'x', effort: 'high', maxTurns: 1 },
      arbiter: { model: 'x', effort: 'high', maxTurns: 1 },
    },
    usdToRmbRate: 7.2,
    pricingMode: 'custom',
    customPricing: { x: { inputPerMTokens: 1, outputPerMTokens: 1, cacheCreationPerMTokens: 1, cacheReadPerMTokens: 1 } },
    providerProfiles: providerEntries,
  };
}

function cleanup() {
  try { rmSync(path.join(FIXTURE_CWD, '.cc-auto'), { recursive: true, force: true }); } catch { /* ok */ }
  // Also clean up any stale lock file
  releaseRunLease(FIXTURE_CWD, 'any');
}

describe('runPreflight', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(FIXTURE_CWD, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  function defaultConfig(): CcAutoConfig {
    return makeTestConfig({
      'deepseek-v4-pro': {
        displayName: 'DeepSeek V4 Pro',
        vendor: 'deepseek',
        transport: 'openai-chat',
        apiBaseUrl: 'https://api.deepseek.com/v1',
        credentialEnvVars: ['DEEPSEEK_API_KEY'],
        runtimeEnvAllowlist: ['PATH', 'HOME'],
        defaultModelId: 'deepseek',
        models: [
          {
            logicalName: 'deepseek',
            requestedModelId: 'deepseek-chat',
            acceptedReportedModelIds: ['deepseek-chat'],
            displayName: 'DeepSeek Chat',
          },
        ],
        pricing: {
          'deepseek-chat': {
            inputPerMTokens: 1.0, outputPerMTokens: 2.0,
            cacheCreationPerMTokens: 1.25, cacheReadPerMTokens: 0.1,
            currency: 'CNY', source: 'test', updatedAt: '2026-08-04',
          },
        },
      },
    });
  }

  it('completes preflight to STRATEGY_GATE successfully', async () => {
    const result = await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '测试任务',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config: defaultConfig(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe('STRATEGY_GATE');
      expect(result.runId).toMatch(/^run-/);
      expect(result.worktreeFingerprint).toHaveLength(64);
    }
  });

  it('does not enter DS_WORK', async () => {
    const result = await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '测试',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config: defaultConfig(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).not.toBe('DS_WORK');
  });

  it('persists RunState with empty calls', async () => {
    const result = await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '测试',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config: defaultConfig(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const state = loadRunState(FIXTURE_CWD, result.runId);
      expect(state.calls).toEqual([]);
    }
  });

  it('persists verificationStatus as NOT_RUN', async () => {
    const result = await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '测试',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config: defaultConfig(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const state = loadRunState(FIXTURE_CWD, result.runId);
      expect(state.verificationStatus).toEqual({ target: 'NOT_RUN', full: 'NOT_RUN' });
    }
  });

  it('persists RunState atomically and can be re-read', async () => {
    const result = await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '任务 X',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config: defaultConfig(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const state = loadRunState(FIXTURE_CWD, result.runId);
      expect(state.taskDescription).toBe('任务 X');
      expect(state.strategy).toBe('deepseek-first');
      expect(state.currentRunPhase).toBe('STRATEGY_GATE');
      expect(state.humanGatePurpose).toBeNull();
    }
  });

  it('returns error when provider profile is missing', async () => {
    const config = makeTestConfig(undefined); // no providerProfiles
    const result = await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '测试',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopReason).toBe('PROVIDER_ERROR');
  });

  it('releases Run Lease after normal preflight', async () => {
    await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '测试',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config: defaultConfig(),
    });
    expect(readRunLease(FIXTURE_CWD)).toBeUndefined();
  });

  it('releases Run Lease after failed preflight', async () => {
    const config = makeTestConfig(undefined);
    await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '测试',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config,
    });
    expect(readRunLease(FIXTURE_CWD)).toBeUndefined();
  });

  it('does not include secret values in output', async () => {
    const result = await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '测试',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config: defaultConfig(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const state = loadRunState(FIXTURE_CWD, result.runId);
      const json = JSON.stringify(state);
      expect(json).not.toContain('sk-');
      expect(json).not.toContain('DEEPSEEK_API_KEY=');
    }
  });

  it('returns PRICING_NOT_FOUND when defaultModelId has no pricing', async () => {
    const config = makeTestConfig({
      'deepseek-v4-pro': {
        displayName: 'Test', vendor: 'deepseek', transport: 'openai-chat',
        credentialEnvVars: [], runtimeEnvAllowlist: ['PATH'],
        defaultModelId: 'deepseek',
        models: [
          {
            logicalName: 'deepseek', requestedModelId: 'deepseek-chat',
            acceptedReportedModelIds: ['deepseek-chat'], displayName: 'DS',
          },
        ],
        pricing: {},
      },
    });
    const result = await runPreflight({
      cwd: FIXTURE_CWD, taskDescription: '测试',
      strategy: 'deepseek-first', deepseekProfileId: 'deepseek-v4-pro',
      config,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopReason).toBe('PRICING_NOT_FOUND');
  });
});
