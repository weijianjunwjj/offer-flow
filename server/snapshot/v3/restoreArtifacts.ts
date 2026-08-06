import fs from 'node:fs';
import path from 'node:path';
import { HostSnapshotV3Error, hostSnapshotError } from './errors';
import type { RestoreCandidatePhaseObserver } from './restorePhases';

export const RESTORE_ARTIFACT_CLEANUP_POLICY = Object.freeze({
  maxAttempts: 3,
  retryDelayMilliseconds: [10, 25] as const,
});

export type RestoreArtifactKind =
  | 'candidate'
  | 'sqlite-journal'
  | 'sqlite-wal'
  | 'sqlite-shm'
  | 'rename-probe'
  | 'report-temporary'
  | 'report-final';

export interface RestoreArtifactRecord {
  kind: RestoreArtifactKind;
  stage: string;
}

interface ArtifactIdentity {
  device: bigint;
  inode: bigint;
}

interface OwnedArtifact extends RestoreArtifactRecord {
  path: string;
  identity?: ArtifactIdentity;
  cleanupBlockedReason?: RestoreArtifactCleanupFailure['reason'];
}

export interface RestoreArtifactCleanupFailure extends RestoreArtifactRecord {
  reason: 'busy-retry-exhausted' | 'identity-changed' | 'handle-close-unconfirmed' | 'remove-failed';
}

export interface RestoreArtifactCleanupResult {
  failures: RestoreArtifactCleanupFailure[];
}

export interface RestoreArtifactIo {
  lstat(filePath: string): fs.BigIntStats;
  fstat(descriptor: number): fs.BigIntStats;
  openExclusive(filePath: string): number;
  writeAll(descriptor: number, content: string): void;
  flush(descriptor: number): void;
  close(descriptor: number): void;
  rename(sourcePath: string, targetPath: string): void;
  link(sourcePath: string, targetPath: string): void;
  unlink(filePath: string): void;
  wait(milliseconds: number): void;
}

function waitSynchronously(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export const DEFAULT_RESTORE_ARTIFACT_IO: RestoreArtifactIo = Object.freeze({
  lstat: (filePath: string) => fs.lstatSync(filePath, { bigint: true }),
  fstat: (descriptor: number) => fs.fstatSync(descriptor, { bigint: true }),
  openExclusive: (filePath: string) => fs.openSync(filePath, 'wx', 0o600),
  writeAll: (descriptor: number, content: string) => fs.writeFileSync(descriptor, content, 'utf8'),
  flush: (descriptor: number) => fs.fsyncSync(descriptor),
  close: (descriptor: number) => fs.closeSync(descriptor),
  rename: (sourcePath: string, targetPath: string) => fs.renameSync(sourcePath, targetPath),
  link: (sourcePath: string, targetPath: string) => fs.linkSync(sourcePath, targetPath),
  unlink: (filePath: string) => fs.unlinkSync(filePath),
  wait: waitSynchronously,
});

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isCollision(error: unknown): boolean {
  return ['EEXIST', 'EACCES', 'EPERM'].includes(errorCode(error) ?? '');
}

function identityOf(stats: fs.BigIntStats): ArtifactIdentity {
  return { device: stats.dev, inode: stats.ino };
}

function sameIdentity(left: ArtifactIdentity, right: fs.BigIntStats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.device === right.dev && left.inode === right.ino;
}

class RestoreArtifactLedger {
  private readonly owned = new Map<string, OwnedArtifact>();

  constructor(private readonly io: RestoreArtifactIo) {}

  registerCreated(filePath: string, kind: RestoreArtifactKind, stage: string): void {
    if (this.owned.has(filePath)) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '恢复产物 ownership 重复登记');
    }
    let stats: fs.BigIntStats;
    try {
      stats = this.io.lstat(filePath);
    } catch {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '恢复产物创建后无法确认 ownership');
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '恢复产物不是 owned 普通文件');
    }
    this.owned.set(filePath, {
      path: filePath,
      kind,
      stage,
      identity: identityOf(stats),
    });
  }

  registerCreatedFromDescriptor(
    filePath: string,
    kind: RestoreArtifactKind,
    stage: string,
    descriptor: number,
  ): void {
    if (this.owned.has(filePath)) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '恢复产物 ownership 重复登记');
    }
    let descriptorStats: fs.BigIntStats;
    try {
      descriptorStats = this.io.fstat(descriptor);
    } catch {
      this.owned.set(filePath, {
        path: filePath,
        kind,
        stage,
        cleanupBlockedReason: 'identity-changed',
      });
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '恢复产物句柄 identity 无法确认');
    }
    if (!descriptorStats.isFile()) {
      this.owned.set(filePath, {
        path: filePath,
        kind,
        stage,
        cleanupBlockedReason: 'identity-changed',
      });
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '恢复产物句柄不是普通文件');
    }
    this.owned.set(filePath, {
      path: filePath,
      kind,
      stage,
      identity: identityOf(descriptorStats),
    });
    this.assertOwnedRegularFile(filePath);
  }

  registerLinkedCreated(sourcePath: string, targetPath: string, kind: RestoreArtifactKind, stage: string): void {
    const source = this.owned.get(sourcePath);
    if (!source?.identity || this.owned.has(targetPath)) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '报告发布 ownership 状态无效');
    }
    this.owned.set(targetPath, {
      path: targetPath,
      kind,
      stage,
      identity: source.identity,
    });
    this.assertOwnedRegularFile(targetPath);
  }

  isOwned(filePath: string): boolean {
    return this.owned.has(filePath);
  }

  records(): RestoreArtifactRecord[] {
    return [...this.owned.values()].map(({ kind, stage }) => ({ kind, stage }));
  }

  assertOwnedRegularFile(filePath: string): void {
    const record = this.owned.get(filePath);
    if (!record) throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '恢复产物缺少 ownership');
    let stats: fs.BigIntStats;
    try {
      stats = this.io.lstat(filePath);
    } catch {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', 'owned 恢复产物无法确认');
    }
    if (!record.identity || !sameIdentity(record.identity, stats)) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', 'owned 恢复产物 identity 已变化');
    }
  }

  moveOwned(sourcePath: string, targetPath: string, stage: string): void {
    const record = this.owned.get(sourcePath);
    if (!record || this.owned.has(targetPath)) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', 'rename 产物 ownership 状态无效');
    }
    this.owned.delete(sourcePath);
    this.owned.set(targetPath, { ...record, path: targetPath, stage });
    this.assertOwnedRegularFile(targetPath);
  }

  retain(filePath: string): void {
    if (!this.owned.delete(filePath)) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '正式产物缺少可释放 ownership');
    }
  }

  blockCleanup(filePath: string): void {
    const record = this.owned.get(filePath);
    if (record) record.cleanupBlockedReason = 'handle-close-unconfirmed';
  }

  removeOne(filePath: string): RestoreArtifactCleanupFailure | undefined {
    const record = this.owned.get(filePath);
    if (!record) return undefined;
    if (record.cleanupBlockedReason) {
      return { kind: record.kind, stage: record.stage, reason: record.cleanupBlockedReason };
    }
    for (let attempt = 0; attempt < RESTORE_ARTIFACT_CLEANUP_POLICY.maxAttempts; attempt += 1) {
      let stats: fs.BigIntStats;
      try {
        stats = this.io.lstat(filePath);
      } catch (error) {
        if (isMissing(error)) {
          this.owned.delete(filePath);
          return undefined;
        }
        return { kind: record.kind, stage: record.stage, reason: 'remove-failed' };
      }
      if (!record.identity || !sameIdentity(record.identity, stats)) {
        return { kind: record.kind, stage: record.stage, reason: 'identity-changed' };
      }
      try {
        this.io.unlink(filePath);
        this.owned.delete(filePath);
        return undefined;
      } catch (error) {
        if (isMissing(error)) {
          this.owned.delete(filePath);
          return undefined;
        }
        const code = errorCode(error);
        if (!['EBUSY', 'EPERM'].includes(code ?? '')) {
          return { kind: record.kind, stage: record.stage, reason: 'remove-failed' };
        }
        if (attempt + 1 >= RESTORE_ARTIFACT_CLEANUP_POLICY.maxAttempts) {
          record.cleanupBlockedReason = 'busy-retry-exhausted';
          return { kind: record.kind, stage: record.stage, reason: 'busy-retry-exhausted' };
        }
        this.io.wait(RESTORE_ARTIFACT_CLEANUP_POLICY.retryDelayMilliseconds[attempt] ?? 25);
      }
    }
    return { kind: record.kind, stage: record.stage, reason: 'remove-failed' };
  }

  cleanupAll(): RestoreArtifactCleanupResult {
    const priority: Record<RestoreArtifactKind, number> = {
      'sqlite-journal': 10,
      'sqlite-wal': 11,
      'sqlite-shm': 12,
      'rename-probe': 20,
      'report-temporary': 30,
      candidate: 40,
      'report-final': 50,
    };
    const orderedPaths = [...this.owned.values()]
      .sort((left, right) => priority[left.kind] - priority[right.kind])
      .map((record) => record.path);
    const failures: RestoreArtifactCleanupFailure[] = [];
    for (const filePath of orderedPaths) {
      const failure = this.removeOne(filePath);
      if (failure) failures.push(failure);
    }
    return { failures };
  }
}

export interface RestoreArtifactControllerOptions {
  candidatePath: string;
  reportPath: string;
  runId: string;
  io?: RestoreArtifactIo;
  /** Test-only phase observer; the formal CLI never supplies this. */
  onPhase?: RestoreCandidatePhaseObserver;
}

function assertSafeRunId(runId: string): void {
  if (!/^[a-f0-9]{32,128}$/u.test(runId)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '恢复运行 ID 无效');
  }
}

export class RestoreArtifactController {
  private readonly io: RestoreArtifactIo;
  private readonly ledger: RestoreArtifactLedger;
  private readonly candidateSidecars: ReadonlyArray<{
    path: string;
    kind: 'sqlite-journal' | 'sqlite-wal' | 'sqlite-shm';
  }>;
  private readonly probePath: string;
  private readonly reportTemporaryPath: string;
  private preflightComplete = false;
  private reportPublished = false;
  private readonly observationFailures: RestoreArtifactCleanupFailure[] = [];

  constructor(private readonly options: RestoreArtifactControllerOptions) {
    assertSafeRunId(options.runId);
    this.io = options.io ?? DEFAULT_RESTORE_ARTIFACT_IO;
    this.ledger = new RestoreArtifactLedger(this.io);
    this.candidateSidecars = [
      { path: `${options.candidatePath}-journal`, kind: 'sqlite-journal' },
      { path: `${options.candidatePath}-wal`, kind: 'sqlite-wal' },
      { path: `${options.candidatePath}-shm`, kind: 'sqlite-shm' },
    ];
    const parent = path.dirname(options.candidatePath);
    this.probePath = path.join(parent, `.offerflow-host-v3-${options.runId}.rename-probe`);
    this.reportTemporaryPath = path.join(
      path.dirname(options.reportPath),
      `.offerflow-host-v3-${options.runId}.report.tmp`,
    );
  }

  private reached(phase: Parameters<RestoreCandidatePhaseObserver>[0]): void {
    this.options.onPhase?.(phase);
  }

  probePathForTesting(): string {
    return this.probePath;
  }

  reportTemporaryPathForTesting(): string {
    return this.reportTemporaryPath;
  }

  ownedArtifacts(): RestoreArtifactRecord[] {
    return this.ledger.records();
  }

  isReportPublished(): boolean {
    return this.reportPublished;
  }

  private pathExists(filePath: string): boolean {
    try {
      this.io.lstat(filePath);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw hostSnapshotError('HOST_SNAPSHOT_V3_ARTIFACT_COLLISION', '恢复产物路径无法安全预检');
    }
  }

  preflight(options: { includeRunArtifacts?: boolean } = {}): void {
    const targets = [
      this.options.candidatePath,
      ...this.candidateSidecars.map((entry) => entry.path),
      this.options.reportPath,
    ];
    if (options.includeRunArtifacts !== false) targets.push(this.probePath, this.reportTemporaryPath);
    if (targets.some((target) => this.pathExists(target))) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_ARTIFACT_COLLISION', '恢复产物目标已经存在');
    }
    this.preflightComplete = true;
  }

  private createExclusiveOwned(filePath: string, kind: RestoreArtifactKind, stage: string): number {
    let descriptor: number;
    try {
      descriptor = this.io.openExclusive(filePath);
    } catch (error) {
      if (isCollision(error)) {
        throw hostSnapshotError('HOST_SNAPSHOT_V3_ARTIFACT_COLLISION', '恢复产物发生独占创建碰撞');
      }
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '恢复产物无法独占创建');
    }
    try {
      this.ledger.registerCreatedFromDescriptor(filePath, kind, stage, descriptor);
    } catch (error) {
      try {
        this.io.close(descriptor);
      } catch {
        this.ledger.blockCleanup(filePath);
      }
      throw error;
    }
    return descriptor;
  }

  private closeOwnedDescriptor(filePath: string, descriptor: number): void {
    try {
      this.io.close(descriptor);
    } catch {
      this.ledger.blockCleanup(filePath);
      throw hostSnapshotError('HOST_SNAPSHOT_V3_CLEANUP_FAILED', '恢复产物句柄关闭状态无法确认');
    }
  }

  reserveCandidate(): void {
    if (!this.preflightComplete) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '候选库预占前缺少产物预检');
    }
    const descriptor = this.createExclusiveOwned(
      this.options.candidatePath,
      'candidate',
      'candidate-reservation',
    );
    this.closeOwnedDescriptor(this.options.candidatePath, descriptor);
    for (const target of [
      ...this.candidateSidecars.map((entry) => entry.path),
      this.options.reportPath,
      this.probePath,
      this.reportTemporaryPath,
    ]) {
      if (this.pathExists(target)) {
        throw hostSnapshotError('HOST_SNAPSHOT_V3_ARTIFACT_COLLISION', '候选库预占后检测到恢复产物碰撞');
      }
    }
  }

  recordSidecarsCreatedDuringOwnedCandidateOperation(stage: string): void {
    if (!this.ledger.isOwned(this.options.candidatePath)) return;
    for (const sidecar of this.candidateSidecars) {
      try {
        if (!this.ledger.isOwned(sidecar.path) && this.pathExists(sidecar.path)) {
          this.ledger.registerCreated(sidecar.path, sidecar.kind, stage);
        }
      } catch {
        this.observationFailures.push({ kind: sidecar.kind, stage, reason: 'remove-failed' });
      }
    }
  }

  proveCandidateRenameable(): void {
    this.ledger.assertOwnedRegularFile(this.options.candidatePath);
    const descriptor = this.createExclusiveOwned(this.probePath, 'rename-probe', 'rename-probe-reservation');
    this.closeOwnedDescriptor(this.probePath, descriptor);
    this.reached('RENAME_PROBE_RESERVED');
    const reservationCleanup = this.ledger.removeOne(this.probePath);
    if (reservationCleanup) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_CLEANUP_FAILED', 'rename probe 预留文件清理失败');
    }
    if (this.pathExists(this.probePath)) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_ARTIFACT_COLLISION', 'rename probe 目标发生碰撞');
    }
    try {
      this.io.rename(this.options.candidatePath, this.probePath);
      this.ledger.moveOwned(this.options.candidatePath, this.probePath, 'rename-probe-outbound');
      this.reached('RENAME_PROBE_CANDIDATE_MOVED');
      this.io.rename(this.probePath, this.options.candidatePath);
      this.ledger.moveOwned(this.probePath, this.options.candidatePath, 'rename-probe-return');
      this.reached('RENAME_PROBE_COMPLETED');
    } catch (error) {
      if (error instanceof HostSnapshotV3Error) throw error;
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '候选库 rename probe 失败');
    }
  }

  publishReport(content: string): void {
    const descriptor = this.createExclusiveOwned(
      this.reportTemporaryPath,
      'report-temporary',
      'report-temporary-create',
    );
    this.reached('REPORT_TEMP_CREATED');
    let writeFailed = false;
    try {
      this.io.writeAll(descriptor, content);
      this.reached('REPORT_TEMP_WRITTEN');
      this.io.flush(descriptor);
      this.reached('REPORT_TEMP_FSYNCED');
    } catch {
      writeFailed = true;
    }
    try {
      this.closeOwnedDescriptor(this.reportTemporaryPath, descriptor);
    } catch {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_PUBLISH_FAILED', '报告临时文件无法安全关闭');
    }
    if (writeFailed) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_PUBLISH_FAILED', '报告临时文件写入失败');
    }
    this.ledger.assertOwnedRegularFile(this.reportTemporaryPath);
    try {
      // A same-directory hard-link publish is atomic and fails when the final name already exists.
      // This supplies no-replace semantics that Node rename does not guarantee cross-platform.
      this.io.link(this.reportTemporaryPath, this.options.reportPath);
    } catch {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_PUBLISH_FAILED', '报告无法以 no-replace 协议发布');
    }
    this.ledger.registerLinkedCreated(
      this.reportTemporaryPath,
      this.options.reportPath,
      'report-final',
      'report-publish',
    );
    this.ledger.retain(this.options.reportPath);
    this.reportPublished = true;
    this.reached('REPORT_FINAL_PUBLISHED');
    const temporaryCleanup = this.ledger.removeOne(this.reportTemporaryPath);
    if (temporaryCleanup) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_CLEANUP_FAILED', '报告已发布但临时产物清理失败');
    }
    this.reached('REPORT_TEMP_REMOVED');
  }

  retainCandidate(): void {
    if (this.ledger.isOwned(this.options.candidatePath)) this.ledger.retain(this.options.candidatePath);
  }

  cleanupOwnedArtifacts(): RestoreArtifactCleanupResult {
    const cleanup = this.ledger.cleanupAll();
    return { failures: [...this.observationFailures, ...cleanup.failures] };
  }
}
