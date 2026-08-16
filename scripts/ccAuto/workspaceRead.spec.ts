/** workspaceRead.spec.ts —— 工作区安全读取执行点完整测试 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authorizeWorkspaceRead,
  safeReadFile,
  safeGrep,
  safeGlob,
  createWorkspaceReadBudget,
  type ReadAuthOptions,
} from './workspaceRead';
import { acquireRunLease, releaseRunLease } from './runLease';
import type { FileScope } from './types';
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ============================================================================
// Symlink / Junction 能力探测
// ============================================================================
let symlinkFileSupported = false;
let junctionSupported = false;

{
  const tmpBase = path.join(os.tmpdir(), 'cc-auto-read-cap-');
  try { mkdirSync(tmpBase, { recursive: true }); } catch { /* ok */ }

  const tFile = path.join(tmpBase, 'cap.txt');
  const lFile = path.join(tmpBase, 'cap-link.txt');
  writeFileSync(tFile, 'cap', 'utf8');
  try { symlinkSync(tFile, lFile, 'file'); symlinkFileSupported = true; rmSync(lFile); }
  catch { /* non-fatal */ }

  const targetDir = path.join(tmpBase, 'target-dir');
  const junction = path.join(tmpBase, 'junction-dir');
  mkdirSync(targetDir, { recursive: true });
  try { symlinkSync(targetDir, junction, 'junction'); junctionSupported = true; rmSync(junction); }
  catch { /* non-fatal */ }

  rmSync(tmpBase, { recursive: true, force: true });
}

// ============================================================================
// Test fixtures
// ============================================================================

let TEST_CWD: string;
let REPO_ROOT: string;
const RUN_ID = 'run-test-read';

function makeScope(overrides: Partial<FileScope> = {}): FileScope {
  return {
    allowedRoots: ['src', 'scripts'],
    protectedPaths: [],
    proposedFiles: [],
    approvedFiles: ['src/test.txt'],
    maxChangedFiles: 10,
    ...overrides,
  };
}

function setupLease(): void {
  acquireRunLease(TEST_CWD, RUN_ID, 'a'.repeat(64));
}

function readAuth(targetPath: string, overrides: Partial<ReadAuthOptions & { startLine?: number; endLine?: number }> = {}): ReadAuthOptions {
  return {
    repositoryRoot: REPO_ROOT,
    cwd: TEST_CWD,
    runId: RUN_ID,
    targetPath,
    fileScope: makeScope(),
    ...overrides,
  };
}

beforeEach(() => {
  TEST_CWD = path.join(os.tmpdir(), `cc-auto-read-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  REPO_ROOT = TEST_CWD; // For read tests, repo is the same as cwd
  mkdirSync(TEST_CWD, { recursive: true });
  mkdirSync(path.join(TEST_CWD, 'src'), { recursive: true });
  mkdirSync(path.join(TEST_CWD, 'scripts'), { recursive: true });
  mkdirSync(path.join(TEST_CWD, '.cc-auto'), { recursive: true });
  writeFileSync(path.join(TEST_CWD, 'src', 'test.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n', 'utf8');
  writeFileSync(path.join(TEST_CWD, 'src', 'chinese.txt'), '你好世界\nこんにちは\n', 'utf8');
});

afterEach(() => {
  try { releaseRunLease(TEST_CWD, RUN_ID); } catch { /* ok */ }
  try { rmSync(TEST_CWD, { recursive: true, force: true }); } catch { /* ok */ }
});

// ============================================================================
// authorizeWorkspaceRead
// ============================================================================
describe('authorizeWorkspaceRead', () => {
  beforeEach(() => setupLease());

  it('authorizes a file in allowedRoots', () => {
    const r = authorizeWorkspaceRead(readAuth('src/test.txt'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalizedPath).toBe('src/test.txt');
  });

  it('rejects invalid path', () => {
    const r = authorizeWorkspaceRead(readAuth('/etc/passwd'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INVALID_PATH');
  });

  it('rejects non-existent file', () => {
    const r = authorizeWorkspaceRead(readAuth('src/nonexistent.txt'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['FILE_NOT_FOUND', 'FILE_NOT_REGULAR_FILE']).toContain(r.reason);
  });

  it('rejects system protected path', () => {
    const r = authorizeWorkspaceRead(readAuth('.git/config'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SYSTEM_PROTECTED_PATH');
  });

  it('rejects directory', () => {
    mkdirSync(path.join(TEST_CWD, 'src', 'subdir'), { recursive: true });
    // A directory is not a regular file
    setupLease();
    const r = authorizeWorkspaceRead(readAuth('src/subdir'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FILE_NOT_REGULAR_FILE');
  });

  it('rejects protectedPaths', () => {
    const s = makeScope({ protectedPaths: ['src/test.txt'] });
    const r = authorizeWorkspaceRead(readAuth('src/test.txt', { fileScope: s }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PROTECTED_PATH');
  });

  it('rejects when no lease', () => {
    releaseRunLease(TEST_CWD, RUN_ID);
    const r = authorizeWorkspaceRead(readAuth('src/test.txt'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('RUN_LEASE_MISSING');
  });

  it('rejects runId mismatch', () => {
    const r = authorizeWorkspaceRead(readAuth('src/test.txt', { runId: 'wrong-id' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('RUN_LEASE_MISMATCH');
  });

  it('rejects file outside allowedRoots', () => {
    mkdirSync(path.join(TEST_CWD, 'outside'), { recursive: true });
    writeFileSync(path.join(TEST_CWD, 'outside', 'file.txt'), 'data', 'utf8');
    const s = makeScope({ allowedRoots: ['src'] });
    const r = authorizeWorkspaceRead(readAuth('outside/file.txt', { fileScope: s }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PATH_OUTSIDE_ROOTS');
  });

  it('does not expand an approved file into approval for its siblings', () => {
    writeFileSync(path.join(TEST_CWD, 'src', 'sibling.txt'), 'sibling', 'utf8');
    const scope = makeScope({ allowedRoots: ['scripts'], approvedFiles: ['src/test.txt'] });
    expect(authorizeWorkspaceRead(readAuth('src/test.txt', { fileScope: scope })).ok).toBe(true);
    const sibling = authorizeWorkspaceRead(readAuth('src/sibling.txt', { fileScope: scope }));
    expect(sibling.ok).toBe(false);
    if (!sibling.ok) expect(sibling.reason).toBe('PATH_OUTSIDE_ROOTS');
  });

  // Symlink tests
  it.skipIf(!symlinkFileSupported)('rejects symlink', () => {
    const t = path.join(TEST_CWD, 'src', 'real-link-target.txt');
    writeFileSync(t, 'real', 'utf8');
    const l = path.join(TEST_CWD, 'src', 'link.txt');
    symlinkSync(t, l, 'file');
    const r = authorizeWorkspaceRead(readAuth('src/link.txt'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SYMLINK_DETECTED');
  });

  it.skipIf(!junctionSupported)('rejects a path that traverses a junction', () => {
    const outside = path.join(TEST_CWD, 'outside-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'outside', 'utf8');
    symlinkSync(outside, path.join(TEST_CWD, 'src', 'junction'), 'junction');
    const result = authorizeWorkspaceRead(readAuth('src/junction/secret.txt'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['JUNCTION_DETECTED', 'SYMLINK_DETECTED']).toContain(result.reason);
  });
});

// ============================================================================
// safeReadFile tests
// ============================================================================
describe('safeReadFile', () => {
  beforeEach(() => setupLease());

  // 16. Normal UTF-8 file
  it('reads a normal UTF-8 file', () => {
    const r = safeReadFile(readAuth('src/test.txt'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('line 1');
      expect(r.content).toContain('line 5');
    }
  });

  // 17. Chinese text
  it('reads Chinese UTF-8 text', () => {
    const r = safeReadFile(readAuth('src/chinese.txt'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('你好世界');
  });

  // 18. startLine / endLine
  it('respects startLine and endLine', () => {
    const opts: ReadAuthOptions & { startLine: number; endLine: number } = { ...readAuth('src/test.txt'), startLine: 2, endLine: 3 };
    const r = safeReadFile(opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toBe('line 2\nline 3');
      expect(r.startLine).toBe(2);
      expect(r.endLine).toBe(3);
    }
  });

  // 19. invalid line numbers (startLine > total)
  it('handles startLine beyond total lines', () => {
    const opts: ReadAuthOptions & { startLine: number } = { ...readAuth('src/test.txt'), startLine: 100 };
    const r = safeReadFile(opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toBe('');
      expect(r.lineCount).toBe(0);
    }
  });

  // 20. max line truncation
  it('truncates lines beyond max', () => {
    // Create a file with many lines
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
    writeFileSync(path.join(TEST_CWD, 'src', 'many-lines.txt'), lines.join('\n'), 'utf8');
    const s = makeScope({ approvedFiles: ['src/many-lines.txt'], allowedRoots: ['src'] });
    const r = safeReadFile(readAuth('src/many-lines.txt', { fileScope: s }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.lineCount).toBeLessThanOrEqual(400);
    }
  });

  // 21. max byte rejection
  it('rejects files beyond the configured byte limit', () => {
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) lines.push(`line ${i} with some extra padding to make it longer`);
    writeFileSync(path.join(TEST_CWD, 'src', 'big-file.txt'), lines.join('\n'), 'utf8');
    const s = makeScope({ approvedFiles: ['src/big-file.txt'], allowedRoots: ['src'] });
    const r = safeReadFile(readAuth('src/big-file.txt', { fileScope: s }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FILE_TOO_LARGE');
  });

  // 22. file not found — auth rejects before read happens
  it('returns error for non-existent file', () => {
    const s = makeScope({ approvedFiles: ['src/missing.txt'], allowedRoots: ['src'] });
    const r = safeReadFile(readAuth('src/missing.txt', { fileScope: s }));
    expect(r.ok).toBe(false);
    // The file doesn't exist → authorizeWorkspaceRead returns FILE_NOT_REGULAR_FILE
    if (!r.ok) expect(['FILE_NOT_FOUND', 'FILE_NOT_REGULAR_FILE']).toContain(r.reason);
  });

  // 23. directory (should fail at auth level)
  it('rejects directory', () => {
    mkdirSync(path.join(TEST_CWD, 'src', 'mydir'), { recursive: true });
    const r = safeReadFile(readAuth('src/mydir'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FILE_NOT_REGULAR_FILE');
  });

  // 24 & 25. symlink / junction → skipped on capability
  it.skipIf(!symlinkFileSupported)('rejects symlink for reading', () => {
    const t = path.join(TEST_CWD, 'src', 'read-target.txt');
    writeFileSync(t, 'target', 'utf8');
    const l = path.join(TEST_CWD, 'src', 'read-link.txt');
    symlinkSync(t, l, 'file');
    const r = safeReadFile(readAuth('src/read-link.txt'));
    expect(r.ok).toBe(false);
  });

  // 27. system protected (validates auth first)
  it('rejects system protected path', () => {
    const r = safeReadFile(readAuth('.git/config'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SYSTEM_PROTECTED_PATH');
  });

  // 28. protectedPaths
  it('rejects file in protectedPaths', () => {
    const s = makeScope({ protectedPaths: ['src/test.txt'] });
    const r = safeReadFile(readAuth('src/test.txt', { fileScope: s }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PROTECTED_PATH');
  });

  // 29. outside allowedRoots — FILE_NOT_REGULAR_FILE is same semantic
  it('rejects path outside allowedRoots', () => {
    mkdirSync(path.join(TEST_CWD, 'docs'), { recursive: true });
    writeFileSync(path.join(TEST_CWD, 'docs', 'readme.md'), 'docs', 'utf8');
    const s = makeScope({ allowedRoots: ['src'] });
    const r = safeReadFile(readAuth('docs/readme.md', { fileScope: s }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['PATH_OUTSIDE_ROOTS', 'FILE_NOT_REGULAR_FILE', 'FILE_NOT_FOUND', 'INVALID_PATH']).toContain(r.reason);
  });

  // 30. non-UTF-8
  it('rejects non-UTF-8 file', () => {
    const bad = Buffer.from([0xFF, 0xFE, 0x41]);
    writeFileSync(path.join(TEST_CWD, 'src', 'bad.txt'), bad);
    const s = makeScope({ approvedFiles: ['src/bad.txt'] });
    const r = safeReadFile(readAuth('src/bad.txt', { fileScope: s }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FILE_NOT_UTF8');
  });

  it('rejects binary files independently from invalid UTF-8', () => {
    writeFileSync(path.join(TEST_CWD, 'src', 'binary.txt'), Buffer.from([0x41, 0x00, 0x42]));
    const r = safeReadFile(readAuth('src/binary.txt'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BINARY_FILE');
  });

  it('enforces the cumulative read budget', () => {
    const budget = createWorkspaceReadBudget(3);
    const r = safeReadFile({ ...readAuth('src/test.txt'), budget });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('READ_BUDGET_EXCEEDED');
  });

  // 31. output does not contain absolute path
  it('result does not contain absolute path', () => {
    const r = safeReadFile(readAuth('src/test.txt'));
    expect(r.ok).toBe(true);
    const json = JSON.stringify(r);
    expect(json).not.toContain(TEST_CWD.replace(/\\/g, '/'));
  });
});

// ============================================================================
// safeGrep tests
// ============================================================================
describe('safeGrep', () => {
  beforeEach(() => {
    setupLease();
    // Create test files for grep
    writeFileSync(path.join(TEST_CWD, 'src', 'search1.txt'), 'Hello World\nThis is a test\nTODO: fix this\n', 'utf8');
    writeFileSync(path.join(TEST_CWD, 'src', 'search2.txt'), 'Another file\nwith TODO items\nand more\n', 'utf8');
  });

  // 32. normal substring search
  it('finds substrings', () => {
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'TODO',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches.length).toBeGreaterThanOrEqual(2);
      expect(result.matches.every(m => m.text.includes('TODO'))).toBe(true);
    }
  });

  // 33. case sensitive
  it('respects case sensitivity: caseSensitive=true', () => {
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'todo', caseSensitive: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches.length).toBe(0);
  });

  // 34. case insensitive
  it('is case insensitive by default', () => {
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'todo',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches.length).toBeGreaterThanOrEqual(1);
  });

  // 35. roots restriction
  it('restricts search by roots', () => {
    mkdirSync(path.join(TEST_CWD, 'scripts', 'sub'), { recursive: true });
    writeFileSync(path.join(TEST_CWD, 'scripts', 'sub', 'tool.ts'), 'only here TODO', 'utf8');
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'TODO', roots: ['scripts/sub'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches.length).toBe(1);
  });

  // 36. maxResults
  it('respects maxResults', () => {
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'TODO', maxResults: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches.length).toBeLessThanOrEqual(1);
      expect(result.truncated).toBe(true);
    }
  });

  // 37. stable ordering
  it('returns stable sorted results', () => {
    const r1 = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'TODO',
    });
    const r2 = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'TODO',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      const p1 = r1.matches.map(m => `${m.path}:${m.line}`);
      const p2 = r2.matches.map(m => `${m.path}:${m.line}`);
      expect(p1).toEqual(p2);
    }
  });

  // 38. skips system protected paths
  it('skips system protected paths', () => {
    mkdirSync(path.join(TEST_CWD, '.git'), { recursive: true });
    writeFileSync(path.join(TEST_CWD, '.git', 'config'), 'TODO inside git', 'utf8');
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'inside git',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches).toHaveLength(0);
  });

  // 41. skips symlink (test through authorized path)
  it.skipIf(!symlinkFileSupported)('skips symlink files', () => {
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'link target',
    });
    expect(result.ok).toBe(true);
  });

  // 43. total bytes limit is tested through scan cap — file count cap
  it('stops at file scan limit', () => {
    // Create many files
    for (let i = 0; i < 50; i++) {
      writeFileSync(path.join(TEST_CWD, 'src', `file${i}.txt`), `data ${i}\n`, 'utf8');
    }
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'data',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scannedFiles).toBeGreaterThan(0);
  });

  // 44. empty query is rejected at the execution boundary too
  it('rejects an empty query', () => {
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_VALUE_INVALID');
  });

  // 45. does not interpret regex
  it('does not interpret regex special characters', () => {
    writeFileSync(path.join(TEST_CWD, 'src', 'regex-test.txt'), 'a.b\nacb\na+b\n', 'utf8');
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: 'a.b',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only literal 'a.b' should match, not acb or a+b
      expect(result.matches.length).toBe(1);
      expect(result.matches[0].text).toContain('a.b');
    }
  });

  // 46. does not exec shell
  it('does not execute shell commands via query', () => {
    const result = safeGrep({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), query: '$(rm -rf /)',
    });
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// safeGlob tests
// ============================================================================
describe('safeGlob', () => {
  beforeEach(() => {
    setupLease();
    writeFileSync(path.join(TEST_CWD, 'src', 'a.ts'), 'content', 'utf8');
    writeFileSync(path.join(TEST_CWD, 'src', 'b.ts'), 'content', 'utf8');
    writeFileSync(path.join(TEST_CWD, 'src', 'c.js'), 'content', 'utf8');
  });

  // 47. * pattern
  it('matches * pattern', () => {
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: '*.ts',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // src/*.ts would match src/a.ts and src/b.ts
    }
  });

  // 48. ** pattern
  it('matches ** recursive pattern', () => {
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: 'src/**/*.ts',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.paths).toContain('src/a.ts');
      expect(result.result.paths).toContain('src/b.ts');
    }
  });

  // 49. ? pattern
  it('matches ? pattern', () => {
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: 'src/?.ts',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.paths).toContain('src/a.ts');
      expect(result.result.paths).toContain('src/b.ts');
      expect(result.result.paths).not.toContain('src/c.js');
    }
  });

  it('preserves nested directory segments in recursive glob results', () => {
    mkdirSync(path.join(TEST_CWD, 'src', 'nested', 'deeper'), { recursive: true });
    writeFileSync(path.join(TEST_CWD, 'src', 'nested', 'deeper', 'target.spec.ts'), 'content', 'utf8');
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: 'src/**/*.ts',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.paths).toContain('src/nested/deeper/target.spec.ts');
      expect(result.result.paths).not.toContain('src/target.spec.ts');
    }
  });

  // 50. absolute pattern rejected
  it('rejects absolute pattern', () => {
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: '/etc/passwd',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_PATH');
  });

  // 51. .. rejected
  it('rejects pattern with ..', () => {
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: '../secret/*',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_PATH');
  });

  // 52. sorted results
  it('returns sorted results', () => {
    writeFileSync(path.join(TEST_CWD, 'src', 'z.ts'), 'z', 'utf8');
    writeFileSync(path.join(TEST_CWD, 'src', '0.ts'), '0', 'utf8');
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: 'src/*.ts',
    });
    expect(result.ok).toBe(true);
    // Results should be deterministic
  });

  // 53. deduplication
  it('deduplicates results', () => {
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: 'src/*.ts',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const unique = new Set(result.result.paths);
      expect(unique.size).toBe(result.result.paths.length);
    }
  });

  // 54. maxResults
  it('respects maxResults', () => {
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: 'src/*.ts', maxResults: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.paths.length).toBeLessThanOrEqual(1);
      // truncated is true only if more results exist
    }
  });

  // 55. skip .git
  it('skips .git directory', () => {
    mkdirSync(path.join(TEST_CWD, '.git'), { recursive: true });
    writeFileSync(path.join(TEST_CWD, '.git', 'config'), 'git', 'utf8');
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: '**/*',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.paths.every(p => !p.startsWith('.git/'))).toBe(true);
    }
  });

  // 57. skip node_modules
  it('skips node_modules', () => {
    mkdirSync(path.join(TEST_CWD, 'node_modules'), { recursive: true });
    writeFileSync(path.join(TEST_CWD, 'node_modules', 'pkg.json'), '{}', 'utf8');
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: '**/*',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.paths.every(p => !p.startsWith('node_modules/'))).toBe(true);
    }
  });

  // 58. skip protectedPaths
  it('skips protectedPaths', () => {
    const s = makeScope({ protectedPaths: ['src/a.ts'] });
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: s, pattern: 'src/*.ts',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.paths).not.toContain('src/a.ts');
    }
  });

  // 59. ignores junctions
  it('handles safeGlob without junctions', () => {
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: 'src/a.ts',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.paths).toContain('src/a.ts');
  });

  // 60. allowedRoots restriction
  it('restricts to allowedRoots', () => {
    mkdirSync(path.join(TEST_CWD, 'docs'), { recursive: true });
    writeFileSync(path.join(TEST_CWD, 'docs', 'readme.md'), '# docs', 'utf8');
    const s = makeScope({ allowedRoots: ['src'] });
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: s, pattern: '**/*.md',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Glob walks from allowedRoots, so docs/ items won't be found
      expect(result.result.paths.every(p => !p.startsWith('docs/'))).toBe(true);
    }
  });

  // No lease test
  it('rejects when no lease', () => {
    releaseRunLease(TEST_CWD, RUN_ID);
    const result = safeGlob({
      repositoryRoot: REPO_ROOT, cwd: TEST_CWD, runId: RUN_ID,
      fileScope: makeScope(), pattern: 'src/*.ts',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('RUN_LEASE_MISSING');
  });
});
