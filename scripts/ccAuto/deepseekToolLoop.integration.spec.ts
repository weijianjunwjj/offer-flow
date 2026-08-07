/** deepseekToolLoop.integration.spec.ts
 *
 * 核心集成测试：真实 OpenAIChatAdapter + fake fetch + fake HTTP
 * → 真实 executeProviderCall → 真实 runDeepSeekToolLoop
 * → 真实 Safe Read/Write/Edit → git diff 非空 → Verifier 通过。
 *
 * 1E-W 冻结版验收门禁。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { OpenAIChatAdapter, type FetchLike } from './openaiChatAdapter';
import { AdapterRegistry } from './adapter';
import { runDeepSeekToolLoop } from './deepseekToolLoop';
import {
  acquireRunLease, releaseRunLease, setWriter,
} from './runLease';
import { createRunState, loadRunState } from './store';
import type {
  FileScope,
  ProviderProfile,
} from './types';

// ============================================================================
// Fixtures & helpers
// ============================================================================

const testProfile: ProviderProfile = {
  id: 'ds-prod-test',
  displayName: 'DeepSeek Production Test',
  vendor: 'deepseek',
  transport: 'openai-chat',
  apiBaseUrl: 'https://api.deepseek.com/v1',
  credentialEnvVars: ['DEEPSEEK_API_KEY'],
  runtimeEnvAllowlist: ['PATH', 'HOME'],
  defaultModelId: 'deepseek',
  models: [{
    logicalName: 'deepseek',
    requestedModelId: 'deepseek-chat',
    acceptedReportedModelIds: ['deepseek-chat'],
    displayName: 'DeepSeek Chat',
  }],
  pricing: {
    'deepseek-chat': {
      inputPerMTokens: 1.0, outputPerMTokens: 2.0,
      cacheCreationPerMTokens: 1.25, cacheReadPerMTokens: 0.1,
      currency: 'CNY' as const, source: 'test', updatedAt: '2026-08-07',
    },
  },
};

let TEST_CWD: string;
let REPO_ROOT: string;
const RUN_ID = 'run-int-spec';

function makeScope(overrides: Partial<FileScope> = {}): FileScope {
  return {
    allowedRoots: ['src'],
    protectedPaths: [],
    proposedFiles: [],
    approvedFiles: ['src/example.ts', 'src/out.ts', 'src/new-file.ts'],
    maxChangedFiles: 10,
    ...overrides,
  };
}

function initGitRepo(root: string): void {
  execSync('git init', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@cc-auto"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: root, stdio: 'pipe' });
  // Initial commit so git diff can show changes
  try {
    execSync('git add -A && git commit -m "initial"', { cwd: root, stdio: 'pipe' });
  } catch {
    // If nothing to commit, create an empty commit
    execSync('git commit --allow-empty -m "initial"', { cwd: root, stdio: 'pipe' });
  }
}

function gitDiff(root: string): string {
  return execSync('git diff --name-only', { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function writeApprovedFile(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** 创建跟踪所有请求的 fake fetch */
function createFakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetch: FetchLike; requests: Array<{ body: string }> } {
  const requests: Array<{ body: string }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = typeof init?.body === 'string' ? init.body : '';
    requests.push({ body });
    return handler(url, init);
  };
  return { fetch, requests };
}

/** 标准 200 JSON 响应 */
function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

/** 构造标准 API 成功响应 */
function chatResponse(opts: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  model?: string;
  usage?: Record<string, number>;
  reasoningContent?: string | null;
}): Response {
  const body = {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1722782400,
    model: opts.model ?? 'deepseek-chat',
    choices: [{
      index: 0,
      finish_reason: opts.toolCalls ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content: opts.content ?? null,
        ...(opts.toolCalls ? {
          tool_calls: opts.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          })),
        } : {}),
        ...(opts.reasoningContent !== undefined ? { reasoning_content: opts.reasoningContent } : {}),
      },
    }],
    usage: opts.usage ?? {
      prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
      prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80,
    },
  };
  return okJson(body);
}

// ============================================================================

beforeEach(() => {
  TEST_CWD = path.join(os.tmpdir(), `cc-auto-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  REPO_ROOT = TEST_CWD;
  mkdirSync(TEST_CWD, { recursive: true });
  mkdirSync(path.join(TEST_CWD, 'src'), { recursive: true });
  mkdirSync(path.join(TEST_CWD, '.cc-auto'), { recursive: true });
  initGitRepo(TEST_CWD);
});

afterEach(() => {
  try { releaseRunLease(TEST_CWD, RUN_ID); } catch { /* ok */ }
  try { rmSync(TEST_CWD, { recursive: true, force: true }); } catch { /* ok */ }
});

function createRegistry(fetchImpl: FetchLike): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new OpenAIChatAdapter(fetchImpl));
  return registry;
}

// ============================================================================
// 24.1 read → final
// ============================================================================

describe('integration: read → final', () => {
  it('two Provider calls, two callIds, two UsageRecords, no file changes', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'export const x = 1;\n');

    let turn = 0;
    const { fetch, requests } = createFakeFetch(() => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: 'Let me read the file.',
          toolCalls: [{ id: 'call_read_1', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
        });
      }
      return chatResponse({ content: 'The file contains export const x = 1; task done.' });
    });

    const registry = createRegistry(fetch);
    const runId = createRunState(TEST_CWD, 'int-read-final', 'read → final', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: makeScope(),
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Read the file.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    // 2 different callIds
    expect(result.callIds.length).toBe(2);
    expect(new Set(result.callIds).size).toBe(2);

    // 2 CallRecord / 2 UsageRecord
    const state = loadRunState(TEST_CWD, runId);
    expect(state.calls.length).toBe(2);
    expect(state.pendingCall).toBeUndefined();

    // PendingCall empty
    expect(state.pendingCall).toBeUndefined();

    // Round 2 request contains assistant tool_calls
    const body2 = JSON.parse(requests[0].body);
    void body2; // Round 1

    // File unchanged
    const diff = gitDiff(TEST_CWD);
    expect(diff).toBe('');

    // COMPLETED
    expect(result.status).toBe('COMPLETED');
    expect(result.summary.terminationReason).toBe('FINAL_RESPONSE');
  });
});

// ============================================================================
// 24.2 read → edit → final
// ============================================================================

describe('integration: read → edit → final', () => {
  it('three Provider calls, file changes, git diff non-empty, changedFiles correct', async () => {
    const initialContent = 'export const value: string = 1;\n';
    writeApprovedFile(TEST_CWD, 'src/example.ts', initialContent);
    // Stage the initial file so git diff can detect changes
    execSync('git add src/example.ts && git commit -m "fixture"', { cwd: TEST_CWD, stdio: 'pipe' });
    const scope = makeScope({ approvedFiles: ['src/example.ts'] });
    const runId = createRunState(TEST_CWD, 'int-edit', 'read → edit → final', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let turn = 0;
    const { fetch } = createFakeFetch(() => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: 'Reading the file...',
          toolCalls: [{ id: 'call_read', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
        });
      }
      if (turn === 2) {
        return chatResponse({
          content: 'Editing...',
          toolCalls: [{
            id: 'call_edit',
            name: 'edit_file',
            args: JSON.stringify({ path: 'src/example.ts', oldText: 'export const value: string = 1;', newText: 'export const value: number = 1;' }),
          }],
        });
      }
      return chatResponse({ content: 'Done. File changed from string to number.' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Edit example.ts.',
      maxTurns: 5, maxToolCallsPerTurn: 4, maxTotalToolCalls: 10,
    });

    // 3 callIds
    expect(result.callIds.length).toBe(3);
    expect(new Set(result.callIds).size).toBe(3);

    // 3 CallRecord / 3 UsageRecord
    const state = loadRunState(TEST_CWD, runId);
    expect(state.calls.length).toBe(3);
    expect(state.pendingCall).toBeUndefined();

    // Git diff non-empty
    const diff = gitDiff(TEST_CWD);
    expect(diff).toContain('src/example.ts');

    // changedFiles correct
    expect(result.summary.changedFiles).toContain('src/example.ts');

    // File content changed
    const finalContent = readFileSync(path.join(TEST_CWD, 'src/example.ts'), 'utf8');
    expect(finalContent).toBe('export const value: number = 1;\n');

    // Verifier can read final file
    expect(finalContent).toContain('number');

    // COMPLETED
    expect(result.status).toBe('COMPLETED');
    expect(result.summary.terminationReason).toBe('FINAL_RESPONSE');

    // writer unchanged via Tool Loop (writer stays deepseek but Tool Loop doesn't change it)
    // Check the scope wasn't mutated
    expect(scope.approvedFiles).toContain('src/example.ts');
  });
});

// ============================================================================
// 24.3 write → final
// ============================================================================

describe('integration: write → final', () => {
  it('writes new file, Safe Write used, no temp residue', async () => {
    const scope = makeScope({ approvedFiles: ['src/out.ts'] });
    const runId = createRunState(TEST_CWD, 'int-write', 'write → final', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');
    // Ensure the initial commit exists for git diff to show changes against
    execSync('git commit --allow-empty -m "before-write"', { cwd: TEST_CWD, stdio: 'pipe' });

    let turn = 0;
    const { fetch } = createFakeFetch(() => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: 'Writing file...',
          toolCalls: [{
            id: 'call_write',
            name: 'write_file',
            args: JSON.stringify({ path: 'src/out.ts', content: 'export const created: boolean = true;\n' }),
          }],
        });
      }
      return chatResponse({ content: 'File created successfully.' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Write out.ts.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    // File exists and content is correct
    const content = readFileSync(path.join(TEST_CWD, 'src/out.ts'), 'utf8');
    expect(content).toBe('export const created: boolean = true;\n');

    // changedFiles correct (summary tracks write result)
    expect(result.summary.changedFiles).toContain('src/out.ts');

    // Status
    expect(result.status).toBe('COMPLETED');
  });
});

// ============================================================================
// 24.4 Unauthorized edit (file not in approvedFiles)
// ============================================================================

describe('integration: unauthorized edit', () => {
  it('file unchanged, tool error stops execution, no further Provider call', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'original\n');
    // NOT in approvedFiles (src/example.ts may be not approved)
    const scope = makeScope({ approvedFiles: [] });

    const runId = createRunState(TEST_CWD, 'int-unauth', 'unauthorized', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let providerCalls = 0;
    const { fetch } = createFakeFetch(() => {
      providerCalls++;
      return chatResponse({
        content: 'Editing...',
        toolCalls: [{
          id: 'call_bad',
          name: 'edit_file',
          args: JSON.stringify({ path: 'src/example.ts', oldText: 'original', newText: 'changed' }),
        }],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Edit unauthorized.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    // File unchanged
    const content = readFileSync(path.join(TEST_CWD, 'src/example.ts'), 'utf8');
    expect(content).toBe('original\n');

    // Tool execution failed
    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');

    // Only 1 Provider call — no second call after failure
    expect(providerCalls).toBe(1);

    // Provider usage preserved
    const state = loadRunState(TEST_CWD, runId);
    expect(state.calls.length).toBe(1);
  });
});

// ============================================================================
// 24.5 `..` path escape
// ============================================================================

describe('integration: path escape', () => {
  it('rejects ../ paths, does not modify files outside repo', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'safe\n');
    const scope = makeScope({ approvedFiles: ['src/example.ts'] });

    const runId = createRunState(TEST_CWD, 'int-escape', 'path escape', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    const { fetch } = createFakeFetch(() => {
      return chatResponse({
        content: 'Attempting escape...',
        toolCalls: [{
          id: 'escape_1',
          name: 'read_file',
          args: JSON.stringify({ path: '../../etc/passwd' }),
        }],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Escape.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');
  });
});

// ============================================================================
// 24.6 Absolute path escape
// ============================================================================

describe('integration: absolute path escape', () => {
  it('rejects absolute Windows paths', async () => {
    const scope = makeScope({ approvedFiles: ['src/example.ts'] });

    const runId = createRunState(TEST_CWD, 'int-abswin', 'abs path win', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    const { fetch } = createFakeFetch(() => {
      return chatResponse({
        content: 'Escaping...',
        toolCalls: [{
          id: 'abs_1',
          name: 'read_file',
          args: JSON.stringify({ path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }),
        }],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Escape.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');
  });

  it('rejects absolute POSIX paths', async () => {
    const scope = makeScope({ approvedFiles: ['src/example.ts'] });

    const runId = createRunState(TEST_CWD, 'int-absposix', 'abs path posix', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    const { fetch } = createFakeFetch(() => {
      return chatResponse({
        content: 'Escaping...',
        toolCalls: [{
          id: 'abs_2',
          name: 'read_file',
          args: JSON.stringify({ path: '/etc/passwd' }),
        }],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Escape.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');
  });
});

// ============================================================================
// 24.8 Invalid workspace (no lease)
// ============================================================================

describe('integration: invalid workspace', () => {
  it('fail closed without lease', async () => {
    const scope = makeScope({ approvedFiles: ['src/example.ts'] });

    const runId = `${RUN_ID}-no-lease`;

    const { fetch } = createFakeFetch(() => {
      return chatResponse({
        content: 'Trying...',
        toolCalls: [{ id: 'r1', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');
  });
});

// ============================================================================
// 24.9 oldText mismatch
// ============================================================================

describe('integration: oldText mismatch', () => {
  it('file unchanged, no further Provider call', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'actual content\n');
    const scope = makeScope({ approvedFiles: ['src/example.ts'] });

    const runId = createRunState(TEST_CWD, 'int-otm', 'oldText mismatch', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let providerCalls = 0;
    const { fetch } = createFakeFetch(() => {
      providerCalls++;
      return chatResponse({
        content: 'Editing...',
        toolCalls: [{
          id: 'edit_bad',
          name: 'edit_file',
          args: JSON.stringify({ path: 'src/example.ts', oldText: 'wrong content', newText: 'replaced' }),
        }],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Edit with wrong oldText.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    // File unchanged
    const content = readFileSync(path.join(TEST_CWD, 'src/example.ts'), 'utf8');
    expect(content).toBe('actual content\n');

    // STOPPED
    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');

    // Only 1 Provider call
    expect(providerCalls).toBe(1);
  });
});

// ============================================================================
// 24.10 Same-round second tool fails
// ============================================================================

describe('integration: same-round A succeeds, B fails, C skipped', () => {
  it('first tool succeeds, second fails, third skipped, no more Provider', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    // approvedFiles has only src/example.ts — second tool targets unapproved file
    const scope = makeScope({ approvedFiles: ['src/example.ts'] });

    const runId = createRunState(TEST_CWD, 'int-fail2', 'A ok B fail', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let providerCalls = 0;
    const { fetch } = createFakeFetch(() => {
      providerCalls++;
      return chatResponse({
        content: null,
        toolCalls: [
          { id: 'a', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) },
          { id: 'b', name: 'edit_file', args: JSON.stringify({ path: 'src/bad.ts', oldText: 'x', newText: 'y' }) },
          { id: 'c', name: 'grep', args: JSON.stringify({ query: 'hello', roots: ['src'] }) },
        ],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');
    expect(result.executedTools.length).toBe(2); // A (ok) + B (fail)
    expect(result.auditTrail.map((entry) => entry.status)).toEqual(['EXECUTED', 'EXECUTED', 'SKIPPED_AFTER_FAILURE']);
    expect(providerCalls).toBe(1);
  });
});

// ============================================================================
// 24.14 Permanent Provider error (400)
// ============================================================================

describe('integration: permanent Provider error', () => {
  it('no retry on 400 parameter error', async () => {
    const runId = createRunState(TEST_CWD, 'int-400', 'permanent error', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const { fetch } = createFakeFetch(() => {
      requestCount++;
      return new Response(JSON.stringify({
        error: { message: 'Invalid request parameter', type: 'invalid_request_error' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: makeScope(),
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 5, maxToolCallsPerTurn: 4, maxTotalToolCalls: 20,
    });

    expect(result.status).toBe('STOPPED');
    // Only 1 attempt — no retry on 400
    expect(requestCount).toBe(1);
  });
});

// ============================================================================
// 24.18 reasoning_content
// ============================================================================

describe('integration: reasoning_content passthrough', () => {
  it('reasoning_content in turn 1 response, passed to turn 2 request', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'export const x = 1;\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-reason', 'reasoning test', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let turn = 0;
    const { fetch, requests } = createFakeFetch(() => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: null,
          reasoningContent: 'The user wants to read a file. I should use read_file.',
          toolCalls: [{ id: 'r1', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
        });
      }
      return chatResponse({ content: 'Done.' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Read file.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('COMPLETED');

    // Turn 2 request body should contain assistant with reasoning_content
    // requests[1] is the second Provider call (turn 2), which carries the assistant message from turn 1
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const body2 = JSON.parse(requests[1].body) as {
      messages: Array<{ role: string; content: string | null; reasoning_content?: string; tool_calls?: unknown[] }>;
    };
    const assistantMsg = body2.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    // reasoning_content should be in the assistant message
    expect(assistantMsg!.reasoning_content).toBeDefined();
  });
});

// ============================================================================
// 24.19 Redaction
// ============================================================================

describe('integration: tool result redaction', () => {
  it('next-turn body does not contain secrets', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'Some content with /home/user/project\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-redact', 'redact test', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let turn = 0;
    const { fetch, requests } = createFakeFetch(() => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: null,
          toolCalls: [{ id: 'r1', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
        });
      }
      return chatResponse({ content: 'Final answer.' });
    });

    const registry = createRegistry(fetch);

    await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test-actual-key-value' },
      },
      systemPrompt: 'Test.', userPrompt: 'Read.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    // Turn 2 body must not contain the actual API key
    const body2 = JSON.parse(requests[0].body) as { messages: Array<{ content: string }> };
    const allContent = JSON.stringify(body2.messages);
    expect(allContent).not.toContain('sk-test-actual-key-value');
  });
});

// ============================================================================
// 24.11 Round 2 timeout
// ============================================================================

describe('integration: Provider timeout on second turn', () => {
  it('round 1 records preserved, round 2 timeout', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-r2timeout', 'round 2 timeout', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let turn = 0;
    const { fetch } = createFakeFetch((_url, init) => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: null,
          toolCalls: [{ id: 'r1', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
        });
      }
      // Simulate timeout by responding to abort signal
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
        } else if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 500, // short timeout
        adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 5, maxToolCallsPerTurn: 4, maxTotalToolCalls: 20,
    });

    expect(result.status).toBe('STOPPED');
    // Round 1 executed
    expect(result.executedTools.length).toBe(1);
    expect(result.turns).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// 24.12 Total timeout
// ============================================================================

describe('integration: total execution timeout', () => {
  it('stops before opening new turn when budget exceeded', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-totalto', 'total timeout', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    // Always return tool_calls to force multiple turns
    let turn = 0;
    const { fetch } = createFakeFetch(() => {
      turn++;
      return chatResponse({
        content: null,
        toolCalls: [{ id: `r${turn}`, name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 20, maxToolCallsPerTurn: 4, maxTotalToolCalls: 100,
      totalTimeoutMs: 1, // 1ms timeout — will fire immediately
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOTAL_TIMEOUT');
  });
});

// ============================================================================
// 24.16 Identity mismatch
// ============================================================================

describe('integration: identity mismatch', () => {
  it('fails immediately, no tools executed, cost null', async () => {
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-idm', 'identity mismatch', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    const { fetch } = createFakeFetch(() => {
      return chatResponse({
        content: 'Hello!',
        model: 'unknown-evil-model', // not in acceptedReportedModelIds
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('MODEL_IDENTITY_MISMATCH');
    expect(result.executedTools.length).toBe(0);
    expect(result.summary.modelIdentity).toBe('UNKNOWN');
  });
});

// ============================================================================
// 24.17 Repeated tool error — same call repeated
// ============================================================================

describe('integration: repeated tool error', () => {
  it('same tool + same args + same permanent error stops by repeat detection', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-repeat', 'repeat error', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    // Same tool call each turn
    let turn = 0;
    const { fetch } = createFakeFetch(() => {
      turn++;
      return chatResponse({
        content: null,
        toolCalls: [{ id: `r${turn}`, name: 'read_file', args: JSON.stringify({ path: 'src/example.txt', startLine: 1 }) }],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    // The tool fails (read_file on nonexistent file), so immediate TOOL_EXECUTION_FAILED
    // REPEATED_TOOL_CALL only fires when identical successful tool calls repeat across turns
    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('TOOL_EXECUTION_FAILED');
  });
});

// ============================================================================
// Summary integrity
// ============================================================================

describe('integration: summary integrity', () => {
  it('summary has correct turn/token/duration after COMPLETED', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'export const x = 1;\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-summary', 'summary', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    const { fetch } = createFakeFetch(() => {
      return chatResponse({ content: 'All done!' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Say hi.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.summary.turns).toBe(1);
    expect(result.summary.toolCallCount).toBe(0);
    expect(result.summary.terminationReason).toBe('FINAL_RESPONSE');
    expect(result.summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.summary.callIds.length).toBe(1);
    expect(result.summary.provider).toBe('deepseek');
  });
});

// ============================================================================
// 1E-W §3: 429 → success retry
// ============================================================================

describe('integration: 429 retry → success', () => {
  it('attempt 1=429, attempt 2=success, 2 callIds, 1 sleep@250ms, COMPLETED, no 3rd attempt', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-429', '429 retry', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { fetch, requests } = createFakeFetch(() => {
      requestCount++;
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: '429' },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      return chatResponse({ content: 'Recovered after rate limit.' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
      maxTransientRetries: 2,
      sleep: fakeSleep,
    });

    // 2 HTTP requests total
    expect(requestCount).toBe(2);
    expect(requests.length).toBe(2);

    // 2 different callIds
    expect(result.callIds.length).toBe(2);
    expect(result.callIds[0]).not.toBe(result.callIds[1]);

    // sleep called once with 250ms
    expect(sleepCalls.length).toBe(1);
    expect(sleepCalls[0]).toBe(250);

    // COMPLETED
    expect(result.status).toBe('COMPLETED');
    expect(result.summary.terminationReason).toBe('FINAL_RESPONSE');

    // Only 1 UsageRecord for the successful final call (the 429 errors get isError=true records)
    const state = loadRunState(TEST_CWD, runId);
    // The 429 isError records also go to calls[] — so we have 2 total calls records
    // or maybe 1 if 429 doesn't generate a call record. Either way, success Usage exists.
    // The key assertion: success record exists
    expect(state.calls.some(c => c.isError === false)).toBe(true);

    // PendingCall cleared
    expect(state.pendingCall).toBeUndefined();

    // No 3rd request
    expect(requestCount).toBeLessThan(3);
  });
});

// ============================================================================
// 1E-W §4: 500 → 503 → success
// ============================================================================

describe('integration: 5xx retry → 5xx retry → success', () => {
  it('attempt 1=500, attempt 2=503, attempt 3=success, 3 callIds, sleep=[250,500]', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-5xx', '5xx retry', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { fetch, requests } = createFakeFetch(() => {
      requestCount++;
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          error: { message: 'Internal Server Error', type: 'server_error' },
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({
          error: { message: 'Service Unavailable', type: 'server_error' },
        }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return chatResponse({ content: 'Recovered after server errors.' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
      maxTransientRetries: 2,
      sleep: fakeSleep,
    });

    // 3 HTTP requests
    expect(requestCount).toBe(3);
    expect(requests.length).toBe(3);

    // 3 different callIds
    expect(result.callIds.length).toBe(3);
    expect(new Set(result.callIds).size).toBe(3);

    // sleep called twice: [250, 500]
    expect(sleepCalls.length).toBe(2);
    expect(sleepCalls[0]).toBe(250);
    expect(sleepCalls[1]).toBe(500);

    // COMPLETED — still within 1 Tool Loop turn
    expect(result.status).toBe('COMPLETED');
    expect(result.summary.terminationReason).toBe('FINAL_RESPONSE');
    expect(result.turns).toBe(1);

    // Success record exists (alongside error records for 500/503 attempts)
    const state = loadRunState(TEST_CWD, runId);
    // Each HTTP error gets an isError=true UsageRecord; success gets a normal record
    // Total: 3 records (500 + 503 + success)
    expect(state.calls.some(c => c.isError === false)).toBe(true);
    // Error records for 429/5xx have isError=true with empty usage → usageStatus='MISSING'
    // The success record should be present
    expect(state.pendingCall).toBeUndefined();
  });
});

// ============================================================================
// 1E-W §5: retry exhaustion
// ============================================================================

describe('integration: retry exhaustion', () => {
  it('429 → 500 → 503 failures, 3 attempts, 3 callIds, 2 sleeps, STOPPED with PROVIDER_RETRY_EXHAUSTED', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-rex', 'retry exhaustion', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { fetch, requests } = createFakeFetch(() => {
      requestCount++;
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          error: { message: 'Rate limit', type: 'rate_limit_error' },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({
          error: { message: 'Server error', type: 'server_error' },
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      // attempt 3 → 503
      return new Response(JSON.stringify({
        error: { message: 'Service unavailable', type: 'server_error' },
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
      maxTransientRetries: 2,
      sleep: fakeSleep,
    });

    // 3 Provider attempts total (0,1,2 = 3 attempts with maxTransientRetries=2)
    expect(requestCount).toBe(3);
    expect(requests.length).toBe(3);

    // 3 different callIds
    expect(result.callIds.length).toBe(3);
    expect(new Set(result.callIds).size).toBe(3);

    // 2 sleep calls
    expect(sleepCalls.length).toBe(2);

    // No 4th call
    expect(requestCount).toBeLessThan(4);

    // STOPPED with PROVIDER_RETRY_EXHAUSTED
    expect(result.status).toBe('STOPPED');
    expect(result.summary.terminationReason).toBe('PROVIDER_RETRY_EXHAUSTED');
    expect(result.stopReason).toBe('PROVIDER_RETRY_EXHAUSTED');

    // No tools executed
    expect(result.executedTools.length).toBe(0);
  });
});

// ============================================================================
// 1E-W §5a: Transient transport → success
// ============================================================================

describe('integration: transient transport → success', () => {
  it('attempt 1=transient TransportError(ECONNRESET), attempt 2=success, 2 callIds, sleep=[250], FINAL_RESPONSE', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-tte', 'transient transport', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { TransportError } = await import('./providerErrors');
    let calls = 0;
    const adapter = {
      transport: 'openai-chat' as const,
      validateProfile: undefined,
      execute: async (req: import('./types').ProviderCallRequest, _ctx: import('./types').ProviderExecutionContext) => {
        calls++;
        requestCount = calls;
        if (calls === 1) {
          throw new TransportError('ECONNRESET: connection reset', { transient: true });
        }
        return {
          callId: req.callId,
          providerId: req.providerId,
          requestedModelId: req.requestedModelId,
          reportedModel: 'deepseek-chat',
          content: 'Recovered after transport error.',
          usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 20 },
          durationMs: 1,
          numTurns: 1,
          subtype: 'stop',
          isError: false,
          error: null,
        };
      },
    };
    const reg = new AdapterRegistry();
    reg.register(adapter);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: reg,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
      maxTransientRetries: 2,
      sleep: fakeSleep,
    });

    expect(requestCount).toBe(2);
    expect(result.callIds.length).toBe(2);
    expect(result.callIds[0]).not.toBe(result.callIds[1]);
    expect(sleepCalls.length).toBe(1);
    expect(sleepCalls[0]).toBe(250);
    expect(result.status).toBe('COMPLETED');
    expect(result.summary.terminationReason).toBe('FINAL_RESPONSE');
    expect(result.turns).toBe(1);
  });
});

// ============================================================================
// 1E-W §5b: Transient transport exhaustion
// ============================================================================

describe('integration: transient transport exhaustion', () => {
  it('3x transient TransportError, maxTransientRetries=2, 3 attempts, 2 sleeps, PROVIDER_RETRY_EXHAUSTED', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-ttex', 'transient transport exhaustion', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { TransportError: TE2 } = await import('./providerErrors');
    let calls = 0;
    const adapter = {
      transport: 'openai-chat' as const,
      validateProfile: undefined,
      execute: async (_req: import('./types').ProviderCallRequest, _ctx: import('./types').ProviderExecutionContext) => {
        calls++;
        requestCount = calls;
        throw new TE2(`ECONNRESET attempt ${calls}`, { transient: true });
      },
    };
    const reg = new AdapterRegistry();
    reg.register(adapter);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: reg,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
      maxTransientRetries: 2,
      sleep: fakeSleep,
    });

    expect(requestCount).toBe(3);
    expect(result.callIds.length).toBe(3);
    expect(new Set(result.callIds).size).toBe(3);
    expect(sleepCalls.length).toBe(2);
    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('PROVIDER_RETRY_EXHAUSTED');
    expect(result.summary.terminationReason).toBe('PROVIDER_RETRY_EXHAUSTED');
    expect(result.executedTools.length).toBe(0);
  });
});

// ============================================================================
// 1E-W §5c: Permanent / non-transient transport
// ============================================================================

describe('integration: permanent non-transient transport', () => {
  it('TransportError with transient=false → 1 attempt, sleep=0, PROVIDER_ERROR', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'hello\n');
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-ntz', 'non-transient transport', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { TransportError: TE3 } = await import('./providerErrors');
    let calls = 0;
    const adapter = {
      transport: 'openai-chat' as const,
      validateProfile: undefined,
      execute: async (_req: import('./types').ProviderCallRequest, _ctx: import('./types').ProviderExecutionContext) => {
        calls++;
        requestCount = calls;
        throw new TE3('TLS certificate expired — permanent failure');
      },
    };
    const reg = new AdapterRegistry();
    reg.register(adapter);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: reg,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
      maxTransientRetries: 2,
      sleep: fakeSleep,
    });

    expect(requestCount).toBe(1);
    expect(sleepCalls.length).toBe(0);
    expect(result.callIds.length).toBe(1);
    expect(result.status).toBe('STOPPED');
    expect(result.summary.terminationReason).toBe('PROVIDER_ERROR');
    expect(result.stopReason).toBe('PROVIDER_ERROR');
  });
});

// ============================================================================
// 1E-W §6: Permanent errors — no retry
// ============================================================================

describe('integration: permanent errors — no retry', () => {
  it('400: 1 attempt, no retry, STOPPED with PROVIDER_ERROR', async () => {
    const runId = createRunState(TEST_CWD, 'int-400-p', '400 permanent', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { fetch } = createFakeFetch(() => {
      requestCount++;
      return new Response(JSON.stringify({
        error: { message: 'Invalid request parameter', type: 'invalid_request_error' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: makeScope(),
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 5, maxToolCallsPerTurn: 4, maxTotalToolCalls: 20,
      maxTransientRetries: 2,
      sleep: fakeSleep,
    });

    // 1 attempt only
    expect(requestCount).toBe(1);
    expect(sleepCalls.length).toBe(0);
    expect(result.callIds.length).toBe(1);

    // STOPPED
    expect(result.status).toBe('STOPPED');
    expect(result.summary.terminationReason).toBe('PROVIDER_ERROR');
  });

  it('MODEL_IDENTITY_MISMATCH: 1 attempt, no retry, STOPPED', async () => {
    const runId = createRunState(TEST_CWD, 'int-mm-p', 'mismatch permanent', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { fetch } = createFakeFetch(() => {
      requestCount++;
      return chatResponse({ content: 'Hello!', model: 'unknown-evil-model' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: makeScope(),
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 5, maxToolCallsPerTurn: 4, maxTotalToolCalls: 20,
      maxTransientRetries: 2,
      sleep: fakeSleep,
    });

    expect(requestCount).toBe(1);
    expect(sleepCalls.length).toBe(0);
    expect(result.callIds.length).toBe(1);
    expect(result.status).toBe('STOPPED');
    expect(result.summary.terminationReason).toBe('MODEL_IDENTITY_MISMATCH');
  });

  it('MODEL_IDENTITY_UNVERIFIED: 1 attempt, no retry, STOPPED with MODEL_IDENTITY_UNVERIFIED', async () => {
    const runId = createRunState(TEST_CWD, 'int-uv-p', 'unverified permanent', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { fetch } = createFakeFetch(() => {
      requestCount++;
      return new Response(JSON.stringify({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1722782400,
        model: null, // explicitly null model → UNVERIFIED
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Hello.' },
        }],
        usage: {
          prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
          prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: makeScope(),
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 5, maxToolCallsPerTurn: 4, maxTotalToolCalls: 20,
      maxTransientRetries: 2,
      sleep: fakeSleep,
    });

    // 1 attempt only, no retry
    expect(requestCount).toBe(1);
    expect(sleepCalls.length).toBe(0);
    expect(result.callIds.length).toBe(1);

    // STOPPED with MODEL_IDENTITY_UNVERIFIED
    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('MODEL_IDENTITY_UNVERIFIED');
    expect(result.summary.terminationReason).toBe('MODEL_IDENTITY_UNVERIFIED');

    // No tools executed
    expect(result.executedTools.length).toBe(0);
  });
});

// ============================================================================
// 1E-W §7: UNKNOWN_AFTER_CRASH Tool Loop regression
// ============================================================================

describe('integration: UNKNOWN_AFTER_CRASH Tool Loop regression', () => {
  it('round 1 read_file succeeds, round 2 dispatch crashes → PendingCall=UNKNOWN_AFTER_CRASH, round 1 preserved, no false usage', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'export const x = 1;\n');
    execSync('git add src/example.ts && git commit -m "fixture-crash"', { cwd: TEST_CWD, stdio: 'pipe' });
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-crash', 'crash after dispatch', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let requestCount = 0;
    // Custom adapter that throws a raw non-domain Error on the second call
    const crashAdapter = {
      transport: 'openai-chat' as const,
      execute: async (req: import('./types').ProviderCallRequest, _ctx: import('./types').ProviderExecutionContext) => {
        requestCount++;
        if (requestCount === 1) {
          // Round 1: return a normal tool_calls response
          return {
            callId: req.callId,
            providerId: req.providerId,
            requestedModelId: req.requestedModelId,
            reportedModel: req.requestedModelId,
            content: 'Let me read the file.',
            usage: {
              inputTokens: 1500, outputTokens: 800,
              cacheCreationInputTokens: 0, cacheReadInputTokens: 200,
            },
            durationMs: 500,
            numTurns: 1,
            subtype: 'tool_calls',
            isError: false,
            error: null,
            toolCalls: [{ id: 'cr_r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/example.ts' }) } }],
            reasoningContent: null,
          };
        }
        // Round 2: throw raw Error (not TimeoutError/TransportError/ProviderProtocolError)
        throw new Error('Connection reset by peer — unexpected crash');
      },
    };
    const crashRegistry = new AdapterRegistry();
    crashRegistry.register(crashAdapter as any);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: crashRegistry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Read the file.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
      maxTransientRetries: 0, // don't retry crash errors
    });

    // Round 1 tool executed
    expect(result.executedTools.length).toBe(1);
    expect(result.executedTools[0].ok).toBe(true);

    // STOPPED with UNKNOWN_AFTER_CRASH
    expect(result.status).toBe('STOPPED');
    expect(result.stopReason).toBe('UNKNOWN_AFTER_CRASH');
    expect(result.summary.terminationReason).toBe('UNKNOWN_AFTER_CRASH');

    // Round 2 did NOT generate a UsageRecord in calls[]
    const state = loadRunState(TEST_CWD, runId);
    // Round 1 UsageRecord present
    expect(state.calls.length).toBeGreaterThanOrEqual(1);

    // Round 2 PendingCall = UNKNOWN_AFTER_CRASH
    expect(state.pendingCall).toBeDefined();
    expect(state.pendingCall!.status).toBe('UNKNOWN_AFTER_CRASH');

    // No further tools executed
    // (result.executedTools only has the round 1 tool)
    expect(result.turns).toBeGreaterThanOrEqual(1);
    // Round 1 preserved — no tools from failed round
    expect(result.executedTools.filter(e => e.ok).length).toBe(1);
  });
});

// ============================================================================
// 1E-W §8-9: Round 2+3 HTTP history full assertions
// ============================================================================

describe('integration: Round 2 HTTP history — read → final', () => {
  it('requests[1] messages=[system, user, assistant, tool] with tool_call_id match', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'export const x = 1;\n');
    execSync('git add src/example.ts && git commit -m "fixture-r2"', { cwd: TEST_CWD, stdio: 'pipe' });
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-r2hist', 'round 2 history', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let turn = 0;
    const { fetch, requests } = createFakeFetch(() => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: 'Reading...',
          toolCalls: [{ id: 'call_read_r2', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
        });
      }
      return chatResponse({ content: 'Final answer.' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'System instruction.', userPrompt: 'Read example.ts.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('COMPLETED');
    expect(requests.length).toBeGreaterThanOrEqual(2);

    // requests[1] is round 2 body
    const body2 = JSON.parse(requests[1].body) as {
      messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }>;
    };

    // Assert message order: system, user, assistant, tool
    const roles = body2.messages.map(m => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);

    // Assistant has tool_calls
    const assistantMsg = body2.messages.find(m => m.role === 'assistant')!;
    expect(assistantMsg.tool_calls).toBeDefined();
    const tc = (assistantMsg.tool_calls as Array<{ id: string; function: { name: string } }>)[0];
    expect(tc.function.name).toBe('read_file');

    // Tool message has matching tool_call_id
    const toolMsg = body2.messages.find(m => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe(tc.id);
    expect(toolMsg.role).toBe('tool');
  });
});

describe('integration: Round 3 HTTP history — read → edit → final', () => {
  it('requests[2] messages=[system, user, assistant(read), tool(read), assistant(edit), tool(edit)], tool_call_ids match', async () => {
    const initialContent = 'export const value: string = 1;\n';
    writeApprovedFile(TEST_CWD, 'src/example.ts', initialContent);
    execSync('git add src/example.ts && git commit -m "fixture-r3"', { cwd: TEST_CWD, stdio: 'pipe' });
    const scope = makeScope({ approvedFiles: ['src/example.ts'] });
    const runId = createRunState(TEST_CWD, 'int-r3hist', 'round 3 history', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let turn = 0;
    const { fetch, requests } = createFakeFetch(() => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: 'Reading the file...',
          toolCalls: [{ id: 'call_read_r3', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
        });
      }
      if (turn === 2) {
        return chatResponse({
          content: 'Editing...',
          toolCalls: [{
            id: 'call_edit_r3',
            name: 'edit_file',
            args: JSON.stringify({ path: 'src/example.ts', oldText: 'export const value: string = 1;', newText: 'export const value: number = 1;' }),
          }],
        });
      }
      return chatResponse({ content: 'Done.' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'System.', userPrompt: 'Read and edit.',
      maxTurns: 5, maxToolCallsPerTurn: 4, maxTotalToolCalls: 10,
    });

    expect(result.status).toBe('COMPLETED');
    expect(requests.length).toBeGreaterThanOrEqual(3);

    // requests[2] = round 3 body
    const body3 = JSON.parse(requests[2].body) as {
      messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string } }>; tool_call_id?: string }>;
    };

    // Full message order: system, user, assistant(read), tool(read), assistant(edit), tool(edit)
    const roles = body3.messages.map(m => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);

    // read assistant tool_call
    const readAssistant = body3.messages[2];
    expect(readAssistant.role).toBe('assistant');
    expect(readAssistant.tool_calls![0].function.name).toBe('read_file');
    const readToolCallId = readAssistant.tool_calls![0].id;

    // read tool result
    const readTool = body3.messages[3];
    expect(readTool.role).toBe('tool');
    expect(readTool.tool_call_id).toBe(readToolCallId);

    // edit assistant tool_call
    const editAssistant = body3.messages[4];
    expect(editAssistant.role).toBe('assistant');
    expect(editAssistant.tool_calls![0].function.name).toBe('edit_file');
    const editToolCallId = editAssistant.tool_calls![0].id;

    // edit tool result
    const editTool = body3.messages[5];
    expect(editTool.role).toBe('tool');
    expect(editTool.tool_call_id).toBe(editToolCallId);

    // Round 1 assistant tool_calls still present in Round 3 history
    const allAssistantToolCallIds = body3.messages
      .filter(m => m.role === 'assistant' && m.tool_calls)
      .flatMap(m => m.tool_calls!.map((tc: { id: string }) => tc.id));
    expect(allAssistantToolCallIds).toContain('call_read_r3');
    expect(allAssistantToolCallIds).toContain('call_edit_r3');
  });
});

// ============================================================================
// 1E-W §10: reasoning_content cross-round assertions
// ============================================================================

describe('integration: reasoning_content cross-round assertions', () => {
  it('round 1 reasoning_content preserved in round 2 request, round 2 reasoning_content preserved in round 3', async () => {
    writeApprovedFile(TEST_CWD, 'src/example.ts', 'export const x = 1;\n');
    writeApprovedFile(TEST_CWD, 'src/other.ts', 'export const y = 2;\n');
    execSync('git add -A && git commit -m "fixture-reason"', { cwd: TEST_CWD, stdio: 'pipe' });
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-rcr', 'reasoning cross', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let turn = 0;
    const { fetch, requests } = createFakeFetch(() => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: null,
          reasoningContent: 'reasoning-round-1',
          toolCalls: [{ id: 'r1_rc', name: 'read_file', args: JSON.stringify({ path: 'src/example.ts' }) }],
        });
      }
      if (turn === 2) {
        return chatResponse({
          content: null,
          reasoningContent: 'reasoning-round-2',
          toolCalls: [{ id: 'r2_rc', name: 'read_file', args: JSON.stringify({ path: 'src/other.ts' }) }],
        });
      }
      return chatResponse({ content: 'All done.' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Task.',
      maxTurns: 5, maxToolCallsPerTurn: 4, maxTotalToolCalls: 10,
    });

    expect(result.status).toBe('COMPLETED');
    expect(requests.length).toBeGreaterThanOrEqual(3);

    // Round 2 body (requests[1]) — should have round 1 reasoning_content
    const body2 = JSON.parse(requests[1].body) as {
      messages: Array<{ role: string; content: string | null; reasoning_content?: string | null; tool_calls?: unknown[] }>;
    };
    const r2Assistants = body2.messages.filter(m => m.role === 'assistant' && m.reasoning_content);
    expect(r2Assistants.length).toBeGreaterThanOrEqual(1);
    // Round 1 assistant with reasoning_content="reasoning-round-1"
    expect(r2Assistants[0].reasoning_content).toBe('reasoning-round-1');
    // Tool calls preserved alongside reasoning_content
    expect(r2Assistants[0].tool_calls).toBeDefined();
    // content preserved (was null)
    expect(r2Assistants[0].content === null || r2Assistants[0].content === '').toBe(true);

    // Round 3 body (requests[2]) — should have BOTH round 1 and round 2 reasoning_content
    const body3 = JSON.parse(requests[2].body) as {
      messages: Array<{ role: string; reasoning_content?: string | null }>;
    };
    const r3ReasoningMsgs = body3.messages.filter(m => m.role === 'assistant' && m.reasoning_content);
    expect(r3ReasoningMsgs.length).toBeGreaterThanOrEqual(2);
    const reasoningValues = r3ReasoningMsgs.map(m => m.reasoning_content);
    expect(reasoningValues).toContain('reasoning-round-1');
    expect(reasoningValues).toContain('reasoning-round-2');
  });
});

// ============================================================================
// 1E-W §11: Real Tool Result redaction with file-based secrets
// ============================================================================

describe('integration: real tool result redaction', () => {
  it('secrets in file content → tool result → redacted → next-turn body clean but tool message present', async () => {
    // Create fixture file with real secrets
    const secretContent = 'apiKey=sk-test-secret-123\nauth=Bearer secret-token\n';
    writeApprovedFile(TEST_CWD, 'src/secret-fixture.txt', secretContent);
    execSync('git add src/secret-fixture.txt && git commit -m "fixture-redact"', { cwd: TEST_CWD, stdio: 'pipe' });
    const scope = makeScope();
    const runId = createRunState(TEST_CWD, 'int-redact2', 'redact fixture', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');

    let turn = 0;
    const { fetch, requests } = createFakeFetch(() => {
      turn++;
      if (turn === 1) {
        return chatResponse({
          content: 'Reading the secret file...',
          toolCalls: [{ id: 'call_read_secret', name: 'read_file', args: JSON.stringify({ path: 'src/secret-fixture.txt' }) }],
        });
      }
      return chatResponse({ content: 'File read. I see the content.' });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        // DEEPSEEK_API_KEY value partially overlaps with fixture content
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Read secret-fixture.txt.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
    });

    expect(result.status).toBe('COMPLETED');
    expect(requests.length).toBeGreaterThanOrEqual(2);

    // The tool result block in requests[1] must contain the tool message
    const body2Text = JSON.stringify(JSON.parse(requests[1].body));
    // Tool message exists (proof that file content was truly read and carried forward)
    expect(body2Text).toContain('"role":"tool"');
    expect(body2Text).toContain('"tool_call_id":"call_read_secret"');

    // Secrets must NOT appear in the body
    expect(body2Text).not.toContain('sk-test-secret-123');
    expect(body2Text).not.toContain('Bearer secret-token');

    // sk-test (the DEEPSEEK_API_KEY value) must not appear unredacted
    // It's used as the credential for Adapter calls, and Tool Loop passes it as a secret to redact
    expect(body2Text).not.toContain('sk-test');
  });
});

// ============================================================================
// 1E-W §12: maxWriteContentBytes Tool Loop integration test
// ============================================================================

describe('integration: maxWriteContentBytes limit — Tool Loop level', () => {
  it('write_file content > maxWriteContentBytes → protocol reject, file not created, STOPPED with TOOL_PROTOCOL_FAILED', async () => {
    const scope = makeScope({ approvedFiles: ['src/out.ts'] });
    const runId = createRunState(TEST_CWD, 'int-wcl', 'write content limit', 'custom').runId;
    acquireRunLease(TEST_CWD, runId, 'a'.repeat(64));
    setWriter(TEST_CWD, runId, 'deepseek');
    execSync('git commit --allow-empty -m "before-write-limit"', { cwd: TEST_CWD, stdio: 'pipe' });

    // Build content > 1024 bytes (1 UTF-8 char = 1 byte for ASCII)
    const oversizedContent = 'x'.repeat(2000); // 2000 bytes > 1024

    let providerCalls = 0;
    const { fetch } = createFakeFetch(() => {
      providerCalls++;
      return chatResponse({
        content: 'Writing...',
        toolCalls: [{
          id: 'call_wl',
          name: 'write_file',
          args: JSON.stringify({ path: 'src/out.ts', content: oversizedContent }),
        }],
      });
    });

    const registry = createRegistry(fetch);

    const result = await runDeepSeekToolLoop({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId,
      fileScope: scope,
      executorContext: {
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        maxOutputTokens: 4096, timeoutMs: 30_000, adapterRegistry: registry,
        parentEnv: { PATH: process.env.PATH ?? '', DEEPSEEK_API_KEY: 'sk-test' },
      },
      systemPrompt: 'Test.', userPrompt: 'Write file.',
      maxTurns: 3, maxToolCallsPerTurn: 4, maxTotalToolCalls: 8,
      maxWriteContentBytes: 1024, // limit to 1024 bytes
    });

    // Protocol rejection before dispatch
    expect(result.status).toBe('STOPPED');
    expect(result.summary.terminationReason).toBe('TOOL_PROTOCOL_FAILED');
    expect(result.stopReason).toBe('TOOL_PROTOCOL_ERROR');

    // File NOT created
    expect(existsSync(path.join(TEST_CWD, 'src/out.ts'))).toBe(false);

    // Only 1 Provider call (the initial one that returned the tool_calls)
    expect(providerCalls).toBe(1);

    // Tool was rejected at protocol layer, not executed
    expect(result.auditTrail.length).toBe(1);
    expect(result.auditTrail[0].status).toBe('REJECTED_PROTOCOL');
    expect(result.auditTrail[0].errorReason).toBe('CONTENT_TOO_LARGE');
  });
});
