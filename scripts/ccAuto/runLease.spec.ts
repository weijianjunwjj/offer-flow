/** runLease.spec.ts —— Run Lease 获取/释放/并发/stale/所有权测试 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireRunLease,
  releaseRunLease,
  readRunLease,
  updateHeartbeat,
  setWriter,
  getWriter,
  getWriterAssignment,
} from './runLease';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WriterAssignment } from './types';

const FIXTURE_CWD = path.join(__dirname, '..', '..', '.cc-auto-test-lease');
const FIXTURE_FP = 'a'.repeat(64);
const GPT_WRITER: WriterAssignment = {
  executionRole: 'FAST_EXECUTOR',
  profileId: 'gpt-writer-profile',
  providerIdentifier: 'openai',
};

function cleanLockFile() {
  try { rmSync(path.join(FIXTURE_CWD, '.cc-auto', 'run-lock.json'), { force: true }); } catch { /* ok */ }
}

describe('acquireRunLease', () => {
  beforeEach(() => {
    mkdirSync(path.join(FIXTURE_CWD, '.cc-auto'), { recursive: true });
    cleanLockFile();
  });

  afterEach(() => { cleanLockFile(); });

  it('acquires first lease successfully with wx flag', () => {
    const result = acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    expect(result.ok).toBe(true);
    expect(result.lease!.writer).toBe('none');
    expect(result.lease!.writerAssignment).toBeNull();
    expect(result.lease!.runId).toBe('run-1');
    expect(result.lease!.worktreeFingerprintAtStart).toBe(FIXTURE_FP);
  });

  it('rejects concurrent run while lease is held', () => {
    const first = acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    expect(first.ok).toBe(true);

    const second = acquireRunLease(FIXTURE_CWD, 'run-2', FIXTURE_FP);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('LOCK_HELD');
  });

  it('rejects lease with mismatched repositoryRoot', () => {
    const lockPath = path.join(FIXTURE_CWD, '.cc-auto', 'run-lock.json');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      runId: 'run-ghost', pid: 99999,
      repositoryRoot: '/some/other/path',
      acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      worktreeFingerprintAtStart: 'x'.repeat(64), writer: 'none',
    }, null, 2), 'utf8');

    const result = acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('仓库根目录不一致');
  });

  it('updates heartbeat with ownership check', () => {
    const result = acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    expect(result.ok).toBe(true);
    updateHeartbeat(FIXTURE_CWD, 'run-1');
    const lease = readRunLease(FIXTURE_CWD);
    expect(lease).toBeDefined();
  });

  it('does not update heartbeat for wrong runId', () => {
    acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    const before = readRunLease(FIXTURE_CWD)!.heartbeatAt;
    updateHeartbeat(FIXTURE_CWD, 'run-wrong');
    const after = readRunLease(FIXTURE_CWD)!.heartbeatAt;
    expect(after).toBe(before); // unchanged — ownership mismatch
  });

  it('releases lease with ownership check and allows new acquisition', () => {
    const first = acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    expect(first.ok).toBe(true);
    releaseRunLease(FIXTURE_CWD, 'run-1');

    const second = acquireRunLease(FIXTURE_CWD, 'run-2', FIXTURE_FP);
    expect(second.ok).toBe(true);
    expect(second.lease!.runId).toBe('run-2');
  });

  it('does not release lease for wrong runId (ownership mismatch)', () => {
    acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    releaseRunLease(FIXTURE_CWD, 'run-wrong');
    // Lock should still exist
    const stillThere = readRunLease(FIXTURE_CWD);
    expect(stillThere).toBeDefined();
    expect(stillThere!.runId).toBe('run-1');
  });

  it('returns STALE_LEASE for dead PID, not silent deletion', () => {
    const lockPath = path.join(FIXTURE_CWD, '.cc-auto', 'run-lock.json');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const expectedRoot = path.resolve(FIXTURE_CWD).replace(/\\/g, '/');
    writeFileSync(lockPath, JSON.stringify({
      runId: 'run-stale', pid: 99999,
      repositoryRoot: expectedRoot,
      acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      worktreeFingerprintAtStart: 'y'.repeat(64), writer: 'none',
    }, null, 2), 'utf8');

    const result = acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('STALE_LEASE');
    expect(result.staleLeaseInfo!.existingRunId).toBe('run-stale');
    // Verify file still exists (NOT silently deleted)
    expect(require('node:fs').existsSync(lockPath)).toBe(true);
  });

  it('sets writer to none on acquisition', () => {
    const result = acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    expect(result.ok).toBe(true);
    expect(result.lease!.writer).toBe('none');
  });

  it('sets and reads writer with ownership check', () => {
    acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    expect(setWriter(FIXTURE_CWD, 'run-1', GPT_WRITER)).toBe(true);
    expect(getWriter(FIXTURE_CWD)).toBe('assigned');
    expect(getWriterAssignment(FIXTURE_CWD)).toEqual(GPT_WRITER);
    expect(setWriter(FIXTURE_CWD, 'run-1', null)).toBe(true);
    expect(getWriter(FIXTURE_CWD)).toBe('none');
    expect(getWriterAssignment(FIXTURE_CWD)).toBeNull();
  });

  it('does not set writer for wrong runId', () => {
    acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    expect(setWriter(FIXTURE_CWD, 'run-wrong', GPT_WRITER)).toBe(false);
    expect(getWriter(FIXTURE_CWD)).toBe('none'); // unchanged
  });

  it('rejects a non-writer execution role', () => {
    acquireRunLease(FIXTURE_CWD, 'run-1', FIXTURE_FP);
    const invalid = {
      executionRole: 'ARBITER',
      profileId: 'arbiter-profile',
      providerIdentifier: 'provider-x',
    } as unknown as WriterAssignment;
    expect(setWriter(FIXTURE_CWD, 'run-1', invalid)).toBe(false);
    expect(getWriter(FIXTURE_CWD)).toBe('none');
  });

  it('normalizes legacy writer=deepseek in memory without rewriting the lease', () => {
    const lockPath = path.join(FIXTURE_CWD, '.cc-auto', 'run-lock.json');
    const legacyRaw = JSON.stringify({
      runId: 'run-legacy',
      pid: process.pid,
      repositoryRoot: path.resolve(FIXTURE_CWD).replace(/\\/g, '/'),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      worktreeFingerprintAtStart: FIXTURE_FP,
      writer: 'deepseek',
    }, null, 2);
    writeFileSync(lockPath, legacyRaw, 'utf8');

    expect(readRunLease(FIXTURE_CWD)).toMatchObject({
      writer: 'assigned',
      writerAssignment: {
        executionRole: 'WRITER',
        profileId: 'legacy-deepseek',
        providerIdentifier: 'deepseek',
      },
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(legacyRaw);
  });
});
