/** 轻量 git 封装：仅用于只读检查（status/branch/diff），不执行任何写操作。 */
import { execFileSync } from 'node:child_process';

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
