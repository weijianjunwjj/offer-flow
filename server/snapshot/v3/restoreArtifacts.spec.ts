import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RESTORE_ARTIFACT_IO,
  RestoreArtifactController,
  type RestoreArtifactIo,
} from './restoreArtifacts';

const cleanupDirectories: string[] = [];

afterEach(() => {
  while (cleanupDirectories.length > 0) {
    fs.rmSync(cleanupDirectories.pop()!, { recursive: true, force: true });
  }
});

function fixture(tag: string, io: RestoreArtifactIo = DEFAULT_RESTORE_ARTIFACT_IO) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `offerflow-restore-artifacts-${tag}-`));
  cleanupDirectories.push(directory);
  const candidatePath = path.join(directory, 'candidate.sqlite3');
  const reportPath = `${candidatePath}.host-snapshot-v3-report.json`;
  return {
    directory,
    candidatePath,
    reportPath,
    controller: new RestoreArtifactController({
      candidatePath,
      reportPath,
      runId: '0123456789abcdef0123456789abcdef',
      io,
    }),
  };
}

function contentHash(filePath: string): string {
  return fs.readFileSync(filePath).toString('hex');
}

describe('Host Snapshot V3 restore artifact ownership', () => {
  it.each(['candidate', 'journal', 'wal', 'shm', 'report'] as const)(
    '预检拒绝调用方已有 %s 且不改内容',
    (kind) => {
      const value = fixture(`preflight-${kind}`);
      const target = {
        candidate: value.candidatePath,
        journal: `${value.candidatePath}-journal`,
        wal: `${value.candidatePath}-wal`,
        shm: `${value.candidatePath}-shm`,
        report: value.reportPath,
      }[kind];
      fs.writeFileSync(target, `caller-owned-${kind}`, { flag: 'wx' });
      const before = contentHash(target);
      const modifiedBefore = fs.statSync(target).mtimeMs;

      expect(() => value.controller.preflight()).toThrowError(expect.objectContaining({
        code: 'HOST_SNAPSHOT_V3_ARTIFACT_COLLISION',
      }));
      expect(contentHash(target)).toBe(before);
      expect(fs.statSync(target).mtimeMs).toBe(modifiedBefore);
      expect(value.controller.ownedArtifacts()).toEqual([]);
    },
  );

  it('候选库只在独占创建成功后登记，竞态碰撞不覆盖也不登记', () => {
    const value = fixture('candidate-exclusive');
    value.controller.preflight();
    fs.writeFileSync(value.candidatePath, 'late-caller-file', { flag: 'wx' });
    const before = contentHash(value.candidatePath);

    expect(() => value.controller.reserveCandidate()).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_ARTIFACT_COLLISION',
    }));
    expect(contentHash(value.candidatePath)).toBe(before);
    expect(value.controller.ownedArtifacts()).toEqual([]);
  });

  it('成功预占零长度 candidate 后 SQLite 可继续初始化，ledger 记录类型和阶段', () => {
    const value = fixture('candidate-owned');
    value.controller.preflight();
    value.controller.reserveCandidate();
    expect(fs.statSync(value.candidatePath).size).toBe(0);
    expect(value.controller.ownedArtifacts()).toEqual([
      expect.objectContaining({ kind: 'candidate', stage: 'candidate-reservation' }),
    ]);
  });

  it('独占创建成功但 descriptor identity 无法确认时仍记录 owned 状态并阻止不安全删除', () => {
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      fstat() { throw new Error('fstat unavailable'); },
    };
    const value = fixture('candidate-fstat-failure', io);
    value.controller.preflight();

    expect(() => value.controller.reserveCandidate()).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_RESTORE_FAILED',
    }));
    expect(value.controller.ownedArtifacts()).toEqual([
      expect.objectContaining({ kind: 'candidate', stage: 'candidate-reservation' }),
    ]);
    expect(value.controller.cleanupOwnedArtifacts().failures).toEqual([
      expect.objectContaining({ kind: 'candidate', reason: 'identity-changed' }),
    ]);
  });

  it('随机 probe 不触碰旧固定 probe，完成后只保留 candidate', () => {
    const value = fixture('probe-fixed-preserved');
    const legacyProbe = `${value.candidatePath}.rename-probe`;
    fs.writeFileSync(legacyProbe, 'caller-owned-legacy-probe', { flag: 'wx' });
    const before = contentHash(legacyProbe);
    value.controller.preflight();
    value.controller.reserveCandidate();
    fs.writeFileSync(value.candidatePath, 'candidate-content');

    value.controller.proveCandidateRenameable();

    expect(contentHash(legacyProbe)).toBe(before);
    expect(fs.readFileSync(value.candidatePath, 'utf8')).toBe('candidate-content');
    expect(fs.readdirSync(value.directory).filter((name) => name.includes('0123456789abcdef'))).toEqual([]);
    expect(value.controller.ownedArtifacts()).toEqual([
      expect.objectContaining({ kind: 'candidate' }),
    ]);
  });

  it('随机 probe 独占创建碰撞时稳定拒绝且不覆盖', () => {
    const value = fixture('probe-collision');
    const probePath = value.controller.probePathForTesting();
    value.controller.preflight({ includeRunArtifacts: false });
    value.controller.reserveCandidate();
    fs.writeFileSync(probePath, 'caller-probe', { flag: 'wx' });
    const before = contentHash(probePath);

    expect(() => value.controller.proveCandidateRenameable()).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_ARTIFACT_COLLISION',
    }));
    expect(contentHash(probePath)).toBe(before);
    expect(value.controller.ownedArtifacts()).toEqual([
      expect.objectContaining({ kind: 'candidate' }),
    ]);
  });

  it('不同高熵运行 ID 产生不同 probe/report 临时名称', () => {
    const first = fixture('run-id-first');
    const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-restore-artifacts-run-id-second-'));
    cleanupDirectories.push(secondDirectory);
    const secondCandidate = path.join(secondDirectory, 'candidate.sqlite3');
    const second = new RestoreArtifactController({
      candidatePath: secondCandidate,
      reportPath: `${secondCandidate}.host-snapshot-v3-report.json`,
      runId: 'fedcbafedcbafedcbafedcbafedcbafe',
    });
    expect(path.basename(first.controller.probePathForTesting()))
      .not.toBe(path.basename(second.probePathForTesting()));
    expect(path.basename(first.controller.reportTemporaryPathForTesting()))
      .not.toBe(path.basename(second.reportTemporaryPathForTesting()));
  });

  it('probe reservation 删除重试耗尽返回稳定 cleanup 错误并保留 candidate', () => {
    const runId = '1234567890abcdef1234567890abcdef';
    const probeName = `.offerflow-host-v3-${runId}.rename-probe`;
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      unlink(filePath) {
        if (path.basename(filePath) === probeName) {
          const error = new Error('C:\\secret probe busy') as NodeJS.ErrnoException;
          error.code = 'EBUSY';
          throw error;
        }
        DEFAULT_RESTORE_ARTIFACT_IO.unlink(filePath);
      },
      wait() { /* deterministic test: no wall-clock sleep */ },
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-restore-artifacts-probe-delete-'));
    cleanupDirectories.push(directory);
    const candidatePath = path.join(directory, 'candidate.sqlite3');
    const controller = new RestoreArtifactController({
      candidatePath,
      reportPath: `${candidatePath}.host-snapshot-v3-report.json`,
      runId,
      io,
    });
    controller.preflight();
    controller.reserveCandidate();

    expect(() => controller.proveCandidateRenameable()).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_CLEANUP_FAILED',
    }));
    expect(fs.existsSync(candidatePath)).toBe(true);
    expect(JSON.stringify(controller.cleanupOwnedArtifacts())).not.toContain(directory);
  });

  it('report 临时文件独占创建、fsync 后以 no-replace 协议发布', () => {
    const value = fixture('report-publish');
    value.controller.preflight();
    value.controller.reserveCandidate();
    value.controller.publishReport('{"status":"candidate-ready"}\n');

    expect(fs.readFileSync(value.reportPath, 'utf8')).toBe('{"status":"candidate-ready"}\n');
    expect(fs.existsSync(value.controller.reportTemporaryPathForTesting())).toBe(false);
    expect(value.controller.isReportPublished()).toBe(true);
    expect(value.controller.ownedArtifacts()).toEqual([
      expect.objectContaining({ kind: 'candidate' }),
    ]);
  });

  it('report 临时文件碰撞不覆盖调用方文件', () => {
    const value = fixture('report-temp-collision');
    const temporaryPath = value.controller.reportTemporaryPathForTesting();
    value.controller.preflight({ includeRunArtifacts: false });
    value.controller.reserveCandidate();
    fs.writeFileSync(temporaryPath, 'caller-temp', { flag: 'wx' });
    const before = contentHash(temporaryPath);

    expect(() => value.controller.publishReport('new-report')).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_ARTIFACT_COLLISION',
    }));
    expect(contentHash(temporaryPath)).toBe(before);
    expect(fs.existsSync(value.reportPath)).toBe(false);
  });

  it('正式 report 在预检后竞态出现时不覆盖，失败只清理 owned 临时文件', () => {
    const value = fixture('report-final-collision');
    value.controller.preflight();
    value.controller.reserveCandidate();
    fs.writeFileSync(value.reportPath, 'late-caller-report', { flag: 'wx' });
    const before = contentHash(value.reportPath);

    expect(() => value.controller.publishReport('new-report')).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_REPORT_PUBLISH_FAILED',
    }));
    expect(contentHash(value.reportPath)).toBe(before);
    expect(fs.existsSync(value.controller.reportTemporaryPathForTesting())).toBe(true);
    const cleanup = value.controller.cleanupOwnedArtifacts();
    expect(cleanup.failures).toEqual([]);
    expect(contentHash(value.reportPath)).toBe(before);
    expect(fs.existsSync(value.controller.reportTemporaryPathForTesting())).toBe(false);
  });

  it.each(['write', 'flush', 'link'] as const)('report %s 失败返回稳定发布错误且可清理 owned 产物', (failure) => {
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      writeAll: failure === 'write'
        ? () => { throw new Error('C:\\secret write failed'); }
        : DEFAULT_RESTORE_ARTIFACT_IO.writeAll,
      flush: failure === 'flush'
        ? () => { throw new Error('C:\\secret flush failed'); }
        : DEFAULT_RESTORE_ARTIFACT_IO.flush,
      link: failure === 'link'
        ? () => { throw new Error('C:\\secret link failed'); }
        : DEFAULT_RESTORE_ARTIFACT_IO.link,
    };
    const value = fixture(`report-${failure}-failure`, io);
    value.controller.preflight();
    value.controller.reserveCandidate();

    expect(() => value.controller.publishReport('report-content')).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_REPORT_PUBLISH_FAILED',
    }));
    expect(value.controller.cleanupOwnedArtifacts().failures).toEqual([]);
    expect(fs.existsSync(value.candidatePath)).toBe(false);
    expect(fs.existsSync(value.reportPath)).toBe(false);
  });

  it('report close 失败阻止删除未确认关闭的临时文件并返回脱敏清理状态', () => {
    let closeCount = 0;
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      close(descriptor) {
        closeCount += 1;
        DEFAULT_RESTORE_ARTIFACT_IO.close(descriptor);
        if (closeCount === 2) throw new Error('C:\\secret close failed');
      },
    };
    const value = fixture('report-close-failure', io);
    value.controller.preflight();
    value.controller.reserveCandidate();

    expect(() => value.controller.publishReport('report-content')).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_REPORT_PUBLISH_FAILED',
    }));
    const cleanup = value.controller.cleanupOwnedArtifacts();
    expect(cleanup.failures).toContainEqual(expect.objectContaining({
      kind: 'report-temporary', reason: 'handle-close-unconfirmed',
    }));
    expect(JSON.stringify(cleanup)).not.toContain(value.directory);
  });

  it('发布后的正式 report 释放 ownership，后续失败清理不会删除', () => {
    const value = fixture('report-retained');
    value.controller.preflight();
    value.controller.reserveCandidate();
    value.controller.publishReport('retained-report');
    value.controller.retainCandidate();

    expect(value.controller.cleanupOwnedArtifacts().failures).toEqual([]);
    expect(fs.readFileSync(value.reportPath, 'utf8')).toBe('retained-report');
    expect(fs.existsSync(value.candidatePath)).toBe(true);
  });

  it('清理只遍历 owned，未知文件与调用方旧 sidecar 保持不变，重复清理幂等', () => {
    const value = fixture('cleanup-idempotent');
    const unknown = path.join(value.directory, 'unknown.sqlite3-wal');
    fs.writeFileSync(unknown, 'unknown-caller-file', { flag: 'wx' });
    const before = contentHash(unknown);
    value.controller.preflight();
    value.controller.reserveCandidate();

    expect(value.controller.cleanupOwnedArtifacts().failures).toEqual([]);
    expect(value.controller.cleanupOwnedArtifacts().failures).toEqual([]);
    expect(contentHash(unknown)).toBe(before);
    expect(fs.existsSync(value.candidatePath)).toBe(false);
  });

  it('Windows EBUSY/EPERM 删除按常量有限重试并可恢复', () => {
    let attempts = 0;
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      unlink(filePath) {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error('busy') as NodeJS.ErrnoException;
          error.code = attempts === 1 ? 'EBUSY' : 'EPERM';
          throw error;
        }
        DEFAULT_RESTORE_ARTIFACT_IO.unlink(filePath);
      },
      wait() { /* deterministic test: no wall-clock sleep */ },
    };
    const value = fixture('cleanup-retry-success', io);
    value.controller.preflight();
    value.controller.reserveCandidate();

    expect(value.controller.cleanupOwnedArtifacts().failures).toEqual([]);
    expect(attempts).toBe(3);
  });

  it('重试耗尽返回脱敏失败，不泄漏路径或底层错误正文', () => {
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      unlink() {
        const error = new Error('C:\\secret\\candidate.sqlite3 SQLITE_BUSY raw') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      },
      wait() { /* deterministic test: no wall-clock sleep */ },
    };
    const value = fixture('cleanup-retry-exhausted', io);
    value.controller.preflight();
    value.controller.reserveCandidate();

    const cleanup = value.controller.cleanupOwnedArtifacts();
    expect(cleanup.failures).toEqual([
      expect.objectContaining({ kind: 'candidate', reason: 'busy-retry-exhausted' }),
    ]);
    expect(JSON.stringify(cleanup)).not.toContain(value.directory);
    expect(JSON.stringify(cleanup)).not.toContain('SQLITE_BUSY');
  });

  it('多个 owned 产物清理失败分别保留类型和阶段，不扫描未知路径', () => {
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      unlink() {
        const error = new Error('raw sqlite failure') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
      wait() { /* deterministic test: no wall-clock sleep */ },
    };
    const value = fixture('cleanup-multiple', io);
    value.controller.preflight();
    value.controller.reserveCandidate();
    fs.writeFileSync(`${value.candidatePath}-journal`, 'owned-journal', { flag: 'wx' });
    fs.writeFileSync(`${value.candidatePath}-wal`, 'owned-wal', { flag: 'wx' });
    value.controller.recordSidecarsCreatedDuringOwnedCandidateOperation('test-sqlite-stage');

    const cleanup = value.controller.cleanupOwnedArtifacts();
    expect(cleanup.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'sqlite-journal', stage: 'test-sqlite-stage' }),
      expect.objectContaining({ kind: 'sqlite-wal', stage: 'test-sqlite-stage' }),
      expect.objectContaining({ kind: 'candidate', stage: 'candidate-reservation' }),
    ]));
    expect(cleanup.failures).toHaveLength(3);
  });

  it('sidecar 观察失败进入 cleanup 状态，不覆盖主流程错误或泄漏路径', () => {
    let rejectWalObservation = false;
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      lstat(filePath) {
        if (rejectWalObservation && filePath.endsWith('-wal')) throw new Error('C:\\secret WAL lstat failed');
        return DEFAULT_RESTORE_ARTIFACT_IO.lstat(filePath);
      },
    };
    const value = fixture('sidecar-observation-failure', io);
    value.controller.preflight();
    value.controller.reserveCandidate();
    rejectWalObservation = true;
    value.controller.recordSidecarsCreatedDuringOwnedCandidateOperation('test-observation');

    const cleanup = value.controller.cleanupOwnedArtifacts();
    expect(cleanup.failures).toContainEqual(expect.objectContaining({
      kind: 'sqlite-wal', stage: 'test-observation', reason: 'remove-failed',
    }));
    expect(JSON.stringify(cleanup)).not.toContain(value.directory);
  });
});
