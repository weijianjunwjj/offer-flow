/** cc-auto v0.2.0 预检骨架。
 *
 * 从用户任务到 STRATEGY_GATE 的完整预检闭环：
 * 用户任务
 * → 校验 CcAutoConfig.providerProfiles
 * → 校验模型与定价
 * → 获取仓库 Run Lease
 * → 计算 WorktreeFingerprint
 * → 创建并持久化 RunState
 * → 进入 STRATEGY_GATE
 * → 输出 PreflightResult
 * → 正常释放 Run Lease
 *
 * 不调用任何真实模型。
 * Provider 配置来自 CcAutoConfig（.cc-auto/config.json），不另建配置真相来源。
 */
import type { StopReason, VerificationOutcome } from './types';
import type { PreflightResult, LaunchStrategy } from './types';
import type { RunState } from './store';
import { newRunId, runDir, saveRunState } from './store';
import { loadProviderProfiles, modelHasPricing } from './provider';
import { acquireRunLease, releaseRunLease, registerExitHook, startHeartbeat } from './runLease';
import { computeWorktreeFingerprint } from './worktreeFingerprint';
import type { CcAutoConfig } from './config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface PreflightOptions {
  cwd: string;
  taskDescription: string;
  strategy: LaunchStrategy;
  deepseekProfileId: string;
  config: CcAutoConfig;
  log?: (line: string) => void;
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const log = opts.log ?? (() => {});
  const cwd = opts.cwd;

  // 1. 加载 Provider 配置（来自 CcAutoConfig，不从单独文件读取）
  log('加载 Provider 配置...');
  const profiles = loadProviderProfiles(opts.config);
  if (!profiles.ok) {
    const reason: StopReason = profiles.reason === 'PRICING_NOT_FOUND' ? 'PRICING_NOT_FOUND' : 'PROVIDER_ERROR';
    return { ok: false, stopReason: reason, message: profiles.error! };
  }

  // 2. 校验 DeepSeek Profile 存在且定价完整
  const dsProfile = profiles.profiles![opts.deepseekProfileId];
  if (!dsProfile) {
    return {
      ok: false,
      stopReason: 'PROVIDER_ERROR',
      message: `DeepSeek Profile "${opts.deepseekProfileId}" 不存在`,
    };
  }

  // 3. 校验 defaultModelId 定价
  const defaultModel = dsProfile.models.find((m) => m.logicalName === dsProfile.defaultModelId);
  if (!defaultModel) {
    return {
      ok: false,
      stopReason: 'PRICING_NOT_FOUND',
      message: `defaultModelId "${dsProfile.defaultModelId}" 不在 Provider "${opts.deepseekProfileId}" 的 models 列表中`,
    };
  }
  if (!modelHasPricing(dsProfile, dsProfile.defaultModelId)) {
    return {
      ok: false,
      stopReason: 'PRICING_NOT_FOUND',
      message: `requestedModelId "${defaultModel.requestedModelId}" 未在定价表中（配置态 PRICING_NOT_FOUND）`,
    };
  }

  log(`Provider: ${dsProfile.displayName} (${dsProfile.id})`);
  log(`Model: ${defaultModel.requestedModelId} (${defaultModel.displayName})`);
  log('配置校验通过');

  // 4. 计算 WorktreeFingerprint（完整 64 hex）
  log('计算 WorktreeFingerprint...');
  const fp = computeWorktreeFingerprint(cwd);

  // 5. 获取 Run Lease
  log('获取 Run Lease...');
  const runId = newRunId();
  const leaseResult = acquireRunLease(cwd, runId, fp);
  if (!leaseResult.ok) {
    const reason: StopReason =
      leaseResult.reason === 'STALE_LEASE' ? 'STALE_LEASE_REQUIRES_CONFIRM' : 'RUN_LEASE_CONFLICT';
    return {
      ok: false,
      stopReason: reason,
      message: leaseResult.detail!,
    };
  }

  // 注册退出钩子（兜底）
  registerExitHook(cwd, runId);
  const stopHeartbeat = startHeartbeat(cwd, runId);

  try {
    // 6. 创建 RunState
    log('创建 RunState...');
    const now = new Date().toISOString();
    const verificationStatus: { target: VerificationOutcome; full: VerificationOutcome } = {
      target: 'NOT_RUN',
      full: 'NOT_RUN',
    };

    const state: RunState = {
      runId,
      taskDescription: opts.taskDescription,
      createdAt: now,
      updatedAt: now,
      currentPhase: 'INTAKE', // v0.1 兼容
      calls: [],
      failures: [],
      repairCycles: 0,
      opusCalls: 0,
      changedFiles: [],
      done: false,
      pricingMode: 'custom',

      // v0.2.0 字段
      strategy: opts.strategy,
      fileScope: {
        allowedRoots: [],
        protectedPaths: [],
        proposedFiles: [],
        approvedFiles: [],
        maxChangedFiles: 15,
      },
      humanGatePurpose: null,
      identityConfirmationContext: null,
      lastFailureFingerprint: null,
      verificationStatus,
      resumed: false,
      currentRunPhase: 'INTAKE',
    };

    mkdirSync(runDir(cwd, runId), { recursive: true });
    saveRunState(cwd, state);

    // 7. INTAKE → STRATEGY_GATE
    state.currentRunPhase = 'STRATEGY_GATE';
    state.currentPhase = 'PREFLIGHT'; // v0.1 兼容
    saveRunState(cwd, state);

    const runStatePath = path.join(runDir(cwd, runId), 'state.json').replace(/\\/g, '/');

    return {
      ok: true,
      runId,
      phase: 'STRATEGY_GATE',
      runStatePath,
      worktreeFingerprint: fp,
    };
  } catch (err) {
    return {
      ok: false,
      stopReason: 'PROVIDER_ERROR',
      message: `预检异常：${(err as Error).message}`,
    };
  } finally {
    // 8. 正常释放 Run Lease
    releaseRunLease(cwd, runId);
    stopHeartbeat();
  }
}
