import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../../db';
import { LATEST_SCHEMA_VERSION } from '../../migrations';
import { initSchema } from '../../schema';
import {
  NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
  bootstrapNovaWingOffline,
} from './bootstrap';
import {
  HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION,
  exportHostSnapshotV3,
} from './hostSnapshot';
import { inspectRestoreResidue } from './residueInspection';
import {
  RESTORE_CANDIDATE_PHASE_MODEL,
  type RestoreCandidatePhase,
} from './restorePhases';
import {
  HOST_SNAPSHOT_V3_DATA_FILE,
  HOST_SNAPSHOT_V3_MANIFEST_FILE,
} from './types';

const INTERRUPT_PHASES = [
  'CANDIDATE_RESERVED',
  'OFFERFLOW_SCHEMA_BOOTSTRAPPED',
  'NOVAWING_SCHEMA_BOOTSTRAPPED',
  'OFFERFLOW_DATA_RESTORED',
  'NOVAWING_DATA_RESTORED',
  'HOST_VERIFICATION_PENDING',
  'RUNTIME_VALIDATED',
  'RENAME_PROBE_CANDIDATE_MOVED',
  'REPORT_TEMP_CREATED',
  'REPORT_TEMP_WRITTEN',
  'REPORT_TEMP_FSYNCED',
  'REPORT_FINAL_PUBLISHED',
  'RESULT_REVALIDATED',
] as const satisfies readonly RestoreCandidatePhase[];

const EXPECTED_CLASSIFICATION: Record<(typeof INTERRUPT_PHASES)[number], string> = {
  CANDIDATE_RESERVED: 'CANDIDATE_WITHOUT_REPORT',
  OFFERFLOW_SCHEMA_BOOTSTRAPPED: 'CANDIDATE_WITHOUT_REPORT',
  NOVAWING_SCHEMA_BOOTSTRAPPED: 'CANDIDATE_WITHOUT_REPORT',
  OFFERFLOW_DATA_RESTORED: 'CANDIDATE_WITHOUT_REPORT',
  NOVAWING_DATA_RESTORED: 'CANDIDATE_WITHOUT_REPORT',
  HOST_VERIFICATION_PENDING: 'CANDIDATE_WITHOUT_REPORT',
  RUNTIME_VALIDATED: 'CANDIDATE_WITHOUT_REPORT',
  RENAME_PROBE_CANDIDATE_MOVED: 'AMBIGUOUS_OR_UNOWNED_RESIDUE',
  REPORT_TEMP_CREATED: 'REPORT_TEMP_WITHOUT_FINAL',
  REPORT_TEMP_WRITTEN: 'REPORT_TEMP_WITHOUT_FINAL',
  REPORT_TEMP_FSYNCED: 'REPORT_TEMP_WITHOUT_FINAL',
  REPORT_FINAL_PUBLISHED: 'FINAL_REPORT_WITH_TEMP_REMAINDER',
  RESULT_REVALIDATED: 'CANDIDATE_AND_FINAL_REPORT_PRESENT',
};

interface WorkerConfig {
  mode: 'interrupt' | 'retry';
  snapshotDirectory: string;
  candidateDatabasePath: string;
  workingDirectory: string;
  workspaceDirectory: string;
  targetPhase?: RestoreCandidatePhase;
  runId: string;
}

interface KilledResult {
  message: { type: string; phase: RestoreCandidatePhase; networkAccess: boolean };
  exitObserved: boolean;
  killAccepted: boolean;
}

let root: string;
let working: string;
let workspace: string;
let source: string;
let snapshot: string;
let callerFile: string;
let sourceHash: string;
let dataHash: string;
let manifestHash: string;
let callerHash: string;

const repositoryRoot = process.cwd();
const workerPath = path.join(repositoryRoot, 'server', 'snapshot', 'v3', 'restoreInterruption.worker.ts');
const tsxImport = pathToFileURL(path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const liveChildren = new Set<ChildProcess>();

function mkdir(parent: string, name: string): string {
  const value = path.join(parent, name);
  fs.mkdirSync(value);
  return value;
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function targetHashes(directory: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => {
    const target = path.join(directory, name);
    const stats = fs.lstatSync(target);
    return [name, stats.isFile() ? hashFile(target) : `non-file:${stats.mode}`];
  }));
}

function workerArgs(config: WorkerConfig): string[] {
  return ['--import', tsxImport, workerPath, JSON.stringify(config)];
}

function killAtPhase(config: WorkerConfig): Promise<KilledResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, workerArgs(config), {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        OFFERFLOW_DB_PATH: '',
        OFFERFLOW_NOVA_WING_ANALYSIS_CONTEXT: 'false',
      },
    });
    liveChildren.add(child);
    let buffer = '';
    let targetMessage: KilledResult['message'] | undefined;
    let killAccepted = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('HOST_SNAPSHOT_V3_INTERRUPTION_HARNESS_SYNC_FAILED'));
    }, 30_000);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as KilledResult['message'];
        if (message.type !== 'phase-reached') {
          clearTimeout(timeout);
          child.kill('SIGKILL');
          reject(new Error('HOST_SNAPSHOT_V3_INTERRUPTION_HARNESS_SYNC_FAILED'));
          return;
        }
        targetMessage = message;
        killAccepted = child.kill('SIGKILL');
      }
    });
    child.once('error', () => {
      clearTimeout(timeout);
      liveChildren.delete(child);
      reject(new Error('HOST_SNAPSHOT_V3_INTERRUPTION_HARNESS_SYNC_FAILED'));
    });
    child.once('close', () => {
      clearTimeout(timeout);
      liveChildren.delete(child);
      if (!targetMessage) {
        reject(new Error('HOST_SNAPSHOT_V3_INTERRUPTION_HARNESS_SYNC_FAILED'));
        return;
      }
      resolve({ message: targetMessage, exitObserved: true, killAccepted });
    });
  });
}

function retryInIndependentProcess(config: WorkerConfig): { type: string; code?: string; message?: string } {
  const result = spawnSync(process.execPath, workerArgs(config), {
    cwd: root,
    shell: false,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      OFFERFLOW_DB_PATH: '',
      OFFERFLOW_NOVA_WING_ANALYSIS_CONTEXT: 'false',
    },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('HOST_SNAPSHOT_V3_INTERRUPTION_HARNESS_SYNC_FAILED');
  }
  const line = result.stdout.trim().split(/\r?\n/u).at(-1);
  if (!line) throw new Error('HOST_SNAPSHOT_V3_INTERRUPTION_HARNESS_SYNC_FAILED');
  return JSON.parse(line) as { type: string; code?: string; message?: string };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-v3-interruption-'));
  working = mkdir(root, 'working');
  workspace = mkdir(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.git'));
  source = path.join(root, 'source.sqlite3');
  const db = openDb(source);
  try {
    initSchema(db, { targetVersion: LATEST_SCHEMA_VERSION });
  } finally {
    db.close();
  }
  bootstrapNovaWingOffline({
    databasePath: source,
    confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
  });
  snapshot = path.join(working, 'snapshot');
  exportHostSnapshotV3({
    databasePath: source,
    outputDirectory: snapshot,
    workingDirectory: working,
    workspaceDirectory: workspace,
    confirmation: HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION,
  });
  callerFile = path.join(root, 'caller-owned.txt');
  fs.writeFileSync(callerFile, 'caller-owned-content');
  sourceHash = hashFile(source);
  dataHash = hashFile(path.join(snapshot, HOST_SNAPSHOT_V3_DATA_FILE));
  manifestHash = hashFile(path.join(snapshot, HOST_SNAPSHOT_V3_MANIFEST_FILE));
  callerHash = hashFile(callerFile);
});

afterAll(async () => {
  for (const child of liveChildren) child.kill('SIGKILL');
  await Promise.all([...liveChildren].map((child) => new Promise<void>((resolve) => child.once('close', () => resolve()))));
  expect(liveChildren.size).toBe(0);
  fs.rmSync(root, { recursive: true, force: true });
  expect(fs.existsSync(root)).toBe(false);
});

describe('Host Snapshot V3 process interruption matrix', () => {
  it('publishes a unique phase model with explicit durable-state fields', () => {
    expect(new Set(RESTORE_CANDIDATE_PHASE_MODEL.map((entry) => entry.phase)).size)
      .toBe(RESTORE_CANDIDATE_PHASE_MODEL.length);
    expect(RESTORE_CANDIDATE_PHASE_MODEL).toEqual(expect.arrayContaining(
      INTERRUPT_PHASES.map((phase) => expect.objectContaining({
        phase,
        sourceMutationPossible: false,
        safeAfterAbruptTermination: true,
      })),
    ));
    for (const entry of RESTORE_CANDIDATE_PHASE_MODEL) {
      expect(entry).toEqual(expect.objectContaining({
        durableArtifacts: expect.any(Array),
        openHandles: expect.any(Array),
        expectedResidue: expect.any(String),
        nextRunBehavior: expect.any(String),
      }));
    }
  });

  it.each(INTERRUPT_PHASES)('force-terminates after %s and fails closed on the next run', async (phase) => {
    const index = INTERRUPT_PHASES.indexOf(phase);
    const targetDirectory = mkdir(working, `target-${String(index + 1).padStart(2, '0')}`);
    const candidate = path.join(targetDirectory, 'candidate.sqlite3');
    const config: WorkerConfig = {
      mode: 'interrupt',
      snapshotDirectory: snapshot,
      candidateDatabasePath: candidate,
      workingDirectory: working,
      workspaceDirectory: workspace,
      targetPhase: phase,
      runId: (index + 1).toString(16).padStart(32, '0'),
    };

    const killed = await killAtPhase(config);
    expect(killed).toMatchObject({
      message: { type: 'phase-reached', phase, networkAccess: false },
      exitObserved: true,
      killAccepted: true,
    });
    expect(liveChildren.size).toBe(0);
    expect(hashFile(source)).toBe(sourceHash);
    expect(hashFile(path.join(snapshot, HOST_SNAPSHOT_V3_DATA_FILE))).toBe(dataHash);
    expect(hashFile(path.join(snapshot, HOST_SNAPSHOT_V3_MANIFEST_FILE))).toBe(manifestHash);
    expect(hashFile(callerFile)).toBe(callerHash);
    expect(fs.readdirSync(targetDirectory).some((name) => /-(?:journal|wal|shm)$/u.test(name))).toBe(false);

    const inspection = inspectRestoreResidue({
      snapshotDirectory: snapshot,
      candidateDatabasePath: candidate,
    });
    expect(inspection.classification).toBe(EXPECTED_CLASSIFICATION[phase]);
    expect(inspection.successRevalidation).toBe(phase === 'RESULT_REVALIDATED' ? 'verified' : 'rejected');
    expect(JSON.stringify(inspection)).not.toContain(root);

    const beforeRetry = targetHashes(targetDirectory);
    const retry = retryInIndependentProcess({
      ...config,
      mode: 'retry',
      targetPhase: undefined,
      runId: 'f'.repeat(32),
    });
    expect(retry.type).toBe('retry-error');
    expect([
      'HOST_SNAPSHOT_V3_OUTPUT_ALREADY_EXISTS',
      'HOST_SNAPSHOT_V3_ARTIFACT_COLLISION',
      'HOST_SNAPSHOT_V3_INTERRUPTED_RESIDUE_COLLISION',
    ]).toContain(retry.code);
    expect(JSON.stringify(retry)).not.toContain(root);
    expect(targetHashes(targetDirectory)).toEqual(beforeRetry);
    expect(hashFile(source)).toBe(sourceHash);
    expect(hashFile(path.join(snapshot, HOST_SNAPSHOT_V3_DATA_FILE))).toBe(dataHash);
    expect(hashFile(path.join(snapshot, HOST_SNAPSHOT_V3_MANIFEST_FILE))).toBe(manifestHash);
    expect(hashFile(callerFile)).toBe(callerHash);
  }, 60_000);
});
