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
import type { Phase } from './types';

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
    state.opusCalls += 1;
    if (!result) return null;
    return result.structuredOutput as { decision: string; rootCause: string };
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

export async function runTask(deps: OrchestratorDeps, taskDescription: string, estimatedFiles?: number): Promise<RunState> {
  const runId = newRunId();
  const state = createRunState(deps.cwd, runId, taskDescription, deps.config.pricingMode);
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

function finish(deps: OrchestratorDeps, state: RunState): RunState {
  saveRunState(deps.cwd, state);
  const markdown = renderReport(state);
  const reportPath = writeReport(deps.cwd, state.runId, markdown);
  deps.log(`报告已写入：${reportPath}`);
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
  // 启动任何 claude 子进程之前：先校验四个角色配置的模型 ID 都能定价，
  // 再验证 claude 可执行文件能否启动，否则立即 STOPPED，绝不 spawn 任何子进程。
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

  const classification = state.classification!;
  const taskBudgetRmb = budgetForComplexity(deps.config, classification.complexity);
  let scoutFiles: string[] = loadPhaseRecord<{ structuredOutput?: { relevantFiles?: string[] } }>(deps.cwd, state.runId, 'SCOUT')?.structuredOutput?.relevantFiles ?? [];

  if (state.currentPhase === 'SCOUT') {
    scoutFiles = await runScout(deps, state, taskBudgetRmb);
    if (state.done) return finish(deps, state);
    state.currentPhase = 'IMPLEMENT';
    saveRunState(deps.cwd, state);
  }

  // 首个 IMPLEMENT 且命中 Direct Edit 条件时，先尝试真实 Direct Edit 执行路径。
  // 仅当真实应用成功才置 directEdit=true 并直接进入验证；准备失败回退标准 Builder；应用失败已 STOPPED。
  if (state.currentPhase === 'IMPLEMENT' && state.repairCycles === 0 && !state.directEdit) {
    const eligibility = evaluateDirectEditEligibility(classification, state.taskDescription, deps.config);
    if (eligibility.eligible) {
      deps.log(`命中 Simple Direct Edit 条件（目标文件：${eligibility.targetFiles.join(', ')}），尝试机器定向编辑`);
      const outcome = await runDirectEdit(deps, state, taskBudgetRmb, eligibility.targetFiles);
      // 候选任务的准备/校验/应用失败都会置 STOPPED（DIRECT_EDIT_PREPARE_FAILED / DIRECT_EDIT_APPLY_FAILED），
      // 一律在此结束，绝不落入下方标准 Agent Builder 路径。
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
    if (state.currentPhase === 'IMPLEMENT' || state.currentPhase === 'REPAIR_1' || state.currentPhase === 'REPAIR_2') {
      const builderResult = await runBuilder(deps, state, state.currentPhase, taskBudgetRmb, scoutFiles, failureContext, classification.touchesHighRisk, classification.complexity);
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

    if (state.currentPhase === 'VERIFY' || state.currentPhase === 'FINAL_VERIFY') {
      const isFinal = state.currentPhase === 'FINAL_VERIFY';
      const runOnce = isFinal
        ? () => deps.runFullVerification()
        : () => {
            const targetFiles = changedFilesSince(deps.cwd);
            return deps.runTests(targetFiles.length > 0 ? targetFiles : state.changedFiles);
          };
      const verifyResult = await verifyWithFlakyGuard(runOnce);
      savePhaseRecord(deps.cwd, state.runId, state.currentPhase, verifyResult);
      if (verifyResult.flaky) {
        stop(state, 'FLAKY_TESTS', '同配置重跑一次后结果仍不稳定（两次结果不一致），停止等待人工确认');
        break;
      }
      if (verifyResult.passed) {
        if (isFinal) { state.currentPhase = 'DONE'; state.done = true; }
        else { state.currentPhase = 'FINAL_VERIFY'; }
        saveRunState(deps.cwd, state);
        continue;
      }
      const fingerprint = computeFailureFingerprint(verifyResult.output);
      const repeated = fingerprint === lastFingerprint;
      lastFingerprint = fingerprint;
      failureContext = truncateLog(verifyResult.output);
      state.failures.push({ phase: state.currentPhase, fingerprint, summary: '验证失败', truncatedLog: failureContext, createdAt: new Date().toISOString() });

      if (shouldEscalateToArbiter({ riskScore: classification.riskScore, touchesHighRisk: classification.touchesHighRisk, repeatedFingerprint: repeated, acceptanceConflict: false })) {
        state.currentPhase = 'ARBITRATE';
        saveRunState(deps.cwd, state);
        continue;
      }
      if (state.repairCycles >= deps.config.limits.maxRepairCycles) {
        stop(state, 'REPEATED_FAILURE_FINGERPRINT', '已用尽修复配额，仍未通过验证');
        break;
      }
      state.repairCycles += 1;
      state.currentPhase = state.repairCycles === 1 ? 'REPAIR_1' : 'REPAIR_2';
      saveRunState(deps.cwd, state);
      continue;
    }

    if (state.currentPhase === 'ARBITRATE') {
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

    if (state.currentPhase === 'APPLY_DECISION') {
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

    stop(state, 'PROVIDER_ERROR', `未知阶段：${state.currentPhase}`);
    break;
  }

  return finish(deps, state);
}
