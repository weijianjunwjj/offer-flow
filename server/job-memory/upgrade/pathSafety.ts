import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface UpgradePathsInput {
  sourceDatabasePath: string;
  backupDirectory: string;
  workspaceDirectory: string;
}

export interface ResolvedUpgradePaths {
  sourceDatabasePath: string;
  backupDirectory: string;
  workspaceDirectory: string;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertNoSymbolicLinks(candidate: string): void {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('安全路径不得包含符号链接');
    }
  }
}

function assertGitIgnored(workspaceDirectory: string, candidate: string): void {
  const relative = path.relative(workspaceDirectory, candidate);
  const result = spawnSync(
    'git',
    ['check-ignore', '--quiet', '--no-index', '--', relative],
    { cwd: workspaceDirectory, stdio: 'ignore', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error('仓库内备份目录必须被 .gitignore 明确排除');
  }
}

export function resolveUpgradePaths(input: UpgradePathsInput): ResolvedUpgradePaths {
  const sourceDatabasePath = path.resolve(input.sourceDatabasePath);
  const backupDirectory = path.resolve(input.backupDirectory);
  const workspaceDirectory = path.resolve(input.workspaceDirectory);
  if (!fs.existsSync(sourceDatabasePath) || !fs.statSync(sourceDatabasePath).isFile()) {
    throw new Error('源数据库必须是已存在的普通文件');
  }
  if (!fs.existsSync(workspaceDirectory) || !fs.statSync(workspaceDirectory).isDirectory()) {
    throw new Error('workspaceDirectory 必须是已存在目录');
  }
  if (!fs.existsSync(path.join(workspaceDirectory, '.git'))) {
    throw new Error('workspaceDirectory 必须是 OfferFlow Git 工作区');
  }
  assertNoSymbolicLinks(sourceDatabasePath);
  assertNoSymbolicLinks(workspaceDirectory);
  assertNoSymbolicLinks(backupDirectory);
  // Existing path segments were checked with lstat above. realpath is still
  // resolved once so Windows short-name/case aliases cannot bypass equality checks.
  const canonicalSource = fs.realpathSync.native(sourceDatabasePath);
  if (canonicalSource.toLowerCase() === backupDirectory.toLowerCase()
    || isPathInside(canonicalSource, backupDirectory)) {
    throw new Error('源数据库与备份目录不得相同或互相覆盖');
  }
  if (isPathInside(workspaceDirectory, backupDirectory)) {
    assertGitIgnored(workspaceDirectory, backupDirectory);
    if (isPathInside(path.join(workspaceDirectory, '.git'), backupDirectory)) {
      throw new Error('备份目录不得位于 .git 内');
    }
  }
  return { sourceDatabasePath, backupDirectory, workspaceDirectory };
}

export function assertDistinctDatabasePaths(sourcePath: string, targetPath: string): void {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    throw new Error('源数据库和工作克隆路径不得相同');
  }
}

export function resolveBackupRunDirectory(backupRoot: string, backupId: string): string {
  if (!/^\d{8}-\d{6}-b7a-[a-f0-9]{8}$/.test(backupId)) {
    throw new Error('backup ID 格式无效');
  }
  const candidate = path.resolve(backupRoot, backupId);
  if (!isPathInside(backupRoot, candidate) || candidate === path.resolve(backupRoot)) {
    throw new Error('backup ID 逃逸备份目录');
  }
  return candidate;
}
