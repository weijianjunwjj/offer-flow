/** cc-auto v0.2.0 Slice 1D — FileScope 路径规范化、系统保护路径、提案与批准。
 *
 * 本模块提供后续 DeepSeek Tool Loop 所需的文件权限内核：
 * - 仓库相对路径规范化（正斜杠、不穿越）
 * - 路径段边界比较（平台感知 + 大小写折叠）
 * - 系统保护路径（复用 safety.ts，补充额外保护，大小写不敏感）
 * - proposedFiles → approvedFiles 提案与批准
 *
 * 不调用任何模型，不执行任何文件 IO。
 */
import { checkPathSafety } from './safety';
import type { FileScope } from './types';

// ============================================================================
// 1. 路径规范化
// ============================================================================

export interface NormalizePathSuccess {
  ok: true;
  normalized: string;
}

export interface NormalizePathFailure {
  ok: false;
  reason: 'EMPTY_PATH' | 'WHITESPACE_ONLY' | 'NUL_CHARACTER' | 'ABSOLUTE_PATH' | 'PATH_TRAVERSAL' | 'ROOT_ONLY';
  detail: string;
}

export type FileScopePathResult = NormalizePathSuccess | NormalizePathFailure;

const POSIX_ABSOLUTE_RE = /^\//;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

/**
 * 将输入的任意路径规范化为仓库根目录相对路径。
 *
 * 规则：
 * - 统一使用正斜杠 /
 * - 不以 / 开头
 * - 不以 ./ 开头
 * - 不以 / 结尾
 * - 拒绝空串、仅空白、NUL、绝对路径、路径穿越、仅为 .
 * - 不对 URL 编码做猜测性解码
 */
export function normalizeRepositoryRelativePath(
  input: string,
  _options?: { platform?: NodeJS.Platform },
): FileScopePathResult {

  if (input.length === 0) {
    return { ok: false, reason: 'EMPTY_PATH', detail: '路径不能为空' };
  }

  if (input.trim().length === 0) {
    return { ok: false, reason: 'WHITESPACE_ONLY', detail: '路径不能仅包含空白字符' };
  }

  if (input.includes('\0')) {
    return { ok: false, reason: 'NUL_CHARACTER', detail: '路径不能包含 NUL 字符' };
  }

  let normalized = input.replace(/\\/g, '/');

  if (POSIX_ABSOLUTE_RE.test(normalized)) {
    return { ok: false, reason: 'ABSOLUTE_PATH', detail: `不允许 POSIX 绝对路径：${input}` };
  }

  if (WINDOWS_DRIVE_RE.test(normalized)) {
    return { ok: false, reason: 'ABSOLUTE_PATH', detail: `不允许 Windows 盘符路径：${input}` };
  }

  if (normalized.startsWith('//')) {
    return { ok: false, reason: 'ABSOLUTE_PATH', detail: `不允许 UNC 路径：${input}` };
  }

  normalized = normalized.replace(/^\.\//, '');
  normalized = normalized.replace(/\/+$/, '');

  if (normalized === '.' || normalized === '') {
    return { ok: false, reason: 'ROOT_ONLY', detail: '路径不能为仓库根目录本身（"."）' };
  }

  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return { ok: false, reason: 'PATH_TRAVERSAL', detail: `路径不允许包含 .. (${input})` };
    }
    if (seg === '.') {
      return { ok: false, reason: 'PATH_TRAVERSAL', detail: `路径不允许包含单独的 . segment (${input})` };
    }
    if (seg.length === 0) {
      return { ok: false, reason: 'EMPTY_PATH', detail: `路径包含空段 (${input})` };
    }
  }

  return { ok: true, normalized };
}

// ============================================================================
// 2. 路径段边界比较
// ============================================================================

/**
 * 按段边界判断 target 是否位于 root 之内。
 * target === root 或 target 以 root + "/" 开头 → true；否则 false。
 * 禁止不带边界的 path.startsWith(root)。
 */
export function isPathWithinRoot(target: string, root: string): boolean {
  if (target === root) return true;
  if (target === '') return false;
  return target.startsWith(root + '/');
}

// ============================================================================
// 3. 平台感知的路径比较 helper
// ============================================================================

/**
 * 系统保护路径统一大小写折叠键。
 *
 * 规则：
 * - 输入必须是仓库相对规范路径（正斜杠）
 * - 统一转换为 Unicode 稳定小写
 * - 不依赖当前平台——所有平台保守视为大小写不敏感
 */
export function normalizeSecurityPathKey(normalizedPath: string): string {
  return normalizedPath.toLocaleLowerCase('en-US');
}

/**
 * 根据平台返回路径比较键。
 * Windows：大小写不敏感
 * POSIX：保持大小写敏感
 * 系统保护路径：统一使用 normalizeSecurityPathKey（无论平台）
 */
export function pathComparisonKey(
  normalizedPath: string,
  options?: { platform?: NodeJS.Platform; securitySensitive?: boolean },
): string {
  if (options?.securitySensitive) {
    return normalizeSecurityPathKey(normalizedPath);
  }
  const platform = options?.platform ?? process.platform;
  if (platform === 'win32') {
    return normalizedPath.toLocaleLowerCase('en-US');
  }
  return normalizedPath;
}

/**
 * 平台感知的路径相等比较。
 * Windows：大小写不敏感
 * POSIX：大小写敏感
 */
export function pathsEqualForFilesystem(
  a: string,
  b: string,
  options?: { platform?: NodeJS.Platform },
): boolean {
  return pathComparisonKey(a, options) === pathComparisonKey(b, options);
}

/**
 * 平台感知的段边界包含检查。
 * Windows：大小写不敏感
 * POSIX：大小写敏感
 */
export function isPathWithinRootForFilesystem(
  target: string,
  root: string,
  options?: { platform?: NodeJS.Platform },
): boolean {
  const keyTarget = pathComparisonKey(target, options);
  const keyRoot = pathComparisonKey(root, options);
  if (keyTarget === keyRoot) return true;
  if (keyTarget === '') return false;
  return keyTarget.startsWith(keyRoot + '/');
}

// ============================================================================
// 4. 系统保护路径
// ============================================================================

/**
 * 系统保护路径的目录前缀集合（使用大小写折叠键比较）。
 * 以不带尾斜杠的目录形式存储，匹配时用段边界。
 */
const SYSTEM_PROTECTED_DIRS = new Set([
  normalizeSecurityPathKey('.git'),
  normalizeSecurityPathKey('.cc-auto/runs'),
  normalizeSecurityPathKey('node_modules'),
]);

/** 系统保护的精确定义文件（使用大小写折叠键比较） */
const SYSTEM_PROTECTED_EXACT_FILES = new Set([
  normalizeSecurityPathKey('.cc-auto/config.json'),
  normalizeSecurityPathKey('.cc-auto/run-lock.json'),
]);

/**
 * 判断给定仓库相对路径是否为系统保护路径。
 *
 * 系统保护路径即使被用户手动加入 approvedFiles，安全写入层仍必须拒绝。
 *
 * 保护范围（通过 safety.ts checkPathSafety 复用）：
 * - data/offerflow.sqlite3
 * - .env / .env.* 系列
 * - server/schema.ts
 *
 * 补充保护（大小写不敏感）：
 * - .git/** （不误伤 .gitignore / .gitattributes）
 * - .cc-auto/config.json
 * - .cc-auto/run-lock.json
 * - .cc-auto/runs/** （不误伤 .cc-auto/runs-old）
 * - node_modules/**
 */
export function isSystemProtectedPath(relativePath: string): boolean {
  // 复用 safety.ts 中已有的高风险路径规则
  const safetyMatch = checkPathSafety(relativePath);
  if (safetyMatch.denied) return true;

  // 大小写折叠键
  const key = normalizeSecurityPathKey(relativePath);

  // 精确文件匹配（大小写不敏感）
  if (SYSTEM_PROTECTED_EXACT_FILES.has(key)) return true;

  // 目录前缀匹配（大小写不敏感 + 段边界）
  for (const dir of SYSTEM_PROTECTED_DIRS) {
    if (key === dir) return true;
    if (key.startsWith(dir + '/')) return true;
  }

  return false;
}

// ============================================================================
// 5. FileScope 提案与批准
// ============================================================================

export type FileProposalDecisionVerdict =
  | 'APPROVED'
  | 'REQUIRES_HUMAN_APPROVAL'
  | 'DENIED';

export type FileProposalDecisionReason =
  | 'WITHIN_ALLOWED_ROOT'
  | 'OUTSIDE_ALLOWED_ROOTS'
  | 'PROTECTED_PATH'
  | 'SYSTEM_PROTECTED_PATH'
  | 'INVALID_PATH'
  | 'MAX_CHANGED_FILES_EXCEEDED'
  | 'DUPLICATE_PATH';

export interface FileProposalDecision {
  path: string;
  normalizedPath: string | null;
  decision: FileProposalDecisionVerdict;
  reason: FileProposalDecisionReason;
}

export interface FileProposalEvaluation {
  decisions: FileProposalDecision[];
  approvedFiles: string[];
  requiresHumanApproval: boolean;
  denied: boolean;
}

/**
 * 对 FileScope 的 allowedRoots / protectedPaths / approvedFiles 做入口规范化。
 * 如果 scope 本身含非法路径（空段、穿越、绝对路径等），返回配置错误。
 */
function normalizeScopePaths(
  scope: FileScope,
  _platform?: NodeJS.Platform,
): { ok: true; allowedRoots: string[]; protectedPaths: string[]; approvedFiles: string[] } | { ok: false; reason: string } {
  const allowedRoots = scope.allowedRoots.map(p => normalizeRepositoryRelativePath(p));
  const badAllowed = allowedRoots.find(r => !r.ok);
  if (badAllowed && !badAllowed.ok) {
    return { ok: false, reason: `allowedRoots 包含无效路径 "${badAllowed.detail}"` };
  }

  const protectedPaths = scope.protectedPaths.map(p => normalizeRepositoryRelativePath(p));
  const badProtected = protectedPaths.find(r => !r.ok);
  if (badProtected && !badProtected.ok) {
    return { ok: false, reason: `protectedPaths 包含无效路径 "${badProtected.detail}"` };
  }

  const approvedFiles = scope.approvedFiles.map(p => normalizeRepositoryRelativePath(p));
  const badApproved = approvedFiles.find(r => !r.ok);
  if (badApproved && !badApproved.ok) {
    return { ok: false, reason: `approvedFiles 包含无效路径 "${badApproved.detail}"` };
  }

  return {
    ok: true,
    allowedRoots: allowedRoots.map(r => (r as NormalizePathSuccess).normalized),
    protectedPaths: protectedPaths.map(r => (r as NormalizePathSuccess).normalized),
    approvedFiles: approvedFiles.map(r => (r as NormalizePathSuccess).normalized),
  };
}

/**
 * 评估 proposedFiles 列表，生成每个文件的决策。
 *
 * 整批原子 maxChangedFiles 语义：
 * - 先规范化全部 proposedFiles
 * - 完成去重和系统保护/受保护路径分类
 * - 计算本批可能新增的唯一候选集合
 * - 如果 existingApprovedUniqueCount + newCandidateUniqueCount > maxChangedFiles
 *   → 本批不得新增任何 approvedFiles，所有候选标记 MAX_CHANGED_FILES_EXCEEDED
 * - 原 scope.approvedFiles 保持不变
 */
export function evaluateFileProposals(
  scope: FileScope,
  proposedFiles: string[],
): FileProposalEvaluation {
  // 入口规范化 scope 路径
  const scopeNorm = normalizeScopePaths(scope);
  if (!scopeNorm.ok) {
    // scope 配置错误 → 所有提案拒绝
    const decisions: FileProposalDecision[] = proposedFiles.map(raw => ({
      path: raw,
      normalizedPath: null,
      decision: 'DENIED' as FileProposalDecisionVerdict,
      reason: 'INVALID_PATH' as FileProposalDecisionReason,
    }));
    return { decisions, approvedFiles: [...scope.approvedFiles], requiresHumanApproval: false, denied: true };
  }

  const decisions: FileProposalDecision[] = [];
  // 使用平台感知的 approvedFiles 比较（去重用）
  const seenNormalizedAll = new Set(scopeNorm.approvedFiles.map(p => pathComparisonKey(p)));
  const platform = process.platform;

  // === 第一遍：规范化 + 去重 + 分类 ===
  interface Candidate {
    raw: string;
    normalized: string;
    verdict: FileProposalDecisionVerdict;
    reason: FileProposalDecisionReason;
  }
  const candidates: Candidate[] = [];

  for (const raw of proposedFiles) {
    const normResult = normalizeRepositoryRelativePath(raw);

    if (!normResult.ok) {
      decisions.push({ path: raw, normalizedPath: null, decision: 'DENIED', reason: 'INVALID_PATH' });
      continue;
    }

    const normalized = normResult.normalized;
    const normKey = pathComparisonKey(normalized, { platform });

    // 去重（包括与已有 approvedFiles 比较——平台感知）
    if (seenNormalizedAll.has(normKey)) {
      decisions.push({ path: raw, normalizedPath: normalized, decision: 'DENIED', reason: 'DUPLICATE_PATH' });
      continue;
    }

    // 系统保护路径 → 永久 DENIED（大小写不敏感）
    if (isSystemProtectedPath(normalized)) {
      decisions.push({ path: raw, normalizedPath: normalized, decision: 'DENIED', reason: 'SYSTEM_PROTECTED_PATH' });
      continue;
    }

    seenNormalizedAll.add(normKey);

    // 触碰 protectedPaths → REQUIRES_HUMAN_APPROVAL（平台感知）
    if (isPathInAnyRootForFilesystem(normalized, scopeNorm.protectedPaths, { platform })) {
      decisions.push({ path: raw, normalizedPath: normalized, decision: 'REQUIRES_HUMAN_APPROVAL', reason: 'PROTECTED_PATH' });
      candidates.push({ raw, normalized, verdict: 'REQUIRES_HUMAN_APPROVAL', reason: 'PROTECTED_PATH' });
      continue;
    }

    // 位于 allowedRoots 内 → 候选机器批准（平台感知）
    if (isPathInAnyRootForFilesystem(normalized, scopeNorm.allowedRoots, { platform })) {
      decisions.push({ path: raw, normalizedPath: normalized, decision: 'APPROVED', reason: 'WITHIN_ALLOWED_ROOT' });
      candidates.push({ raw, normalized, verdict: 'APPROVED', reason: 'WITHIN_ALLOWED_ROOT' });
      continue;
    }

    // 位于 allowedRoots 外 → 需人工批准
    decisions.push({ path: raw, normalizedPath: normalized, decision: 'REQUIRES_HUMAN_APPROVAL', reason: 'OUTSIDE_ALLOWED_ROOTS' });
    candidates.push({ raw, normalized, verdict: 'REQUIRES_HUMAN_APPROVAL', reason: 'OUTSIDE_ALLOWED_ROOTS' });
  }

  // === 第二遍：原子化 maxChangedFiles 检查 ===
  const approvedSet = new Set(scopeNorm.approvedFiles);
  const potentiallyNew = candidates.filter(c => c.verdict === 'APPROVED');
  const newCount = potentiallyNew.length;

  if (newCount > 0 && approvedSet.size + newCount > scope.maxChangedFiles) {
    // 整批拒绝——不新增任何 approvedFiles
    for (const c of potentiallyNew) {
      // 改写对应的 decision
      const d = decisions.find(d => d.normalizedPath === c.normalized && d.decision === 'APPROVED');
      if (d) {
        (d as { decision: FileProposalDecisionVerdict; reason: FileProposalDecisionReason }).decision = 'DENIED';
        (d as { reason: FileProposalDecisionReason }).reason = 'MAX_CHANGED_FILES_EXCEEDED';
      }
    }
  } else {
    // 逐个添加（候选通过 verified）
    for (const c of potentiallyNew) {
      approvedSet.add(c.normalized);
    }
  }

  const requiresHumanApproval = decisions.some(d => d.decision === 'REQUIRES_HUMAN_APPROVAL');
  const denied = decisions.some(d => d.decision === 'DENIED');

  return {
    decisions,
    approvedFiles: Array.from(approvedSet),
    requiresHumanApproval,
    denied,
  };
}

/**
 * 平台感知的 isPathInAnyRoot。
 */
function isPathInAnyRootForFilesystem(
  file: string,
  rootPaths: string[],
  options?: { platform?: NodeJS.Platform },
): boolean {
  for (const root of rootPaths) {
    if (isPathWithinRootForFilesystem(file, root, options)) return true;
  }
  return false;
}

// ============================================================================
// 6. 人工批准
// ============================================================================

export interface FileScopeApprovalResult {
  approvedFiles: string[];
  decisions: FileProposalDecision[];
  denied: boolean;
}

/**
 * 将指定文件加入 approvedFiles。
 *
 * 规则：
 * - 系统保护路径、非法路径永远拒绝
 * - protectedPaths 即使 userApproved=true 也不得直接绕过——
 *   返回 REQUIRES_HUMAN_APPROVAL / PROTECTED_PATH，
 *   用户必须通过独立的 FileScope 扩展流程显式修改 protectedPaths
 * - maxChangedFiles 整批原子：若本批候选会超限，整批拒绝
 */
export function approveProposedFiles(
  scope: FileScope,
  files: string[],
  userApproved: boolean,
): FileScopeApprovalResult {
  // 入口规范化 scope 路径
  const scopeNorm = normalizeScopePaths(scope);
  if (!scopeNorm.ok) {
    const decisions: FileProposalDecision[] = files.map(raw => ({
      path: raw,
      normalizedPath: null,
      decision: 'DENIED' as FileProposalDecisionVerdict,
      reason: 'INVALID_PATH' as FileProposalDecisionReason,
    }));
    return { decisions, approvedFiles: [...scope.approvedFiles], denied: true };
  }

  const decisions: FileProposalDecision[] = [];
  const approvedSet = new Set(scopeNorm.approvedFiles);
  const platform = process.platform;

  // === 第一遍 ===
  interface ApproveCandidate {
    raw: string;
    normalized: string;
  }
  const approveCandidates: ApproveCandidate[] = [];

  for (const raw of files) {
    const normResult = normalizeRepositoryRelativePath(raw);

    if (!normResult.ok) {
      decisions.push({ path: raw, normalizedPath: null, decision: 'DENIED', reason: 'INVALID_PATH' });
      continue;
    }

    const normalized = normResult.normalized;

    // 系统保护路径永远拒绝（大小写不敏感）
    if (isSystemProtectedPath(normalized)) {
      decisions.push({ path: raw, normalizedPath: normalized, decision: 'DENIED', reason: 'SYSTEM_PROTECTED_PATH' });
      continue;
    }

    // protectedPaths 不可绕过——即使 userApproved=true 也返回 PROTECTED_PATH（平台感知）
    // 用户必须通过独立的 FileScope 扩展流程显式修改 protectedPaths
    if (isPathInAnyRootForFilesystem(normalized, scopeNorm.protectedPaths, { platform })) {
      decisions.push({ path: raw, normalizedPath: normalized, decision: 'REQUIRES_HUMAN_APPROVAL', reason: 'PROTECTED_PATH' });
      continue;
    }

    if (userApproved) {
      approveCandidates.push({ raw, normalized });
    } else {
      // 用户未批准范围扩展
      if (isPathInAnyRootForFilesystem(normalized, scopeNorm.allowedRoots, { platform })) {
        approveCandidates.push({ raw, normalized });
      } else {
        decisions.push({ path: raw, normalizedPath: normalized, decision: 'REQUIRES_HUMAN_APPROVAL', reason: 'OUTSIDE_ALLOWED_ROOTS' });
      }
    }
  }

  // === 第二遍：原子化 maxChangedFiles ===
  if (approveCandidates.length > 0 && approvedSet.size + approveCandidates.length > scope.maxChangedFiles) {
    // 整批拒绝
    for (const c of approveCandidates) {
      decisions.push({ path: c.raw, normalizedPath: c.normalized, decision: 'DENIED', reason: 'MAX_CHANGED_FILES_EXCEEDED' });
    }
  } else {
    for (const c of approveCandidates) {
      approvedSet.add(c.normalized);
      const reason = isPathInAnyRootForFilesystem(c.normalized, scopeNorm.allowedRoots, { platform }) ? 'WITHIN_ALLOWED_ROOT' : 'OUTSIDE_ALLOWED_ROOTS';
      decisions.push({ path: c.raw, normalizedPath: c.normalized, decision: 'APPROVED', reason });
    }
  }

  const denied = decisions.some(d => d.decision === 'DENIED');

  return {
    approvedFiles: Array.from(approvedSet),
    decisions,
    denied,
  };
}
