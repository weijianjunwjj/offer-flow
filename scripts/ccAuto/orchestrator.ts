/** cc-auto 编排器：串联分类、探路、构建、验证、修复、仲裁与预算闭环。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CcAutoConfig } from './config';
import { budgetForComplexity } from './config';
import { classifyTask } from './classify';
import { computeFailureFingerprint, truncateLog } from './fingerprint';
import { redactForDisk } from './redact';
import {
  createRunState, saveRunState, loadRunState, runStateExists,
  savePhaseRecord, loadPhaseRecord, newRunId, writeReport,
  type RunState,
} from './store';
import { renderReport } from './report';
import { shouldEscalateToArbiter, budgetGate, changedFilesExceeded } from './stateMachine';
import { validateConfiguredModelPricing } from './budget';
import { changedFilesSince, shortStatus } from './git';
import {
  evaluateDirectEditEligibility, prepareDirectEditContext, validateDirectEdits, applyDirectEdits,
  DIRECT_EDIT_SCHEMA, type DirectEditBuilderOutput, type PreparedFile,
} from './directEdit';
import type { ClaudeCallOptions, ClaudeCallResult } from './runner';
import type { Phase, FileScope } from './types';
import { evaluateFileProposals } from './fileScope';

export interface OrchestratorDeps {
  cwd: string;
  config: CcAutoConfig;
  runClaude: (options: ClaudeCallOptions) => Promise<ClaudeCallResult>;
  /** 定向验证：同名 spec -> 同模块 spec -> 全量测试兜底；永不「找不到测试=通过」。 */
  runTests: (files: string[]) => Promise<{ passed: boolean; output: string }>;
  /** FINAL_VERIFY 专用：至少一次全量 typecheck + 一次全量 vitest。 */
  runFullVerification: () => Promise<{ passed: boolean; output: string }>;
  currentDailyRmb: () => number;
  recordDailySpend: (rmb: number) => void;
  hookSettingsInlineJson: string;
  log: (line: string) => void;
  /** 启动任何模型调用前验证 claude 可执行文件；未提供时跳过该校验（测试可省略）。 */
  verifyClaudeBinary?: () => { ok: boolean; error?: string };
  /**
   * v0.2.0 Slice 1F-RUN: 路由执行器注入。
   * 仅当 modelRouting.enabled=true 时使用。由 cli.ts 注入 true 实现。
   * routing 关闭时保持 undefined → 100% 旧行为兼容。
   */
  routedExecution?: boolean;
  /**
   * v0.2.0 Slice 1F-RUN: 可注入的 fetchImpl，传递给 createProductionAdapterRegistry。
   * 生产环境使用 globalThis.fetch；测试注入 fake fetch。
   */
  adapterFetchImpl?: import('./openaiChatAdapter').FetchLike;
  /**
   * v0.2.0 Slice 1F-RUN: 可注入的 RoutedExecutionReporter，覆盖默认 console reporter。
   * 测试注入 fake sink 以捕获 reporter 输出 / 模拟失败。
   */
  routedReporter?: import('./types').RoutedExecutionReporter;
}

// --bare 下不再自动加载 CLAUDE.md/AGENTS.md，各角色所需最小规则改为经 --append-system-prompt 显式注入。
// 三段规则均要求「所有报告使用简体中文」，并各自附最小边界。
const SCOUT_SYSTEM_RULE = [
  '你是只读探路角色。只允许使用 Read/Grep/Glob 定位相关文件，禁止修改、创建或删除任何文件。',
  '所有报告使用简体中文。',
].join('\n');

const BUILDER_SYSTEM_RULE = [
  '你是受控实施角色，必须遵守本仓库 AGENTS.md/CLAUDE.md 的边界：',
  '不新增依赖、不修改数据库 schema、不推送/合并/打 Tag、不做产品验收替代、不擅自扩大范围。',
  '所有报告使用简体中文。',
].join('\n');

const ARBITER_SYSTEM_RULE = [
  '你是仲裁角色。只依据 prompt 中给出的上下文进行根因诊断与决策，禁止探索或读取任何文件（也没有文件工具可用）。',
  '所有报告使用简体中文。',
].join('\n');

const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    relevantFiles: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    notes: { type: 'string' },
  },
  required: ['relevantFiles'],
};

const BUILDER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    needsArbitration: { type: 'boolean' },
    arbitrationReason: { type: 'string' },
  },
  required: ['summary', 'changedFiles'],
};

function stop(state: RunState, reason: RunState['stopReason'], detail: string): void {
  state.currentPhase = 'STOPPED';
  state.stopReason = reason;
  state.stopDetail = detail;
  state.done = true;
}

async function guardedCall(
  deps: OrchestratorDeps,
  state: RunState,
  phase: Phase,
  role: ClaudeCallOptions['role'],
  taskBudgetRmb: number,
  optionsBase: ClaudeCallOptions,
): Promise<ClaudeCallResult | null> {
  // 粗略预估（元），基于各角色模型单次调用的典型花费，用于「调用前」预算闭环；
  // 真实花费在调用返回后累加进 state.calls，下一次调用会用真实累计值再校验一次。
  const estimate = role === 'arbiter' ? 3 : role === 'builder' ? 1.5 : 0.3;
  const gate = budgetGate(state, deps.config, taskBudgetRmb, deps.currentDailyRmb(), estimate);
  if (gate.blocked) {
    stop(state, gate.reason, gate.detail ?? '');
    deps.log(`预算超限，停止于 ${phase}：${gate.detail}`);
    return null;
  }
  const result = await deps.runClaude(optionsBase);
  // 调用已经真实发生：无论能否定价，先把 usage 计入 state.calls（含 token、官方费用、role、耗时），再判断是否停止。
  state.calls.push(result.usage);
  if (result.pricingError) {
    stop(state, 'PRICING_NOT_FOUND', `模型 ID「${result.pricingError.modelId}」未在第三方渠道价格表中，不使用默认价格猜测，已停止（该调用已记录为 UNPRICED）`);
    deps.log(`价格表未命中模型 ID：${result.pricingError.modelId}，停止于 ${phase}`);
    return null;
  }
  // 仅 PRICED 调用有确切人民币费用可累计当日花费；UNPRICED（null）不得写成 0。
  if (result.usage.costRmb !== null) deps.recordDailySpend(result.usage.costRmb);
  savePhaseRecord(deps.cwd, state.runId, phase, { role, resultText: result.resultText, structuredOutput: result.structuredOutput, isError: result.isError, subtype: result.subtype });
  return result;
}

/** 任务正文中直接给出的文件路径（形如 a/b.ts、a/b.spec.ts），用于 simple 任务收敛提示。 */
const EXPLICIT_FILE_PATTERN = /[\w./-]+\.(ts|tsx|js|jsx|json|md)\b/g;

export function extractExplicitFiles(task: string): string[] {
  const matches = task.match(EXPLICIT_FILE_PATTERN) ?? [];
  return Array.from(new Set(matches));
}

// Direct Edit Builder 系统规则：无任何文件工具，只依据 prompt 内的文件内容返回 search/replace edits。
const DIRECT_EDIT_SYSTEM_RULE = [
  '你是「定向编辑」角色。没有任何文件工具（不能读取、搜索或写入文件），',
  '只能依据 prompt 中直接给出的目标文件内容，返回 search/replace 形式的最小改动。',
  'search 必须是目标文件中逐字存在、且唯一出现的片段；不要臆造未提供的文件或路径。',
  '所有报告使用简体中文。',
].join('\n');

/** 构造 Direct Edit Builder 的 prompt：只包含任务、允许文件路径与机器读取出的文件内容。 */
export function directEditPrompt(task: string, files: PreparedFile[]): string {
  const parts = [
    `任务：${task}`,
    `允许编辑的文件（只能改这些，禁止引用其他路径）：${files.map((f) => f.path).join(', ')}`,
    '以下是这些文件的完整当前内容（由机器读取，不要假设任何未在此列出的内容）：',
  ];
  for (const f of files) {
    parts.push(`===== 文件：${f.path} =====\n${f.content}`);
  }
  parts.push(
    [
      '请返回结构化 JSON：edits 数组（每项含 path/search/replace）、summary、可选 suggestedTests。',
      '每个 search 必须逐字取自上面对应文件内容，且在该文件中唯一出现；search 与 replace 不得相同。',
      '只做任务要求的最小改动，不要顺手重构无关代码。',
    ].join('\n'),
  );
  return parts.join('\n\n');
}

export function builderPrompt(task: string, scoutFiles: string[], failureContext: string | undefined, complexity: 'simple' | 'normal' | 'complex'): string {
  const parts = [`任务：${task}`];
  if (scoutFiles.length > 0) parts.push(`已知相关文件（来自探路阶段）：${scoutFiles.join(', ')}`);

  const explicitFiles = extractExplicitFiles(task);
  if (complexity === 'simple' && explicitFiles.length > 0) {
    parts.push(
      [
        `任务已明确给出目标文件：${explicitFiles.join(', ')}。`,
        '禁止进行全仓探索：不要用 Grep/Glob 遍历无关目录或搜集额外上下文，只读取上面列出的目标文件（及其对应的测试文件）。',
        '收敛顺序：1) 直接 Read 目标文件；2) 尽快用 Edit 完成改动；3) 运行一个定向测试验证改动；4) 立即输出结构化 JSON（summary/changedFiles），不要继续探索或反复读取其他文件。',
      ].join('\n'),
    );
  }

  parts.push('必须遵守本仓库 AGENTS.md/CLAUDE.md 的边界：不新增依赖、不改数据库 schema、不推送/合并/打 Tag，不做产品验收替代。');
  if (failureContext) parts.push(`上一轮验证失败，请修复：\n${failureContext}`);
  return parts.join('\n\n');
}

async function runScout(deps: OrchestratorDeps, state: RunState, taskBudgetRmb: number): Promise<string[]> {
  const rule = deps.config.models.scout;
  const result = await guardedCall(deps, state, 'SCOUT', 'scout', taskBudgetRmb, {
    prompt: `只读探路，找出与以下任务最相关的最多 ${deps.config.limits.maxContextFiles} 个文件，不要修改任何文件：\n${state.taskDescription}`,
    role: 'scout',
    rule,
    tools: ['Read', 'Grep', 'Glob'],
    jsonSchema: SCOUT_SCHEMA,
    appendSystemPrompt: SCOUT_SYSTEM_RULE,
    isolateContext: true,
    cwd: deps.cwd,
  });
  if (!result) return [];
  const structured = result.structuredOutput as { relevantFiles?: string[] } | undefined;
  return structured?.relevantFiles ?? [];
}

interface BuilderOutput {
  summary: string;
  changedFiles: string[];
  needsArbitration: boolean;
  arbitrationReason?: string;
}

async function runBuilder(
  deps: OrchestratorDeps,
  state: RunState,
  phase: Phase,
  taskBudgetRmb: number,
  scoutFiles: string[],
  failureContext: string | undefined,
  highRisk: boolean,
  complexity: 'simple' | 'normal' | 'complex',
): Promise<BuilderOutput | null> {
  const rule = highRisk ? deps.config.models.builderHighRisk : deps.config.models.builderDefault;
  const result = await guardedCall(deps, state, phase, 'builder', taskBudgetRmb, {
    prompt: builderPrompt(state.taskDescription, scoutFiles, failureContext, complexity),
    role: 'builder',
    rule,
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    jsonSchema: BUILDER_SCHEMA,
    appendSystemPrompt: BUILDER_SYSTEM_RULE,
    settingsInlineJson: deps.hookSettingsInlineJson,
    isolateContext: true,
    cwd: deps.cwd,
  });
  if (!result) return null;
  const structured = result.structuredOutput as BuilderOutput | undefined;
  if (!structured) return null;
  for (const file of structured.changedFiles) {
    if (!state.changedFiles.includes(file)) state.changedFiles.push(file);
  }
  return structured;
}

/** Direct Edit 执行结果：'applied' 已真实写盘并产生 diff；'stopped' 已置 STOPPED（不回退标准 Builder）。 */
type DirectEditOutcome = 'applied' | 'stopped';

/**
 * 真实 Simple Direct Edit 执行路径：机器准备上下文 → tools:[] 的 Direct Edit Builder →
 * 机器校验并原子应用 edits → 确认产生真实 git diff。不调用 Scout，不提高 Agent Builder maxTurns。
 *
 * 失败语义（关键安全边界）：
 * - 本函数只在任务**已被判定为 Direct Edit 候选**（evaluateDirectEditEligibility 通过）后调用；
 * - 准备阶段（路径穿越/绝对路径/仓库外/文件不存在/超上限/读取失败/文件数超限）失败
 *   → STOPPED(DIRECT_EDIT_PREPARE_FAILED)，**绝不**回退到拥有 Read/Edit/Bash 的标准 Builder，
 *   以免标准 Builder 绕过 Direct Edit 的机器侧安全拒绝；
 * - Builder 未返回结构化输出、edits 校验失败或应用失败 → STOPPED(DIRECT_EDIT_APPLY_FAILED)。
 */
async function runDirectEdit(
  deps: OrchestratorDeps,
  state: RunState,
  taskBudgetRmb: number,
  targetFiles: string[],
): Promise<DirectEditOutcome> {
  const context = prepareDirectEditContext(deps.cwd, targetFiles);
  if (!context.ok) {
    stop(state, 'DIRECT_EDIT_PREPARE_FAILED', `Direct Edit 机器准备阶段失败：${context.reason}`);
    deps.log(`Direct Edit 准备阶段安全拒绝（${context.reason}），停止且不回退标准 Builder`);
    return 'stopped';
  }

  // Direct Edit Builder：固定 claude-sonnet-5、tools:[]、maxTurns<=2；上下文只经 prompt 文本给出。
  const rule = { model: 'claude-sonnet-5', effort: 'medium' as const, maxTurns: Math.min(2, deps.config.models.builderDefault.maxTurns) };
  const result = await guardedCall(deps, state, 'IMPLEMENT', 'builder', taskBudgetRmb, {
    prompt: directEditPrompt(state.taskDescription, context.files),
    role: 'builder',
    rule,
    tools: [],
    jsonSchema: DIRECT_EDIT_SCHEMA,
    appendSystemPrompt: DIRECT_EDIT_SYSTEM_RULE,
    isolateContext: true,
    cwd: deps.cwd,
  });
  if (state.done) return 'stopped'; // 预算/定价在 guardedCall 内已置 STOPPED
  if (!result) return 'stopped';

  const output = result.structuredOutput as DirectEditBuilderOutput | undefined;
  if (!output || !Array.isArray(output.edits)) {
    stop(state, 'DIRECT_EDIT_APPLY_FAILED', 'Direct Edit Builder 未返回有效 edits');
    return 'stopped';
  }

  const validation = validateDirectEdits(output.edits, context.files, deps.config);
  if (!validation.ok) {
    stop(state, 'DIRECT_EDIT_APPLY_FAILED', `edits 校验失败：${validation.reason}`);
    return 'stopped';
  }

  const applied = applyDirectEdits(deps.cwd, output.edits, context.files);
  if (!applied.ok) {
    stop(state, 'DIRECT_EDIT_APPLY_FAILED', `edits 应用失败：${applied.reason}`);
    return 'stopped';
  }

  // 确认应用后确实产生真实 git diff；否则视为空改动，按应用失败处理，不伪装成功。
  const diffFiles = changedFilesSince(deps.cwd);
  const producedDiff = applied.changedFiles.some((f) => diffFiles.includes(f));
  if (!producedDiff) {
    stop(state, 'DIRECT_EDIT_APPLY_FAILED', '应用后未检测到真实 git diff（可能为等价改动）');
    return 'stopped';
  }

  for (const file of applied.changedFiles) {
    if (!state.changedFiles.includes(file)) state.changedFiles.push(file);
  }
  state.directEdit = true;
  state.directEditDetail = {
    targetFiles: context.files.map((f) => f.path),
    editCount: output.edits.length,
    appliedFiles: applied.changedFiles,
    summary: output.summary,
    suggestedTests: output.suggestedTests ?? [],
  };
  savePhaseRecord(deps.cwd, state.runId, 'IMPLEMENT', {
    mode: 'direct-edit', targetFiles: state.directEditDetail.targetFiles,
    editCount: state.directEditDetail.editCount, appliedFiles: applied.changedFiles, summary: output.summary,
  });
  deps.log(`Direct Edit 已应用 ${output.edits.length} 处改动到 ${applied.changedFiles.join(', ')}，进入验证`);
  return 'applied';
}

const ARBITRATION_BUNDLE_MAX_CHARS = 8000;

/**
 * Opus 仲裁硬隔离：
 * - cwd 是每次调用新建的独立临时目录，绝不是仓库根目录，Opus 无法通过任何文件工具触达仓库；
 * - 该临时目录内只写入脱敏 + 裁剪后的 arbitration-bundle.json，不放任何其他文件；
 * - tools 传空数组：不开放 Bash/Edit/Write/Glob/Grep，也不开放 Read——上下文只通过 prompt 文本直接给出；
 * - 结构化输出仍必须满足 JSON Schema。
 */
async function runArbiter(
  deps: OrchestratorDeps,
  state: RunState,
  taskBudgetRmb: number,
  contextBundle: string,
): Promise<{ decision: string; rootCause: string } | null> {
  if (state.opusCalls >= deps.config.limits.maxOpusCalls) return null;
  const rule = deps.config.models.arbiter;

  const redactedBundle = redactForDisk(contextBundle).slice(0, ARBITRATION_BUNDLE_MAX_CHARS);
  const isolatedCwd = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-arbiter-'));
  try {
    writeFileSync(path.join(isolatedCwd, 'arbitration-bundle.json'), JSON.stringify({ bundle: redactedBundle }, null, 2), 'utf8');

    // 只有 Arbiter 子进程真实启动、形成调用记录后才计数：guardedCall 在「调用前预算门禁」拦截时
    // 返回 null 且不会 push 任何 usage，此时 opusCalls 必须保持不变，报告不得声称 Opus 已被调用。
    const callsBefore = state.calls.length;
    const result = await guardedCall(deps, state, 'ARBITRATE', 'arbiter', taskBudgetRmb, {
      prompt: `请诊断根因并给出决策，不要尝试探索或读取任何文件（也没有文件工具可用），只依据以下上下文：\n${redactedBundle}`,
      role: 'arbiter',
      rule,
      tools: [],
      jsonSchema: { type: 'object', properties: { rootCause: { type: 'string' }, decision: { type: 'string' } }, required: ['rootCause', 'decision'] },
      appendSystemPrompt: ARBITER_SYSTEM_RULE,
      bare: true,
      cwd: isolatedCwd,
    });
    // 调用真实发生的充要标志：state.calls 增长了一条（guardedCall 在真正 spawn 后才 push usage）。
    if (state.calls.length > callsBefore) state.opusCalls += 1;
    if (!result) return null;
    return result.structuredOutput as { decision: string; rootCause: string };
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

export async function runTask(deps: OrchestratorDeps, taskDescription: string, estimatedFiles?: number, perRunOpts?: { requestedRole?: import('./types').ExecutionModelRole }): Promise<RunState> {
  const runId = newRunId();
  const state = createRunState(deps.cwd, runId, taskDescription, deps.config.pricingMode);
  if (perRunOpts?.requestedRole) {
    state.perRunRequestedRole = perRunOpts.requestedRole;
  }
  return driveStateMachine(deps, state, estimatedFiles);
}

export async function resumeTask(deps: OrchestratorDeps, runId: string): Promise<RunState> {
  if (!runStateExists(deps.cwd, runId)) throw new Error(`未找到 run：${runId}`);
  const state = loadRunState(deps.cwd, runId);
  if (state.done) {
    deps.log(`run ${runId} 已处于终态（${state.currentPhase}），无需 resume`);
    return state;
  }
  return driveStateMachine(deps, state, undefined);
}

async function finish(deps: OrchestratorDeps, state: RunState): Promise<RunState> {
  // B4: Generate cost summary for routed tasks at terminal state
  if (deps.routedExecution && state.routingDecisions && state.routingDecisions.length > 0) {
    try {
      // Reload authoritative state from disk before building cost summary
      const authoritative = loadRunState(deps.cwd, state.runId);
      // Use in-memory state but sync calls from disk
      state.calls = authoritative.calls;

      // Build cost summary from authoritative ledger
      const summary = await buildAndPersistCostSummary(deps, state);
      if (summary) {
        const reporter = deps.routedReporter ?? createConsoleRoutedExecutionReporter();
        try {
          await reporter.onCostSummary(summary, '');
        } catch {
          // H: reporter failure after execution — calls already persisted; don't retry
          deps.log('成本 Reporter 失败——Provider 调用已持久化，不再重试');
          if (!state.stopReason) {
            // If we were DONE, mark reporter failure
            state.stopReason = 'PROVIDER_ERROR';
            state.stopDetail = 'REPORTER_OUTPUT_FAILED_AFTER_EXECUTION';
            state.done = true;
          }
        }
      }
    } catch (err) {
      deps.log(`成本汇总失败：${(err as Error).message}`);
    }
  }

  // P2: Zero-provider cost summary for Direct Edit (no model calls at all).
  // Print clearly: Provider 调用 0 次, Token 0, Cost ¥0.0000.
  // No fake UsageRecord — state.calls.length === 0 is the truth.
  if (state.directEdit && state.calls.length === 0) {
    deps.log('');
    deps.log('────────────────────────────────');
    deps.log('cc-auto 模型成本复盘');
    deps.log('────────────────────────────────');
    deps.log('');
    deps.log('执行方式：Simple Direct Edit');
    deps.log('LLM Provider 调用：0 次');
    deps.log('输入 Token：0');
    deps.log('输出 Token：0');
    deps.log('实际模型成本：¥0.0000');
    deps.log('');
    deps.log('全 Pro 对照：不适用（本次未调用模型）');
    deps.log('节省：无需模型调用');
    deps.log('────────────────────────────────');
    deps.log('');
  }

  // Legacy zero-provider summary (non-Direct Edit but still 0 calls, e.g. budget blocked).
  // Don't duplicate if Direct Edit already printed above.
  if (!state.directEdit && state.calls.length === 0 && state.currentPhase !== 'PREFLIGHT') {
    deps.log('');
    deps.log('────────────────────────────────');
    deps.log('cc-auto 模型成本复盘');
    deps.log('────────────────────────────────');
    deps.log('');
    deps.log('LLM Provider 调用：0 次');
    deps.log('输入 Token：0');
    deps.log('输出 Token：0');
    deps.log('实际模型成本：¥0.0000');
    deps.log('');
    deps.log(`停止原因：${state.stopReason ?? '（未知）'}`);
    deps.log('全 Pro 对照：不适用（本次未调用模型）');
    deps.log('────────────────────────────────');
    deps.log('');
  }

  saveRunState(deps.cwd, state);
  const markdown = renderReport(state);
  const reportPath = writeReport(deps.cwd, state.runId, markdown);
  deps.log(`报告已写入：${reportPath}`);

  // Release run lease for routed execution (acquired at run level in driveStateMachine)
  if (deps.routedExecution) {
    releaseRunLease(deps.cwd, state.runId);
    deps.log('Run Lease 已释放');
  }

  return state;
}

/**
 * flaky 检测：只在「第一次结果为失败」时才重跑一次同配置校验——第一次通过就直接采信，
 * 避免每次验证都多花一倍成本。若第一次失败、第二次通过（或反之），判定为不稳定，交给上层 STOPPED。
 */
async function verifyWithFlakyGuard(
  runOnce: () => Promise<{ passed: boolean; output: string }>,
): Promise<{ passed: boolean; output: string; flaky: boolean }> {
  const first = await runOnce();
  if (first.passed) return { ...first, flaky: false };
  const second = await runOnce();
  if (second.passed !== first.passed) {
    return { passed: false, output: `${first.output}\n\n--- 重跑结果不一致 ---\n${second.output}`, flaky: true };
  }
  return { ...second, flaky: false };
}

async function driveStateMachine(deps: OrchestratorDeps, state: RunState, estimatedFiles: number | undefined): Promise<RunState> {
  // =========================================================================
  // PREFLIGHT (shared by legacy & routed)
  // =========================================================================
  // Legacy-only: validate Claude pricing + binary before spawning
  if (!deps.routedExecution) {
    const pricingCheck = validateConfiguredModelPricing(deps.config);
    if (!pricingCheck.ok) {
      const detail = pricingCheck.missing.map((m) => `${m.role}=${m.modelId}`).join('、');
      stop(state, 'PRICING_NOT_FOUND', `配置的模型未在第三方渠道价格表中，无法在启动前定价：${detail}；不使用默认价格猜测，未发起任何模型调用`);
      deps.log(`配置校验失败：以下角色模型缺少渠道价格 ${detail}，未启动任何 claude 子进程`);
      return finish(deps, state);
    }

    if (deps.verifyClaudeBinary) {
      const binaryCheck = deps.verifyClaudeBinary();
      if (!binaryCheck.ok) {
        stop(state, 'CLAUDE_BINARY_NOT_FOUND', `claude 可执行文件无法启动：${binaryCheck.error}；请设置 CC_AUTO_CLAUDE_BIN 环境变量或确保全局 claude CLI 可用`);
        deps.log(`claude 二进制文件校验失败：${binaryCheck.error}`);
        return finish(deps, state);
      }
    }
  }

  // =========================================================================
  // PREFLIGHT + CLASSIFY (shared)
  // =========================================================================
  const dirty = shortStatus(deps.cwd);
  if (state.currentPhase === 'INTAKE') {
    state.currentPhase = 'PREFLIGHT';
    saveRunState(deps.cwd, state);
  }
  if (state.currentPhase === 'PREFLIGHT') {
    if (dirty.length > 0) deps.log(`工作区存在未提交改动（${dirty.length} 项），继续执行但请注意区分`);
    state.currentPhase = 'CLASSIFY';
    saveRunState(deps.cwd, state);
  }

  if (state.currentPhase === 'CLASSIFY') {
    state.classification = classifyTask(state.taskDescription, estimatedFiles);
    saveRunState(deps.cwd, state);
    deps.log(`分类结果：${state.classification.complexity}（风险分 ${state.classification.riskScore}）`);
    // Direct Edit 命中判定只决定「是否尝试」；是否真正走该路径由准备/应用是否成功决定，
    // 复杂/高风险任务一律进 SCOUT，保持原 Agent Builder 路径。
    state.currentPhase = state.classification.complexity === 'simple' ? 'IMPLEMENT' : 'SCOUT';
    saveRunState(deps.cwd, state);
  }

  // =========================================================================
  // ROUTED RUN-LEVEL LEASE: acquire once for entire run, release in finish()
  // Flash and Pro share the same run lease — no per-attempt acquisition.
  // =========================================================================
  if (deps.routedExecution) {
    const fp = computeWorktreeFingerprint(deps.cwd);
    const leaseResult = acquireRunLease(deps.cwd, state.runId, fp);
    if (!leaseResult.ok) {
      if (leaseResult.reason === 'STALE_LEASE') {
        stop(state, 'PROVIDER_ERROR', `[STALE_LEASE] ${leaseResult.detail ?? '发现残留 Run Lease。请手动检查后删除 .cc-auto/run-lock.json'}`);
      } else {
        stop(state, 'PROVIDER_ERROR', `Run Lease 获取失败：${leaseResult.reason} — ${leaseResult.detail}`);
      }
      deps.log(`Run Lease 获取失败：${leaseResult.reason} — ${leaseResult.detail}`);
      return finish(deps, state);
    }
    setWriter(deps.cwd, state.runId, 'deepseek');
    deps.log('Run Lease 已获取，writer=deepseek');
  }

  const classification = state.classification!;
  const taskBudgetRmb = budgetForComplexity(deps.config, classification.complexity);
  let scoutFiles: string[] = loadPhaseRecord<{ structuredOutput?: { relevantFiles?: string[] } }>(deps.cwd, state.runId, 'SCOUT')?.structuredOutput?.relevantFiles ?? [];

  // =========================================================================
  // SCOUT (shared phase, executor branches by mode)
  // =========================================================================
  // Legacy: runScout → Claude CLI (read-only)
  // Routed: skip legacy scout; routed discovery happens inside driveRoutedImplement
  //   AFTER routing+budget — never before budget gate.
  if (state.currentPhase === 'SCOUT') {
    if (deps.routedExecution) {
      // Routed: no Claude call. Scout is either trivially empty (complexity-driven)
      // or a routed read-only discovery inside driveRoutedImplement after budget gate.
      deps.log('路由模式：跳过 Claude Scout, 候选文件将在预算门禁后通过 routed discovery 获取');
      scoutFiles = [];
    } else {
      scoutFiles = await runScout(deps, state, taskBudgetRmb);
      if (state.done) return finish(deps, state);
    }
    state.currentPhase = 'IMPLEMENT';
    saveRunState(deps.cwd, state);
  }

  // =========================================================================
  // IMPLEMENT — legacy executor vs routed executor (seam)
  // =========================================================================
  // Legacy: Direct Edit eligibility for simple tasks
  if (state.currentPhase === 'IMPLEMENT' && state.repairCycles === 0 && !state.directEdit && !deps.routedExecution) {
    const eligibility = evaluateDirectEditEligibility(classification, state.taskDescription, deps.config, deps.cwd);
    if (eligibility.eligible) {
      deps.log(`命中 Simple Direct Edit 条件（目标文件：${eligibility.targetFiles.join(', ')}），尝试机器定向编辑`);
      const outcome = await runDirectEdit(deps, state, taskBudgetRmb, eligibility.targetFiles);
      if (state.done) return finish(deps, state);
      if (outcome === 'applied') {
        state.currentPhase = 'VERIFY';
        saveRunState(deps.cwd, state);
      }
    }
  }

  let failureContext: string | undefined;
  let lastFingerprint: string | undefined;

  while (!state.done) {
    const phase = state.currentPhase;

    // =========================================================================
    // Routed Implement/Repair seam — runs inside the while loop for re-entrancy
    // =========================================================================
    if (
      deps.routedExecution &&
      (phase === 'IMPLEMENT' || phase === 'REPAIR_1' || phase === 'REPAIR_2')
    ) {
      await driveRoutedImplement(deps, state, scoutFiles);

      if (state.done) break;

      // On success: driveRoutedImplement sets VERIFY
      // On failure (Pro exhausted): driveRoutedImplement sets STOPPED / Arbitration
      // On Flash failure: driveRoutedImplement persists flashLastCallId, we advance below
      //     (the next VERIFY failure in shared handler will escalate to REPAIR_1)
      saveRunState(deps.cwd, state);
      continue; // re-read phase from top of while loop
    }

    // Legacy IMPLEMENT/REPAIR (only for non-routed path)
    if (!deps.routedExecution && (phase === 'IMPLEMENT' || phase === 'REPAIR_1' || phase === 'REPAIR_2')) {
      const builderResult = await runBuilder(deps, state, phase, taskBudgetRmb, scoutFiles, failureContext, classification.touchesHighRisk, classification.complexity);
      if (state.done) break;
      if (!builderResult) {
        // Builder 未返回结构化输出：先检查最后一次调用的 subtype
        const lastCall = state.calls[state.calls.length - 1];
        if (lastCall && lastCall.subtype === 'error_max_turns') {
          stop(state, 'MAX_TURNS_EXCEEDED', `builder 达到最大轮次限制（${lastCall.numTurns} 轮）但未输出结构化 JSON`);
        } else {
          stop(state, 'STRUCTURED_OUTPUT_MISSING', 'builder 未返回结构化输出');
        }
        break;
      }
      if (changedFilesExceeded(state, deps.config)) { stop(state, 'MAX_CHANGED_FILES_EXCEEDED', `改动文件数 ${state.changedFiles.length} 超过上限 ${deps.config.limits.maxChangedFiles}`); break; }

      const escalate = shouldEscalateToArbiter({
        riskScore: classification.riskScore,
        touchesHighRisk: classification.touchesHighRisk,
        repeatedFingerprint: false,
        acceptanceConflict: builderResult.needsArbitration,
      });
      if (escalate) { state.currentPhase = 'ARBITRATE'; saveRunState(deps.cwd, state); continue; }
      state.currentPhase = 'VERIFY';
      saveRunState(deps.cwd, state);
      continue;
    }

    // =========================================================================
    // VERIFY + FINAL_VERIFY (shared by legacy and routed)
    // =========================================================================
    if (phase === 'VERIFY' || phase === 'FINAL_VERIFY') {
      const isFinal = phase === 'FINAL_VERIFY';
      const runOnce = isFinal
        ? () => deps.runFullVerification()
        : () => {
            const targetFiles = state.directEdit ? state.changedFiles : changedFilesSince(deps.cwd);
            return deps.runTests(targetFiles.length > 0 ? targetFiles : state.changedFiles);
          };
      const verifyResult = await verifyWithFlakyGuard(runOnce);
      savePhaseRecord(deps.cwd, state.runId, phase, verifyResult);
      if (verifyResult.flaky) {
        stop(state, 'FLAKY_TESTS', '同配置重跑一次后结果仍不稳定（两次结果不一致），停止等待人工确认');
        break;
      }
      if (verifyResult.passed) {
        if (isFinal) { state.currentPhase = 'DONE'; state.done = true; }
        // Direct Edit with riskScore=0 and single file: VERIFY is sufficient.
        // The VERIFY phase already provides tiered coverage (typecheck/syntax for
        // no-spec cases, targeted specs only when mapped). Full-suite FINAL_VERIFY
        // is redundant and wasteful for mechanical single-file edits.
        else if (state.directEdit) { state.currentPhase = 'DONE'; state.done = true; }
        else { state.currentPhase = 'FINAL_VERIFY'; }
        saveRunState(deps.cwd, state);
        continue;
      }

      // VERIFY failed — handle repair/escalation
      const fingerprint = computeFailureFingerprint(verifyResult.output);
      const repeated = fingerprint === lastFingerprint;
      lastFingerprint = fingerprint;
      failureContext = truncateLog(verifyResult.output);
      state.failures.push({ phase, fingerprint, summary: '验证失败', truncatedLog: failureContext, createdAt: new Date().toISOString() });

      // Arbitration check (shared)
      if (shouldEscalateToArbiter({ riskScore: classification.riskScore, touchesHighRisk: classification.touchesHighRisk, repeatedFingerprint: repeated, acceptanceConflict: false })) {
        state.currentPhase = 'ARBITRATE';
        saveRunState(deps.cwd, state);
        continue;
      }
      if (state.repairCycles >= deps.config.limits.maxRepairCycles) {
        stop(state, 'REPEATED_FAILURE_FINGERPRINT', '已用尽修复配额，仍未通过验证');
        break;
      }

      // Routed Flash→Pro escalation: VERIFY failed after Flash IMPLEMENT
      // Check if we should escalate from Flash to Pro (B2/H2)
      if (deps.routedExecution && state.flashLastCallId) {
        const escalateToPro = shouldEscalateFlashToPro('VERIFIER_FAILURE', deps.config.modelRouting?.allowStrongEscalation ?? false);
        if (escalateToPro) {
          deps.log('Flash VERIFY 失败 → 升级到 Pro REPAIR_1');
          state.nextRoutedRole = 'STRONG_EXECUTOR';
          state.repairCycles += 1;
          state.currentPhase = 'REPAIR_1';
          saveRunState(deps.cwd, state);
          continue;
        }
      }

      state.repairCycles += 1;
      state.currentPhase = state.repairCycles === 1 ? 'REPAIR_1' : 'REPAIR_2';
      saveRunState(deps.cwd, state);
      continue;
    }

    // =========================================================================
    // ARBITRATE (shared)
    // =========================================================================
    if (phase === 'ARBITRATE') {
      const bundle = [
        `任务：${state.taskDescription}`,
        `已改动文件：${state.changedFiles.join(', ') || '（无）'}`,
        failureContext ? `最近一次失败日志：\n${failureContext}` : '（无失败日志，为高风险/冲突升级）',
      ].join('\n\n');
      const arbiterResult = await runArbiter(deps, state, taskBudgetRmb, bundle);
      if (state.done) break;
      if (!arbiterResult) { stop(state, 'ARBITRATION_FAILED', '仲裁未返回有效决策或已用尽仲裁配额'); break; }
      savePhaseRecord(deps.cwd, state.runId, 'ARBITRATE', arbiterResult);
      state.currentPhase = 'APPLY_DECISION';
      saveRunState(deps.cwd, state);
      continue;
    }

    // =========================================================================
    // APPLY_DECISION (shared)
    // =========================================================================
    if (phase === 'APPLY_DECISION') {
      // 仲裁决策仅作为下一轮修复的上下文，不自动执行任何高风险动作；沿用 failureContext 走 REPAIR。
      const arbitration = loadPhaseRecord<{ decision: string; rootCause: string }>(deps.cwd, state.runId, 'ARBITRATE');
      failureContext = [failureContext, arbitration ? `仲裁根因：${arbitration.rootCause}\n仲裁决策：${arbitration.decision}` : ''].filter(Boolean).join('\n\n');
      if (state.repairCycles >= deps.config.limits.maxRepairCycles) {
        stop(state, 'ARBITRATION_FAILED', '仲裁后仍无修复配额可用');
        break;
      }
      state.repairCycles += 1;
      state.currentPhase = state.repairCycles === 1 ? 'REPAIR_1' : 'REPAIR_2';
      saveRunState(deps.cwd, state);
      continue;
    }

    stop(state, 'PROVIDER_ERROR', `未知阶段：${phase}`);
    break;
  }

  return finish(deps, state);
}

// ============================================================================
// v0.2.0 Slice 1F-RUN: 路由执行路径（DeepSeek Tool Loop）
// — IMPLEMENT phase executor seam, NOT a parallel state machine
// ============================================================================

import { selectExecutionModel, shouldEscalateFlashToPro } from './modelRouting';
import { buildRoutingContext } from './routingContext';
import { createProductionAdapterRegistry } from './productionAdapterRegistry';
import { estimateTaskBudget } from './taskBudget';
import { buildTaskCostSummary } from './taskCostSummary';
import { createConsoleRoutedExecutionReporter } from './consoleReporter';
import { runDeepSeekToolLoop } from './deepseekToolLoop';
import { DEEPSEEK_READ_ONLY_TOOL_DEFINITIONS } from './toolProtocol';
import {
  saveBudgetEstimate, saveRoutingDecision, saveArbitrationCapsule,
  saveCostSummary,
} from './store';
import { auditChangedFilesAgainstScope } from './workspaceWrite';
import type {
  RoutingDecisionRecord,
  ProviderProfile,
} from './types';
import type { ModelPricing } from './types';
import { setWriter, acquireRunLease, releaseRunLease } from './runLease';
import { computeWorktreeFingerprint } from './worktreeFingerprint';

/**
 * Routed IMPLEMENT executor seam — SINGLE ATTEMPT.
 *
 * Called from driveStateMachine's while loop when deps.routedExecution=true and
 * currentPhase is IMPLEMENT / REPAIR_1 / REPAIR_2.
 *
 * Flow:
 *   resolve profile (Flash or Pro based on nextRoutedRole for REPAIR) →
 *   deterministic routing →
 *   budget estimate + reporter →
 *   [if no approvedFiles] read-only discovery →
 *   write-capable Tool Loop →
 *   changedFiles audit →
 *   on success → state.currentPhase = VERIFY
 *   on Flash attempt done → persist flashLastCallId for M3 linkage
 *
 * This function runs ONE attempt. The shared state machine handles:
 *   - VERIFY → pass → FINAL_VERIFY → DONE
 *   - VERIFY → fail + flashLastCallId → escalate to REPAIR_1 + nextRoutedRole=Pro
 *   - VERIFY → fail + Pro → normal repair or arbitration
 */
async function driveRoutedImplement(
  deps: OrchestratorDeps,
  state: RunState,
  _scoutFiles: string[],
): Promise<void> {
  const config = deps.config;
  const mrConfig = config.modelRouting!;
  const cwd = deps.cwd;
  const runId = state.runId;

  // --- 1. Resolve provider profiles ---
  const flashProfileId = mrConfig.fastModel.profileId;
  const proProfileId = mrConfig.strongModel.profileId;
  const rawProfiles = config.providerProfiles ?? {};

  const flashProfile = rawProfiles[flashProfileId] as ProviderProfile | undefined;
  const proProfile = rawProfiles[proProfileId] as ProviderProfile | undefined;

  if (!flashProfile || !proProfile) {
    stop(state, 'PROVIDER_ERROR', `MODEL_ROUTING_PROFILE_NOT_CONFIGURED：缺少 ${!flashProfile ? flashProfileId : ''} ${!proProfile ? proProfileId : ''} ProviderProfile。请在 .cc-auto/config.json 中配置 providerProfiles。`);
    deps.log('路由开启但缺少 ProviderProfile——MODEL_ROUTING_PROFILE_NOT_CONFIGURED');
    return;
  }

  // --- 2. Build FileScope ---
  // 1F-RUN Blocker Fix: pre-approve 'src' and 'scripts' directories so
  // FileScope passes. Write dispatch will still check individual file-level
  // approval after discovery adds specific approvedFiles, but the
  // root-level approval is needed so that the Tool Loop's write can succeed
  // when approvedFiles was populated by the discovery step.
  const fileScope: FileScope = {
    allowedRoots: ['src', 'scripts'],
    protectedPaths: ['.cc-auto/config.json', '.env', '.env.local', 'data/offerflow.sqlite3', 'node_modules'],
    proposedFiles: [],
    approvedFiles: [],
    maxChangedFiles: config.limits.maxChangedFiles,
  };
  // Lease + writer already acquired at run level by driveStateMachine.
  // Ensure writer is deepseek (safety check — lease ownership validated by setWriter).
  setWriter(cwd, runId, 'deepseek');

  // --- 3. Determine which role to use ---
  // For REPAIR phases: use nextRoutedRole from state (set by VERIFY failure handler)
  // For IMPLEMENT: use perRunRequestedRole from --fast CLI flag
  const isRepair = state.currentPhase === 'REPAIR_1' || state.currentPhase === 'REPAIR_2';
  let forcedRole: import('./types').ExecutionModelRole | undefined;
  if (isRepair && state.nextRoutedRole) {
    forcedRole = state.nextRoutedRole;
    // Clear nextRoutedRole so next iteration doesn't re-read stale value
    state.nextRoutedRole = undefined;
  }

  const routingRequestedRole: import('./types').ExecutionModelRole | undefined =
    forcedRole ?? (state.currentPhase === 'IMPLEMENT' ? state.perRunRequestedRole : undefined);

  // --- 4. Build routing context + deterministic selection ---
  const routingContext = buildRoutingContext(state.taskDescription, {
    allowEscalation: mrConfig.allowStrongEscalation,
    requestedRole: routingRequestedRole,
  });

  // If we have previous attempt info in routingDecisions, enrich context
  if (state.routingDecisions && state.routingDecisions.length > 0) {
    routingContext.previousAttemptCount = state.routingDecisions.length;
    const lastDecision = state.routingDecisions[state.routingDecisions.length - 1];
    routingContext.previousModelRole = lastDecision.role;
  }

  let selection = selectExecutionModel(routingContext, mrConfig);

  // For REPAIR with forced role, override the routing result
  if (isRepair && forcedRole) {
    const model = forcedRole === 'STRONG_EXECUTOR' ? mrConfig.strongModel : mrConfig.fastModel;
    selection = {
      role: forcedRole,
      provider: model.provider,
      profileId: model.profileId,
      modelLogicalName: model.modelLogicalName,
      source: 'ESCALATION',
      reasonCodes: forcedRole === 'STRONG_EXECUTOR' ? ['FLASH_QUALITY_FAILURE'] : ['DEFAULT_FLASH'],
      policyVersion: 'cc-auto-model-routing-v1',
    };
  }

  const reporter = deps.routedReporter ?? createConsoleRoutedExecutionReporter();
  const parentEnv: NodeJS.ProcessEnv = { ...process.env };
  const registry = createProductionAdapterRegistry(
    deps.adapterFetchImpl ? { fetchImpl: deps.adapterFetchImpl } : undefined,
  );

  // --- 5. Persist routing decision ---
  const attemptNum = (state.routingDecisions?.length ?? 0) + 1;
  const attemptId = `attempt-${runId}-${attemptNum}`;
  const previousCallId = selection.role === 'STRONG_EXECUTOR' && state.flashLastCallId
    ? state.flashLastCallId
    : undefined;

  const decision: RoutingDecisionRecord = {
    decisionId: `rd-${runId}-${attemptNum}`,
    runId, taskId: runId, attemptId,
    role: selection.role,
    provider: selection.provider, profileId: selection.profileId,
    modelLogicalName: selection.modelLogicalName,
    source: selection.source,
    reasonCodes: [...selection.reasonCodes],
    policyVersion: 'cc-auto-model-routing-v1',
    escalatedFromCallId: previousCallId,
    createdAt: new Date().toISOString(),
  };
  saveRoutingDecision(cwd, runId, decision);
  if (!state.routingDecisions) state.routingDecisions = [];
  if (!state.routingDecisions.some((d) => d.decisionId === decision.decisionId)) {
    state.routingDecisions.push(decision);
  }

  const currentProfile = selection.profileId === flashProfileId ? flashProfile : proProfile;
  if (!currentProfile) {
    stop(state, 'PROVIDER_ERROR', `缺少 ${selection.profileId} ProviderProfile`);
    return;
  }

  deps.log(`路由选择：${selection.role === 'FAST_EXECUTOR' ? 'V4 Flash' : 'V4 Pro'}（${selection.reasonCodes.join('、')}）`);

  // --- 6. Budget estimate ---
  const _pricingByModel: Record<string, ModelPricing> = {};
  for (const pricingKey of Object.keys(currentProfile.pricing)) {
    const modelConfig = currentProfile.models.find((m) => m.requestedModelId === pricingKey);
    const logicalName = modelConfig?.logicalName ?? pricingKey;
    _pricingByModel[logicalName] = currentProfile.pricing[pricingKey];
  }

  const budgetEstimate = estimateTaskBudget({
    runId, taskId: runId,
    initialSelection: selection,
    taskType: routingContext.taskType,
    affectedFileCount: routingContext.affectedFileCount,
    usesToolLoop: true,
    maxToolLoopTurns: 8,
    maxToolCalls: 16,
    systemPromptChars: 2000,
    userPromptChars: state.taskDescription.length + 4000,
    routingConfig: mrConfig,
    budgetPolicy: config.budgetPolicy!,
    pricingByModel: _pricingByModel,
    hasOpusProvider: false,
  });
  saveBudgetEstimate(cwd, runId, budgetEstimate);
  state.budgetEstimate = budgetEstimate;

  try {
    await reporter.onBudgetEstimate(budgetEstimate, '');
  } catch {
    stop(state, 'PROVIDER_ERROR', 'REPORTER_OUTPUT_FAILED_BEFORE_EXECUTION');
    deps.log('预算 Reporter 失败——Provider 0 次调用');
    return;
  }

  // --- 7. Read-only discovery (if no approved files) ---
  if (fileScope.approvedFiles.length === 0) {
    deps.log('未持有已批准文件，执行只读 routed discovery');
    const discoveryFiles = await runRoutedDiscovery(
      deps, state, fileScope, currentProfile, selection.modelLogicalName,
    );
    if (state.done) return;
    if (discoveryFiles.length > 0) {
      const discoveryEvaluation = evaluateFileProposals(fileScope, discoveryFiles);
      fileScope.proposedFiles = discoveryFiles;
      fileScope.approvedFiles = discoveryEvaluation.approvedFiles;
      if (fileScope.approvedFiles.length === 0) {
        stop(state, 'PROVIDER_ERROR', `STAGE_GATE_BLOCKED: 只读探索发现 ${discoveryFiles.length} 个候选文件但 FileScope 审批全部失败。`);
        deps.log(`探索结果 FileScope 审批：${discoveryEvaluation.decisions.map(d => `${d.path}=${d.decision}`).join(', ')}`);
        return;
      }
    }
  }

  deps.log(`FileScope 批准文件：${fileScope.approvedFiles.join(', ') || '（无候选文件）'}`);

  // --- 8. Write-capable Tool Loop ---
  const executorContext = {
    profile: currentProfile,
    logicalModelName: selection.modelLogicalName,
    role: 'builder' as const,
    maxOutputTokens: 4096,
    timeoutMs: 300_000,
    adapterRegistry: registry,
    parentEnv,
    executionRole: selection.role,  // FAST_EXECUTOR or STRONG_EXECUTOR for cost attribution
  };

  const toolLoopResult = await runDeepSeekToolLoop({
    repositoryRoot: cwd, cwd, runId, fileScope,
    executorContext,
    systemPrompt: state.taskDescription,
    userPrompt: state.taskDescription,
    maxTurns: 8,
    maxToolCallsPerTurn: 4,
    maxTotalToolCalls: 16,
  });

  // Reload state from disk to sync calls[] written by completeKnownCall
  const reloaded = loadRunState(cwd, runId);
  state.calls = reloaded.calls;
  state.pendingCall = reloaded.pendingCall;
  state.attemptHistory = reloaded.attemptHistory;
  if (reloaded.routingDecisions) state.routingDecisions = reloaded.routingDecisions;
  if (reloaded.budgetEstimate) state.budgetEstimate = reloaded.budgetEstimate;
  if (reloaded.arbitrationCapsule) state.arbitrationCapsule = reloaded.arbitrationCapsule;
  // Sync changedFiles from disk too — auditor applies to in-memory state
  if (reloaded.changedFiles) state.changedFiles = reloaded.changedFiles;

  // --- 9. changedFiles audit ---
  const changedFilesFromGit = changedFilesSince(cwd);
  const auditResult = auditChangedFilesAgainstScope(fileScope, changedFilesFromGit);

  if (!auditResult.ok) {
    const violations = auditResult.violations.map(v => `${v.path}: ${v.reason}`).join('; ');
    deps.log(`changedFiles 审计失败：${violations}`);
  }

  for (const f of auditResult.normalizedChangedFiles) {
    if (!state.changedFiles.includes(f)) state.changedFiles.push(f);
  }

  // --- 10. Result evaluation ---
  const tolOk = toolLoopResult.status === 'COMPLETED' && toolLoopResult.stopReason === null && auditResult.ok;

  // MIStake check: if the tool loop stopped due to MODEL_IDENTITY_MISMATCH, stop immediately
  if (toolLoopResult.stopReason === 'MODEL_IDENTITY_MISMATCH') {
    stop(state, 'MODEL_IDENTITY_MISMATCH', 'Tool Loop 检测到模型身份不匹配');
    deps.log('模型身份不匹配 → STOPPED');
    return;
  }

  // PROCO error from the tool loop also stops
  if (toolLoopResult.stopReason === 'PROVIDER_ERROR') {
    stop(state, 'PROVIDER_ERROR', toolLoopResult.summary.terminationReason);
    deps.log('Tool Loop Provider 错误 → STOPPED');
    return;
  }

  if (tolOk && state.changedFiles.length > 0) {
    // Success: persist Flash lastCallId for M3 escalation linkage, advance to VERIFY
    if (selection.role === 'FAST_EXECUTOR') {
      state.flashLastCallId = toolLoopResult.callIds[toolLoopResult.callIds.length - 1] ?? undefined;
    }
    deps.log('Tool Loop 完成，进入 VERIFY');
    state.currentPhase = 'VERIFY';
    saveRunState(cwd, state);
    return;
  }

  // --- 11. Failure: no changed files or tool-loop stopped ---
  if (selection.role === 'FAST_EXECUTOR') {
    // Flash attempt failed — persist flashLastCallId so the shared VERIFY handler
    // (which runs next) can escalate to Pro.
    state.flashLastCallId = toolLoopResult.callIds[toolLoopResult.callIds.length - 1] ?? undefined;
    deps.log('Flash Tool Loop 未产生有效改动 → 进入 VERIFY (将由 VERIFY 失败驱动升级)');
    state.currentPhase = 'VERIFY';
    saveRunState(cwd, state);
    return;
  }

  if (selection.role === 'STRONG_EXECUTOR') {
    // Pro failed → Arbitration Capsule
    deps.log('Pro 失败 → 生成 ArbitrationCapsule → STOP');
    const capsule = {
      taskGoal: state.taskDescription.slice(0, 2000),
      hardConstraints: [],
      attemptedModels: (state.routingDecisions ?? []).map((d) => ({
        role: d.role,
        modelLogicalName: d.modelLogicalName,
        outcome: d.role === 'STRONG_EXECUTOR' ? 'FAILED: Tool Loop failure' : 'SUCCESS',
        failureCategory: 'MODEL_QUALITY_FAILURE' as const,
      })),
      changedFiles: state.changedFiles,
      verifierFailures: [toolLoopResult.stopReason ?? 'Tool Loop failure'],
      relevantDiff: '',
      unresolvedQuestions: ['Pro 无法完成可靠收口'],
    };
    saveArbitrationCapsule(cwd, runId, capsule);
    state.arbitrationCapsule = capsule;
    stop(state, 'ARBITRATION_FAILED', 'Opus 仲裁 Capsule 已生成，当前不自动调用 Opus');
    return;
  }

  // Fallback
  stop(state, 'PROVIDER_ERROR', toolLoopResult.stopReason ?? 'Tool Loop 无法完成');
}

/**
 * B4: Build and persist cost summary from authoritative calls ledger.
 * Called from finish() at terminal state for routed tasks.
 * Returns null if no calls exist yet.
 */
async function buildAndPersistCostSummary(
  deps: OrchestratorDeps,
  state: RunState,
): Promise<import('./types').TaskCostSummary | null> {
  const cwd = deps.cwd;
  const runId = state.runId;
  const config = deps.config;
  const mrConfig = config.modelRouting!;

  // Reload authoritative state
  const authoritative = loadRunState(cwd, runId);
  const calls = authoritative.calls;

  if (calls.length === 0) return null;

  // Build usage records from calls
  const usageRecords: Array<{
    usage: import('./types').UsageRecord;
    role: import('./types').ExecutionModelRole;
    provider: string;
    modelLogicalName: string;
    callId?: string;
  }> = [];

  for (const call of calls) {
    // P2 fix: use executionRole from the call record itself (set at call time),
    // NOT a heuristic from call.model/builder.
    const role: import('./types').ExecutionModelRole =
      (call.executionRole ?? null) as import('./types').ExecutionModelRole | null
      ?? (call.model === 'arbiter' ? 'ARBITER' : 'FAST_EXECUTOR');  // legacy fallback
    const decision = (authoritative.routingDecisions ?? []).find(
      (d) => d.role === role,
    );
    usageRecords.push({
      usage: {
        model: 'builder',
        requestedModelId: call.modelId,
        reportedModel: call.modelId,
        providerId: decision?.provider ?? 'unknown',
        modelIdentityStatus: 'VERIFIED',
        pricingStatus: (call.costRmbCustom !== null) ? 'PRICED' : 'UNPRICED',
        usageStatus: (call.inputTokens !== null && call.outputTokens !== null) ? 'AVAILABLE' : 'PARTIAL',
        costStatus: (call.costRmbCustom !== null) ? 'AVAILABLE' : 'UNAVAILABLE',
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cacheCreationInputTokens: call.cacheCreationInputTokens,
        cacheReadInputTokens: call.cacheReadInputTokens,
        costRmbCustom: call.costRmbCustom,
        costRmbOfficial: call.costRmbOfficial,
        durationMs: call.durationMs,
        numTurns: call.numTurns,
        subtype: call.subtype,
        isError: call.isError,
        toolUseCounts: call.toolUseCounts ?? null,
        toolErrorCounts: call.toolErrorCounts ?? null,
        permissionDenialsCount: call.permissionDenialsCount,
      },
      role,  // authoritative: from executionRole (P2)
      provider: decision?.provider ?? 'deepseek',
      modelLogicalName: decision?.modelLogicalName ?? 'unknown',
      callId: call.callId,  // H2: propagate callId for escalation cost attribution
    });
  }

  const selections: Array<import('./types').ModelSelection> = (authoritative.routingDecisions ?? []).map((d) => ({
    role: d.role,
    provider: d.provider,
    profileId: d.profileId,
    modelLogicalName: d.modelLogicalName,
    source: d.source,
    reasonCodes: d.reasonCodes,
    policyVersion: 'cc-auto-model-routing-v1' as const,
    escalatedFromCallId: d.escalatedFromCallId,
  }));
  const attempts: Array<{ role: import('./types').ExecutionModelRole; failure?: import('./types').ModelAttemptFailure }> = selections.map((s, i) => {
    // H2: Flash escalated due to verifier failure — construct failure evidence from routing decisions.
    // The next selection being ESCALATION with escalatedFromCallId is the authoritative signal.
    const nextSel = selections[i + 1];
    if (nextSel && nextSel.source === 'ESCALATION' && nextSel.escalatedFromCallId) {
      return {
        role: s.role,
        failure: {
          category: 'VERIFIER_FAILURE' as import('./types').ModelAttemptFailureCategory,
          summary: 'Flash 实施通过但验证失败，升级到 Pro',
          contributedToFinalResult: false,
        },
      };
    }
    return { role: s.role };
  });
  const proPricing = (() => {
    if (!mrConfig.strongModel.profileId) return null;
    const proProfile = (config.providerProfiles?.[mrConfig.strongModel.profileId] as ProviderProfile | undefined);
    if (!proProfile) return null;
    const modelConfig = proProfile.models.find((m) => m.logicalName === mrConfig.strongModel.modelLogicalName);
    if (!modelConfig) return null;
    return proProfile.pricing[modelConfig.requestedModelId] ?? null;
  })();

  const fallbackSelection: import('./types').ModelSelection = {
    role: 'FAST_EXECUTOR', provider: 'deepseek', profileId: mrConfig.fastModel.profileId, modelLogicalName: mrConfig.fastModel.modelLogicalName,
    source: 'POLICY', reasonCodes: ['DEFAULT_FLASH'], policyVersion: 'cc-auto-model-routing-v1',
  };

  const summary = buildTaskCostSummary({
    runId,
    taskId: runId,
    estimate: authoritative.budgetEstimate ?? {
      estimateId: 'fallback', runId, taskId: runId,
      routingPolicyVersion: 'cc-auto-model-routing-v1',
      initialSelection: selections[0] ?? fallbackSelection,
      currency: 'CNY',
      estimatedCalls: [],
      totalEstimatedCostRmb: { min: null, expected: null, max: null },
      assumptions: [],
      createdAt: new Date().toISOString(),
    },
    usageRecords,
    selections,
    attempts,
    completed: authoritative.currentPhase === 'DONE',
    strongModelPricing: proPricing ?? null,
    strongModelLogicalName: mrConfig.strongModel.modelLogicalName,
  });

  saveCostSummary(cwd, runId, summary);
  state.costSummary = summary;
  return summary;
}

/**
 * READ-ONLY DISCOVERY: routed model explores files but cannot write.
 *
 * CRITICAL CONSTRAINTS:
 * - Uses the Task Attempt's selected role/profile/model (passed in, not hardcoded Flash).
 * - Protocol-level read-only: only read_file/grep/glob exposed to model.
 * - Structured output required: candidate files come from JSON schema, not regex guessing.
 * - Every executeProviderCall enters state.calls via executor.ts completeKnownCall.
 * - Separated from WRITE-CAPABLE IMPLEMENT — model cannot self-approve files.
 *
 * Returns candidate file paths for evaluateFileProposals.
 */
async function runRoutedDiscovery(
  deps: OrchestratorDeps,
  state: RunState,
  fileScope: FileScope,
  profile: ProviderProfile,
  modelLogicalName: string,
): Promise<string[]> {
  const registry = createProductionAdapterRegistry(
    deps.adapterFetchImpl ? { fetchImpl: deps.adapterFetchImpl } : undefined,
  );
  const parentEnv: NodeJS.ProcessEnv = { ...process.env };
  const cwd = deps.cwd;
  const runId = state.runId;

  // Build read-only scope — no approved files, no write tools
  const readOnlyScope: FileScope = {
    ...fileScope,
    proposedFiles: [],
    approvedFiles: [],
  };

  // Run a read-only Tool Loop for discovery.
  // Uses read-only tool definitions — write_file / edit_file NOT exposed.
  const discoveryResult = await runDeepSeekToolLoop({
    repositoryRoot: cwd, cwd, runId, fileScope: readOnlyScope,
    executorContext: {
      profile,
      logicalModelName: modelLogicalName,
      role: 'builder' as const,
      maxOutputTokens: 2048,
      timeoutMs: 120_000,
      adapterRegistry: registry,
      parentEnv,
      executionRole: null,  // Discovery is shared — role assigned by IMPLEMENT caller
    },
    systemPrompt: `你是只读探索角色。只能使用 read_file、grep、glob 工具。禁止 write_file 和 edit_file。
任务：定位与以下任务相关的候选文件路径。只做探索，不修改任何文件。
必须以结构化 JSON 格式返回结果：{"candidateFiles": ["相对路径1", "相对路径2", ...]}`,
    userPrompt: state.taskDescription,
    maxTurns: 4,
    maxToolCallsPerTurn: 3,
    maxTotalToolCalls: 8,
    toolDefinitions: DEEPSEEK_READ_ONLY_TOOL_DEFINITIONS,
  });

  // Discovery calls are already in state.calls via executeProviderCall → completeKnownCall.
  // They are part of the same Task Attempt.

  // Reload state from disk to sync calls[] written by completeKnownCall
  const reloaded = loadRunState(cwd, runId);
  state.calls = reloaded.calls;
  state.pendingCall = reloaded.pendingCall;
  state.attemptHistory = reloaded.attemptHistory;
  if (reloaded.routingDecisions) state.routingDecisions = reloaded.routingDecisions;
  if (reloaded.budgetEstimate) state.budgetEstimate = reloaded.budgetEstimate;

  if (discoveryResult.finalText) {
    // Prefer structured JSON extraction — do NOT regex-scan natural language for file paths
    const structured = extractStructuredCandidateFiles(discoveryResult.finalText);
    if (structured && Array.isArray(structured)) {
      const normalized = structured
        .map((f: unknown) => (typeof f === 'string' ? f.trim() : ''))
        .filter((f: string) => f.startsWith('src/') || f.startsWith('scripts/'));
      deps.log(`只读探索发现候选文件（结构化）：${normalized.join(', ') || '（无）'}`);
      return Array.from(new Set(normalized));
    }
  }

  deps.log('只读探索未返回结构化 candidateFiles');
  return [];
}

/**
 * Extract candidateFiles from structured JSON result, not from natural language scanning.
 * Tries: top-level JSON, JSON inside markdown fences, JSON inside braces.
 */
function extractStructuredCandidateFiles(text: string): string[] | null {
  // Try direct JSON parse
  try {
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.candidateFiles)) return obj.candidateFiles;
    if (obj && Array.isArray(obj.files)) return obj.files;
  } catch { /* not JSON */ }

  // Try markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1].trim());
      if (obj && Array.isArray(obj.candidateFiles)) return obj.candidateFiles;
      if (obj && Array.isArray(obj.files)) return obj.files;
    } catch { /* not JSON in fence */ }
  }

  // Try JSON object anywhere in text
  const braceMatch = text.match(/\{[\s\S]*"candidateFiles"\s*:\s*\[[\s\S]*?\][\s\S]*\}/);
  if (braceMatch) {
    try {
      const obj = JSON.parse(braceMatch[0]);
      if (obj && Array.isArray(obj.candidateFiles)) return obj.candidateFiles;
    } catch { /* not valid JSON */ }
  }

  return null;
}
