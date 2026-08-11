/** toolDispatcher.spec.ts —— 工具 Dispatcher 完整测试 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dispatchDeepSeekTool, buildToolResultMessage, serializeToolResult } from './toolDispatcher';
import { acquireRunLease, releaseRunLease } from './runLease';
import type { ModelToolCall, FileScope, ToolExecutionEnvelope } from './types';
import * as workspaceRead from './workspaceRead';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let TEST_CWD: string;
let REPO_ROOT: string;
const RUN_ID = 'run-test-dispatch';

function makeScope(overrides: Partial<FileScope> = {}): FileScope {
  return {
    allowedRoots: ['src', 'scripts'],
    protectedPaths: [],
    proposedFiles: [],
    approvedFiles: ['src/test.txt', 'src/new-file.txt', 'src/edit-target.txt'],
    maxChangedFiles: 10,
    ...overrides,
  };
}

function setupLease(): void {
  acquireRunLease(TEST_CWD, RUN_ID, 'a'.repeat(64));
}

function dispatchOpts(toolCall: ModelToolCall, overrides: Partial<{ fileScope: FileScope; runId: string; repositoryRoot: string }> = {}) {
  return {
    repositoryRoot: overrides.repositoryRoot ?? REPO_ROOT,
    cwd: TEST_CWD,
    runId: overrides.runId ?? RUN_ID,
    fileScope: overrides.fileScope ?? makeScope(),
    toolCall,
  };
}

function rawCall(name: string, args: unknown, id = 'call_1'): ModelToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

beforeEach(() => {
  TEST_CWD = path.join(os.tmpdir(), `cc-auto-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  REPO_ROOT = TEST_CWD;
  mkdirSync(TEST_CWD, { recursive: true });
  mkdirSync(path.join(TEST_CWD, 'src'), { recursive: true });
  mkdirSync(path.join(TEST_CWD, 'scripts'), { recursive: true });
  mkdirSync(path.join(TEST_CWD, '.cc-auto'), { recursive: true });
  writeFileSync(path.join(TEST_CWD, 'src', 'test.txt'), 'line 1\nline 2\nline 3\n', 'utf8');
  writeFileSync(path.join(TEST_CWD, 'src', 'edit-target.txt'), 'original content here\n', 'utf8');
});

afterEach(() => {
  vi.restoreAllMocks();
  try { releaseRunLease(TEST_CWD, RUN_ID); } catch { /* ok */ }
  try { rmSync(TEST_CWD, { recursive: true, force: true }); } catch { /* ok */ }
});

// ============================================================================
// Dispatcher tests
// ============================================================================
describe('dispatchDeepSeekTool', () => {
  // 61. read_file dispatch
  it('dispatches read_file successfully', async () => {
    setupLease();
    const tc = rawCall('read_file', { path: 'src/test.txt' });
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    expect(envelope.ok).toBe(true);
    expect(envelope.toolName).toBe('read_file');
    expect(envelope.toolCallId).toBe('call_1');
    if (envelope.result && typeof envelope.result === 'object') {
      expect(envelope.result.kind).toBe('read_file');
      if (envelope.result.kind === 'read_file') expect(envelope.result.content).toContain('line 1');
    }
  });

  // 62. grep dispatch
  it('dispatches grep successfully', async () => {
    setupLease();
    const tc = rawCall('grep', { query: 'line' });
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    expect(envelope.ok).toBe(true);
    expect(envelope.toolName).toBe('grep');
  });

  // 63. glob dispatch
  it('dispatches glob successfully', async () => {
    setupLease();
    const tc = rawCall('glob', { pattern: 'src/*.txt' });
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    expect(envelope.ok).toBe(true);
    expect(envelope.toolName).toBe('glob');
  });

  // 69. unknown tool rejected
  it('rejects unknown tool', async () => {
    setupLease();
    const tc = rawCall('bash', {});
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    expect(envelope.ok).toBe(false);
    expect(envelope.toolName).toBe('unknown');
    if (envelope.error) expect(envelope.error.reason).toBe('UNKNOWN_TOOL');
  });

  // 70. tool exception becomes structured
  it('converts internal exceptions to structured envelope', async () => {
    setupLease();
    vi.spyOn(workspaceRead, 'safeReadFile').mockImplementation(() => {
      throw new Error(`secret stack ${REPO_ROOT}`);
    });
    const tc = rawCall('read_file', { path: 'src/test.txt' }, 'call_err');
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    expect(envelope.toolCallId).toBe('call_err');
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.reason).toBe('INTERNAL_ERROR');
      expect(envelope.error.message).not.toContain(REPO_ROOT);
    }
  });

  it('rejects arguments that fail runtime schema validation', async () => {
    setupLease();
    const envelope = await dispatchDeepSeekTool(dispatchOpts(
      rawCall('read_file', { path: 'src/test.txt', command: 'whoami' }),
    ));
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.reason).toBe('ARGUMENT_FIELD_UNKNOWN');
  });

  it('returns a stable failure for missing files', async () => {
    setupLease();
    const envelope = await dispatchDeepSeekTool(dispatchOpts(
      rawCall('read_file', { path: 'src/missing.txt' }),
    ));
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.reason).toBe('FILE_NOT_FOUND');
  });

  it('rejects recursive dispatcher entry without blocking unrelated calls', async () => {
    setupLease();
    const nestedCalls: Array<Promise<ToolExecutionEnvelope>> = [];
    vi.spyOn(workspaceRead, 'safeReadFile').mockImplementation(() => {
      nestedCalls.push(dispatchDeepSeekTool(dispatchOpts(rawCall('read_file', { path: 'src/test.txt' }, 'nested'))));
      return { ok: false, reason: 'FILE_NOT_FOUND', message: 'outer failure' };
    });
    await dispatchDeepSeekTool(dispatchOpts(rawCall('read_file', { path: 'src/test.txt' }, 'outer')));
    const nested = await nestedCalls[0];
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.error.reason).toBe('DISPATCH_REENTRY');
  });

  // grep: non-existent directory → FILE_NOT_FOUND (not IO_ERROR)
  it('grep with non-existent root directory returns FILE_NOT_FOUND', async () => {
    setupLease();
    const tc = rawCall('grep', { query: 'hello', roots: ['src/nonexistent-dir'] });
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.reason).toBe('FILE_NOT_FOUND');
  });

  // glob: non-existent directory → FILE_NOT_FOUND (not IO_ERROR)
  it('glob with non-existent root directory returns FILE_NOT_FOUND', async () => {
    setupLease();
    const tc = rawCall('glob', { pattern: '*.txt', roots: ['src/nonexistent-dir'] });
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.reason).toBe('FILE_NOT_FOUND');
  });

  // grep: SCAN_LIMIT_EXCEEDED preserved (not IO_ERROR)
  it('grep SCAN_LIMIT_EXCEEDED is preserved as-is', async () => {
    setupLease();
    vi.spyOn(workspaceRead, 'safeGrep').mockReturnValue({ ok: false, reason: 'SCAN_LIMIT_EXCEEDED', message: 'too many files' });
    const tc = rawCall('grep', { query: 'anything' });
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.reason).toBe('SCAN_LIMIT_EXCEEDED');
  });

  // glob: SCAN_LIMIT_EXCEEDED preserved (not IO_ERROR)
  it('glob SCAN_LIMIT_EXCEEDED is preserved as-is', async () => {
    setupLease();
    vi.spyOn(workspaceRead, 'safeGlob').mockReturnValue({ ok: false, reason: 'SCAN_LIMIT_EXCEEDED', message: 'too many entries' });
    const tc = rawCall('glob', { pattern: '*.txt' });
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.reason).toBe('SCAN_LIMIT_EXCEEDED');
  });

  // 71. error result does not contain stack trace
  it('error result has no stack trace', async () => {
    setupLease();
    const tc = rawCall('read_file', { path: 'src/nonexistent.txt' });
    const envelope = await dispatchDeepSeekTool(dispatchOpts(tc));
    const json = JSON.stringify(envelope);
    expect(json).not.toContain('Error:');
    expect(json).not.toContain('at ');
    expect(json).not.toContain('.ts:');
  });

});

// ============================================================================
// Tool result serialization
// ============================================================================
describe('serializeToolResult', () => {
  it('produces valid JSON', () => {
    const env: ToolExecutionEnvelope = {
      ok: true, toolCallId: 'c1', toolName: 'read_file',
      result: { kind: 'read_file', content: 'hello', lineCount: 1, byteCount: 5, startLine: 1, endLine: 1 },
      error: null, truncated: false,
    };
    const json = serializeToolResult(env);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('handles failure envelope', () => {
    const env: ToolExecutionEnvelope = {
      ok: false, toolCallId: 'c1', toolName: 'read_file',
      result: null,
      error: { reason: 'FILE_NOT_FOUND', message: 'file missing' },
      truncated: false,
    };
    const json = serializeToolResult(env);
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.reason).toBe('FILE_NOT_FOUND');
  });

  it('redacts exact secrets and replaces oversized results with a failure', () => {
    const secret = 'not-a-real-secret-value';
    const env: ToolExecutionEnvelope = {
      ok: true, toolCallId: 'c1', toolName: 'read_file',
      result: { kind: 'read_file', content: secret.repeat(20), lineCount: 1, byteCount: 500, startLine: 1, endLine: 1 },
      error: null, truncated: false,
    };
    const parsed = JSON.parse(serializeToolResult(env, { maxChars: 200, secrets: [secret] })) as {
      ok: boolean; error?: { reason?: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.reason).toBe('MAX_OUTPUT_EXCEEDED');
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });
});

describe('buildToolResultMessage', () => {
  it('builds correct OpenAI tool result message', () => {
    const env: ToolExecutionEnvelope = {
      ok: true, toolCallId: 'call_abc', toolName: 'read_file',
      result: { kind: 'read_file', content: 'data', lineCount: 1, byteCount: 4, startLine: 1, endLine: 1 },
      error: null, truncated: false,
    };
    const msg = buildToolResultMessage(env);
    expect(msg.role).toBe('tool');
    expect(msg.toolCallId).toBe('call_abc');
    expect(typeof msg.content).toBe('string');
  });
});
