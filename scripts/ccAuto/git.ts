/** 轻量 git 封装：仅用于只读检查（status/branch/diff），不执行任何写操作。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type GitHeadState = 'NORMAL_HEAD' | 'UNBORN_HEAD';

export type GitBaselineFailureKind = 'NOT_A_GIT_REPOSITORY' | 'GIT_COMMAND_FAILED';

export class GitBaselineError extends Error {
  readonly kind: GitBaselineFailureKind;
  readonly gitArgs: readonly string[];

  constructor(kind: GitBaselineFailureKind, message: string, gitArgs: readonly string[]) {
    super(message);
    this.name = 'GitBaselineError';
    this.kind = kind;
    this.gitArgs = gitArgs;
  }
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runGit(args: string[], cwd: string): GitCommandResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      // 捕获 stderr，避免 unborn HEAD 把 fatal 泄漏到宿主终端
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), stderr: '', status: 0 };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      status?: number | null;
      message?: string;
    };
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout.trim() : '',
      stderr: typeof err.stderr === 'string' ? err.stderr.trim() : '',
      status: typeof err.status === 'number' ? err.status : null,
    };
  }
}

function classifyGitFailure(result: GitCommandResult, args: readonly string[]): GitBaselineError {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    text.includes('not a git repository')
    || text.includes('not a git repo')
  ) {
    return new GitBaselineError(
      'NOT_A_GIT_REPOSITORY',
      `当前目录不是 git 仓库：git ${args.join(' ')}`,
      args,
    );
  }
  return new GitBaselineError(
    'GIT_COMMAND_FAILED',
    `git ${args.join(' ')} 失败（exit=${result.status ?? 'unknown'}）`,
    args,
  );
}

function gitRequired(args: string[], cwd: string): string {
  const result = runGit(args, cwd);
  if (result.status === 0) return result.stdout;
  throw classifyGitFailure(result, args);
}

function isUnbornHeadFailure(result: GitCommandResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  // 只匹配 unborn HEAD 的典型文案，避免把真实坏对象 / 命令失败吞成 unborn。
  return (
    text.includes('needed a single revision')
    || text.includes("ambiguous argument 'head'")
    || text.includes('unknown revision or path not in the working tree')
  );
}

/** 判断 HEAD 是否可解析。非 git / 真实命令失败时抛 GitBaselineError。 */
export function inspectGitHead(cwd: string): GitHeadState {
  const inside = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside.status !== 0) {
    throw classifyGitFailure(inside, ['rev-parse', '--is-inside-work-tree']);
  }
  if (inside.stdout.trim() !== 'true') {
    throw new GitBaselineError(
      'NOT_A_GIT_REPOSITORY',
      '当前目录不是 git worktree',
      ['rev-parse', '--is-inside-work-tree'],
    );
  }

  const head = runGit(['rev-parse', '--verify', 'HEAD'], cwd);
  if (head.status === 0 && head.stdout.length > 0) return 'NORMAL_HEAD';

  // HEAD 不可解析时，用对象库是否为空区分 unborn 与真实命令失败。
  // 不能只靠 stderr 文案：损坏的 HEAD 也会打印 ambiguous argument。
  const anyCommit = runGit(['rev-list', '-n', '1', '--all'], cwd);
  if (anyCommit.status === 0 && anyCommit.stdout.length === 0) return 'UNBORN_HEAD';
  if (anyCommit.status !== 0 && isUnbornHeadFailure(head) && isUnbornHeadFailure(anyCommit)) {
    return 'UNBORN_HEAD';
  }
  throw classifyGitFailure(head, ['rev-parse', '--verify', 'HEAD']);
}

export function currentBranch(cwd: string): string {
  return gitRequired(['branch', '--show-current'], cwd);
}

export function shortStatus(cwd: string): string[] {
  const out = gitRequired(['status', '--short'], cwd);
  return out.length > 0 ? out.split('\n') : [];
}

/**
 * 1F-RUN P1: 精确排除 cc-auto 自身运行时文件（不得过滤整个 .cc-auto/）。
 *
 * Runtime artifacts（由 cc-auto 自身创建，不是模型工作区修改）：
 *   .cc-auto/runs/       — 运行状态持久化
 *   .cc-auto/run-lock.json — Run Lease 锁文件
 *
 * 必须保留在 changed-files audit 中的用户/安全配置：
 *   .cc-auto/config.json — 用户配置，受 FileScope protectedPaths 保护
 */
function isCcAutoRuntimeArtifact(path: string): boolean {
  // Win32 兼容：将反斜杠规范化为正斜杠后再做前缀匹配
  const normalized = path.replace(/\\/g, '/');
  return (
    normalized.startsWith('.cc-auto/runs/') ||
    normalized === '.cc-auto/run-lock.json'
  );
}

function collectChangedPaths(blocks: string[]): string[] {
  const set = new Set<string>();
  for (const block of blocks) {
    if (block.length === 0) continue;
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (isCcAutoRuntimeArtifact(trimmed)) continue;
      set.add(trimmed);
    }
  }
  return Array.from(set);
}

/**
 * 相对某个基线改动的文件列表。
 * 正常仓库使用 HEAD；unborn HEAD 不调用 `git diff HEAD`，改用 index / 工作区命令。
 */
export function changedFilesSince(cwd: string, baseRef = 'HEAD'): string[] {
  const headState = inspectGitHead(cwd);

  if (headState === 'UNBORN_HEAD') {
    // 无 commit：不能解析 HEAD。用工作区 vs index、index vs 空树、未跟踪文件。
    // 这些命令不引用 HEAD，因此不会打印 ambiguous argument。
    const unstaged = gitRequired(['diff', '--name-only'], cwd);
    const staged = gitRequired(['diff', '--name-only', '--cached'], cwd);
    const untracked = gitRequired(['ls-files', '--others', '--exclude-standard'], cwd);
    return collectChangedPaths([unstaged, staged, untracked]);
  }

  const out = gitRequired(['diff', '--name-only', baseRef, '--'], cwd);
  const staged = gitRequired(['diff', '--name-only', '--cached', baseRef, '--'], cwd);
  const untracked = gitRequired(['ls-files', '--others', '--exclude-standard'], cwd);
  return collectChangedPaths([out, staged, untracked]);
}

// ============================================================================
// v0.2.0 P4: Run-scoped changedFiles attribution
// ============================================================================

/** Per-file baseline at run start: path + git status + content fingerprint. */
export interface RunStartFileBaseline {
  path: string;
  /** `git status --porcelain=v1` line for this file at run start (e.g. " M scripts/ccAuto/cli.ts"). */
  statusLine: string | null;
  /** SHA256 of file content at run start, or null if the file is untracked and unreadable. */
  contentFingerprint: string | null;
}

/** Snapshot of all pre-existing dirty files at run start. */
export interface RunStartBaseline {
  capturedAt: string;
  files: RunStartFileBaseline[];
  /** HEAD 状态：NORMAL_HEAD 或 UNBORN_HEAD。非 git / 命令失败会抛 GitBaselineError。 */
  headState: GitHeadState;
}

/**
 * Capture a per-file baseline of all pre-existing dirty files at run start.
 *
 * This covers all files that git reports as different from the current baseline:
 * - 正常 HEAD：相对 HEAD 的 unstaged / staged / untracked
 * - unborn HEAD：相对空历史的工作区 / index / untracked，不调用 `git diff HEAD`
 */
export function captureRunStartBaseline(cwd: string): RunStartBaseline {
  const headState = inspectGitHead(cwd);
  const dirtyPaths = changedFilesSince(cwd);
  const statusOutput = gitRequired(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
  const statusLines = statusOutput.length > 0 ? statusOutput.split('\n') : [];

  // Build a map: normalized path → status line
  const statusByPath = new Map<string, string>();
  for (const line of statusLines) {
    if (line.trim().length === 0) continue;
    // porcelain=v1 format: "XY path" where XY is two status characters, followed by a space
    // For rename/copy the format is "XY old -> new" — we match on new path
    const match = line.match(/^.. (.+)$/);
    if (match) {
      const raw = match[1].trim();
      const normalized = raw.replace(/\\/g, '/');
      statusByPath.set(normalized, line);
    }
  }

  const files: RunStartFileBaseline[] = [];
  for (const p of dirtyPaths) {
    const normalized = p.replace(/\\/g, '/');
    const statusLine = statusByPath.get(normalized) ?? null;

    let contentFingerprint: string | null = null;
    try {
      const content = readFileSync(path.join(cwd, p), 'utf8');
      contentFingerprint = createHash('sha256').update(content, 'utf8').digest('hex');
    } catch {
      // Binary or unreadable file — record null fingerprint
      contentFingerprint = null;
    }

    files.push({ path: p, statusLine, contentFingerprint });
  }

  return { capturedAt: new Date().toISOString(), files, headState };
}

/**
 * Compute the set of files whose state/content differs from the run-start baseline.
 *
 * A file is considered "changed by this run" if:
 * - It was NOT in the baseline and now appears as dirty (Case C: clean → dirty).
 * - It WAS in the baseline but its current content fingerprint differs from baseline
 *   (Case B/D: pre-dirty file modified again, or restored to HEAD).
 * - It WAS in the baseline but is no longer dirty — NOT included (Case A: untouched).
 * - It is an untracked file that is new since baseline — included.
 *
 * Returns the list of files that were actually changed during this run.
 */
export function computeRunChangedFiles(
  cwd: string,
  baseline: RunStartBaseline,
): string[] {
  const currentDirty = new Set(changedFilesSince(cwd));
  const baselineMap = new Map<string, RunStartFileBaseline>();
  for (const f of baseline.files) {
    baselineMap.set(f.path, f);
  }

  const changed = new Set<string>();

  // Pass 1: files currently dirty — check against baseline
  for (const p of currentDirty) {
    const baselineEntry = baselineMap.get(p);

    if (!baselineEntry) {
      // Not in baseline → newly dirty during run (Case C, or new untracked)
      changed.add(p);
      continue;
    }

    // Was in baseline — check if content actually changed
    const currentFingerprint = fileFingerprint(cwd, p);
    if (currentFingerprint !== baselineEntry.contentFingerprint) {
      // Content differs → model touched this file (Case B)
      changed.add(p);
    }
    // else: same content → model did NOT touch (Case A) — exclude
  }

  // Pass 2: files that were dirty at baseline but are no longer dirty
  // If content changed (e.g. restored to HEAD), model touched it (Case D).
  for (const baselineEntry of baseline.files) {
    if (currentDirty.has(baselineEntry.path)) continue;
    // Was dirty, now clean — did content actually change?
    const currentFingerprint = fileFingerprint(cwd, baselineEntry.path);
    if (currentFingerprint !== baselineEntry.contentFingerprint) {
      // Model restored to HEAD or otherwise altered content (Case D)
      changed.add(baselineEntry.path);
    }
    // If fingerprint matches baseline but file is now clean: this shouldn't
    // normally happen (git wouldn't show a diff if content == HEAD), but
    // if it does, model may have `git checkout`'d it — still Case D.
    // We include it as a run change for safety.
    else {
      // Same fingerprint as baseline, but git says it's clean now.
      // The model likely ran `git checkout <file>` or `git restore <file>`.
      changed.add(baselineEntry.path);
    }
  }

  return Array.from(changed);
}

/** Compute SHA256 of a file's content, or null if unreadable. */
function fileFingerprint(cwd: string, relPath: string): string | null {
  try {
    const content = readFileSync(path.join(cwd, relPath), 'utf8');
    return createHash('sha256').update(content, 'utf8').digest('hex');
  } catch {
    return null;
  }
}
