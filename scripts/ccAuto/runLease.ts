/** cc-auto v0.2.0 Run Lease 管理。
 *
 * 路径：.cc-auto/run-lock.json
 * 职责：同一仓库同一时刻只允许一个 cc-auto run。
 *
 * 安全约束：
 * - 首次获取使用 fs.openSync(lockPath, 'wx') 原子排他创建，确保目标已存在时直接失败
 * - 释放/heartbeat/setWriter/exit hook 前必须校验 runId + pid + repositoryRoot 所有权
 * - 不得静默删除 stale lease
 * - 不得覆盖已有锁
 */
import { existsSync, readFileSync, writeFileSync, closeSync, openSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RunLease, WriterAssignment, WriterExecutionRole, WriterRole } from './types';

const LOCK_FILE = 'run-lock.json';
const HEARTBEAT_INTERVAL_MS = 30_000;
const LEGACY_DEEPSEEK_WRITER_ASSIGNMENT: WriterAssignment = {
  executionRole: 'WRITER',
  profileId: 'legacy-deepseek',
  providerIdentifier: 'deepseek',
};

/** 获取 Run Lease 的领域结果 */
export interface AcquireLeaseResult {
  ok: boolean;
  lease?: RunLease;
  reason?: 'LOCK_HELD' | 'STALE_LEASE' | 'IO_ERROR';
  detail?: string;
  staleLeaseInfo?: { existingRunId: string; existingPid: number; repositoryRoot: string; acquiredAt: string };
}

/** 所有权校验结果 */
export interface OwnershipCheck {
  ok: boolean;
  reason?: 'LOCK_MISSING' | 'OWNERSHIP_MISMATCH';
  detail?: string;
}

/**
 * 原子获取 Run Lease。
 * 使用 fs.openSync(lockPath, 'wx') 实现排他创建——若目标已存在则直接 fail（不覆盖）。
 */
export function acquireRunLease(
  cwd: string,
  runId: string,
  worktreeFingerprint: string,
): AcquireLeaseResult {
  const lockPath = lockFilePath(cwd);
  const expectedRoot = normalize(path.resolve(cwd));

  // 检查已有锁
  if (existsSync(lockPath)) {
    let existing: RunLease;
    try {
      const parsed = normalizeRunLease(JSON.parse(readFileSync(lockPath, 'utf8')));
      if (!parsed) throw new Error('INVALID_RUN_LEASE');
      existing = parsed;
    } catch {
      return {
        ok: false,
        reason: 'IO_ERROR',
        detail: 'Run Lease 文件损坏，无法解析。请手动检查后删除 .cc-auto/run-lock.json',
      };
    }

    // 核对 repositoryRoot
    const actualRoot = normalize(existing.repositoryRoot);
    if (actualRoot !== expectedRoot) {
      return {
        ok: false,
        reason: 'LOCK_HELD',
        detail: `仓库根目录不一致：当前=${expectedRoot}，Lease 记录=${actualRoot}`,
      };
    }

    // 检查进程是否存活
    if (isProcessAlive(existing.pid)) {
      return {
        ok: false,
        reason: 'LOCK_HELD',
        detail: `仓库已被 runId=${existing.runId} 占用（pid=${existing.pid}）`,
      };
    }

    // PID 不存在——stale lease
    return {
      ok: false,
      reason: 'STALE_LEASE',
      detail: `发现残留 Run Lease（runId=${existing.runId}，pid=${existing.pid} 已不存在）。请手动确认后清理`,
      staleLeaseInfo: {
        existingRunId: existing.runId,
        existingPid: existing.pid,
        repositoryRoot: existing.repositoryRoot,
        acquiredAt: existing.acquiredAt,
      },
    };
  }

  // 无锁——原子排他创建（wx flag: 文件必须不存在才创建，否则 EEXIST）
  const lease: RunLease = {
    runId,
    pid: process.pid,
    repositoryRoot: expectedRoot,
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    worktreeFingerprintAtStart: worktreeFingerprint,
    writer: 'none',
    writerAssignment: null,
  };

  try {
    // 确保父目录存在
    const dir = path.dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify(lease, null, 2), 'utf8');
    closeSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return {
        ok: false,
        reason: 'LOCK_HELD',
        detail: `获取 Run Lease 失败：文件已存在（并发竞争）`,
      };
    }
    return {
      ok: false,
      reason: 'IO_ERROR',
      detail: `获取 Run Lease 失败：${(err as Error).message}`,
    };
  }

  return { ok: true, lease };
}

/** 校验调用者对锁的所有权 */
function checkOwnership(lockPath: string, runId: string, expectedRoot: string): OwnershipCheck {
  if (!existsSync(lockPath)) {
    return { ok: false, reason: 'LOCK_MISSING', detail: 'Run Lease 文件不存在' };
  }

  let lock: RunLease;
  try {
    const parsed = normalizeRunLease(JSON.parse(readFileSync(lockPath, 'utf8')));
    if (!parsed) throw new Error('INVALID_RUN_LEASE');
    lock = parsed;
  } catch {
    return { ok: false, reason: 'OWNERSHIP_MISMATCH', detail: 'Run Lease 文件损坏' };
  }

  if (lock.runId !== runId) {
    return {
      ok: false,
      reason: 'OWNERSHIP_MISMATCH',
      detail: `锁所有权不匹配：期望 runId=${runId}，实际 runId=${lock.runId}`,
    };
  }

  if (lock.pid !== process.pid) {
    return {
      ok: false,
      reason: 'OWNERSHIP_MISMATCH',
      detail: `锁所有权不匹配：期望 pid=${process.pid}，实际 pid=${lock.pid}`,
    };
  }

  if (normalize(lock.repositoryRoot) !== normalize(expectedRoot)) {
    return {
      ok: false,
      reason: 'OWNERSHIP_MISMATCH',
      detail: `锁所有权不匹配：期望 repositoryRoot=${expectedRoot}，实际=${lock.repositoryRoot}`,
    };
  }

  return { ok: true };
}

/** 更新 heartbeat——校验所有权后写入 */
export function updateHeartbeat(cwd: string, runId: string): void {
  const lockPath = lockFilePath(cwd);
  const expectedRoot = normalize(path.resolve(cwd));
  const check = checkOwnership(lockPath, runId, expectedRoot);
  if (!check.ok) return;

  const lease = readLeaseFile(lockPath);
  if (!lease) return;
  lease.heartbeatAt = new Date().toISOString();
  writeFileSync(lockPath, JSON.stringify(lease, null, 2), 'utf8');
}

/** 设置或清除正式 Writer assignment——校验所有权后写入。 */
export function setWriter(
  cwd: string,
  runId: string,
  assignment: WriterAssignment | null,
): boolean {
  const lockPath = lockFilePath(cwd);
  const expectedRoot = normalize(path.resolve(cwd));
  const check = checkOwnership(lockPath, runId, expectedRoot);
  if (!check.ok) return false;

  const normalizedAssignment = assignment === null
    ? null
    : normalizeWriterAssignment(assignment);
  if (assignment !== null && normalizedAssignment === null) return false;

  const lease = readLeaseFile(lockPath);
  if (!lease) return false;
  lease.writer = normalizedAssignment === null ? 'none' : 'assigned';
  lease.writerAssignment = normalizedAssignment;
  writeFileSync(lockPath, JSON.stringify(lease, null, 2), 'utf8');
  return true;
}

/** 获取当前 writer */
export function getWriter(cwd: string): WriterRole {
  return readRunLease(cwd)?.writer ?? 'none';
}

/** 获取当前 Writer 的审计身份；没有正式授权时返回 null。 */
export function getWriterAssignment(cwd: string): WriterAssignment | null {
  return readRunLease(cwd)?.writerAssignment ?? null;
}

/** 释放 Run Lease——校验所有权后删除 */
export function releaseRunLease(cwd: string, runId: string): void {
  const lockPath = lockFilePath(cwd);
  const expectedRoot = normalize(path.resolve(cwd));
  const check = checkOwnership(lockPath, runId, expectedRoot);
  if (!check.ok) return; // 所有权不匹配——绝不删除

  try {
    unlinkSync(lockPath);
  } catch { /* 尽力释放 */ }
}

/** 读取当前 Run Lease */
export function readRunLease(cwd: string): RunLease | undefined {
  const lockPath = lockFilePath(cwd);
  if (!existsSync(lockPath)) return undefined;
  return readLeaseFile(lockPath);
}

/** 启动 heartbeat 定时器。返回 stop 函数用于清除。 */
export function startHeartbeat(cwd: string, runId: string): () => void {
  const interval = setInterval(() => updateHeartbeat(cwd, runId), HEARTBEAT_INTERVAL_MS);
  interval.unref();
  return () => clearInterval(interval);
}

/** 注册进程退出兜底钩子。同步执行，所有权校验确保不误删新任务锁。 */
export function registerExitHook(cwd: string, runId: string): void {
  const cleanup = () => {
    const lockPath = lockFilePath(cwd);
    if (!existsSync(lockPath)) return;
    const expectedRoot = normalize(path.resolve(cwd));
    const check = checkOwnership(lockPath, runId, expectedRoot);
    if (!check.ok) return; // 锁已被其他 run 接管——不删除

    try {
      unlinkSync(lockPath);
    } catch { /* 尽力 */ }
  };

  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      cleanup();
      process.exit(1);
    });
  }
}

/** 检查进程是否存活 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockFilePath(cwd: string): string {
  return path.join(cwd, '.cc-auto', LOCK_FILE);
}

function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

function readLeaseFile(lockPath: string): RunLease | undefined {
  try {
    return normalizeRunLease(JSON.parse(readFileSync(lockPath, 'utf8')));
  } catch {
    return undefined;
  }
}

function normalizeRunLease(value: unknown): RunLease | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.runId !== 'string'
    || typeof value.pid !== 'number'
    || !Number.isSafeInteger(value.pid)
    || typeof value.repositoryRoot !== 'string'
    || typeof value.acquiredAt !== 'string'
    || typeof value.heartbeatAt !== 'string'
    || typeof value.worktreeFingerprintAtStart !== 'string'
  ) return undefined;

  let writer: WriterRole;
  let writerAssignment: WriterAssignment | null;
  if (value.writer === 'none') {
    writer = 'none';
    writerAssignment = null;
  } else if (value.writer === 'assigned') {
    writerAssignment = normalizeWriterAssignment(value.writerAssignment);
    if (!writerAssignment) return undefined;
    writer = 'assigned';
  } else if (value.writer === 'deepseek') {
    // Migration-free compatibility for legacy run-lock.json files. The file is
    // not rewritten merely by reading it, and Provider identity remains audit-only.
    writer = 'assigned';
    writerAssignment = { ...LEGACY_DEEPSEEK_WRITER_ASSIGNMENT };
  } else {
    return undefined;
  }

  return {
    runId: value.runId,
    pid: value.pid,
    repositoryRoot: value.repositoryRoot,
    acquiredAt: value.acquiredAt,
    heartbeatAt: value.heartbeatAt,
    worktreeFingerprintAtStart: value.worktreeFingerprintAtStart,
    writer,
    writerAssignment,
  };
}

function normalizeWriterAssignment(value: unknown): WriterAssignment | null {
  if (!isRecord(value)) return null;
  if (!isWriterExecutionRole(value.executionRole)) return null;
  if (!isIdentityPart(value.profileId) || !isIdentityPart(value.providerIdentifier)) return null;
  return {
    executionRole: value.executionRole,
    profileId: value.profileId,
    providerIdentifier: value.providerIdentifier,
  };
}

function isWriterExecutionRole(value: unknown): value is WriterExecutionRole {
  return value === 'WRITER' || value === 'FAST_EXECUTOR' || value === 'STRONG_EXECUTOR';
}

function isIdentityPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
