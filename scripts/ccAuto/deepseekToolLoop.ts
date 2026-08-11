/** cc-auto v0.2.0 Slice 1E-W — DeepSeek 受控写入工具循环。
 *
 * 每轮通过正式 executeProviderCall（executor.ts）调用 Adapter，
 * 产生独立的 PendingCall → CallRecord → UsageRecord。
 *
 * Slice 1E-W 扩展：read_file / grep / glob / write_file / edit_file
 * 所有写操作通过 workspaceWrite.ts 的 Safe Write/Edit 执行点。
 * Tool Loop 不自动 setWriter、不自动修改 FileScope、不自动批准文件。
 *
 * 1E-W 瞬时重试：仅当 Provider 返回 429/5xx 时有限重试（最多 2 次），
 * 每次重试都通过独立的 executeProviderCall → 独立 callId。
 */
import type {
  ProviderChatMessage,
  ModelToolCall,
  ToolExecutionEnvelope,
  DeepSeekToolLoopStopReason,
  DeepSeekToolLoopResult,
  DeepSeekToolLoopSummary,
  DeepSeekToolLoopOptions,
  ToolLoopAuditRecord,
  ToolLoopTerminationReason,
  ParsedToolCall,
  ModelIdentityStatus,
  UsageRecord,
  ProviderToolDefinition,
  ProviderToolMode,
  DeepSeekToolLoopExecutorContext,
  ProviderExecutionStopReason,
  ToolExecutionErrorReason,
} from './types';
import { parseToolCalls, DEEPSEEK_FILE_TOOL_DEFINITIONS } from './toolProtocol';
import { dispatchDeepSeekTool, buildToolResultMessage } from './toolDispatcher';
import { executeProviderCall, newCallId } from './executor';
import { createWorkspaceReadBudget } from './workspaceRead';

// ============================================================================

const DEFAULT_MAX_TURNS = 4;
const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 4;
const DEFAULT_MAX_TOTAL_TOOL_CALLS = 8;
const DEFAULT_MAX_HISTORY_CHARS = 200_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 16_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300_000; // 5 min
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;

const HARD_LIMITS = {
  maxTurns: 20,
  maxToolCallsPerTurn: 10,
  maxTotalToolCalls: 100,
  maxHistoryChars: 1_000_000,
  maxToolResultChars: 64_000,
  maxTotalReadBytes: 10 * 1024 * 1024,
  maxWriteContentBytes: 512_000,
  maxEditContentBytes: 128_000,
} as const;

const TOOL_LOOP_SYSTEM_PROMPT_PREFIX = `你是一个只能在宿主授权的工作区范围内使用文件工具的 AI 助手。

你可使用的工具只有：read_file、grep、glob、write_file、edit_file。

安全约束：
- 只能使用提供的工具
- 不得声称执行未提供的 Bash、Git 或测试命令
- 不得请求凭证
- 不得读取 .git、.env、.cc-auto/config.json、node_modules 等保护路径
- 工具错误必须作为事实接受，不得尝试绕过安全边界
- 不得虚构工具结果
- 最终回答只能总结经过工具验证的事实
- write_file 和 edit_file 只能写入已批准的文件路径；写入结果以 Dispatcher 返回为准

`;

// ============================================================================

function stableJsonLength(value: unknown): number {
  try { return JSON.stringify(value).length; } catch { return 0; }
}

/** 包含可能的 content、tool_calls 和 reasoning_content 的消息——用于追加 assistant 消息 */
function buildAssistantMessage(
  content: string | null,
  toolCalls: ModelToolCall[],
  reasoningContent?: string | null,
): ProviderChatMessage {
  if (toolCalls.length > 0) {
    return { role: 'assistant', content: content ?? null, toolCalls, reasoningContent: reasoningContent ?? null };
  }
  return { role: 'assistant', content: content ?? null, reasoningContent: reasoningContent ?? null };
}

function auditRecord(
  turn: number,
  toolCall: ParsedToolCall,
  status: ToolLoopAuditRecord['status'],
  resultOk: boolean | null,
  errorReason: ToolLoopAuditRecord['errorReason'],
): ToolLoopAuditRecord {
  return {
    turn,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    status,
    resultOk,
    errorReason,
  };
}

/** 只读工具：read_file、grep、glob */
const READ_ONLY_TOOL_NAMES = new Set<string>(['read_file', 'grep', 'glob']);

/** 可恢复的只读探索错误——模型定位/搜索范围有误，允许看到错误后自行修正路径 */
const RECOVERABLE_READ_FAILURE_REASONS: ReadonlySet<ToolExecutionErrorReason> = new Set([
  'FILE_NOT_FOUND',
  'FILE_NOT_REGULAR_FILE',
  'DIRECTORY_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'FILE_NOT_UTF8',
  'BINARY_FILE',
  'MAX_OUTPUT_EXCEEDED',
  'SCAN_LIMIT_EXCEEDED',
  'ARGUMENT_VALUE_INVALID',
]);

function isReadOnlyToolCall(tc: ParsedToolCall): boolean {
  return READ_ONLY_TOOL_NAMES.has(tc.name);
}

function isRecoverableReadToolFailure(envelope: ToolExecutionEnvelope): boolean {
  if (envelope.ok) return false;
  return RECOVERABLE_READ_FAILURE_REASONS.has(envelope.error.reason);
}

function toolCallSignature(parsedCall: ParsedToolCall): string {
  return `${parsedCall.name}:${stableStringify(parsedCall.arguments)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function validPositiveLimit(value: number, hardMaximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= hardMaximum;
}

function validLimits(limits: {
  maxTurns: number;
  maxToolCallsPerTurn: number;
  maxTotalToolCalls: number;
  maxHistoryChars: number;
  maxToolResultChars: number;
  maxTotalReadBytes: number;
  maxWriteContentBytes: number;
  maxEditContentBytes: number;
}): boolean {
  return validPositiveLimit(limits.maxTurns, HARD_LIMITS.maxTurns)
    && validPositiveLimit(limits.maxToolCallsPerTurn, HARD_LIMITS.maxToolCallsPerTurn)
    && validPositiveLimit(limits.maxTotalToolCalls, HARD_LIMITS.maxTotalToolCalls)
    && limits.maxTotalToolCalls >= limits.maxToolCallsPerTurn
    && validPositiveLimit(limits.maxHistoryChars, HARD_LIMITS.maxHistoryChars)
    && Number.isSafeInteger(limits.maxToolResultChars)
    && limits.maxToolResultChars >= 192
    && limits.maxToolResultChars <= HARD_LIMITS.maxToolResultChars
    && validPositiveLimit(limits.maxTotalReadBytes, HARD_LIMITS.maxTotalReadBytes)
    && validPositiveLimit(limits.maxWriteContentBytes, HARD_LIMITS.maxWriteContentBytes)
    && validPositiveLimit(limits.maxEditContentBytes, HARD_LIMITS.maxEditContentBytes);
}

/**
 * 瞬时错误判定：
 * - 429 / 5xx HTTP → 瞬时
 * - TransportError.transient === true → 瞬时（ECONNRESET 等已知瞬时网络失败）
 * - 其他所有（400、auth、balance、mismatch、unverified、unknown crash）→ 不重试
 */
function isTransientProviderError(
  result: {
    errorKind?: string;
    httpStatus?: number | null;
    transientTransportError?: boolean;
    requiresHumanConfirmation?: boolean;
    stopReason?: ProviderExecutionStopReason | null;
  },
): boolean {
  // Never retry requiresHumanConfirmation (UNVERIFIED) or MISMATCH
  if (result.requiresHumanConfirmation) return false;
  if (result.stopReason === 'MODEL_IDENTITY_MISMATCH') return false;
  if (result.stopReason === 'UNKNOWN_AFTER_CRASH') return false;

  if (result.transientTransportError === true) return true;
  if (result.errorKind === 'RATE_LIMIT') return true;
  if (result.errorKind === 'HTTP' && result.httpStatus !== null && result.httpStatus !== undefined) {
    return result.httpStatus >= 500 && result.httpStatus < 600;
  }
  return false;
}

/**
 * 停止原因映射——如实区分 Provider 错误类别。
 * 不再将所有 Provider 失败映射为 PROVIDER_RETRY_EXHAUSTED。
 */
function classifyProviderFailure(
  result: {
    stopReason: ProviderExecutionStopReason | null;
    requiresHumanConfirmation: boolean;
    errorKind?: string;
    httpStatus?: number | null;
  },
): DeepSeekToolLoopStopReason {
  const sr = result.stopReason;
  if (sr === 'MODEL_IDENTITY_MISMATCH') return 'MODEL_IDENTITY_MISMATCH';
  if (sr === 'COST_UNAVAILABLE') return 'PROVIDER_ERROR';
  if (sr === 'PROVIDER_TIMEOUT') return 'TURN_TIMEOUT';
  if (sr === 'UNKNOWN_AFTER_CRASH') return 'UNKNOWN_AFTER_CRASH';
  // default: non-transient PROVIDER_ERROR
  return 'PROVIDER_ERROR';
}

function estimateHistorySize(messages: ProviderChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.content) total += m.content.length;
      if (m.toolCalls) total += stableJsonLength(m.toolCalls);
      if (m.reasoningContent) total += m.reasoningContent.length;
    } else if (m.role === 'tool') {
      total += m.content.length;
    } else if (m.content) {
      total += m.content.length;
    }
  }
  return total;
}

/** Monotonic clock——不受系统时钟回拨影响 */
function monotonicNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function mapToTerminationReason(
  stopReason: DeepSeekToolLoopStopReason | null,
  status: 'COMPLETED' | 'STOPPED',
): ToolLoopTerminationReason {
  if (status === 'COMPLETED') return 'FINAL_RESPONSE';
  switch (stopReason) {
    case 'TOOL_EXECUTION_FAILED': return 'TOOL_EXECUTION_FAILED';
    case 'TOOL_PROTOCOL_ERROR': return 'TOOL_PROTOCOL_FAILED';
    case 'MAX_TURNS_EXCEEDED': case 'MAX_TOOL_CALLS_PER_TURN_EXCEEDED':
    case 'MAX_TOTAL_TOOL_CALLS_EXCEEDED': return 'MAX_TOOL_CALLS_EXCEEDED';
    case 'DUPLICATE_TOOL_CALL_ID': case 'REPEATED_TOOL_CALL': return 'REPEATED_TOOL_ERROR';
    case 'CONTEXT_LIMIT_EXCEEDED': return 'HISTORY_LIMIT_EXCEEDED';
    case 'TOTAL_TIMEOUT': return 'TOTAL_TIMEOUT';
    case 'TURN_TIMEOUT': return 'TURN_TIMEOUT';
    case 'PROVIDER_RETRY_EXHAUSTED': return 'PROVIDER_RETRY_EXHAUSTED';
    case 'PROVIDER_ERROR': return 'PROVIDER_ERROR';
    case 'MODEL_IDENTITY_MISMATCH': return 'MODEL_IDENTITY_MISMATCH';
    case 'MODEL_IDENTITY_UNVERIFIED': return 'MODEL_IDENTITY_UNVERIFIED';
    case 'UNKNOWN_AFTER_CRASH': return 'UNKNOWN_AFTER_CRASH';
    case 'CANCELLED': return 'CANCELLED';
    case 'LIMIT_CONFIGURATION_INVALID': case 'EMPTY_FINAL_RESPONSE':
    default: return 'TOOL_PROTOCOL_FAILED';
  }
}

/** 默认退避定时器——生产环境使用。测试可注入 fake sleeper。 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================

export async function runDeepSeekToolLoop(
  options: DeepSeekToolLoopOptions,
): Promise<DeepSeekToolLoopResult> {
  const {
    repositoryRoot, cwd, runId, fileScope, executorContext,
    systemPrompt, userPrompt,
  } = options;
  const limits = {
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    maxToolCallsPerTurn: options.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN,
    maxTotalToolCalls: options.maxTotalToolCalls ?? DEFAULT_MAX_TOTAL_TOOL_CALLS,
    maxHistoryChars: options.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS,
    maxToolResultChars: options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS,
    maxTotalReadBytes: options.maxTotalReadBytes ?? 256 * 1024,
    maxWriteContentBytes: options.maxWriteContentBytes ?? HARD_LIMITS.maxWriteContentBytes,
    maxEditContentBytes: options.maxEditContentBytes ?? HARD_LIMITS.maxEditContentBytes,
    totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
  } as const;
  const maxTransientRetries = options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
  const sleep = options.sleep ?? defaultSleep;

  const fullSystemPrompt = TOOL_LOOP_SYSTEM_PROMPT_PREFIX + systemPrompt;
  const callIdFactory = executorContext.callIdFactory ?? newCallId;
  const tools = options.toolDefinitions ?? DEEPSEEK_FILE_TOOL_DEFINITIONS;

  const messages: ProviderChatMessage[] = [
    { role: 'system', content: fullSystemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const executedTools: ToolExecutionEnvelope[] = [];
  const callIds: string[] = [];
  const auditTrail: ToolLoopAuditRecord[] = [];
  const seenToolCallIds = new Set<string>();
  const seenToolCallSignatures = new Set<string>();
  const allInputTokens: (number | null)[] = [];
  const allOutputTokens: (number | null)[] = [];
  const changedFilesSet = new Set<string>();
  let turns = 0;
  let totalToolCalls = 0;
  const startMs = monotonicNow();
  let finalText: string | null = null;

  // 保存最近一次成功的 Provider 执行证据（用于 Summary）
  let lastVerifiedUsage: {
    requestedModelId: string;
    reportedModel: string | null;
    modelIdentityStatus: ModelIdentityStatus;
    provider: string;
    profileId: string;
  } | null = null;

  // 保存最后一次 Provider 失败诊断（用于 Summary 和 Orchestrator stopDetail）
  let lastFailureDetail: import('./types').ProviderFailureDetail | null = null;

  if (!validLimits(limits)) return buildResult('STOPPED', null, 'LIMIT_CONFIGURATION_INVALID');
  const readBudget = createWorkspaceReadBudget(limits.maxTotalReadBytes);
  const secretValues = executorContext.profile.credentialEnvVars
    .map((name) => executorContext.parentEnv[name]);

  while (turns < limits.maxTurns) {
    turns++;

    // 总超时检查
    if (monotonicNow() - startMs > limits.totalTimeoutMs) {
      return buildResult('STOPPED', null, 'TOTAL_TIMEOUT');
    }

    if (estimateHistorySize(messages) > limits.maxHistoryChars) {
      return buildResult('STOPPED', null, 'CONTEXT_LIMIT_EXCEEDED');
    }

    // 1. 通过正式 executeProviderCall 调用 Provider（含瞬时重试）
    const providerResult = await executeProviderCallWithRetry({
      messages,
      tools,
      toolMode: 'enabled',
      maxTransientRetries,
      sleep,
      callIdFactory,
      executorContext,
      cwd,
      runId,
    });

    // 收集所有实际调用 ID（包括重试的）
    for (const cid of providerResult.allCallIds) {
      callIds.push(cid);
    }

    // 2. Provider 失败 → 根据原因分类终止
    if (!providerResult.ok) {
      const errResult = providerResult;
      // 捕获 failureDetail 用于最终诊断
      lastFailureDetail = errResult.failureDetail ?? null;
      // requiresHumanConfirmation → MODEL_IDENTITY_UNVERIFIED
      if (errResult.requiresHumanConfirmation) {
        return buildResult('STOPPED', null, 'MODEL_IDENTITY_UNVERIFIED');
      }
      if (errResult.providerRetryExhausted) {
        return buildResult('STOPPED', null, 'PROVIDER_RETRY_EXHAUSTED');
      }
      const classified = classifyProviderFailure({
        stopReason: errResult.stopReason ?? null,
        requiresHumanConfirmation: false,
        errorKind: errResult.errorKind,
        httpStatus: errResult.httpStatus,
      });
      return buildResult('STOPPED', null, classified);
    }

    // 3. 成功：保存 Usage 证据
    const usageRec = providerResult.usageRecord;
    allInputTokens.push(usageRec?.inputTokens ?? null);
    allOutputTokens.push(usageRec?.outputTokens ?? null);

    if (usageRec) {
      lastVerifiedUsage = {
        requestedModelId: usageRec.requestedModelId,
        reportedModel: usageRec.reportedModel,
        modelIdentityStatus: usageRec.modelIdentityStatus,
        provider: usageRec.providerId, // providerId 来自 UsageRecord
        profileId: executorContext.profile.id,
      };
    }

    const content = providerResult.content ?? '';
    const rawToolCalls = providerResult.toolCalls ?? [];
    const reasoningContent = providerResult.reasoningContent ?? null;

    // 4. 无 tool_calls → COMPLETED（final text）
    if (rawToolCalls.length === 0) {
      if (!content || content.trim().length === 0) {
        return buildResult('STOPPED', null, 'EMPTY_FINAL_RESPONSE');
      }
      finalText = content;
      return buildResult('COMPLETED', finalText, null);
    }

    // 5. content + tool_calls → 执行工具，不得将该 content 当作最终结果

    // 6. 校验 tool_calls 数量
    if (rawToolCalls.length > limits.maxToolCallsPerTurn) {
      recordRawCalls(rawToolCalls);
      return buildResult('STOPPED', null, 'MAX_TOOL_CALLS_PER_TURN_EXCEEDED');
    }
    if (totalToolCalls + rawToolCalls.length > limits.maxTotalToolCalls) {
      recordRawCalls(rawToolCalls);
      return buildResult('STOPPED', null, 'MAX_TOTAL_TOOL_CALLS_EXCEEDED');
    }

    // 7. 解析工具调用（传入 write/edit 限额）
    const parsedResult = parseToolCalls(rawToolCalls, {
      maxWriteContentBytes: limits.maxWriteContentBytes,
      maxEditContentBytes: limits.maxEditContentBytes,
    });
    if (!parsedResult.ok) {
      const raw = rawToolCalls[parsedResult.toolCallIndex ?? 0];
      auditTrail.push({
        turn: turns,
        toolCallId: raw?.id?.slice(0, 256) ?? '',
        toolName: raw?.function?.name?.slice(0, 128) ?? 'unknown',
        status: 'REJECTED_PROTOCOL', resultOk: null, errorReason: parsedResult.reason,
      });
      return buildResult('STOPPED', null,
        parsedResult.reason === 'DUPLICATE_TOOL_CALL_ID'
          ? 'DUPLICATE_TOOL_CALL_ID'
          : 'TOOL_PROTOCOL_ERROR');
    }

    const signaturesThisRound = new Set(seenToolCallSignatures);
    for (const toolCall of parsedResult.parsed) {
      if (seenToolCallIds.has(toolCall.id)) {
        auditTrail.push(auditRecord(turns, toolCall, 'REJECTED_PROTOCOL', null, 'DUPLICATE_TOOL_CALL_ID'));
        return buildResult('STOPPED', null, 'DUPLICATE_TOOL_CALL_ID');
      }
      const signature = toolCallSignature(toolCall);
      if (signaturesThisRound.has(signature)) {
        auditTrail.push(auditRecord(turns, toolCall, 'REJECTED_REPEAT', null, null));
        return buildResult('STOPPED', null, 'REPEATED_TOOL_CALL');
      }
      signaturesThisRound.add(signature);
    }

    // 追加 assistant 消息（含原始 tool_calls + content + reasoning_content）
    messages.push(buildAssistantMessage(content, rawToolCalls, reasoningContent));

    // 8. 串行执行工具
    const readOnlyTurn = parsedResult.parsed.every(isReadOnlyToolCall);
    let recoverableFailureOccurred = false;

    for (let index = 0; index < parsedResult.parsed.length; index++) {
      const tc = parsedResult.parsed[index];
      seenToolCallIds.add(tc.id);
      seenToolCallSignatures.add(toolCallSignature(tc));
      totalToolCalls++;

      const envelope = await dispatchDeepSeekTool({
        repositoryRoot, cwd, runId, fileScope,
        toolCall: rawToolCalls[index],
        readBudget,
      });
      executedTools.push(envelope);
      auditTrail.push(auditRecord(turns, tc, 'EXECUTED', envelope.ok, envelope.ok ? null : envelope.error.reason));

      // Track file changes (write_file & edit_file)
      if (envelope.ok) {
        if (envelope.toolName === 'write_file' && envelope.result?.kind === 'write_file') {
          (changedFilesSet as Set<string>).add(envelope.result.path);
        } else if (envelope.toolName === 'edit_file' && envelope.result?.kind === 'edit_file') {
          (changedFilesSet as Set<string>).add(envelope.result.path);
        }
      }

      messages.push(buildToolResultMessage(envelope, {
        maxChars: limits.maxToolResultChars,
        secrets: secretValues,
      }));

      // 任何工具失败 → 判断是否可恢复
      if (!envelope.ok) {
        if (readOnlyTurn && isRecoverableReadToolFailure(envelope)) {
          recoverableFailureOccurred = true;
          continue; // 继续本 turn 剩余工具，允许下一 Provider turn 看到错误后自行修正
        }
        // 不可恢复：skip 剩余工具，fail-fast
        for (const skipped of parsedResult.parsed.slice(index + 1)) {
          auditTrail.push(auditRecord(turns, skipped, 'SKIPPED_AFTER_FAILURE', null, null));
        }
        return buildResult('STOPPED', null, 'TOOL_EXECUTION_FAILED');
      }
    }

    // 如果本 turn 所有工具都失败了但都是可恢复的，仍然不返回 TOOL_EXECUTION_FAILED —
    // 自然进入下一 Provider turn（受 maxTurns / maxTotalToolCalls 限制）
    void recoverableFailureOccurred;
  }

  return buildResult('STOPPED', null, 'MAX_TURNS_EXCEEDED');

  // ==========================================================================
  // buildResult: 统一构造 DeepSeekToolLoopResult + DeepSeekToolLoopSummary
  // ==========================================================================

  function buildResult(
    status: 'COMPLETED' | 'STOPPED',
    text: string | null,
    stopReason: DeepSeekToolLoopStopReason | null,
  ): DeepSeekToolLoopResult {
    const durationMs = monotonicNow() - startMs;
    const totalInput = sumTokens(allInputTokens);
    const totalOutput = sumTokens(allOutputTokens);
    const totalAll = (totalInput !== null && totalOutput !== null) ? totalInput + totalOutput : null;

    // Summary 来自执行证据，不是配置推测
    const evidence = lastVerifiedUsage;

    const summary: DeepSeekToolLoopSummary = {
      turns,
      toolCallCount: totalToolCalls,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalAll,
      durationMs,
      terminationReason: mapToTerminationReason(stopReason, status),
      provider: executorContext.profile.vendor, // vendor，不是 profile.id
      profileId: executorContext.profile.id,
      requestedModelId: evidence?.requestedModelId ?? null,
      resolvedModelId: evidence?.reportedModel ?? null,
      modelIdentity: evidence?.modelIdentityStatus ?? 'UNKNOWN',
      callIds: [...callIds],
      changedFiles: [...(changedFilesSet as Set<string>)],
    };

    return {
      status,
      finalText: text,
      turns,
      totalToolCalls,
      executedTools,
      stopReason,
      callIds,
      auditTrail,
      summary,
      failureDetail: lastFailureDetail,
    };
  }

  function recordRawCalls(calls: ModelToolCall[]): void {
    for (const call of calls) {
      auditTrail.push({
        turn: turns,
        toolCallId: typeof call.id === 'string' ? call.id.slice(0, 256) : '',
        toolName: typeof call.function?.name === 'string' ? call.function.name.slice(0, 128) : 'unknown',
        status: 'REJECTED_LIMIT', resultOk: null, errorReason: null,
      });
    }
  }
}

// ============================================================================
// executeProviderCallWithRetry——瞬时 Provider 错误有限重试
// ============================================================================

interface RetryContext {
  messages: ProviderChatMessage[];
  tools: ProviderToolDefinition[];
  toolMode: ProviderToolMode;
  maxTransientRetries: number;
  sleep: (ms: number) => Promise<void>;
  callIdFactory: () => string;
  executorContext: DeepSeekToolLoopExecutorContext;
  cwd: string;
  runId: string;
}

interface RetryResult {
  ok: boolean;
  content?: string | null;
  toolCalls?: ModelToolCall[];
  reasoningContent?: string | null;
  usageRecord?: UsageRecord | null;
  allCallIds: string[];
  // failure-specific
  stopReason?: ProviderExecutionStopReason | null;
  requiresHumanConfirmation?: boolean;
  errorKind?: string;
  httpStatus?: number | null;
  transientTransportError?: boolean;
  providerRetryExhausted?: boolean;
  /** v0.8.x 诊断修复：最后一个失败 attempt 的安全结构化诊断摘要 */
  failureDetail?: import('./types').ProviderFailureDetail | null;
}

const BACKOFF_MS = [250, 500];

async function executeProviderCallWithRetry(
  ctx: RetryContext,
): Promise<RetryResult> {
  const allCallIds: string[] = [];
  let lastErrorKind: string | undefined;
  let lastHttpStatus: number | null | undefined;
  let attempts = 0;

  for (let i = 0; i <= ctx.maxTransientRetries; i++) {
    const callId = ctx.callIdFactory();
    allCallIds.push(callId);
    attempts = i + 1;

    const result = await executeProviderCall({
      profile: ctx.executorContext.profile,
      logicalModelName: ctx.executorContext.logicalModelName,
      role: ctx.executorContext.role,
      systemPrompt: '',
      userPrompt: '',
      maxOutputTokens: ctx.executorContext.maxOutputTokens,
      timeoutMs: ctx.executorContext.timeoutMs,
      adapterRegistry: ctx.executorContext.adapterRegistry,
      parentEnv: ctx.executorContext.parentEnv,
      cwd: ctx.cwd,
      runId: ctx.runId,
      messages: ctx.messages,
      tools: ctx.tools,
      toolMode: ctx.toolMode,
      callId,
      executionRole: ctx.executorContext.executionRole ?? null,
    });

    // Success
    if (result.ok) {
      return {
        ok: true,
        content: result.content,
        toolCalls: result.toolCalls,
        reasoningContent: result.reasoningContent,
        usageRecord: result.usageRecord,
        allCallIds,
      };
    }

    lastErrorKind = result.errorKind;
    lastHttpStatus = result.httpStatus;

    // Check if transient and we have retries remaining
    if (i < ctx.maxTransientRetries && isTransientProviderError({
      errorKind: result.errorKind,
      httpStatus: result.httpStatus,
      transientTransportError: result.transientTransportError,
      requiresHumanConfirmation: result.requiresHumanConfirmation,
      stopReason: result.stopReason,
    })) {
      const delay = BACKOFF_MS[i] ?? 500;
      await ctx.sleep(delay);
      continue;
    }

    // Non-transient or retries exhausted
    return {
      ok: false,
      allCallIds,
      stopReason: result.stopReason,
      requiresHumanConfirmation: result.requiresHumanConfirmation,
      errorKind: result.errorKind,
      httpStatus: result.httpStatus,
      transientTransportError: result.transientTransportError,
      failureDetail: result.failureDetail ?? null,
      providerRetryExhausted: attempts > 1 && isTransientProviderError({
        errorKind: result.errorKind,
        httpStatus: result.httpStatus,
        transientTransportError: result.transientTransportError,
        requiresHumanConfirmation: result.requiresHumanConfirmation,
        stopReason: result.stopReason,
      }),
    };
  }

  // Should never reach here (loop condition handles it), but types need this
  return {
    ok: false,
    allCallIds,
    stopReason: null,
    requiresHumanConfirmation: false,
    errorKind: lastErrorKind,
    httpStatus: lastHttpStatus,
    providerRetryExhausted: attempts > 1,
  };
}

function sumTokens(values: (number | null)[]): number | null {
  let total = 0;
  let anyKnown = false;
  for (const v of values) {
    if (v !== null && v !== undefined) {
      total += v;
      anyKnown = true;
    }
  }
  return anyKnown ? total : null;
}
