/** cc-auto v0.2.0 Slice 1E-W — 工具 Dispatcher（含 Safe Write/Edit）。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ParsedToolCall,
  ToolExecutionEnvelope,
  ToolExecutionErrorReason,
  FileScope,
  DeepSeekToolName,
  ModelToolCall,
} from './types';
import {
  safeReadFile,
  safeGrep,
  safeGlob,
  type WorkspaceReadBudget,
} from './workspaceRead';
import {
  safeWriteWorkspaceFile,
  safeEditWorkspaceFile,
  type WorkspaceWriteDenyReason,
} from './workspaceWrite';
import { parseToolCalls } from './toolProtocol';
import { redactForDisk, redactSecretValues } from './redact';

// ============================================================================
// 接口
// ============================================================================

export interface ToolDispatchOptions {
  repositoryRoot: string;
  cwd: string;
  runId: string;
  fileScope: FileScope;
  /** 原始 Provider tool_call；Dispatcher 自己执行运行时 schema 校验。 */
  toolCall: ModelToolCall;
  readBudget?: WorkspaceReadBudget;
}

const dispatchContext = new AsyncLocalStorage<boolean>();

function dispatchFailure(
  id: string,
  toolName: DeepSeekToolName | 'unknown',
  reason: ToolExecutionErrorReason,
  message: string,
): ToolExecutionEnvelope {
  return {
    ok: false,
    toolCallId: id,
    toolName,
    result: null,
    error: { reason, message: redactForDisk(message).slice(0, 300) },
    truncated: false,
  };
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * 分发并执行单个工具调用。
 *
 * 规则：
 * - 串行执行
 * - 不自动 setWriter
 * - 不自动修改 FileScope
 * - 不自动批准 proposedFiles
 * - 不自动运行 Git / 测试
 * - 异常转为结构化 envelope
 */
export async function dispatchDeepSeekTool(
  options: ToolDispatchOptions,
): Promise<ToolExecutionEnvelope> {
  if (dispatchContext.getStore() === true) {
    return dispatchFailure(safeToolCallId(options.toolCall), 'unknown', 'DISPATCH_REENTRY', '工具 Dispatcher 禁止递归调用');
  }

  let parsed: ReturnType<typeof parseToolCalls>;
  try {
    parsed = parseToolCalls([options.toolCall]);
  } catch {
    return dispatchFailure('', 'unknown', 'INTERNAL_ERROR', '工具协议校验发生内部错误');
  }
  if (!parsed.ok) {
    return dispatchFailure(
      safeToolCallId(options.toolCall),
      'unknown',
      parsed.reason,
      parsed.message,
    );
  }
  const tc = parsed.parsed[0];

  return dispatchContext.run(true, async () => {
    try {
      switch (tc.name) {
        case 'read_file': return dispatchReadFile(options, tc);
        case 'grep': return dispatchGrep(options, tc);
        case 'glob': return dispatchGlob(options, tc);
        case 'write_file': return dispatchWriteFile(options, tc);
        case 'edit_file': return dispatchEditFile(options, tc);
      }
    } catch {
      return dispatchFailure(tc.id, tc.name, 'INTERNAL_ERROR', '工具执行发生内部错误');
    }
  });
}

// ============================================================================
// 各工具分发实现
// ============================================================================

function dispatchReadFile(
  options: ToolDispatchOptions,
  tc: ParsedToolCall & { name: 'read_file' },
): ToolExecutionEnvelope {
  const { repositoryRoot, cwd, runId, fileScope } = options;
  const { path: targetPath, startLine, endLine } = tc.arguments;

  const result = safeReadFile({
    repositoryRoot,
    cwd,
    runId,
    targetPath,
    fileScope,
    startLine,
    endLine,
    budget: options.readBudget,
  });

  if (!result.ok) {
    return {
      ok: false,
      toolCallId: tc.id,
      toolName: 'read_file',
      result: null,
      error: {
        reason: mapReadDenyReason(result.reason),
        message: result.message,
      },
      truncated: false,
    };
  }

  return {
    ok: true,
    toolCallId: tc.id,
    toolName: 'read_file',
    result: {
      kind: 'read_file',
      content: result.content,
      lineCount: result.lineCount,
      byteCount: result.byteCount,
      startLine: result.startLine,
      endLine: result.endLine,
    },
    error: null,
    truncated: result.truncated,
  };
}

function dispatchGrep(
  options: ToolDispatchOptions,
  tc: ParsedToolCall & { name: 'grep' },
): ToolExecutionEnvelope {
  const { repositoryRoot, cwd, runId, fileScope } = options;
  const { query, roots, caseSensitive, maxResults } = tc.arguments;

  const result = safeGrep({
    repositoryRoot,
    cwd,
    runId,
    fileScope,
    query,
    roots,
    caseSensitive,
    maxResults,
    budget: options.readBudget,
  });

  if (!result.ok) {
    return {
      ok: false,
      toolCallId: tc.id,
      toolName: 'grep',
      result: null,
      error: {
        reason: 'IO_ERROR',
        message: result.message,
      },
      truncated: false,
    };
  }

  return {
    ok: true,
    toolCallId: tc.id,
    toolName: 'grep',
    result: {
      kind: 'grep',
      matches: result.matches,
      scannedFiles: result.scannedFiles,
      bytesRead: result.bytesRead,
    },
    error: null,
    truncated: result.truncated,
  };
}

function dispatchGlob(
  options: ToolDispatchOptions,
  tc: ParsedToolCall & { name: 'glob' },
): ToolExecutionEnvelope {
  const { repositoryRoot, cwd, runId, fileScope } = options;
  const { pattern, roots, maxResults } = tc.arguments;

  const outcome = safeGlob({
    repositoryRoot,
    cwd,
    runId,
    fileScope,
    pattern,
    roots,
    maxResults,
  });

  if (!outcome.ok) {
    return {
      ok: false,
      toolCallId: tc.id,
      toolName: 'glob',
      result: null,
      error: {
        reason: 'IO_ERROR',
        message: outcome.message,
      },
      truncated: false,
    };
  }

  return {
    ok: true,
    toolCallId: tc.id,
    toolName: 'glob',
    result: {
      kind: 'glob',
      paths: outcome.result.paths,
      scannedEntries: outcome.result.scannedEntries,
    },
    error: null,
    truncated: outcome.result.truncated,
  };
}

function dispatchWriteFile(
  options: ToolDispatchOptions,
  tc: ParsedToolCall & { name: 'write_file' },
): ToolExecutionEnvelope {
  const { repositoryRoot, cwd, runId, fileScope } = options;
  const { path: targetPath, content } = tc.arguments;

  const result = safeWriteWorkspaceFile({
    repositoryRoot,
    cwd,
    runId,
    targetPath,
    fileScope,
    content,
  });

  if (!result.ok) {
    return dispatchFailure(tc.id, 'write_file', mapWriteDenyReason(result.reason), result.message);
  }

  return {
    ok: true,
    toolCallId: tc.id,
    toolName: 'write_file',
    result: { kind: 'write_file', path: result.normalizedPath, action: result.action, bytesWritten: result.bytesWritten },
    error: null,
    truncated: false,
  };
}

function dispatchEditFile(
  options: ToolDispatchOptions,
  tc: ParsedToolCall & { name: 'edit_file' },
): ToolExecutionEnvelope {
  const { repositoryRoot, cwd, runId, fileScope } = options;
  const { path: targetPath, oldText, newText } = tc.arguments;

  const result = safeEditWorkspaceFile({
    repositoryRoot,
    cwd,
    runId,
    targetPath,
    fileScope,
    oldText,
    newText,
  });

  if (!result.ok) {
    return dispatchFailure(tc.id, 'edit_file', mapEditDenyReason(result.reason), result.message);
  }

  return {
    ok: true,
    toolCallId: tc.id,
    toolName: 'edit_file',
    result: { kind: 'edit_file', path: result.normalizedPath, replacements: 1, bytesBefore: result.bytesBefore, bytesAfter: result.bytesAfter },
    error: null,
    truncated: false,
  };
}

// ============================================================================
// 错误映射
// ============================================================================

function mapReadDenyReason(reason: string): ToolExecutionErrorReason {
  switch (reason) {
    case 'INVALID_PATH': return 'PATH_OUTSIDE_ROOTS';
    case 'PATH_OUTSIDE_REPOSITORY': return 'PATH_OUTSIDE_ROOTS';
    case 'SYSTEM_PROTECTED_PATH': return 'SYSTEM_PROTECTED_PATH';
    case 'PROTECTED_PATH': return 'PROTECTED_PATH';
    case 'PATH_OUTSIDE_ROOTS': return 'PATH_OUTSIDE_ROOTS';
    case 'FILE_NOT_REGULAR_FILE': return 'FILE_NOT_REGULAR_FILE';
    case 'SYMLINK_DETECTED': return 'SYMLINK_DETECTED';
    case 'JUNCTION_DETECTED': return 'JUNCTION_DETECTED';
    case 'RUN_LEASE_MISSING': return 'READ_PERMISSION_DENIED';
    case 'RUN_LEASE_MISMATCH': return 'READ_PERMISSION_DENIED';
    case 'REPOSITORY_ROOT_MISMATCH': return 'READ_PERMISSION_DENIED';
    case 'FILE_NOT_FOUND': return 'FILE_NOT_FOUND';
    case 'FILE_TOO_LARGE': return 'FILE_TOO_LARGE';
    case 'FILE_NOT_UTF8': return 'FILE_NOT_UTF8';
    case 'BINARY_FILE': return 'BINARY_FILE';
    case 'READ_PERMISSION_DENIED': return 'READ_PERMISSION_DENIED';
    case 'READ_BUDGET_EXCEEDED': return 'READ_BUDGET_EXCEEDED';
    case 'SCAN_LIMIT_EXCEEDED': return 'SCAN_LIMIT_EXCEEDED';
    case 'MAX_OUTPUT_EXCEEDED': return 'MAX_OUTPUT_EXCEEDED';
    default: return 'IO_ERROR';
  }
}

function safeToolCallId(toolCall: ModelToolCall): string {
  try {
    return typeof toolCall.id === 'string' ? toolCall.id.slice(0, 256) : '';
  } catch {
    return '';
  }
}

function mapWriteDenyReason(reason: WorkspaceWriteDenyReason | string): ToolExecutionErrorReason {
  switch (reason) {
    case 'INVALID_PATH': return 'PATH_OUTSIDE_ROOTS';
    case 'PATH_OUTSIDE_REPOSITORY': return 'PATH_OUTSIDE_ROOTS';
    case 'PROTECTED_PATH': return 'PROTECTED_PATH';
    case 'SYSTEM_PROTECTED_PATH': return 'SYSTEM_PROTECTED_PATH';
    case 'FILE_NOT_APPROVED': return 'FILE_NOT_APPROVED';
    case 'MAX_CHANGED_FILES_EXCEEDED': return 'MAX_CHANGED_FILES_EXCEEDED';
    case 'RUN_LEASE_MISSING': return 'INTERNAL_ERROR';
    case 'RUN_LEASE_MISMATCH': return 'INTERNAL_ERROR';
    case 'REPOSITORY_ROOT_MISMATCH': return 'INTERNAL_ERROR';
    case 'WRITER_NOT_DEEPSEEK': return 'WRITER_NOT_DEEPSEEK';
    case 'SYMLINK_ESCAPE': return 'SYMLINK_DETECTED';
    case 'TARGET_NOT_REGULAR_FILE': return 'FILE_NOT_REGULAR_FILE';
    case 'FILE_IDENTITY_UNVERIFIABLE': return 'FILE_IDENTITY_UNVERIFIABLE';
    case 'TARGET_RACE_DETECTED': return 'TARGET_RACE_DETECTED';
    case 'WRITE_PERMISSION_DENIED': return 'WRITE_PERMISSION_DENIED';
    case 'WRITE_STORAGE_ERROR': return 'WRITE_STORAGE_ERROR';
    case 'WRITE_IO_ERROR': return 'WRITE_IO_ERROR';
    case 'WRITE_FAILED_AFTER_TRUNCATE': return 'WRITE_FAILED_AFTER_TRUNCATE';
    case 'SCOPE_CONFIG_ERROR': return 'SCOPE_CONFIG_ERROR';
    default: return 'IO_ERROR';
  }
}

function mapEditDenyReason(reason: WorkspaceWriteDenyReason | 'FILE_IDENTITY_UNVERIFIABLE' | 'EDIT_TARGET_NOT_FOUND' | 'EDIT_TARGET_NOT_UNIQUE' | 'OLD_TEXT_EMPTY' | 'FILE_NOT_UTF8' | string): ToolExecutionErrorReason {
  switch (reason) {
    case 'OLD_TEXT_EMPTY': return 'OLD_TEXT_EMPTY';
    case 'EDIT_TARGET_NOT_FOUND': return 'EDIT_TARGET_NOT_FOUND';
    case 'EDIT_TARGET_NOT_UNIQUE': return 'EDIT_TARGET_NOT_UNIQUE';
    case 'FILE_NOT_UTF8': return 'FILE_NOT_UTF8';
    case 'FILE_IDENTITY_UNVERIFIABLE': return 'FILE_IDENTITY_UNVERIFIABLE';
    default: return mapWriteDenyReason(reason);
  }
}

// ============================================================================
// 工具结果脱敏——供 Tool Loop 使用
// ============================================================================

/**
 * 将 ToolExecutionEnvelope 转换为模型可安全消费的 JSON 字符串。
 */
export function serializeToolResult(
  envelope: ToolExecutionEnvelope,
  options: { maxChars?: number; secrets?: Array<string | undefined> } = {},
): string {
  const maxChars = Math.max(192, Math.min(options.maxChars ?? 16_000, 64_000));
  const serialized = redactSecretValues(redactForDisk(JSON.stringify(envelope)), options.secrets ?? []);
  if (serialized.length <= maxChars) return serialized;

  const compactFailure: ToolExecutionEnvelope = {
    ok: false,
    toolCallId: envelope.toolCallId.slice(0, 32),
    toolName: envelope.toolName,
    result: null,
    error: { reason: 'MAX_OUTPUT_EXCEEDED', message: 'tool result omitted' },
    truncated: false,
  };
  return JSON.stringify(compactFailure);
}

/**
 * 构建单条 OpenAI tool result 消息。
 */
export function buildToolResultMessage(
  envelope: ToolExecutionEnvelope,
  options: { maxChars?: number; secrets?: Array<string | undefined> } = {},
): { role: 'tool'; toolCallId: string; content: string } {
  return {
    role: 'tool',
    toolCallId: envelope.toolCallId,
    content: serializeToolResult(envelope, options),
  };
}
