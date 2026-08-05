/** cc-auto v0.2.0 Slice 1E — DeepSeek 受控 Tool Loop。
 *
 * 每轮通过正式 executeProviderCall（executor.ts）调用 Adapter，
 * 产生独立的 PendingCall → CallRecord → UsageRecord。
 */
import type {
  ProviderChatMessage,
  ModelToolCall,
  ToolExecutionEnvelope,
  DeepSeekToolLoopStopReason,
  DeepSeekToolLoopResult,
  DeepSeekToolLoopOptions,
  ToolLoopAuditRecord,
  ParsedToolCall,
} from './types';
import { parseToolCalls, DEEPSEEK_FILE_TOOL_DEFINITIONS } from './toolProtocol';
import { dispatchDeepSeekTool, buildToolResultMessage } from './toolDispatcher';
import { executeProviderCall, newCallId } from './executor';
import { createWorkspaceReadBudget } from './workspaceRead';

// ============================================================================

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 4;
const DEFAULT_MAX_TOTAL_TOOL_CALLS = 16;
const DEFAULT_MAX_HISTORY_CHARS = 200_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 16_000;

const HARD_LIMITS = {
  maxTurns: 20,
  maxToolCallsPerTurn: 10,
  maxTotalToolCalls: 100,
  maxHistoryChars: 1_000_000,
  maxToolResultChars: 64_000,
  maxTotalReadBytes: 10 * 1024 * 1024,
} as const;

const TOOL_LOOP_SYSTEM_PROMPT_PREFIX = `你是一个只能在宿主授权的工作区范围内使用只读文件工具的 AI 助手。

你可使用的工具只有：read_file、grep、glob。

安全约束：
- 只能使用提供的工具
- 不得声称执行未提供的 Bash、Git 或测试命令
- 不得修改任何文件或 FileScope
- 不得请求凭证
- 不得读取 .git、.env、.cc-auto/config.json、node_modules 等保护路径
- 工具错误必须作为事实接受
- 不得虚构工具结果
- 最终回答只能总结经过工具验证的事实

`;

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
  };

  const fullSystemPrompt = TOOL_LOOP_SYSTEM_PROMPT_PREFIX + systemPrompt;
  const callIdFactory = executorContext.callIdFactory ?? newCallId;

  const messages: (ProviderChatMessage)[] = [
    { role: 'system', content: fullSystemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const executedTools: ToolExecutionEnvelope[] = [];
  const callIds: string[] = [];
  const auditTrail: ToolLoopAuditRecord[] = [];
  const seenToolCallIds = new Set<string>();
  const seenToolCallSignatures = new Set<string>();
  let turns = 0;
  let totalToolCalls = 0;
  if (!validLimits(limits)) return stopped('LIMIT_CONFIGURATION_INVALID');
  const readBudget = createWorkspaceReadBudget(limits.maxTotalReadBytes);
  const secretValues = executorContext.profile.credentialEnvVars
    .map((name) => executorContext.parentEnv[name]);

  while (turns < limits.maxTurns) {
    turns++;

    if (estimateHistorySize(messages) > limits.maxHistoryChars) {
      return stopped('CONTEXT_LIMIT_EXCEEDED');
    }

    // 1. 通过正式 executeProviderCall 调用 Provider
    const callId = callIdFactory();
    const providerResult = await executeProviderCall({
      profile: executorContext.profile,
      logicalModelName: executorContext.logicalModelName,
      role: executorContext.role,
      systemPrompt: '',
      userPrompt: '',
      maxOutputTokens: executorContext.maxOutputTokens,
      timeoutMs: executorContext.timeoutMs,
      adapterRegistry: executorContext.adapterRegistry,
      parentEnv: executorContext.parentEnv,
      cwd,
      runId,
      messages,
      tools: DEEPSEEK_FILE_TOOL_DEFINITIONS,
      toolMode: 'enabled',
      callId,
    });

    callIds.push(callId);

    // 2. Provider 错误 → STOPPED
    if (!providerResult.ok) {
      return stopped(mapProviderStopReason(providerResult.stopReason));
    }

    const content = providerResult.content ?? '';
    const rawToolCalls = providerResult.toolCalls ?? [];
    // 3. 无 tool_calls → COMPLETED
    if (rawToolCalls.length === 0) {
      if (!content || content.trim().length === 0) {
        return stopped('EMPTY_FINAL_RESPONSE');
      }
      return { status: 'COMPLETED', finalText: content, turns, totalToolCalls, executedTools, stopReason: null, callIds, auditTrail };
    }

    // 4. 校验 tool_calls 数量
    if (rawToolCalls.length > limits.maxToolCallsPerTurn) {
      recordRawCalls(rawToolCalls);
      return stopped('MAX_TOOL_CALLS_PER_TURN_EXCEEDED');
    }
    if (totalToolCalls + rawToolCalls.length > limits.maxTotalToolCalls) {
      recordRawCalls(rawToolCalls);
      return stopped('MAX_TOTAL_TOOL_CALLS_EXCEEDED');
    }

    // 5. 解析工具调用
    const parsedResult = parseToolCalls(rawToolCalls);
    if (!parsedResult.ok) {
      const raw = rawToolCalls[parsedResult.toolCallIndex ?? 0];
      auditTrail.push({
        turn: turns,
        toolCallId: raw?.id?.slice(0, 256) ?? '',
        toolName: raw?.function?.name?.slice(0, 128) ?? 'unknown',
        status: 'REJECTED_PROTOCOL', resultOk: null, errorReason: parsedResult.reason,
      });
      return stopped(parsedResult.reason === 'DUPLICATE_TOOL_CALL_ID'
        ? 'DUPLICATE_TOOL_CALL_ID'
        : 'TOOL_PROTOCOL_ERROR');
    }

    const signaturesThisRound = new Set(seenToolCallSignatures);
    for (const toolCall of parsedResult.parsed) {
      if (seenToolCallIds.has(toolCall.id)) {
        auditTrail.push(auditRecord(turns, toolCall, 'REJECTED_PROTOCOL', null, 'DUPLICATE_TOOL_CALL_ID'));
        return stopped('DUPLICATE_TOOL_CALL_ID');
      }
      const signature = toolCallSignature(toolCall);
      if (signaturesThisRound.has(signature)) {
        auditTrail.push(auditRecord(turns, toolCall, 'REJECTED_REPEAT', null, null));
        return stopped('REPEATED_TOOL_CALL');
      }
      signaturesThisRound.add(signature);
    }

    // 追加 assistant 消息（含原始 tool_calls）
    messages.push(buildAssistantMessage(content, rawToolCalls));

    // 6. 串行执行工具
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

      messages.push(buildToolResultMessage(envelope, {
        maxChars: limits.maxToolResultChars,
        secrets: secretValues,
      }));

      if (!envelope.ok) {
        for (const skipped of parsedResult.parsed.slice(index + 1)) {
          auditTrail.push(auditRecord(turns, skipped, 'SKIPPED_AFTER_FAILURE', null, null));
        }
        return stopped('TOOL_EXECUTION_FAILED');
      }
    }
  }

  return stopped('MAX_TURNS_EXCEEDED');

  function stopped(stopReason: DeepSeekToolLoopStopReason): DeepSeekToolLoopResult {
    return {
      status: 'STOPPED', finalText: null, turns, totalToolCalls,
      executedTools, stopReason, callIds, auditTrail,
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

function buildAssistantMessage(content: string | null, toolCalls: ModelToolCall[]): ProviderChatMessage {
  if (toolCalls.length > 0) {
    return { role: 'assistant', content: content ?? null, toolCalls };
  }
  return { role: 'assistant', content: content ?? null };
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

function toolCallSignature(toolCall: ParsedToolCall): string {
  return `${toolCall.name}:${stableStringify(toolCall.arguments)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function validLimits(limits: {
  maxTurns: number;
  maxToolCallsPerTurn: number;
  maxTotalToolCalls: number;
  maxHistoryChars: number;
  maxToolResultChars: number;
  maxTotalReadBytes: number;
}): boolean {
  return validPositiveLimit(limits.maxTurns, HARD_LIMITS.maxTurns)
    && validPositiveLimit(limits.maxToolCallsPerTurn, HARD_LIMITS.maxToolCallsPerTurn)
    && validPositiveLimit(limits.maxTotalToolCalls, HARD_LIMITS.maxTotalToolCalls)
    && limits.maxTotalToolCalls >= limits.maxToolCallsPerTurn
    && validPositiveLimit(limits.maxHistoryChars, HARD_LIMITS.maxHistoryChars)
    && Number.isSafeInteger(limits.maxToolResultChars)
    && limits.maxToolResultChars >= 192
    && limits.maxToolResultChars <= HARD_LIMITS.maxToolResultChars
    && validPositiveLimit(limits.maxTotalReadBytes, HARD_LIMITS.maxTotalReadBytes);
}

function validPositiveLimit(value: number, hardMaximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= hardMaximum;
}

function mapProviderStopReason(reason: string | null): DeepSeekToolLoopStopReason {
  switch (reason) {
    case 'MODEL_IDENTITY_MISMATCH': return 'MODEL_IDENTITY_MISMATCH';
    case 'PROVIDER_ERROR': case 'PROVIDER_AUTH_ERROR': case 'PROVIDER_TIMEOUT': return 'PROVIDER_ERROR';
    default: return 'PROVIDER_ERROR';
  }
}

function estimateHistorySize(messages: ProviderChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.content) total += m.content.length;
    // discriminated union — assistant can have toolCalls
    const msg = m as { content?: string | null; role?: string; toolCalls?: unknown };
    if (msg.role === 'assistant' && msg.toolCalls) {
      total += JSON.stringify(msg.toolCalls).length;
    }
  }
  return total;
}
