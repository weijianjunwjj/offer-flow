/** 落盘存储：.cc-auto/runs/<run-id>/ 下的 state.json、phases/*.json、report.md。 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Phase, CallUsage, FailureRecord, StopReason, Classification } from './types';
import type { LaunchStrategy, FileScope, HumanGatePurpose, IdentityConfirmationContext, VerificationOutcome } from './types';
import type { PendingCall } from './types';
import type {
  TaskBudgetEstimate,
  RoutingDecisionRecord,
  TaskCostSummary,
  ArbitrationCapsule,
} from './types';
import type { PricingMode } from './config';
import { redactForDisk } from './redact';

export interface RunState {
  runId: string;
  taskDescription: string;
  createdAt: string;
  updatedAt: string;
  currentPhase: Phase;
  classification?: Classification;
  calls: CallUsage[];
  failures: FailureRecord[];
  repairCycles: number;
  opusCalls: number;
  changedFiles: string[];
  stopReason?: StopReason;
  stopDetail?: string;
  /** 运行是否已结束（终态，无论成功或失败）；不代表任务本身是否成功，见 taskSucceeded。 */
  done: boolean;
  /** 本次 run 生效的计价模式，写入状态供 report 展示（不影响历史已记录调用的 costRmb）。 */
  pricingMode: PricingMode;
  /**
   * 仅当**真实进入并成功执行** Simple Direct Edit 执行路径（机器读取上下文 → tools:[] Builder →
   * 机器原子应用 edits）时才为 true。仅满足命中条件但准备/应用阶段失败时不得置 true，
   * 报告据此判断是否标记 Simple Direct Edit（不允许「标记但仍走标准 Agent Builder」）。
   */
  directEdit?: boolean;
  /** Direct Edit 真实执行的机器侧记录，供报告展示目标文件、edit 数量与应用结果。仅在 directEdit=true 时存在。 */
  directEditDetail?: DirectEditDetail;

  // ======== v0.2.0 新增字段 ========
  /** 启动策略（v0.2.0） */
  strategy?: LaunchStrategy;
  /** 文件范围（v0.2.0） */
  fileScope?: FileScope;
  /** HUMAN_GATE 目的——进入前持久化，离开后清理（v0.2.0） */
  humanGatePurpose?: HumanGatePurpose | null;
  /** 模型身份确认上下文——进入 HUMAN_GATE 前持久化，离开后清理（v0.2.0） */
  identityConfirmationContext?: IdentityConfirmationContext | null;
  /** 最后一次失败指纹——持久化，用于重复失败检测（v0.2.0） */
  lastFailureFingerprint?: string | null;
  /** 验证状态——持久化，用于恢复时判断验证进度（v0.2.0） */
  verificationStatus?: {
    target: VerificationOutcome;
    full: VerificationOutcome;
  };
  /** 是否恢复执行（v0.2.0） */
  resumed?: boolean;
  /** 当前 v0.2.0 阶段（v0.2.0，区别于 v0.1 currentPhase，两套状态机共存期间兼容） */
  currentRunPhase?: string;
  /** v0.2.0 Slice 1F：append-only phase history for production integration audit. */
  phaseHistory?: import('./types').Phase[];
  /** v0.2.0 Slice 1F-RUN Blockers: next model role for REPAIR phases (set by VERIFY failure handler). */
  nextRoutedRole?: import('./types').ExecutionModelRole;
  /** v0.2.0 Slice 1F-RUN Blockers: per-run requested role from --fast CLI flag (used once in IMPLEMENT). */
  perRunRequestedRole?: import('./types').ExecutionModelRole;
  /** v0.2.0 Slice 1F-RUN Blockers: Flash attempt's last Provider callId for M3 escalation linkage. */
  flashLastCallId?: string;
  /** v0.2.0 Slice 1B：当前挂起的模型调用（持久化用于崩溃恢复探测；非挂起状态时不存在） */
  pendingCall?: PendingCall;
  /** v0.2.0 Slice 1F：已完成的调用尝试痕迹（append-only，包括 UNKNOWN_AFTER_CRASH）。
   *  每个 attempt 独立 callId、不可覆盖，作为不可覆盖的审计证据保留。*/
  attemptHistory?: PendingCall[];

  // ======== v0.2.0 Slice 1F：路由、预算、成本、仲裁持久化 ========
  /** 任务前预算估算——在第一条 PendingCall 之前写入 */
  budgetEstimate?: TaskBudgetEstimate;
  /** 路由决策记录——每次模型选择追加一条 */
  routingDecisions?: RoutingDecisionRecord[];
  /** 任务成本总结——任务结束后写入 */
  costSummary?: TaskCostSummary;
  /** 裁决 Capsule——需要 Opus 外部仲裁时写入 */
  arbitrationCapsule?: ArbitrationCapsule;
}

export interface DirectEditDetail {
  /** 机器准备上下文时读取的目标文件（相对仓库根路径）。 */
  targetFiles: string[];
  /** 校验并原子应用的 edit 数量。 */
  editCount: number;
  /** 实际写盘且产生真实 git diff 的文件。 */
  appliedFiles: string[];
  /** Builder 返回的改动摘要。 */
  summary: string;
  /** Builder 建议的定向测试（若有）。 */
  suggestedTests: string[];
}

/**
 * 任务是否成功：只有「以 DONE 结束 + 有改动文件 + 无 terminal error」才算成功。
 * STOPPED、无改动、存在 stopReason 均为否，避免「运行已结束」与「任务已成功」的歧义。
 * H3: terminal stop/error（如 REPORTER_OUTPUT_FAILED_AFTER_EXECUTION）→ success = false。
 */
export function isTaskSucceeded(state: RunState): boolean {
  if (state.currentPhase !== 'DONE') return false;
  if (state.changedFiles.length === 0) return false;
  if (state.stopReason) return false;
  return true;
}

export function ccAutoRoot(cwd: string): string {
  return path.join(cwd, '.cc-auto');
}

export function runDir(cwd: string, runId: string): string {
  return path.join(ccAutoRoot(cwd), 'runs', runId);
}

export function phasesDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'phases');
}

export function newRunId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${Date.now()}-${rand}`;
}

export function createRunState(cwd: string, runId: string, taskDescription: string, pricingMode: PricingMode): RunState {
  const now = new Date().toISOString();
  const state: RunState = {
    runId,
    taskDescription,
    createdAt: now,
    updatedAt: now,
    currentPhase: 'INTAKE',
    calls: [],
    failures: [],
    repairCycles: 0,
    opusCalls: 0,
    changedFiles: [],
    done: false,
    pricingMode,
  };
  mkdirSync(phasesDir(cwd, runId), { recursive: true });
  saveRunState(cwd, state);
  return state;
}

export function saveRunState(cwd: string, state: RunState): void {
  state.updatedAt = new Date().toISOString();
  // phaseHistory: append-only log of phases visited
  if (!state.phaseHistory) state.phaseHistory = [];
  const lastPhase = state.phaseHistory[state.phaseHistory.length - 1];
  if (lastPhase !== state.currentPhase) {
    state.phaseHistory.push(state.currentPhase);
  }
  const file = path.join(runDir(cwd, state.runId), 'state.json');
  // 原子写：临时文件 + rename，避免半写状态
  const tmp = file + '.tmp';
  writeFileSync(tmp, redactForDisk(JSON.stringify(state, null, 2)), 'utf8');
  renameSync(tmp, file);
}

export function loadRunState(cwd: string, runId: string): RunState {
  const file = path.join(runDir(cwd, runId), 'state.json');
  return JSON.parse(readFileSync(file, 'utf8')) as RunState;
}

export function runStateExists(cwd: string, runId: string): boolean {
  return existsSync(path.join(runDir(cwd, runId), 'state.json'));
}

/** 记录某阶段的输入输出快照（脱敏后），用于 resume 时判断该阶段是否已完成。 */
export function savePhaseRecord(cwd: string, runId: string, phase: Phase, record: unknown): void {
  const dir = phasesDir(cwd, runId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${phase}.json`);
  writeFileSync(file, redactForDisk(JSON.stringify(record, null, 2)), 'utf8');
}

export function loadPhaseRecord<T>(cwd: string, runId: string, phase: Phase): T | undefined {
  const file = path.join(phasesDir(cwd, runId), `${phase}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function listRunIds(cwd: string): string[] {
  const dir = path.join(ccAutoRoot(cwd), 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function latestRunId(cwd: string): string | undefined {
  const ids = listRunIds(cwd);
  return ids.length > 0 ? ids[ids.length - 1] : undefined;
}

export function writeReport(cwd: string, runId: string, markdown: string): string {
  const file = path.join(runDir(cwd, runId), 'report.md');
  writeFileSync(file, redactForDisk(markdown), 'utf8');
  return file;
}

/**
 * 追加一条已完成的 PendingCall 到 attemptHistory（append-only 审计痕迹）。
 * 在覆盖 pendingCall 之前调用：保留旧 attempt 为不可覆盖证据。
 * 每个 attempt 保持独立 callId、独立 terminal evidence。
 */
export function appendAttemptHistory(cwd: string, runId: string, call: PendingCall): void {
  if (!runStateExists(cwd, runId)) return;
  const state = loadRunState(cwd, runId);
  if (!state.attemptHistory) state.attemptHistory = [];
  // 防重复：同 callId 不再追加
  if (state.attemptHistory.some((c) => c.callId === call.callId)) return;
  state.attemptHistory.push(call);
  state.updatedAt = new Date().toISOString();
  saveRunState(cwd, state);
}

// ============================================================================
// v0.2.0 Slice 1F：路由与预算持久化
// ============================================================================

/**
 * 原子保存 TaskBudgetEstimate。
 * 在第一条 PendingCall 之前调用。
 */
export function saveBudgetEstimate(cwd: string, runId: string, estimate: TaskBudgetEstimate): void {
  if (!runStateExists(cwd, runId)) return;
  const state = loadRunState(cwd, runId);
  state.budgetEstimate = estimate;
  state.updatedAt = new Date().toISOString();
  saveRunState(cwd, state);
}

/**
 * 追加一条 RoutingDecisionRecord。
 * 每次模型选择后调用。
 */
export function saveRoutingDecision(cwd: string, runId: string, decision: RoutingDecisionRecord): void {
  if (!runStateExists(cwd, runId)) return;
  const state = loadRunState(cwd, runId);
  if (!state.routingDecisions) state.routingDecisions = [];
  // 防重复：同 decisionId 不再追加
  if (state.routingDecisions.some((d) => d.decisionId === decision.decisionId)) return;
  state.routingDecisions.push(decision);
  state.updatedAt = new Date().toISOString();
  saveRunState(cwd, state);
}

/**
 * 保存 TaskCostSummary。
 * 任务结束后调用。多次调用可覆盖（最后一次生效）。
 */
export function saveCostSummary(cwd: string, runId: string, summary: TaskCostSummary): void {
  if (!runStateExists(cwd, runId)) return;
  const state = loadRunState(cwd, runId);
  state.costSummary = summary;
  state.updatedAt = new Date().toISOString();
  saveRunState(cwd, state);
}

/**
 * 保存仲裁 Capsule。
 * 需要 Opus 外部仲裁时调用。
 */
export function saveArbitrationCapsule(cwd: string, runId: string, capsule: ArbitrationCapsule): void {
  if (!runStateExists(cwd, runId)) return;
  const state = loadRunState(cwd, runId);
  state.arbitrationCapsule = capsule;
  state.updatedAt = new Date().toISOString();
  saveRunState(cwd, state);
}

/**
 * 从 RunState 读取持久化的预算估算。
 * 用于进程重启后恢复。
 */
export function loadBudgetEstimate(cwd: string, runId: string): TaskBudgetEstimate | undefined {
  if (!runStateExists(cwd, runId)) return undefined;
  return loadRunState(cwd, runId).budgetEstimate;
}

/**
 * 从 RunState 读取已持久化的路由决策。
 */
export function loadRoutingDecisions(cwd: string, runId: string): RoutingDecisionRecord[] {
  if (!runStateExists(cwd, runId)) return [];
  return loadRunState(cwd, runId).routingDecisions ?? [];
}

/**
 * 从 RunState 读取已持久化的成本总结。
 */
export function loadCostSummary(cwd: string, runId: string): TaskCostSummary | undefined {
  if (!runStateExists(cwd, runId)) return undefined;
  return loadRunState(cwd, runId).costSummary;
}

/**
 * 从 RunState 读取已持久化的仲裁 Capsule。
 */
export function loadArbitrationCapsule(cwd: string, runId: string): ArbitrationCapsule | undefined {
  if (!runStateExists(cwd, runId)) return undefined;
  return loadRunState(cwd, runId).arbitrationCapsule;
}
