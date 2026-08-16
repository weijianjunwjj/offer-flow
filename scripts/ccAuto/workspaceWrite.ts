/** cc-auto v0.2.0 Slice 1D — 工作区安全写入执行点。
 *
 * 本模块提供 Writer Tool Loop 所需的文件写入权限内核：
 * - authorizeWorkspaceWrite：写入前多层授权检查（PROTECTED_PATH 不可绕过）
 * - 双重授权：requested path → resolved realpath 都须通过 FileScope
 * - openExistingRegularFileSecurely：非截断安全打开 + bigint dev/ino 身份验证
 * - safeWriteWorkspaceFile：安全全量写入（新文件 O_EXCL，已有文件验证后截断）
 * - safeEditWorkspaceFile：同 fd Read–Modify–Write（严格 UTF-8）
 * - auditChangedFilesAgainstScope：施工后 changedFiles 二次审计
 *
 * 不调用任何模型，不执行 shell 命令。
 */
import {
  existsSync, lstatSync, writeFileSync, mkdirSync, realpathSync,
  openSync, closeSync, fstatSync, ftruncateSync,
  readSync,
} from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { constants } from 'node:fs';
import path from 'node:path';
import type { FileScope } from './types';
import {
  normalizeRepositoryRelativePath,
  isSystemProtectedPath,
  pathsEqualForFilesystem,
  isPathWithinRootForFilesystem,
} from './fileScope';
import { readRunLease } from './runLease';

// ============================================================================
// 1. 授权类型定义
// ============================================================================

export interface WorkspaceWriteAuthorizationOptions {
  repositoryRoot: string;
  cwd: string;
  runId: string;
  targetPath: string;
  fileScope: FileScope;
}

export type WorkspaceWriteDenyReason =
  | 'INVALID_PATH'
  | 'PATH_OUTSIDE_REPOSITORY'
  | 'PROTECTED_PATH'
  | 'SYSTEM_PROTECTED_PATH'
  | 'FILE_NOT_APPROVED'
  | 'MAX_CHANGED_FILES_EXCEEDED'
  | 'RUN_LEASE_MISSING'
  | 'RUN_LEASE_MISMATCH'
  | 'REPOSITORY_ROOT_MISMATCH'
  | 'WRITER_NOT_ASSIGNED'
  | 'SYMLINK_ESCAPE'
  | 'TARGET_NOT_REGULAR_FILE'
  | 'FILE_IDENTITY_UNVERIFIABLE'
  | 'TARGET_RACE_DETECTED'
  | 'WRITE_PERMISSION_DENIED'
  | 'WRITE_STORAGE_ERROR'
  | 'WRITE_IO_ERROR'
  | 'WRITE_FAILED_AFTER_TRUNCATE'
  | 'SCOPE_CONFIG_ERROR';

export interface WorkspaceWriteAuthorizationResult {
  ok: true;
  normalizedPath: string;
  resolvedNormalizedPath: string;
  absolutePath: string;
  resolvedAbsolutePath: string;
}

export type WorkspaceWriteAuthorization =
  | WorkspaceWriteAuthorizationResult
  | { ok: false; reason: WorkspaceWriteDenyReason; message: string };

// ============================================================================
// 2. 核心授权检查（双重授权：requested + resolved realpath）
// ============================================================================

export function authorizeWorkspaceWrite(
  options: WorkspaceWriteAuthorizationOptions,
): WorkspaceWriteAuthorization {
  const { repositoryRoot, runId, targetPath, fileScope } = options;

  // === 2a. 规范化 scope 路径（入口 fail closed） ===
  const scopeNorm = normalizeScopeRoots(fileScope);
  if (!scopeNorm.ok) {
    return { ok: false, reason: 'SCOPE_CONFIG_ERROR', message: scopeNorm.reason };
  }

  // === 2b. 规范化请求路径 ===
  const normResult = normalizeRepositoryRelativePath(targetPath);
  if (!normResult.ok) {
    return { ok: false, reason: 'INVALID_PATH', message: `路径无效：${normResult.detail}` };
  }
  const requestedNormalizedPath = normResult.normalized;
  const platform = process.platform;

  // === 2c. 对请求路径执行多层安全检查 ===
  // 系统保护路径（大小写不敏感）
  if (isSystemProtectedPath(requestedNormalizedPath)) {
    return { ok: false, reason: 'SYSTEM_PROTECTED_PATH', message: `"${requestedNormalizedPath}" 是系统保护路径，不得写入` };
  }

  // protectedPaths（平台感知段边界）
  if (scopeNorm.protectedPaths.some(p => isPathWithinRootForFilesystem(requestedNormalizedPath, p, { platform }))) {
    return { ok: false, reason: 'PROTECTED_PATH', message: `"${requestedNormalizedPath}" 位于 protectedPaths 中，禁止写入` };
  }

  // approvedFiles 精确命中（平台感知）
  if (!scopeNorm.approvedFiles.some(p => pathsEqualForFilesystem(requestedNormalizedPath, p, { platform }))) {
    return { ok: false, reason: 'FILE_NOT_APPROVED', message: `文件 "${requestedNormalizedPath}" 未在 approvedFiles 中` };
  }

  // === 2d. Lease 检查 ===
  const lease = readRunLease(options.cwd);
  if (!lease) {
    return { ok: false, reason: 'RUN_LEASE_MISSING', message: 'Run Lease 不存在' };
  }

  if (lease.runId !== runId) {
    return { ok: false, reason: 'RUN_LEASE_MISMATCH', message: `Run Lease runId 不匹配（期望=${runId}，实际=${lease.runId}）` };
  }

  const leaseRoot = normalizeAbsolute(lease.repositoryRoot);
  const actualRoot = normalizeAbsolute(repositoryRoot);
  if (leaseRoot !== actualRoot) {
    return { ok: false, reason: 'REPOSITORY_ROOT_MISMATCH', message: `repositoryRoot 不匹配` };
  }

  if (lease.writer !== 'assigned' || lease.writerAssignment === null) {
    return { ok: false, reason: 'WRITER_NOT_ASSIGNED', message: '当前 Run Lease 没有正式授权的 Writer' };
  }

  if (scopeNorm.approvedFiles.length > fileScope.maxChangedFiles) {
    return { ok: false, reason: 'MAX_CHANGED_FILES_EXCEEDED', message: `已批准文件数 ${scopeNorm.approvedFiles.length} 超过 ${fileScope.maxChangedFiles}` };
  }

  // === 2e. 双重授权：realpath 解析 ===
  const repoAbs = path.resolve(repositoryRoot);
  const targetAbs = path.resolve(repositoryRoot, requestedNormalizedPath);

  // 绝对路径边界检查
  if (!isAbsolutePathInside(targetAbs, repoAbs)) {
    return { ok: false, reason: 'PATH_OUTSIDE_REPOSITORY', message: `路径 "${requestedNormalizedPath}" 不在仓库根目录内` };
  }

  const dualCheck = performDualAuthorization(
    targetAbs, repoAbs, requestedNormalizedPath, scopeNorm, platform,
  );
  if (!dualCheck.ok) return dualCheck;

  return {
    ok: true,
    normalizedPath: requestedNormalizedPath,
    resolvedNormalizedPath: dualCheck.resolvedNormalizedPath,
    absolutePath: targetAbs,
    resolvedAbsolutePath: dualCheck.resolvedAbsolutePath,
  };
}

// ============================================================================
// 3. 双重授权：requested path → realpath → resolved path
// ============================================================================

interface DualAuthResult {
  ok: true;
  resolvedNormalizedPath: string;
  resolvedAbsolutePath: string;
}

function performDualAuthorization(
  targetAbs: string,
  repoAbs: string,
  requestedNormalizedPath: string,
  scopeNorm: NormalizedScope,
  platform: NodeJS.Platform,
): DualAuthResult | { ok: false; reason: WorkspaceWriteDenyReason; message: string } {
  const targetExists = existsSync(targetAbs);

  if (targetExists) {
    return dualAuthExistingFile(targetAbs, repoAbs, requestedNormalizedPath, scopeNorm, platform);
  }

  return dualAuthNewFile(targetAbs, repoAbs, requestedNormalizedPath, scopeNorm, platform);
}

/**
 * 已有文件的双重授权：
 * 1. lstat → 必须是普通文件（非 symlink/junction）
 * 2. realpath → 解析真实路径
 * 3. 折算为仓库相对路径 → resolvedNormalizedPath
 * 4. resolved 路径重新检查 system protected / protectedPaths / approvedFiles
 * 5. requested !== resolved → 拒绝
 */
function dualAuthExistingFile(
  targetAbs: string,
  repoAbs: string,
  requestedNormalizedPath: string,
  scopeNorm: NormalizedScope,
  platform: NodeJS.Platform,
): DualAuthResult | { ok: false; reason: WorkspaceWriteDenyReason; message: string } {
  // 1. lstat
  let lstatBefore: Stats;
  try {
    lstatBefore = lstatSync(targetAbs);
  } catch {
    return { ok: false, reason: 'TARGET_NOT_REGULAR_FILE', message: `无法获取 "${requestedNormalizedPath}" 的状态` };
  }

  if (lstatBefore.isSymbolicLink()) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `"${requestedNormalizedPath}" 是符号链接` };
  }
  if (!lstatBefore.isFile()) {
    return { ok: false, reason: 'TARGET_NOT_REGULAR_FILE', message: `"${requestedNormalizedPath}" 不是普通文件` };
  }

  // 2. realpath
  let realPath: string;
  try {
    realPath = normalizeAbsolute(realpathSync(targetAbs));
  } catch {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `无法解析 "${requestedNormalizedPath}" 的真实路径` };
  }

  // 3. 折算为仓库相对路径
  const resolvedAbs = realPath;
  if (!isAbsolutePathInside(resolvedAbs, normalizeAbsolute(repoAbs))) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `"${requestedNormalizedPath}" 的真实路径不在仓库内` };
  }

  const resolvedRel = path.relative(repoAbs, resolvedAbs).replace(/\\/g, '/');
  // 规范化
  const normResolved = normalizeRepositoryRelativePath(resolvedRel);
  if (!normResolved.ok) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `无法规范化 resolved 路径` };
  }
  const resolvedNormalizedPath = normResolved.normalized;

  // 4. 对 resolved 路径重新执行安全检查

  // 系统保护路径
  if (isSystemProtectedPath(resolvedNormalizedPath)) {
    return { ok: false, reason: 'SYSTEM_PROTECTED_PATH', message: `真实路径 "${resolvedNormalizedPath}" 是系统保护路径` };
  }

  // protectedPaths
  if (scopeNorm.protectedPaths.some(p => isPathWithinRootForFilesystem(resolvedNormalizedPath, p, { platform }))) {
    return { ok: false, reason: 'PROTECTED_PATH', message: `真实路径 "${resolvedNormalizedPath}" 位于 protectedPaths 中` };
  }

  // approvedFiles 精确命中
  if (!scopeNorm.approvedFiles.some(p => pathsEqualForFilesystem(resolvedNormalizedPath, p, { platform }))) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `目标路径经真实路径解析后不再对应已批准文件` };
  }

  // 5. requested !== resolved → 拒绝（即使都在仓库内）
  if (!pathsEqualForFilesystem(requestedNormalizedPath, resolvedNormalizedPath, { platform })) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `目标路径经真实路径解析后不再对应已批准文件` };
  }

  return { ok: true, resolvedNormalizedPath, resolvedAbsolutePath: resolvedAbs };
}

/**
 * 新文件的双重授权：
 * 1. 遍历所有已存在父目录，每一级执行 lstat
 * 2. 任意一级为 symlink/junction/reparse → 拒绝
 * 3. 对最近存在祖先执行 realpath
 * 4. 拼接剩余路径段，计算最终 resolved absolute path
 * 5. 折算为仓库相对路径
 * 6. resolved 必须与 requested 完全一致
 * 7. 再执行 system protected / protectedPaths / approvedFiles 检查
 */
function dualAuthNewFile(
  targetAbs: string,
  repoAbs: string,
  requestedNormalizedPath: string,
  scopeNorm: NormalizedScope,
  platform: NodeJS.Platform,
): DualAuthResult | { ok: false; reason: WorkspaceWriteDenyReason; message: string } {
  const repoAbsNorm = normalizeAbsolute(repoAbs);

  // 1-2. 遍历父目录链，检查 symlink/junction
  const ancestors: string[] = [];
  let current = targetAbs;

  while (true) {
    if (existsSync(current)) break;
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return { ok: false, reason: 'PATH_OUTSIDE_REPOSITORY', message: `"${requestedNormalizedPath}" 无存在祖先目录` };
    }
    current = parent;
  }

  // 2-3. 对每一级已存在祖先执行 lstat，检查 symlink/junction
  {
    let checkPath = current;
    while (true) {
      let stat: Stats;
      try {
        stat = lstatSync(checkPath);
      } catch {
        return { ok: false, reason: 'SYMLINK_ESCAPE', message: `无法获取父目录 "${requestedNormalizedPath}" 的状态` };
      }

      if (stat.isSymbolicLink()) {
        return { ok: false, reason: 'SYMLINK_ESCAPE', message: `父目录链中存在符号链接（在 "${requestedNormalizedPath}" 的父路径中）` };
      }

      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        // 到达普通目录——这是我们要找的最深存在祖先
        break;
      }

      // 继续向上
      const parent = path.dirname(checkPath);
      if (parent === checkPath) break;
      checkPath = parent;
    }
  }

  // 遍历所有不存在的中间段，确保不包含特殊路径
  // （已在 ancestors 中记录了所有不存在的路径段）

  // 4. 对最近存在祖先执行 realpath
  let ancestorReal: string;
  try {
    ancestorReal = normalizeAbsolute(realpathSync(current));
  } catch {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `无法解析父目录真实路径` };
  }

  if (!isAbsolutePathInside(ancestorReal, repoAbsNorm)) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `父目录真实路径不在仓库内` };
  }

  // 5. 拼接剩余路径段
  // ancestors 是从目标向上找到的"不存在"路径段，按 targetAbs → current 排列
  // 我们需要从 current 出发，重建完整路径
  const unresolvedSegments = ancestors.reverse(); // 从 current 的子级到 targetAbs
  let resolvedAbs = ancestorReal;
  for (const segAbs of unresolvedSegments) {
    const segName = path.basename(segAbs);
    resolvedAbs = path.join(resolvedAbs, segName);
  }
  resolvedAbs = normalizeAbsolute(resolvedAbs);

  // 6. 折算为仓库相对路径
  if (!isAbsolutePathInside(resolvedAbs, repoAbsNorm)) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `新文件 resolved 路径不在仓库内` };
  }

  const resolvedRel = path.relative(repoAbs, resolvedAbs).replace(/\\/g, '/');
  const normResolved = normalizeRepositoryRelativePath(resolvedRel);
  if (!normResolved.ok) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `无法规范化 resolved 路径` };
  }
  const resolvedNormalizedPath = normResolved.normalized;

  // 7. resolved 必须与 requested 完全一致
  if (!pathsEqualForFilesystem(requestedNormalizedPath, resolvedNormalizedPath, { platform })) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `目标路径经真实路径解析后不再对应已批准文件` };
  }

  // 8. 对 resolved 路径重新执行安全检查

  if (isSystemProtectedPath(resolvedNormalizedPath)) {
    return { ok: false, reason: 'SYSTEM_PROTECTED_PATH', message: `真实路径 "${resolvedNormalizedPath}" 是系统保护路径` };
  }

  if (scopeNorm.protectedPaths.some(p => isPathWithinRootForFilesystem(resolvedNormalizedPath, p, { platform }))) {
    return { ok: false, reason: 'PROTECTED_PATH', message: `真实路径 "${resolvedNormalizedPath}" 位于 protectedPaths 中` };
  }

  if (!scopeNorm.approvedFiles.some(p => pathsEqualForFilesystem(resolvedNormalizedPath, p, { platform }))) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `目标路径经真实路径解析后不再对应已批准文件` };
  }

  return { ok: true, resolvedNormalizedPath, resolvedAbsolutePath: resolvedAbs };
}

// ============================================================================
// 4. 绝对路径内判断
// ============================================================================

export function isAbsolutePathInside(child: string, parent: string, _platform?: NodeJS.Platform): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

// ============================================================================
// 5. 安全文件打开 helper —— 非截断、bigint 身份验证
// ============================================================================

export type FileIdentityResult =
  | { ok: true }
  | { ok: false; reason: 'FILE_IDENTITY_UNVERIFIABLE' | 'SYMLINK_ESCAPE'; message: string };

/** 仅测试使用的竞态注入 hook */
export interface FileOpenTestHooks {
  /** 在 lstat 之后、openSync 之前调用 */
  afterLstatBeforeOpen?: () => void;
  /** 在 openSync+fstat+身份验证完成之后、truncate 之前调用 */
  afterVerifyBeforeWrite?: () => void;
  /** 在 Read–Modify–Write 中读取之后、写入之前调用 */
  afterReadBeforeWrite?: () => void;
}

/**
 * 比较 lstat 前和 fstat 后的文件身份。
 * 使用 bigint 避免 NTFS File ID 精度丢失。
 *
 * 规则：
 * - dev 或 ino 为 0n → FILE_IDENTITY_UNVERIFIABLE
 * - dev 不同 → 拒绝
 * - ino 不同 → 拒绝
 */
export function compareFileIdentity(
  before: { dev: bigint; ino: bigint },
  after: { dev: bigint; ino: bigint },
): FileIdentityResult {
  if (before.dev === 0n || before.ino === 0n || after.dev === 0n || after.ino === 0n) {
    return { ok: false, reason: 'FILE_IDENTITY_UNVERIFIABLE', message: '无法确认文件系统身份（dev/ino 为 0）' };
  }

  if (before.dev !== after.dev) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: '文件身份在打开前后发生变化（dev 不匹配）' };
  }

  if (before.ino !== after.ino) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: '文件身份在打开前后发生变化（ino 不匹配）' };
  }

  return { ok: true };
}

/** 打开已有文件的 fd 安全结果 */
export interface SecureOpenedFileResult {
  ok: true;
  fd: number;
}

/**
 * 使用非截断 flag（O_RDWR | O_NOFOLLOW if available）安全打开已有文件。
 *
 * 时序：
 * 1. lstatSync(path, { bigint: true }) — 必须是普通文件、非 symlink
 * 2. openSync(path, O_RDWR | O_NOFOLLOW?) — 不截断
 * 3. fstatSync(fd, { bigint: true }) — 确认仍为普通文件
 * 4. 严格比较 bigint dev + ino — 必须完全相同
 * 5. 无法确认 dev/ino → FILE_IDENTITY_UNVERIFIABLE
 *
 * 验证完成前不做任何 truncate、write。
 */
function openExistingRegularFileSecurely(
  absolutePath: string,
  normalizedPath: string,
  hooks?: FileOpenTestHooks,
): SecureOpenedFileResult | { ok: false; reason: WorkspaceWriteDenyReason | 'FILE_IDENTITY_UNVERIFIABLE'; message: string } {
  // 1. lstat with bigint（后面不再使用路径访问文件）
  let lstatStatsBefore: BigIntStats;
  try {
    lstatStatsBefore = lstatSync(absolutePath, { bigint: true });
  } catch {
    return { ok: false, reason: 'TARGET_NOT_REGULAR_FILE', message: `无法获取 "${normalizedPath}" 的状态` };
  }

  if (lstatStatsBefore.isSymbolicLink()) {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: `"${normalizedPath}" 是符号链接` };
  }
  if (!lstatStatsBefore.isFile()) {
    return { ok: false, reason: 'TARGET_NOT_REGULAR_FILE', message: `"${normalizedPath}" 不是普通文件` };
  }

  // test hook: between lstat and open
  hooks?.afterLstatBeforeOpen?.();

  // 2. 打开——使用非截断 flag
  const flags = buildNonTruncatingFlags();
  let fd: number;
  try {
    fd = openSync(absolutePath, flags);
  } catch {
    return { ok: false, reason: 'TARGET_NOT_REGULAR_FILE', message: `无法打开 "${normalizedPath}"` };
  }

  // 3. fstat with bigint — 确认仍为普通文件
  let fstatAfter: BigIntStats;
  try {
    fstatAfter = fstatSync(fd, { bigint: true });
  } catch {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'TARGET_NOT_REGULAR_FILE', message: `fstat "${normalizedPath}" 失败` };
  }

  if (!fstatAfter.isFile()) {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'TARGET_NOT_REGULAR_FILE', message: `"${normalizedPath}" 打开后不再是普通文件` };
  }

  // 4. 严格比较 bigint dev + ino
  const identityCheck = compareFileIdentity(
    { dev: lstatStatsBefore.dev, ino: lstatStatsBefore.ino },
    { dev: fstatAfter.dev, ino: fstatAfter.ino },
  );

  if (!identityCheck.ok) {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: identityCheck.reason, message: identityCheck.message };
  }

  return { ok: true, fd };
}

/** 构建不截断的 open flags：O_RDWR，POSIX 优先追加 O_NOFOLLOW */
function buildNonTruncatingFlags(): number {
  const O_RDWR = constants.O_RDWR ?? 2;
  const O_NOFOLLOW = (constants as Record<string, number | undefined>).O_NOFOLLOW;
  if (typeof O_NOFOLLOW === 'number') {
    return O_RDWR | O_NOFOLLOW;
  }
  return O_RDWR;
}

// ============================================================================
// 6. Safe Write
// ============================================================================

export interface SafeWriteWorkspaceFileOptions extends WorkspaceWriteAuthorizationOptions {
  content: string;
  testHooks?: FileOpenTestHooks;
}

export interface WorkspaceWriteResult {
  ok: true;
  normalizedPath: string;
  bytesWritten: number;
  action: 'created' | 'updated';
}

export interface WorkspaceWriteFailure {
  ok: false;
  reason: WorkspaceWriteDenyReason;
  message: string;
}

export type WorkspaceWriteOutcome = WorkspaceWriteResult | WorkspaceWriteFailure;

/**
 * 安全写入文件。
 *
 * 新文件：双重授权 → O_EXCL（wx）排他创建。
 * 已有文件：双重授权 → openExistingRegularFileSecurely → ftruncate → write → close。
 */
export function safeWriteWorkspaceFile(
  options: SafeWriteWorkspaceFileOptions,
): WorkspaceWriteOutcome {
  const auth = authorizeWorkspaceWrite(options);
  if (!auth.ok) return auth;

  const { resolvedAbsolutePath, normalizedPath } = auth;
  const content = options.content;

  if (typeof content !== 'string') {
    return { ok: false, reason: 'INVALID_PATH', message: '内容必须是 UTF-8 字符串' };
  }

  const existed = existsSync(resolvedAbsolutePath);

  if (!existed) {
    // === 新文件 O_EXCL ===
    return createNewFileExclusive(resolvedAbsolutePath, normalizedPath, content, options.repositoryRoot);
  }

  // === 已有文件：openExistSecure → truncate → write ===
  return overwriteExistingFile(resolvedAbsolutePath, normalizedPath, content, options.testHooks);
}

/** 新文件 O_EXCL 创建 */
function createNewFileExclusive(
  absolutePath: string, normalizedPath: string, content: string, repositoryRoot: string,
): WorkspaceWriteOutcome {
  const parentDir = path.dirname(absolutePath);
  if (!existsSync(parentDir)) {
    try { mkdirSync(parentDir, { recursive: true }); } catch {
      return { ok: false, reason: 'WRITE_IO_ERROR', message: `无法创建父目录 for "${normalizedPath}"` };
    }
    // 父目录创建后重新做 symlink 检查
    const repoAbsNorm = normalizeAbsolute(repositoryRoot);
    const parentCheck = checkNewFileParentSymlinks(absolutePath, repoAbsNorm);
    if (!parentCheck.ok) return { ok: false, reason: parentCheck.reason, message: parentCheck.message };
  }

  if (existsSync(absolutePath)) {
    return { ok: false, reason: 'TARGET_RACE_DETECTED', message: `"${normalizedPath}" 在检查后突然出现` };
  }

  let fd: number;
  try {
    fd = openSync(absolutePath, 'wx');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return { ok: false, reason: 'TARGET_RACE_DETECTED', message: `"${normalizedPath}" O_EXCL 创建时已被占用` };
    }
    return classifyWriteError(err, normalizedPath);
  }

  try {
    writeFileSync(fd, content, 'utf8');
  } catch (err) {
    try { closeSync(fd); } catch { /* best effort */ }
    return classifyWriteError(err, normalizedPath);
  }

  const bytesWritten = Buffer.byteLength(content, 'utf8');
  try { closeSync(fd); } catch { /* best effort */ }

  return { ok: true, normalizedPath, bytesWritten, action: 'created' };
}

/** 已有文件：安全打开 → truncate → write */
function overwriteExistingFile(
  absolutePath: string, normalizedPath: string, content: string,
  hooks?: FileOpenTestHooks,
): WorkspaceWriteOutcome {
  const secure = openExistingRegularFileSecurely(absolutePath, normalizedPath, hooks);
  if (!secure.ok) return secure;

  const { fd } = secure;
  const bytes = Buffer.from(content, 'utf8');

  // test hook: after verify, before truncate
  hooks?.afterVerifyBeforeWrite?.();

  // truncate — 一旦执行，文件可能已被破坏
  try {
    ftruncateSync(fd, 0);
  } catch (err) {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'WRITE_IO_ERROR', message: `截断 "${normalizedPath}" 失败` };
  }

  // truncate 后写入
  try {
    writeFileSync(fd, bytes);
  } catch (err) {
    try { closeSync(fd); } catch { /* best effort */ }
    return {
      ok: false,
      reason: 'WRITE_FAILED_AFTER_TRUNCATE',
      message: `写入 "${normalizedPath}" 失败：文件已开始修改，可能处于截断或部分写入状态，需要人工检查。`,
    };
  }

  try { closeSync(fd); } catch { /* best effort */ }
  return { ok: true, normalizedPath, bytesWritten: bytes.length, action: 'updated' };
}

/** 将文件系统错误分类为 WorkspaceWriteDenyReason */
function classifyWriteError(err: unknown, normalizedPath: string): WorkspaceWriteOutcome {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return { ok: false, reason: 'WRITE_PERMISSION_DENIED', message: `无权写入 "${normalizedPath}"` };
  }
  if (code === 'ENOSPC') {
    return { ok: false, reason: 'WRITE_STORAGE_ERROR', message: `存储空间不足，无法写入 "${normalizedPath}"` };
  }
  // ENOENT, EIO, and all others → WRITE_IO_ERROR
  return { ok: false, reason: 'WRITE_IO_ERROR', message: `写入 "${normalizedPath}" I/O 错误 (${code ?? 'UNKNOWN'})` };
}

/** 新文件父目录链 symlink 检查 */
function checkNewFileParentSymlinks(
  targetAbs: string, repoAbsNorm: string,
): { ok: true } | { ok: false; reason: WorkspaceWriteDenyReason; message: string } {
  let current = targetAbs;

  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return { ok: false, reason: 'PATH_OUTSIDE_REPOSITORY', message: '无存在祖先目录' };
    current = parent;
  }

  let stat: Stats;
  try { stat = lstatSync(current); } catch {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: '无法获取父目录状态' };
  }

  if (stat.isSymbolicLink()) return { ok: false, reason: 'SYMLINK_ESCAPE', message: '父目录链中存在符号链接' };

  let realPath: string;
  try { realPath = normalizeAbsolute(realpathSync(current)); } catch {
    return { ok: false, reason: 'SYMLINK_ESCAPE', message: '无法解析父目录真实路径' };
  }

  if (!isAbsolutePathInside(realPath, repoAbsNorm)) return { ok: false, reason: 'SYMLINK_ESCAPE', message: '父目录真实路径不在仓库内' };

  return { ok: true };
}

// ============================================================================
// 7. Safe Edit —— 同一个 fd 完成 Read–Modify–Write
// ============================================================================

export interface SafeEditWorkspaceFileOptions extends WorkspaceWriteAuthorizationOptions {
  oldText: string;
  newText: string;
  testHooks?: FileOpenTestHooks;
}

export interface WorkspaceEditResult {
  ok: true;
  normalizedPath: string;
  replacements: 1;
  bytesBefore: number;
  bytesAfter: number;
}

export interface WorkspaceEditFailure {
  ok: false;
  reason: WorkspaceWriteDenyReason | 'FILE_IDENTITY_UNVERIFIABLE' | 'EDIT_TARGET_NOT_FOUND' | 'EDIT_TARGET_NOT_UNIQUE' | 'OLD_TEXT_EMPTY' | 'FILE_NOT_UTF8';
  message: string;
}

export type WorkspaceEditOutcome = WorkspaceEditResult | WorkspaceEditFailure;

/**
 * 安全文本替换——同一个 fd 完成 Read–Modify–Write。
 *
 * 时序：
 * 1. authorizeWorkspaceWrite（含双重授权）
 * 2. 确认文件存在
 * 3. openExistingRegularFileSecurely（非截断，bigint dev/ino 验证）
 * 4. 从同一个 fd 读取全部字节（显式 position=0）
 * 5. strict UTF-8 TextDecoder 解码
 * 6. 检查 oldText 唯一出现
 * 7. 替换 + BOM 保留
 * 8. ftruncateSync(fd, 0) + writeFileSync(fd, bytes)
 * 9. close fd
 *
 * 读取后写入前不重新打开路径。
 */
export function safeEditWorkspaceFile(
  options: SafeEditWorkspaceFileOptions,
): WorkspaceEditOutcome {
  const { oldText, newText } = options;

  if (oldText.length === 0) {
    return { ok: false, reason: 'OLD_TEXT_EMPTY', message: 'oldText 不能为空' };
  }

  const auth = authorizeWorkspaceWrite(options);
  if (!auth.ok) return { ok: false, reason: auth.reason, message: auth.message };

  const { resolvedAbsolutePath, normalizedPath } = auth;

  if (!existsSync(resolvedAbsolutePath)) {
    return { ok: false, reason: 'EDIT_TARGET_NOT_FOUND', message: `"${normalizedPath}" 不存在` };
  }

  // 3. 安全打开（非截断，bigint dev/ino 验证）
  const secure = openExistingRegularFileSecurely(resolvedAbsolutePath, normalizedPath, options.testHooks);
  if (!secure.ok) {
    return { ok: false, reason: secure.reason === 'FILE_IDENTITY_UNVERIFIABLE' ? 'FILE_IDENTITY_UNVERIFIABLE' : secure.reason, message: secure.message };
  }

  const { fd } = secure;

  // 4. 从同一个 fd 读取——先用 fstat 获取文件大小
  let fileSize: number;
  try {
    const statAfter = fstatSync(fd);
    fileSize = Number(statAfter.size);
  } catch {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'FILE_NOT_UTF8', message: `无法获取 "${normalizedPath}" 大小` };
  }

  if (fileSize === 0) {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'EDIT_TARGET_NOT_FOUND', message: `"${normalizedPath}" 为空文件` };
  }

  const readBytes = Buffer.alloc(fileSize);
  let bytesRead: number;
  try {
    bytesRead = readSync(fd, readBytes, 0, fileSize, 0);
  } catch {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'FILE_NOT_UTF8', message: `无法读取 "${normalizedPath}"` };
  }

  if (bytesRead !== fileSize) {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'FILE_NOT_UTF8', message: `读取 "${normalizedPath}" 不完整 (${bytesRead}/${fileSize})` };
  }

  const readUint8 = new Uint8Array(readBytes.buffer, readBytes.byteOffset, bytesRead);
  const bytesBefore = bytesRead;

  // 5. strict UTF-8
  let original: string;
  try {
    original = new TextDecoder('utf-8', { fatal: true }).decode(readUint8);
  } catch {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'FILE_NOT_UTF8', message: `"${normalizedPath}" 不是合法 UTF-8` };
  }

  // 6. 精确匹配
  let count = 0;
  let searchIdx = 0;
  while ((searchIdx = original.indexOf(oldText, searchIdx)) !== -1) {
    count++;
    searchIdx += oldText.length;
  }

  if (count === 0) {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'EDIT_TARGET_NOT_FOUND', message: `oldText 出现 0 次` };
  }

  if (count > 1) {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'EDIT_TARGET_NOT_UNIQUE', message: `oldText 出现 ${count} 次` };
  }

  // test hook: after read, before write
  options.testHooks?.afterReadBeforeWrite?.();

  // 7. 替换 + BOM 保留
  const modified = original.replace(oldText, newText);
  const hasBOM = bytesBefore >= 3 && readBytes[0] === 0xEF && readBytes[1] === 0xBB && readBytes[2] === 0xBF;
  const textBytes = new TextEncoder().encode(modified);
  const finalBytes = hasBOM
    ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(textBytes)])
    : Buffer.from(textBytes);
  const bytesAfter = finalBytes.length;

  // 8. 同一个 fd 上 truncate + write
  try {
    ftruncateSync(fd, 0);
  } catch {
    try { closeSync(fd); } catch { /* best effort */ }
    return { ok: false, reason: 'WRITE_IO_ERROR', message: `截断 "${normalizedPath}" 失败` };
  }

  try {
    writeFileSync(fd, finalBytes);
  } catch {
    try { closeSync(fd); } catch { /* best effort */ }
    return {
      ok: false,
      reason: 'WRITE_FAILED_AFTER_TRUNCATE',
      message: `写入 "${normalizedPath}" 失败：文件已开始修改，可能处于截断或部分写入状态，需要人工检查。`,
    };
  }

  // 9. close
  try { closeSync(fd); } catch { /* best effort */ }

  return { ok: true, normalizedPath, replacements: 1, bytesBefore, bytesAfter };
}

// ============================================================================
// 8. changedFiles 二次审计
// ============================================================================

export interface ChangedFilesViolation {
  path: string;
  reason: 'INVALID_PATH' | 'FILE_NOT_APPROVED' | 'PROTECTED_PATH' | 'SYSTEM_PROTECTED_PATH' | 'MAX_CHANGED_FILES_EXCEEDED';
}

export interface ChangedFilesAuditResult {
  ok: boolean;
  normalizedChangedFiles: string[];
  violations: ChangedFilesViolation[];
}

export function auditChangedFilesAgainstScope(
  scope: FileScope,
  changedFiles: string[],
): ChangedFilesAuditResult {
  const violations: ChangedFilesViolation[] = [];
  const normalizedSet = new Set<string>();
  const platform = process.platform;

  // 规范化 scope
  const scopeNorm = normalizeScopeRoots(scope);
  if (!scopeNorm.ok) {
    return {
      ok: false,
      normalizedChangedFiles: [],
      violations: [{ path: '<scope config error>', reason: 'INVALID_PATH' }],
    };
  }

  for (const raw of changedFiles) {
    const normResult = normalizeRepositoryRelativePath(raw);

    if (!normResult.ok) { violations.push({ path: raw, reason: 'INVALID_PATH' }); continue; }

    const normalized = normResult.normalized;

    if (isSystemProtectedPath(normalized)) { violations.push({ path: normalized, reason: 'SYSTEM_PROTECTED_PATH' }); continue; }

    if (scopeNorm.protectedPaths.some(p => isPathWithinRootForFilesystem(normalized, p, { platform }))) {
      violations.push({ path: normalized, reason: 'PROTECTED_PATH' }); continue;
    }

    if (!scopeNorm.approvedFiles.some(p => pathsEqualForFilesystem(normalized, p, { platform }))) {
      violations.push({ path: normalized, reason: 'FILE_NOT_APPROVED' }); continue;
    }

    normalizedSet.add(normalized);
  }

  if (normalizedSet.size > scope.maxChangedFiles) {
    violations.push({ path: `<已去重 ${normalizedSet.size} 个文件>`, reason: 'MAX_CHANGED_FILES_EXCEEDED' });
  }

  return { ok: violations.length === 0, normalizedChangedFiles: Array.from(normalizedSet), violations };
}

// ============================================================================
// 9. Scope 路径规范化
// ============================================================================

interface NormalizedScope {
  ok: true;
  allowedRoots: string[];
  protectedPaths: string[];
  approvedFiles: string[];
  reason: string;
}

function normalizeScopeRoots(scope: FileScope): NormalizedScope | { ok: false; reason: string } {
  const allowedRoots = scope.allowedRoots.map(p => normalizeRepositoryRelativePath(p));
  const badAllowed = allowedRoots.find(r => !r.ok);
  if (badAllowed && !badAllowed.ok) {
    return { ok: false, reason: `allowedRoots 包含无效路径` };
  }

  const protectedPaths = scope.protectedPaths.map(p => normalizeRepositoryRelativePath(p));
  const badProtected = protectedPaths.find(r => !r.ok);
  if (badProtected && !badProtected.ok) {
    return { ok: false, reason: `protectedPaths 包含无效路径` };
  }

  const approvedFiles = scope.approvedFiles.map(p => normalizeRepositoryRelativePath(p));
  const badApproved = approvedFiles.find(r => !r.ok);
  if (badApproved && !badApproved.ok) {
    return { ok: false, reason: `approvedFiles 包含无效路径` };
  }

  return {
    ok: true,
    allowedRoots: allowedRoots.map(r => (r as { ok: true; normalized: string }).normalized),
    protectedPaths: protectedPaths.map(r => (r as { ok: true; normalized: string }).normalized),
    approvedFiles: approvedFiles.map(r => (r as { ok: true; normalized: string }).normalized),
    reason: '',
  };
}

// ============================================================================
// 工具函数
// ============================================================================

function normalizeAbsolute(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}
