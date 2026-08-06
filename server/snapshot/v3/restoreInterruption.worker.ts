/**
 * Test-only child process for abrupt-termination coverage. This is not
 * imported by the formal CLI and exposes no production argument surface.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {
  HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
  restoreHostSnapshotV3ToCandidate,
} from './restoreCandidate';
import type { RestoreCandidatePhase } from './restorePhases';
import { HostSnapshotV3Error } from './errors';

interface WorkerConfig {
  mode: 'interrupt' | 'retry';
  snapshotDirectory: string;
  candidateDatabasePath: string;
  workingDirectory: string;
  workspaceDirectory: string;
  targetPhase?: RestoreCandidatePhase;
  runId: string;
}

function emit(value: unknown): void {
  fs.writeSync(1, `${JSON.stringify(value)}\n`);
}

function disableNetwork(): void {
  const blocked = () => {
    throw new Error('TEST_NETWORK_ACCESS_BLOCKED');
  };
  globalThis.fetch = blocked as typeof globalThis.fetch;
  http.request = blocked as typeof http.request;
  http.get = blocked as typeof http.get;
  https.request = blocked as typeof https.request;
  https.get = blocked as typeof https.get;
}

function safeError(error: unknown): { code: string; message: string } {
  return error instanceof HostSnapshotV3Error
    ? { code: error.code, message: error.message }
    : { code: 'HOST_SNAPSHOT_V3_RESTORE_FAILED', message: '测试子进程恢复失败' };
}

const raw = process.argv[2];
if (!raw) {
  emit({ type: 'worker-error', code: 'HOST_SNAPSHOT_V3_INTERRUPTION_HARNESS_SYNC_FAILED' });
  process.exitCode = 2;
} else {
  const config = JSON.parse(raw) as WorkerConfig;
  disableNetwork();
  try {
    const result = restoreHostSnapshotV3ToCandidate({
      snapshotDirectory: config.snapshotDirectory,
      candidateDatabasePath: config.candidateDatabasePath,
      workingDirectory: config.workingDirectory,
      workspaceDirectory: config.workspaceDirectory,
      confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
      hooks: {
        runId: config.runId,
        onPhase: config.mode === 'interrupt'
          ? (phase) => {
            if (phase !== config.targetPhase) return;
            emit({ type: 'phase-reached', phase, networkAccess: false });
            // The parent terminates this process after receiving the exact phase.
            const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
            Atomics.wait(gate, 0, 0);
          }
          : undefined,
      },
    });
    emit({ type: config.mode === 'retry' ? 'retry-success' : 'unexpected-success', status: result.status });
    if (config.mode === 'interrupt') process.exitCode = 3;
  } catch (error) {
    emit({ type: config.mode === 'retry' ? 'retry-error' : 'worker-error', ...safeError(error) });
    if (config.mode === 'interrupt') process.exitCode = 2;
  }
}
