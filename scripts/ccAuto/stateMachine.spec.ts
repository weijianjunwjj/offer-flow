import { describe, expect, it } from 'vitest';
import { shouldEscalateToArbiter, opusShareExceeded, changedFilesExceeded } from './stateMachine';
import { DEFAULT_CONFIG } from './config';
import type { RunState } from './store';
import type { CallUsage } from './types';

function baseState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-test', taskDescription: 't', createdAt: '', updatedAt: '',
    currentPhase: 'VERIFY', calls: [], failures: [], repairCycles: 0, opusCalls: 0,
    changedFiles: [], done: false, pricingMode: 'custom', ...overrides,
  };
}

describe('shouldEscalateToArbiter', () => {
  it('风险分 >= 8 直接升级', () => {
    expect(shouldEscalateToArbiter({ riskScore: 8, touchesHighRisk: false, repeatedFingerprint: false, acceptanceConflict: false })).toBe(true);
  });

  it('重复失败指纹直接升级', () => {
    expect(shouldEscalateToArbiter({ riskScore: 1, touchesHighRisk: false, repeatedFingerprint: true, acceptanceConflict: false })).toBe(true);
  });

  it('高风险 + 中等风险分升级；仅高风险但风险分低不升级', () => {
    expect(shouldEscalateToArbiter({ riskScore: 5, touchesHighRisk: true, repeatedFingerprint: false, acceptanceConflict: false })).toBe(true);
    expect(shouldEscalateToArbiter({ riskScore: 2, touchesHighRisk: true, repeatedFingerprint: false, acceptanceConflict: false })).toBe(false);
  });

  it('builder 自报验收冲突直接升级', () => {
    expect(shouldEscalateToArbiter({ riskScore: 0, touchesHighRisk: false, repeatedFingerprint: false, acceptanceConflict: true })).toBe(true);
  });

  it('低风险且无特殊情况不升级', () => {
    expect(shouldEscalateToArbiter({ riskScore: 2, touchesHighRisk: false, repeatedFingerprint: false, acceptanceConflict: false })).toBe(false);
  });
});

function usage(model: CallUsage['model'], costRmb: number): CallUsage {
  return { model, modelId: 'x', inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, costRmbOfficial: costRmb, costRmbCustom: costRmb, costRmb, durationMs: 0, numTurns: 1, pricingStatus: 'PRICED' };
}

describe('opusShareExceeded / changedFilesExceeded', () => {
  it('仲裁占比超过上限时为 true', () => {
    const state = baseState({ calls: [usage('builder', 5), usage('arbiter', 3)] });
    expect(opusShareExceeded(state, DEFAULT_CONFIG)).toBe(true);
  });

  it('无仲裁调用时不算超限', () => {
    const state = baseState({ calls: [usage('builder', 100)] });
    expect(opusShareExceeded(state, DEFAULT_CONFIG)).toBe(false);
  });

  it('改动文件数超过上限时为 true', () => {
    const files = Array.from({ length: DEFAULT_CONFIG.limits.maxChangedFiles + 1 }, (_, i) => `f${i}.ts`);
    expect(changedFilesExceeded(baseState({ changedFiles: files }), DEFAULT_CONFIG)).toBe(true);
    expect(changedFilesExceeded(baseState({ changedFiles: ['a.ts'] }), DEFAULT_CONFIG)).toBe(false);
  });
});
