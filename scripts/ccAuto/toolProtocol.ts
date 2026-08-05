/** cc-auto v0.2.0 Slice 1E — 只读工具协议解析与运行时校验。 */
import type {
  DeepSeekToolName,
  GlobArguments,
  GrepArguments,
  ModelToolCall,
  ParsedToolCall,
  ProviderToolDefinition,
  ReadFileArguments,
  ToolProtocolErrorReason,
} from './types';

export const DEEPSEEK_READ_TOOL_NAMES = ['read_file', 'grep', 'glob'] as const;

const VALID_TOOL_NAMES: ReadonlySet<string> = new Set(DEEPSEEK_READ_TOOL_NAMES);
const MAX_ARGUMENTS_LENGTH = 64_000;
const MAX_TOOL_CALL_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_PATH_LENGTH = 4096;

export type ParseToolCallsOutcome =
  | { ok: true; parsed: ParsedToolCall[] }
  | {
      ok: false;
      reason: ToolProtocolErrorReason;
      message: string;
      toolCallIndex?: number;
    };

type SingleParseOutcome =
  | { ok: true; parsed: ParsedToolCall }
  | {
      ok: false;
      reason: ToolProtocolErrorReason;
      message: string;
      toolCallIndex: number;
    };

function failure(
  reason: ToolProtocolErrorReason,
  message: string,
  toolCallIndex: number,
): SingleParseOutcome {
  return { ok: false, reason, message, toolCallIndex };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function firstUnknownField(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

/**
 * 只接受 Provider 原生 tool_calls 数组。普通文本、Markdown 或内嵌 JSON 均不会被猜测成调用。
 */
export function parseToolCalls(raw: unknown): ParseToolCallsOutcome {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: 'INVALID_TOOL_CALL', message: 'tool_calls 必须是非空数组' };
  }

  const seenIds = new Set<string>();
  const parsed: ParsedToolCall[] = [];
  for (let index = 0; index < raw.length; index++) {
    const outcome = parseSingleToolCall(raw[index], index, seenIds);
    if (!outcome.ok) return outcome;
    parsed.push(outcome.parsed);
  }
  return { ok: true, parsed };
}

function parseSingleToolCall(
  value: unknown,
  index: number,
  seenIds: Set<string>,
): SingleParseOutcome {
  if (!isPlainRecord(value)) {
    return failure('INVALID_TOOL_CALL', `tool_calls[${index}] 必须是普通对象`, index);
  }
  const wrapperExtra = firstUnknownField(value, new Set(['id', 'type', 'function']));
  if (wrapperExtra !== null) {
    return failure('INVALID_TOOL_CALL', `tool_calls[${index}] 包含未知字段`, index);
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return failure('TOOL_CALL_ID_MISSING', `tool_calls[${index}] 缺少 id`, index);
  }
  if (value.id.length > MAX_TOOL_CALL_ID_LENGTH) {
    return failure('INVALID_TOOL_CALL', `tool_calls[${index}] id 过长`, index);
  }
  if (seenIds.has(value.id)) {
    return failure('DUPLICATE_TOOL_CALL_ID', `tool_calls[${index}] id 重复`, index);
  }
  seenIds.add(value.id);
  if (value.type !== 'function') {
    return failure('INVALID_TOOL_CALL', `tool_calls[${index}] type 必须为 function`, index);
  }
  if (!isPlainRecord(value.function)) {
    return failure('INVALID_TOOL_CALL', `tool_calls[${index}] function 必须是普通对象`, index);
  }
  const functionExtra = firstUnknownField(value.function, new Set(['name', 'arguments']));
  if (functionExtra !== null) {
    return failure('INVALID_TOOL_CALL', `tool_calls[${index}].function 包含未知字段`, index);
  }
  const name = value.function.name;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) {
    return failure('UNKNOWN_TOOL', `tool_calls[${index}] 工具名无效`, index);
  }
  if (!VALID_TOOL_NAMES.has(name)) {
    return failure('UNKNOWN_TOOL', `未知工具 "${name.slice(0, 64)}"`, index);
  }
  if (typeof value.function.arguments !== 'string') {
    return failure('ARGUMENTS_INVALID_JSON', `工具 "${name}" arguments 必须是字符串`, index);
  }
  if (value.function.arguments.length > MAX_ARGUMENTS_LENGTH) {
    return failure('ARGUMENTS_TOO_LARGE', `工具 "${name}" arguments 超过限制`, index);
  }

  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(value.function.arguments);
  } catch {
    return failure('ARGUMENTS_INVALID_JSON', `工具 "${name}" arguments 不是合法 JSON`, index);
  }
  if (!isPlainRecord(argumentsValue)) {
    return failure('ARGUMENTS_NOT_OBJECT', `工具 "${name}" arguments 必须是普通对象`, index);
  }

  const argumentsOutcome = validateArguments(name as DeepSeekToolName, argumentsValue, index);
  if (!argumentsOutcome.ok) return argumentsOutcome;
  return { ok: true, parsed: addToolCallId(value.id, argumentsOutcome.parsed) };
}

type ParsedToolCallWithoutId =
  | { name: 'read_file'; arguments: ReadFileArguments }
  | { name: 'grep'; arguments: GrepArguments }
  | { name: 'glob'; arguments: GlobArguments };

type ArgumentsOutcome =
  | { ok: true; parsed: ParsedToolCallWithoutId }
  | Extract<SingleParseOutcome, { ok: false }>;

function addToolCallId(id: string, call: ParsedToolCallWithoutId): ParsedToolCall {
  switch (call.name) {
    case 'read_file': return { id, name: call.name, arguments: call.arguments };
    case 'grep': return { id, name: call.name, arguments: call.arguments };
    case 'glob': return { id, name: call.name, arguments: call.arguments };
  }
}

function validateArguments(
  name: DeepSeekToolName,
  value: Record<string, unknown>,
  index: number,
): ArgumentsOutcome {
  switch (name) {
    case 'read_file': return validateReadArguments(value, index);
    case 'grep': return validateGrepArguments(value, index);
    case 'glob': return validateGlobArguments(value, index);
  }
}

function unknownArgument(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: DeepSeekToolName,
  index: number,
): Extract<SingleParseOutcome, { ok: false }> | null {
  const key = firstUnknownField(value, new Set(allowed));
  return key === null
    ? null
    : { ok: false, reason: 'ARGUMENT_FIELD_UNKNOWN', message: `工具 "${name}" 包含未知参数`, toolCallIndex: index };
}

function requiredString(
  value: unknown,
  field: string,
  index: number,
): Extract<SingleParseOutcome, { ok: false }> | string {
  if (value === undefined) {
    return { ok: false, reason: 'ARGUMENT_FIELD_MISSING', message: `${field} 缺失`, toolCallIndex: index };
  }
  if (typeof value !== 'string') {
    return { ok: false, reason: 'ARGUMENT_TYPE_INVALID', message: `${field} 必须是字符串`, toolCallIndex: index };
  }
  if (value.length === 0) {
    return { ok: false, reason: 'ARGUMENT_VALUE_INVALID', message: `${field} 不能为空`, toolCallIndex: index };
  }
  if (value.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: 'ARGUMENT_VALUE_INVALID', message: `${field} 超过长度限制`, toolCallIndex: index };
  }
  return value;
}

function positiveInteger(
  value: unknown,
  field: string,
  maximum: number,
  index: number,
): Extract<SingleParseOutcome, { ok: false }> | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return { ok: false, reason: 'ARGUMENT_TYPE_INVALID', message: `${field} 必须是整数`, toolCallIndex: index };
  }
  if (value < 1 || value > maximum) {
    return { ok: false, reason: 'ARGUMENT_VALUE_INVALID', message: `${field} 超出允许范围`, toolCallIndex: index };
  }
  return value;
}

function isFailureValue(
  value: string | string[] | number | undefined | Extract<SingleParseOutcome, { ok: false }>,
): value is Extract<SingleParseOutcome, { ok: false }> {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

function validateReadArguments(value: Record<string, unknown>, index: number): ArgumentsOutcome {
  const extra = unknownArgument(value, ['path', 'startLine', 'endLine'], 'read_file', index);
  if (extra !== null) return extra;
  const targetPath = requiredString(value.path, 'read_file.path', index);
  if (isFailureValue(targetPath)) return targetPath;
  const startLine = positiveInteger(value.startLine, 'read_file.startLine', 10_000_000, index);
  if (isFailureValue(startLine)) return startLine;
  const endLine = positiveInteger(value.endLine, 'read_file.endLine', 10_000_000, index);
  if (isFailureValue(endLine)) return endLine;
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    return failure('ARGUMENT_VALUE_INVALID', 'read_file.startLine 不能大于 endLine', index);
  }
  const args: ReadFileArguments = { path: targetPath };
  if (startLine !== undefined) args.startLine = startLine;
  if (endLine !== undefined) args.endLine = endLine;
  return { ok: true, parsed: { name: 'read_file', arguments: args } };
}

function validateRoots(
  value: unknown,
  field: string,
  index: number,
): Extract<SingleParseOutcome, { ok: false }> | string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return { ok: false, reason: 'ARGUMENT_TYPE_INVALID', message: `${field} 必须是字符串数组`, toolCallIndex: index };
  }
  if (value.length === 0 || value.length > 20 || value.some((entry) => entry.length === 0 || entry.length > MAX_PATH_LENGTH)) {
    return { ok: false, reason: 'ARGUMENT_VALUE_INVALID', message: `${field} 数量或路径长度无效`, toolCallIndex: index };
  }
  return value;
}

function validateGrepArguments(value: Record<string, unknown>, index: number): ArgumentsOutcome {
  const extra = unknownArgument(value, ['query', 'roots', 'caseSensitive', 'maxResults'], 'grep', index);
  if (extra !== null) return extra;
  const query = requiredString(value.query, 'grep.query', index);
  if (isFailureValue(query)) return query;
  const roots = validateRoots(value.roots, 'grep.roots', index);
  if (isFailureValue(roots)) return roots;
  if (value.caseSensitive !== undefined && typeof value.caseSensitive !== 'boolean') {
    return failure('ARGUMENT_TYPE_INVALID', 'grep.caseSensitive 必须是布尔值', index);
  }
  const maxResults = positiveInteger(value.maxResults, 'grep.maxResults', 200, index);
  if (isFailureValue(maxResults)) return maxResults;
  const args: GrepArguments = { query };
  if (roots !== undefined) args.roots = roots;
  if (typeof value.caseSensitive === 'boolean') args.caseSensitive = value.caseSensitive;
  if (maxResults !== undefined) args.maxResults = maxResults;
  return { ok: true, parsed: { name: 'grep', arguments: args } };
}

function validateGlobArguments(value: Record<string, unknown>, index: number): ArgumentsOutcome {
  const extra = unknownArgument(value, ['pattern', 'roots', 'maxResults'], 'glob', index);
  if (extra !== null) return extra;
  const pattern = requiredString(value.pattern, 'glob.pattern', index);
  if (isFailureValue(pattern)) return pattern;
  const roots = validateRoots(value.roots, 'glob.roots', index);
  if (isFailureValue(roots)) return roots;
  const maxResults = positiveInteger(value.maxResults, 'glob.maxResults', 500, index);
  if (isFailureValue(maxResults)) return maxResults;
  const args: GlobArguments = { pattern };
  if (roots !== undefined) args.roots = roots;
  if (maxResults !== undefined) args.maxResults = maxResults;
  return { ok: true, parsed: { name: 'glob', arguments: args } };
}

export const DEEPSEEK_FILE_TOOL_DEFINITIONS: ProviderToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取 FileScope 内的 UTF-8 文本文件。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: {
          path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '在 FileScope 内进行纯文本子串搜索。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: {
          query: { type: 'string' }, roots: { type: 'array', items: { type: 'string' } },
          caseSensitive: { type: 'boolean' }, maxResults: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '在 FileScope 内按 *、**、? 匹配文件。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['pattern'],
        properties: {
          pattern: { type: 'string' }, roots: { type: 'array', items: { type: 'string' } },
          maxResults: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
  },
];

/** 供 Adapter/测试构造原始调用，避免不受控类型断言。 */
export function modelToolCall(
  id: string,
  name: string,
  argumentsJson: string,
): ModelToolCall {
  return { id, type: 'function', function: { name, arguments: argumentsJson } };
}
