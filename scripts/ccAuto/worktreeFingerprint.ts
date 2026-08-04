/** cc-auto v0.2.0 WorktreeFingerprint 计算。
 *
 * 按冻结文档定义：
 * 1. `git status --porcelain=v1 --untracked-files=all` 规范化并排序
 * 2. `git diff` 内容 SHA256
 * 3. `git diff --staged` 内容 SHA256
 * 4. 未跟踪且未被 gitignore 忽略的文件：相对路径 + 文件内容 SHA256
 * 5. 排除：`.git/`、`.cc-auto/`、gitignored 缓存和构建产物
 *
 * 返回完整 64 位十六进制 SHA256 摘要。
 * 持久化和比较均使用完整值；CLI 展示可截短。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 计算工作区指纹的完整 SHA256（64 位十六进制字符串） */
export function computeWorktreeFingerprint(cwd: string): string {
  const parts: string[] = [];

  // 1. git status 规范化输出
  const status = gitOrEmpty(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
  const statusLines = status.split('\n').filter((l) => l.trim().length > 0).sort();
  parts.push(`STATUS:${statusLines.join('\n')}`);

  // 2. git diff
  const diff = gitOrEmpty(['diff'], cwd);
  parts.push(`DIFF:${hashContent(diff)}`);

  // 3. git diff --staged
  const stagedDiff = gitOrEmpty(['diff', '--staged'], cwd);
  parts.push(`STAGED:${hashContent(stagedDiff)}`);

  // 4. 未跟踪且未被 gitignore 忽略的文件
  const untrackedFiles = gitOrEmpty(['ls-files', '--others', '--exclude-standard'], cwd)
    .split('\n')
    .filter((l) => l.trim().length > 0);

  for (const file of untrackedFiles) {
    // 跳过 .cc-auto/ 和 .git/ 目录
    const normalized = normalizePath(file);
    if (normalized.startsWith('.cc-auto/') || normalized.startsWith('.git/')) continue;

    try {
      const content = readFileSync(path.join(cwd, file), 'utf8');
      parts.push(`UNTRACKED:${normalized}:${hashContent(content)}`);
    } catch {
      // 二进制文件或读取失败——只记录路径
      parts.push(`UNTRACKED:${normalized}:<binary/unreadable>`);
    }
  }

  // 5. 计算完整 SHA256 哈希（64 hex）
  const combined = parts.join('\n');
  return hashContent(combined);
}

/** 执行 Git 命令，忽略错误（如仓库无 commit）返回空字符串 */
function gitOrEmpty(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).toString();
  } catch {
    return '';
  }
}

/** SHA256 哈希 */
function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 规范化路径：反斜杠转正斜杠，去除前导 './' */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
