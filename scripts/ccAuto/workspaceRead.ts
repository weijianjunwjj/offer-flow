/** cc-auto v0.2.0 Slice 1E — 工作区安全读取执行点。
 *
 * 本模块提供 DeepSeek Tool Loop 所需的文件读取权限内核：
 * - authorizeWorkspaceRead：读取前授权检查
 * - safeReadFile：安全读取 UTF-8 文件
 * - safeGrep：纯文本子串搜索
 * - safeGlob：最小通配符文件匹配
 *
 * 所有读取目标必须：
 * 1. 是合法仓库相对路径
 * 2. 位于 repositoryRoot 内
 * 3. 不触碰 system protected paths
 * 4. 不触碰 FileScope.protectedPaths
 * 5. 不经过 symlink / junction 重定向
 * 6. realpath 后仍精确对应请求路径
 * 7. 是普通文件
 * 8. 是严格 UTF-8
 *
 * 不调用任何模型，不执行 shell 命令，不使用子进程。
 */
import {
  existsSync, lstatSync, readFileSync, realpathSync,
  readdirSync, statSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { FileScope, GrepMatch, GlobResult } from './types';
import {
  normalizeRepositoryRelativePath,
  isSystemProtectedPath,
  pathsEqualForFilesystem,
  isPathWithinRootForFilesystem,
} from './fileScope';
import { readRunLease } from './runLease';

// ============================================================================
// 常量
// ============================================================================

/** 单次 read 最大行数 */
const MAX_READ_LINES = 400;

/** 单次 read 最大字节数（UTF-8） */
const MAX_READ_BYTES = 64 * 1024; // 64 KiB

/** 跨 Tool Loop 的默认累计读取预算。 */
export const DEFAULT_TOTAL_READ_BUDGET_BYTES = 256 * 1024;

export interface WorkspaceReadBudget {
  readonly maxTotalBytes: number;
  consumedBytes: number;
}

export function createWorkspaceReadBudget(
  maxTotalBytes = DEFAULT_TOTAL_READ_BUDGET_BYTES,
): WorkspaceReadBudget {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new RangeError('maxTotalBytes 必须是正整数');
  }
  return { maxTotalBytes, consumedBytes: 0 };
}

/** Grep 默认最大结果数 */
const DEFAULT_GREP_MAX_RESULTS = 50;

/** Grep 最大结果数上限 */
const GREP_MAX_RESULTS_CAP = 200;

/** Grep 最大扫描文件数 */
const MAX_GREP_FILES = 1000;
const MAX_GREP_DIRS = 500;
const MAX_GREP_ENTRIES = 10_000;

/** Grep 总读取字节上限 */
const MAX_GREP_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Grep 单条匹配行最大字符数 */
const MAX_GREP_MATCH_TEXT_LENGTH = 300;

/** Glob 默认最大结果数 */
const DEFAULT_GLOB_MAX_RESULTS = 100;

/** Glob 最大结果数上限 */
const GLOB_MAX_RESULTS_CAP = 500;

/** Glob 最大遍历目录数 */
const MAX_GLOB_DIRS = 500;

/** Glob 跳过目录（永远不进入） */
const GLOB_SKIP_DIRS = new Set(['.git', 'node_modules']);

/** Glob 跳过前缀（段边界匹配） */
const GLOB_SKIP_PREFIXES = ['.cc-auto/runs/'];

/** 读取工具额外屏蔽的凭证/工具状态目录；不扩大既有写入规则。 */
const READ_PROTECTED_DIRS = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.config', '.cc-auto', 'data', 'backups',
]);

const READ_PROTECTED_FILES = new Set(['.npmrc', '.netrc', '.pypirc']);

// ============================================================================
// 读取授权
// ============================================================================

export type WorkspaceReadDenyReason =
  | 'INVALID_PATH'
  | 'PATH_OUTSIDE_REPOSITORY'
  | 'SYSTEM_PROTECTED_PATH'
  | 'PROTECTED_PATH'
  | 'PATH_OUTSIDE_ROOTS'
  | 'FILE_NOT_REGULAR_FILE'
  | 'DIRECTORY_NOT_ALLOWED'
  | 'SYMLINK_DETECTED'
  | 'JUNCTION_DETECTED'
  | 'RUN_LEASE_MISSING'
  | 'RUN_LEASE_MISMATCH'
  | 'REPOSITORY_ROOT_MISMATCH'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'FILE_NOT_UTF8'
  | 'BINARY_FILE'
  | 'READ_PERMISSION_DENIED'
  | 'READ_BUDGET_EXCEEDED'
  | 'SCAN_LIMIT_EXCEEDED';

export interface WorkspaceReadAuthorizationResult {
  ok: true;
  normalizedPath: string;
  absolutePath: string;
}

export type WorkspaceReadAuthorization =
  | WorkspaceReadAuthorizationResult
  | { ok: false; reason: WorkspaceReadDenyReason; message: string };

export interface ReadAuthOptions {
  repositoryRoot: string;
  cwd: string;
  runId: string;
  targetPath: string;
  fileScope: FileScope;
}

/**
 * 读取授权不要求 Writer assignment，但要求 Run Lease 有效 + runId 匹配 + repositoryRoot 匹配。
 *
 * 验证链：
 * 1. 路径规范化
 * 2. 系统保护路径检查
 * 3. FileScope 权限检查（allowedRoots / approvedFiles 父链内 + 非 protectedPaths）
 * 4. Run Lease 校验
 * 5. 真实路径双重授权
 */
export function authorizeWorkspaceRead(
  options: ReadAuthOptions,
): WorkspaceReadAuthorization {
  const { repositoryRoot, runId, targetPath, fileScope } = options;
  const platform = process.platform;

  // 1. 路径规范化
  const normResult = normalizeRepositoryRelativePath(targetPath);
  if (!normResult.ok) {
    return { ok: false, reason: 'INVALID_PATH', message: `路径无效：${normResult.detail}` };
  }
  const requestedNormalizedPath = normResult.normalized;

  // 2. 系统保护路径
  if (isSystemProtectedPath(requestedNormalizedPath)) {
    return { ok: false, reason: 'SYSTEM_PROTECTED_PATH', message: `"${requestedNormalizedPath}" 是系统保护路径` };
  }
  if (isReadProtectedPath(requestedNormalizedPath)) {
    return { ok: false, reason: 'SYSTEM_PROTECTED_PATH', message: `"${requestedNormalizedPath}" 是读取保护路径` };
  }

  // 3. FileScope 权限检查
  const scopeAuth = checkReadFileScope(requestedNormalizedPath, fileScope, platform);
  if (scopeAuth) return scopeAuth;

  // 4. Run Lease 校验
  const lease = readRunLease(options.cwd);
  if (!lease) {
    return { ok: false, reason: 'RUN_LEASE_MISSING', message: 'Run Lease 不存在' };
  }

  if (lease.runId !== runId) {
    return { ok: false, reason: 'RUN_LEASE_MISMATCH', message: `Run Lease runId 不匹配` };
  }

  const leaseRoot = normalizeAbsolute(lease.repositoryRoot);
  const actualRoot = normalizeAbsolute(repositoryRoot);
  if (leaseRoot !== actualRoot) {
    return { ok: false, reason: 'REPOSITORY_ROOT_MISMATCH', message: `repositoryRoot 不匹配` };
  }

  // 5. 真实路径双重授权
  const repoAbs = path.resolve(repositoryRoot);
  const targetAbs = path.resolve(repositoryRoot, requestedNormalizedPath);

  if (!isAbsolutePathInside(targetAbs, repoAbs)) {
    return { ok: false, reason: 'PATH_OUTSIDE_REPOSITORY', message: `"${requestedNormalizedPath}" 不在仓库根目录内` };
  }

  const linkCheck = checkPathChainForLinks(repoAbs, requestedNormalizedPath);
  if (linkCheck) return linkCheck;

  let lstatBefore: Stats;
  try {
    lstatBefore = lstatSync(targetAbs);
  } catch {
    return { ok: false, reason: 'FILE_NOT_REGULAR_FILE', message: `无法获取 "${requestedNormalizedPath}" 状态` };
  }

  if (lstatBefore.isSymbolicLink()) {
    return { ok: false, reason: 'SYMLINK_DETECTED', message: `"${requestedNormalizedPath}" 是符号链接/junction` };
  }

  if (!lstatBefore.isFile()) {
    return { ok: false, reason: 'FILE_NOT_REGULAR_FILE', message: `"${requestedNormalizedPath}" 不是普通文件` };
  }

  // realpath 双重检查
  let realPath: string;
  try {
    realPath = normalizeAbsolute(realpathSync(targetAbs));
  } catch {
    return { ok: false, reason: 'SYMLINK_DETECTED', message: `无法解析 "${requestedNormalizedPath}" 的真实路径` };
  }

  if (!isAbsolutePathInside(realPath, normalizeAbsolute(repoAbs))) {
    return { ok: false, reason: 'SYMLINK_DETECTED', message: `"${requestedNormalizedPath}" 真实路径不在仓库内` };
  }

  const resolvedRel = path.relative(repoAbs, realPath).replace(/\\/g, '/');
  const normResolved = normalizeRepositoryRelativePath(resolvedRel);
  if (!normResolved.ok) {
    return { ok: false, reason: 'SYMLINK_DETECTED', message: `无法规范化 resolved 路径` };
  }

  // resolved 必须与 requested 精确一致
  if (!pathsEqualForFilesystem(requestedNormalizedPath, normResolved.normalized, { platform })) {
    return { ok: false, reason: 'SYMLINK_DETECTED', message: `目标路径经真实路径解析后不再对应请求路径` };
  }

  return { ok: true, normalizedPath: requestedNormalizedPath, absolutePath: targetAbs };
}

/**
 * 检查请求路径是否在 FileScope 的读权限内。
 *
 * 保守策略：路径必须在 allowedRoots 任一之内，或 approvedFiles 任一文件的父链之内。
 * 不在 protectedPaths 内。
 */
function checkReadFileScope(
  normalizedPath: string,
  fileScope: FileScope,
  platform: NodeJS.Platform,
): null | WorkspaceReadAuthorization {
  const scopeNorm = normalizeReadScopeRoots(fileScope);
  if (!scopeNorm.ok) {
    return { ok: false, reason: 'PATH_OUTSIDE_ROOTS', message: 'FileScope 配置错误' };
  }

  // protectedPaths 检查（平台感知段边界）
  for (const pp of scopeNorm.protectedPaths) {
    if (isPathWithinRootForFilesystem(normalizedPath, pp, { platform })) {
      return { ok: false, reason: 'PROTECTED_PATH', message: `"${normalizedPath}" 位于 protectedPaths 中，禁止读取` };
    }
  }

  // 必须在 allowedRoots 或 approvedFiles 父链内
  const withinAllowed = scopeNorm.allowedRoots.some(r =>
    isPathWithinRootForFilesystem(normalizedPath, r, { platform }),
  );
  if (withinAllowed) return null; // 通过

  // approvedFiles 只批准精确文件，绝不能扩大到其父目录。
  for (const af of scopeNorm.approvedFiles) {
    if (pathsEqualForFilesystem(normalizedPath, af, { platform })) {
      return null; // 通过
    }
  }

  return { ok: false, reason: 'PATH_OUTSIDE_ROOTS', message: `"${normalizedPath}" 不在允许的读取范围内` };
}

// ============================================================================
// 安全读取文件
// ============================================================================

export interface SafeReadFileResult {
  ok: true;
  content: string;
  lineCount: number;
  byteCount: number;
  truncated: boolean;
  startLine: number;
  endLine: number;
}

export type SafeReadFileOutcome =
  | SafeReadFileResult
  | { ok: false; reason: WorkspaceReadDenyReason | 'FILE_NOT_FOUND' | 'FILE_NOT_UTF8' | 'MAX_OUTPUT_EXCEEDED'; message: string };

export interface SafeReadFileOptions extends ReadAuthOptions {
  startLine?: number;
  endLine?: number;
  budget?: WorkspaceReadBudget;
  maxFileBytes?: number;
  maxReadLines?: number;
}

/**
 * 安全读取 UTF-8 文本文件。
 */
export function safeReadFile(options: SafeReadFileOptions): SafeReadFileOutcome {
  const auth = authorizeWorkspaceRead(options);
  if (!auth.ok) return { ok: false, reason: auth.reason as WorkspaceReadDenyReason, message: auth.message };

  const { absolutePath } = auth;

  const maxFileBytes = Math.min(options.maxFileBytes ?? MAX_READ_BYTES, 1024 * 1024);
  const maxReadLines = Math.min(options.maxReadLines ?? MAX_READ_LINES, 2_000);
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1
    || !Number.isSafeInteger(maxReadLines) || maxReadLines < 1) {
    return { ok: false, reason: 'MAX_OUTPUT_EXCEEDED', message: '读取限制配置无效' };
  }
  if ((options.startLine !== undefined && (!Number.isSafeInteger(options.startLine) || options.startLine < 1))
    || (options.endLine !== undefined && (!Number.isSafeInteger(options.endLine) || options.endLine < 1))
    || (options.startLine !== undefined && options.endLine !== undefined && options.startLine > options.endLine)) {
    return { ok: false, reason: 'INVALID_PATH', message: '读取行号范围无效' };
  }

  let fileSize: number;
  try {
    fileSize = statSync(absolutePath).size;
  } catch (error: unknown) {
    return fileReadFailure(auth.normalizedPath, error);
  }
  if (fileSize > maxFileBytes) {
    return { ok: false, reason: 'FILE_TOO_LARGE', message: `"${auth.normalizedPath}" 超过单文件读取上限` };
  }
  if (options.budget && options.budget.consumedBytes + fileSize > options.budget.maxTotalBytes) {
    return { ok: false, reason: 'READ_BUDGET_EXCEEDED', message: '累计读取预算已耗尽' };
  }

  // 读取文件
  let raw: Buffer;
  try {
    raw = readFileSync(absolutePath);
  } catch (error: unknown) {
    return fileReadFailure(auth.normalizedPath, error);
  }
  if (raw.length > maxFileBytes) {
    return { ok: false, reason: 'FILE_TOO_LARGE', message: `"${auth.normalizedPath}" 超过单文件读取上限` };
  }
  if (options.budget) options.budget.consumedBytes += raw.length;

  if (raw.includes(0)) {
    return { ok: false, reason: 'BINARY_FILE', message: `"${auth.normalizedPath}" 是二进制文件` };
  }

  // 严格 UTF-8
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return { ok: false, reason: 'FILE_NOT_UTF8', message: `"${auth.normalizedPath}" 不是合法 UTF-8` };
  }

  const allLines = text.split('\n');
  const totalLines = allLines.length;
  // 行号范围
  const startLine = Math.max(1, options.startLine ?? 1);
  const endLine = Math.min(options.endLine ?? (startLine + maxReadLines - 1), totalLines, startLine + maxReadLines - 1);

  if (startLine > totalLines) {
    return { ok: true, content: '', lineCount: 0, byteCount: 0, truncated: false, startLine, endLine: startLine - 1 };
  }

  const selectedLines = allLines.slice(startLine - 1, endLine);
  const result = selectedLines.join('\n');
  const byteCount = Buffer.byteLength(result, 'utf8');
  const truncated = endLine < totalLines;

  return { ok: true, content: result, lineCount: selectedLines.length, byteCount, truncated, startLine, endLine };
}

// ============================================================================
// 安全 Grep
// ============================================================================

export interface SafeGrepOptions {
  repositoryRoot: string;
  cwd: string;
  runId: string;
  fileScope: FileScope;
  query: string;
  roots?: string[];
  caseSensitive?: boolean;
  maxResults?: number;
  budget?: WorkspaceReadBudget;
  maxFileBytes?: number;
  maxScanFiles?: number;
  maxScanBytes?: number;
  maxScanDirectories?: number;
  maxScanEntries?: number;
}

export interface SafeGrepResult {
  ok: true;
  matches: GrepMatch[];
  truncated: boolean;
  scannedFiles: number;
  bytesRead: number;
}

export type SafeGrepOutcome =
  | SafeGrepResult
  | { ok: false; reason: string; message: string };

/**
 * 安全纯文本子串搜索——不使用子进程、正则或 shell。
 */
export function safeGrep(options: SafeGrepOptions): SafeGrepOutcome {
  const { repositoryRoot, query, caseSensitive = false, fileScope } = options;
  const maxResults = Math.min(options.maxResults ?? DEFAULT_GREP_MAX_RESULTS, GREP_MAX_RESULTS_CAP);
  const maxScanFiles = Math.min(options.maxScanFiles ?? MAX_GREP_FILES, MAX_GREP_FILES);
  const maxScanBytes = Math.min(options.maxScanBytes ?? MAX_GREP_TOTAL_BYTES, MAX_GREP_TOTAL_BYTES);
  const maxScanDirectories = Math.min(options.maxScanDirectories ?? MAX_GREP_DIRS, MAX_GREP_DIRS);
  const maxScanEntries = Math.min(options.maxScanEntries ?? MAX_GREP_ENTRIES, MAX_GREP_ENTRIES);
  const maxFileBytes = options.maxFileBytes ?? MAX_READ_BYTES;
  const platform = process.platform;
  const repoAbs = path.resolve(repositoryRoot);

  if (query.length === 0) {
    return { ok: false, reason: 'ARGUMENT_VALUE_INVALID', message: 'grep query 不能为空' };
  }

  const rootResolution = resolveAuthorizedScanRoots(options);
  if (!rootResolution.ok) return rootResolution;

  const matches: GrepMatch[] = [];
  let scannedFiles = 0;
  let totalBytesRead = 0;
  let truncated = false;

  const effectiveQuery = caseSensitive ? query : query.toLowerCase();

  for (const root of rootResolution.roots) {
    if (truncated) break;
    const rootAbs = root.absolutePath;
    if (!existsSync(rootAbs)) continue;

    const collection = collectReadableFiles(
      rootAbs, repoAbs, fileScope, platform,
      maxScanFiles, maxScanDirectories, maxScanEntries,
    );
    if (collection.limitExceeded) {
      return { ok: false, reason: 'SCAN_LIMIT_EXCEEDED', message: 'grep 扫描范围超过上限' };
    }
    for (const file of collection.files) {
      if (truncated || matches.length >= maxResults || scannedFiles >= maxScanFiles) {
        truncated = true;
        break;
      }

      const relPath = path.relative(repoAbs, file).replace(/\\/g, '/');

      // 读取文件
      let raw: Buffer;
      try {
        raw = readFileSync(file);
      } catch {
        continue;
      }

      if (raw.length === 0) continue;
      if (raw.length > maxFileBytes || raw.includes(0)) continue;

      // 字节限制
      if (totalBytesRead + raw.length > maxScanBytes) {
        truncated = true;
        break;
      }
      if (options.budget && options.budget.consumedBytes + raw.length > options.budget.maxTotalBytes) {
        return { ok: false, reason: 'READ_BUDGET_EXCEEDED', message: '累计读取预算已耗尽' };
      }
      totalBytesRead += raw.length;
      if (options.budget) options.budget.consumedBytes += raw.length;

      // UTF-8
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        continue;
      }

      scannedFiles++;

      // 搜索
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        const lineStr = lines[i];
        const searchIn = caseSensitive ? lineStr : lineStr.toLowerCase();
        let col = 0;
        while ((col = searchIn.indexOf(effectiveQuery, col)) !== -1) {
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
          const matchText = lineStr.length > MAX_GREP_MATCH_TEXT_LENGTH
            ? lineStr.slice(Math.max(0, col - 20), col + MAX_GREP_MATCH_TEXT_LENGTH - 20)
            : lineStr;
          matches.push({
            path: relPath,
            line: i + 1,
            column: col + 1,
            text: matchText,
          });
          col += query.length;
        }
      }

      if (scannedFiles >= maxScanFiles) {
        truncated = true;
      }
    }
  }

  return { ok: true, matches, truncated, scannedFiles, bytesRead: totalBytesRead };
}

// ============================================================================
// 安全 Glob
// ============================================================================

export interface SafeGlobOptions {
  repositoryRoot: string;
  cwd: string;
  runId: string;
  fileScope: FileScope;
  pattern: string;
  roots?: string[];
  maxResults?: number;
  maxDirectories?: number;
  maxEntries?: number;
}

export type SafeGlobOutcome =
  | { ok: true; result: GlobResult }
  | { ok: false; reason: string; message: string };

/**
 * 最小通配符 glob——仅支持 * ** ?，不引入外部依赖。
 *
 * 禁止：
 * - 绝对 pattern
 * - `..`
 * - brace expansion / extglob / shell expansion
 * - 动态代码执行
 */
export function safeGlob(options: SafeGlobOptions): SafeGlobOutcome {
  const { pattern, fileScope, repositoryRoot } = options;
  void repositoryRoot; // 由下层函数直接使用
  const maxResults = Math.min(options.maxResults ?? DEFAULT_GLOB_MAX_RESULTS, GLOB_MAX_RESULTS_CAP);
  const maxDirectories = Math.min(options.maxDirectories ?? MAX_GLOB_DIRS, MAX_GLOB_DIRS);
  const maxEntries = Math.min(options.maxEntries ?? 10_000, 10_000);

  // pattern 安全校验
  if (pattern.length === 0 || pattern.includes('..') || pattern.includes('\0') || pattern.includes('\\')) {
    return { ok: false, reason: 'INVALID_PATH', message: 'glob pattern 不允许包含 ..' };
  }
  if (/^[a-zA-Z]:/.test(pattern) || pattern.startsWith('/')) {
    return { ok: false, reason: 'INVALID_PATH', message: 'glob pattern 不允许绝对路径' };
  }
  if (/[{}()[\]!]/.test(pattern)) {
    return { ok: false, reason: 'ARGUMENT_VALUE_INVALID', message: 'glob pattern 包含不支持的扩展语法' };
  }

  const platform = process.platform;
  const rootResolution = resolveAuthorizedScanRoots(options);
  if (!rootResolution.ok) return rootResolution;

  // 编译 pattern 为正则
  const regex = compileGlobPattern(pattern);

  const paths: string[] = [];
  const seen = new Set<string>();
  const state: GlobState = { scannedEntries: 0, dirsScanned: 0, truncated: false };

  for (const root of rootResolution.roots) {
    if (state.truncated || state.dirsScanned >= maxDirectories) {
      state.truncated = true;
      break;
    }
    const rootAbs = root.absolutePath;
    if (!existsSync(rootAbs)) continue;

    try {
      globWalk(
        rootAbs, '', root.normalizedPath,
        regex, fileScope, platform,
        paths, seen, maxResults, maxDirectories, maxEntries, state,
      );
    } catch { /* 单个 root 失败不终止其他 root */ }
  }

  paths.sort((a, b) => a.localeCompare(b));
  return { ok: true, result: { paths, truncated: state.truncated, scannedEntries: state.scannedEntries } };
}

interface GlobState {
  scannedEntries: number;
  dirsScanned: number;
  truncated: boolean;
}

function globWalk(
  currentAbs: string,
  currentRel: string,
  rootRel: string,
  regex: RegExp,
  fileScope: FileScope,
  platform: NodeJS.Platform,
  paths: string[],
  seen: Set<string>,
  maxResults: number,
  maxDirs: number,
  maxEntries: number,
  state: GlobState,
): void {
  if (paths.length >= maxResults || state.dirsScanned >= maxDirs || state.scannedEntries >= maxEntries) {
    state.truncated = true;
    return;
  }

  // 跳过目录
  const lastSeg = path.basename(currentAbs);
  if (GLOB_SKIP_DIRS.has(lastSeg)) return;

  // 跳过 .cc-auto/runs/
  const rel = currentRel || rootRel;
  for (const prefix of GLOB_SKIP_PREFIXES) {
    if (rel.startsWith(prefix)) return;
  }

  let entries: string[];
  try {
    entries = readdirSync(currentAbs).sort((a, b) => a.localeCompare(b));
  } catch {
    return;
  }

  for (const entry of entries) {
    if (paths.length >= maxResults || state.scannedEntries >= maxEntries) {
      state.truncated = true;
      return;
    }

    const entryAbs = path.join(currentAbs, entry);
    const entryRel = currentRel
      ? path.posix.join(currentRel, entry)
      : rootRel
        ? path.posix.join(rootRel, entry)
        : entry;

    state.scannedEntries++;

    // lstat 检查 symlink/junction
    let lstat: Stats;
    try {
      lstat = lstatSync(entryAbs);
    } catch {
      continue;
    }

    if (lstat.isSymbolicLink()) continue;

    if (lstat.isDirectory()) {
      state.dirsScanned++;
      if (state.dirsScanned >= maxDirs) {
        state.truncated = true;
        return;
      }

      // 检查跳过目录
      if (GLOB_SKIP_DIRS.has(entry)) continue;
      let skipForPrefix = false;
      for (const prefix of GLOB_SKIP_PREFIXES) {
        if (entryRel.startsWith(prefix)) { skipForPrefix = true; break; }
      }
      if (skipForPrefix) continue;

      // 检查 protectedPaths / system protected
      const normRel = normalizeGlobPath(entryRel);
      if (normRel) {
        if (isSystemProtectedPath(normRel)) continue;
        if (isScopeProtected(normRel, fileScope, platform)) continue;
      }

      globWalk(entryAbs, entryRel, rootRel, regex, fileScope, platform, paths, seen, maxResults, maxDirs, maxEntries, state);
      continue;
    }

    if (!lstat.isFile()) continue;

    // 匹配
    const normPath = normalizeGlobPath(entryRel);
    if (!normPath) continue;

    if (!regex.test(entryRel) && !regex.test(normPath)) continue;

    // 安全检查
    if (isSystemProtectedPath(normPath)) continue;
    if (isScopeProtected(normPath, fileScope, platform)) continue;

    // 去重
    if (seen.has(normPath)) continue;
    seen.add(normPath);
    paths.push(normPath);

    if (paths.length >= maxResults) {
      state.truncated = true;
      return;
    }
  }
}

function normalizeGlobPath(p: string): string | null {
  const norm = normalizeRepositoryRelativePath(p);
  if (norm.ok) return norm.normalized;
  return null;
}

/**
 * 将简化 glob pattern 编译为正则。
 * 只支持 * (单段通配) 、** (多段通配) 、? (单字符通配)。
 */
function compileGlobPattern(pattern: string): RegExp {
  // 转义正则特殊字符，然后替换 glob 语法
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // ** — 匹配零或多个路径段
      if (i === 0 || pattern[i - 1] === '/') {
        // ** 在段边界——可匹配零或多个路径段
        regexStr += '(?:.*/)?';
        i += 2;
        // 跳过 **/ 斜杠
        if (pattern[i] === '/') i++;
        continue;
      }
    }

    if (pattern[i] === '*') {
      regexStr += '[^/]*';
      i++;
      continue;
    }

    if (pattern[i] === '?') {
      regexStr += '[^/]';
      i++;
      continue;
    }

    // 转义正则特殊字符
    if ('.+^${}()|[]\\'.includes(pattern[i])) {
      regexStr += '\\' + pattern[i];
    } else {
      regexStr += pattern[i];
    }
    i++;
  }

  return new RegExp('^' + regexStr + '$');
}

// ============================================================================
// 文件收集辅助
// ============================================================================

function collectReadableFiles(
  dirAbs: string,
  repoAbs: string,
  fileScope: FileScope,
  platform: NodeJS.Platform,
  maxFiles: number,
  maxDirectories: number,
  maxEntries: number,
): { files: string[]; limitExceeded: boolean } {
  const files: string[] = [];
  const normalizedScope = normalizeReadScopeRoots(fileScope);
  if (!normalizedScope.ok) return { files, limitExceeded: true };
  const stack = [dirAbs];
  const seenDirs = new Set<string>();
  let scannedDirectories = 0;
  let scannedEntries = 0;
  let limitExceeded = false;

  while (stack.length > 0) {
    if (scannedDirectories >= maxDirectories) {
      limitExceeded = true;
      break;
    }
    const current = stack.pop()!;
    if (seenDirs.has(current)) continue;
    seenDirs.add(current);
    scannedDirectories++;

    let entries: string[];
    try {
      entries = readdirSync(current).sort((a, b) => b.localeCompare(a));
    } catch {
      continue;
    }

    for (const entry of entries) {
      scannedEntries++;
      if (scannedEntries > maxEntries) {
        limitExceeded = true;
        break;
      }

      const full = path.join(current, entry);
      const rel = path.relative(repoAbs, full).replace(/\\/g, '/');

      // 跳过保护路径
      const normRel = normalizeGlobPath(rel);
      if (!normRel) continue;
      if (isSystemProtectedPath(normRel)) continue;
      if (normalizedScope.protectedPaths.some(pp => isPathWithinRootForFilesystem(normRel, pp, { platform }))) continue;

      // 跳过 .cc-auto/runs
      let skipRuns = false;
      for (const prefix of GLOB_SKIP_PREFIXES) {
        if (rel.startsWith(prefix)) { skipRuns = true; break; }
      }
      if (skipRuns) continue;

      let lstat: Stats;
      try {
        lstat = lstatSync(full);
      } catch {
        continue;
      }

      if (lstat.isSymbolicLink()) continue;

      if (lstat.isDirectory()) {
        const lastSeg = path.basename(full);
        if (!GLOB_SKIP_DIRS.has(lastSeg)) {
          stack.push(full);
        }
      } else if (lstat.isFile()) {
        // 验证在 scope 内
        if (normalizedScope.allowedRoots.some(r => isPathWithinRootForFilesystem(normRel, r, { platform }))) {
          if (files.length >= maxFiles) {
            limitExceeded = true;
            break;
          }
          files.push(full);
        }
      }
    }
    if (limitExceeded) break;
  }

  return { files, limitExceeded };
}

// ============================================================================
// 工具函数
// ============================================================================

interface ResolvedScanRoot {
  normalizedPath: string;
  absolutePath: string;
}

type ScanRootResolution =
  | { ok: true; roots: ResolvedScanRoot[] }
  | { ok: false; reason: WorkspaceReadDenyReason | 'INVALID_PATH'; message: string };

function resolveAuthorizedScanRoots(options: {
  repositoryRoot: string;
  cwd: string;
  runId: string;
  fileScope: FileScope;
  roots?: string[];
}): ScanRootResolution {
  const lease = readRunLease(options.cwd);
  if (!lease) {
    return { ok: false, reason: 'RUN_LEASE_MISSING', message: 'Run Lease 不存在' };
  }
  if (lease.runId !== options.runId) {
    return { ok: false, reason: 'RUN_LEASE_MISMATCH', message: 'Run Lease runId 不匹配' };
  }
  if (normalizeAbsolute(lease.repositoryRoot) !== normalizeAbsolute(options.repositoryRoot)) {
    return { ok: false, reason: 'REPOSITORY_ROOT_MISMATCH', message: 'repositoryRoot 不匹配' };
  }

  const normalizedScope = normalizeReadScopeRoots(options.fileScope);
  if (!normalizedScope.ok || normalizedScope.allowedRoots.length === 0) {
    return { ok: false, reason: 'PATH_OUTSIDE_ROOTS', message: 'FileScope 没有可扫描目录' };
  }

  const requestedRoots = options.roots && options.roots.length > 0
    ? options.roots
    : normalizedScope.allowedRoots;
  const repoAbs = path.resolve(options.repositoryRoot);
  const resolved: ResolvedScanRoot[] = [];
  const seen = new Set<string>();

  for (const requested of requestedRoots) {
    const normalized = normalizeRepositoryRelativePath(requested);
    if (!normalized.ok) {
      return { ok: false, reason: 'INVALID_PATH', message: `扫描根路径无效：${normalized.detail}` };
    }
    if (isSystemProtectedPath(normalized.normalized) || isReadProtectedPath(normalized.normalized)) {
      return { ok: false, reason: 'SYSTEM_PROTECTED_PATH', message: '扫描根路径是保护路径' };
    }
    if (normalizedScope.protectedPaths.some(root =>
      isPathWithinRootForFilesystem(normalized.normalized, root))) {
      return { ok: false, reason: 'PROTECTED_PATH', message: '扫描根路径位于 protectedPaths' };
    }
    if (!normalizedScope.allowedRoots.some(root =>
      isPathWithinRootForFilesystem(normalized.normalized, root))) {
      return { ok: false, reason: 'PATH_OUTSIDE_ROOTS', message: '扫描根路径不在 allowedRoots 内' };
    }

    const linkCheck = checkPathChainForLinks(repoAbs, normalized.normalized);
    if (linkCheck) return linkCheck;
    const absolutePath = path.resolve(repoAbs, normalized.normalized);
    let rootStat: Stats;
    try {
      rootStat = lstatSync(absolutePath);
    } catch (error: unknown) {
      const code = getErrorCode(error);
      return {
        ok: false,
        reason: code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'READ_PERMISSION_DENIED',
        message: '无法读取扫描根路径',
      };
    }
    if (!rootStat.isDirectory()) {
      return { ok: false, reason: 'DIRECTORY_NOT_ALLOWED', message: '扫描根路径不是目录' };
    }
    const key = normalizeAbsolute(absolutePath);
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push({ normalizedPath: normalized.normalized, absolutePath });
    }
  }
  return { ok: true, roots: resolved };
}

function normalizeAbsolute(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

function isScopeProtected(
  normalizedPath: string,
  fileScope: FileScope,
  platform: NodeJS.Platform,
): boolean {
  return fileScope.protectedPaths.some((protectedPath) => {
    const normalized = normalizeRepositoryRelativePath(protectedPath);
    return normalized.ok
      && isPathWithinRootForFilesystem(normalizedPath, normalized.normalized, { platform });
  });
}

function isReadProtectedPath(relativePath: string): boolean {
  const key = relativePath.toLocaleLowerCase('en-US');
  if (READ_PROTECTED_FILES.has(key)) return true;
  for (const dir of READ_PROTECTED_DIRS) {
    if (key === dir || key.startsWith(`${dir}/`)) return true;
  }
  return false;
}

function checkPathChainForLinks(
  repositoryRoot: string,
  normalizedPath: string,
): Extract<WorkspaceReadAuthorization, { ok: false }> | null {
  let current = repositoryRoot;
  for (const segment of normalizedPath.split('/')) {
    current = path.join(current, segment);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) {
        return {
          ok: false,
          reason: process.platform === 'win32' ? 'JUNCTION_DETECTED' : 'SYMLINK_DETECTED',
          message: '请求路径包含符号链接或 junction',
        };
      }
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code === 'ENOENT') {
        return { ok: false, reason: 'FILE_NOT_FOUND', message: '请求的文件不存在' };
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return { ok: false, reason: 'READ_PERMISSION_DENIED', message: '没有读取请求路径的权限' };
      }
      return { ok: false, reason: 'FILE_NOT_REGULAR_FILE', message: '无法验证请求路径' };
    }
  }
  return null;
}

function fileReadFailure(pathLabel: string, error: unknown): SafeReadFileOutcome {
  const code = getErrorCode(error);
  if (code === 'ENOENT') {
    return { ok: false, reason: 'FILE_NOT_FOUND', message: `"${pathLabel}" 不存在` };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { ok: false, reason: 'READ_PERMISSION_DENIED', message: `没有读取 "${pathLabel}" 的权限` };
  }
  return { ok: false, reason: 'FILE_NOT_REGULAR_FILE', message: `无法读取 "${pathLabel}"` };
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function isAbsolutePathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

interface NormalizedScopePaths {
  ok: true;
  allowedRoots: string[];
  protectedPaths: string[];
  approvedFiles: string[];
}

function normalizeReadScopeRoots(scope: FileScope): NormalizedScopePaths | { ok: false } {
  const allowedRoots: string[] = [];
  for (const p of scope.allowedRoots) {
    const result = normalizeRepositoryRelativePath(p);
    if (!result.ok) return { ok: false };
    allowedRoots.push(result.normalized);
  }
  const protectedPaths: string[] = [];
  for (const p of scope.protectedPaths) {
    const result = normalizeRepositoryRelativePath(p);
    if (!result.ok) return { ok: false };
    protectedPaths.push(result.normalized);
  }
  const approvedFiles: string[] = [];
  for (const p of scope.approvedFiles) {
    const result = normalizeRepositoryRelativePath(p);
    if (!result.ok) return { ok: false };
    approvedFiles.push(result.normalized);
  }
  return { ok: true, allowedRoots, protectedPaths, approvedFiles };
}
