/** 轻量 git 封装：仅用于只读检查（status/branch/diff），不执行任何写操作。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function currentBranch(cwd: string): string {
  return git(['branch', '--show-current'], cwd);
}

export function shortStatus(cwd: string): string[] {
  const out = git(['status', '--short'], cwd);
  return out.length > 0 ? out.split('\n') : [];
}

function gitSafe(args: string[], cwd: string): string {
  try {
    return git(args, cwd);
  } catch {
    return ''; // 例如仓库还没有任何 commit（无 HEAD），按「无改动」处理，不中断编排流程
  }
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

/** 相对某个基线（默认 HEAD）改动的文件列表；用于把改动映射到相关测试。 */
export function changedFilesSince(cwd: string, baseRef = 'HEAD'): string[] {
  const out = gitSafe(['diff', '--name-only', baseRef], cwd);
  const staged = gitSafe(['diff', '--name-only', '--cached', baseRef], cwd);
  const untracked = gitSafe(['ls-files', '--others', '--exclude-standard'], cwd);
  const set = new Set<string>();
  for (const block of [out, staged, untracked]) {
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
}

/**
 * Capture a per-file baseline of all pre-existing dirty files at run start.
 *
 * This covers all files that git reports as different from HEAD:
 * - unstaged modifications (`git diff --name-only HEAD`)
 * - staged modifications (`git diff --name-only --staged HEAD`)
 * - untracked files not gitignored (`git ls-files --others --exclude-standard`)
 *
 * Each file's status line and content SHA256 are recorded so we can later
 * determine whether the model actually changed it during the run.
 */
export function captureRunStartBaseline(cwd: string): RunStartBaseline {
  const dirtyPaths = changedFilesSince(cwd);
  const statusOutput = gitSafe(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
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

  return { capturedAt: new Date().toISOString(), files };
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
