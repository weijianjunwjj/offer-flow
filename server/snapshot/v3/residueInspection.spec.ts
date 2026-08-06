import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
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
  HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
  restoreHostSnapshotV3ToCandidate,
} from './restoreCandidate';

let root: string;
let working: string;
let workspace: string;
let snapshot: string;

function mkdir(name: string): string {
  const value = path.join(root, name);
  fs.mkdirSync(value);
  return value;
}

function candidateFixture(tag: string): { directory: string; candidate: string; report: string } {
  const directory = path.join(working, `target-${tag}`);
  fs.mkdirSync(directory);
  const candidate = path.join(directory, 'candidate.sqlite3');
  return { directory, candidate, report: `${candidate}.host-snapshot-v3-report.json` };
}

function restoreComplete(tag: string): { directory: string; candidate: string; report: string } {
  const value = candidateFixture(tag);
  restoreHostSnapshotV3ToCandidate({
    snapshotDirectory: snapshot,
    candidateDatabasePath: value.candidate,
    workingDirectory: working,
    workspaceDirectory: workspace,
    confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
  });
  return value;
}

function inspect(candidate: string) {
  return inspectRestoreResidue({ snapshotDirectory: snapshot, candidateDatabasePath: candidate });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-v3-residue-'));
  working = mkdir('working');
  workspace = mkdir('workspace');
  fs.mkdirSync(path.join(workspace, '.git'));
  const source = path.join(root, 'source.sqlite3');
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
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  expect(fs.existsSync(root)).toBe(false);
});

describe('Host Snapshot V3 read-only residue inspection', () => {
  it('classifies the required residue shapes without deleting or changing caller files', () => {
    const empty = candidateFixture('empty');
    expect(inspect(empty.candidate).classification).toBe('NO_RESIDUE');

    const onlyCandidate = candidateFixture('candidate');
    fs.writeFileSync(onlyCandidate.candidate, 'incomplete');
    expect(inspect(onlyCandidate.candidate)).toMatchObject({
      classification: 'CANDIDATE_WITHOUT_REPORT',
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_CANDIDATE_INCOMPLETE',
    });
    expect(fs.readFileSync(onlyCandidate.candidate, 'utf8')).toBe('incomplete');

    const onlyTemp = candidateFixture('temp');
    const tempPath = path.join(onlyTemp.directory, `.offerflow-host-v3-${'a'.repeat(32)}.report.tmp`);
    fs.writeFileSync(tempPath, 'partial');
    expect(inspect(onlyTemp.candidate).classification).toBe('REPORT_TEMP_WITHOUT_FINAL');
    expect(fs.readFileSync(tempPath, 'utf8')).toBe('partial');

    const candidateAndFinal = candidateFixture('candidate-final');
    fs.writeFileSync(candidateAndFinal.candidate, 'incomplete');
    fs.writeFileSync(candidateAndFinal.report, '{}');
    expect(inspect(candidateAndFinal.candidate)).toMatchObject({
      classification: 'CANDIDATE_AND_FINAL_REPORT_PRESENT',
      successRevalidation: 'rejected',
    });

    const finalAndTemp = candidateFixture('final-temp');
    fs.writeFileSync(finalAndTemp.report, '{}');
    fs.writeFileSync(
      path.join(finalAndTemp.directory, `.offerflow-host-v3-${'b'.repeat(32)}.report.tmp`),
      'partial',
    );
    expect(inspect(finalAndTemp.candidate).classification).toBe('FINAL_REPORT_WITH_TEMP_REMAINDER');

    const sidecar = candidateFixture('sidecar');
    fs.writeFileSync(sidecar.candidate, 'incomplete');
    fs.writeFileSync(`${sidecar.candidate}-journal`, 'unknown');
    expect(inspect(sidecar.candidate)).toMatchObject({
      classification: 'SQLITE_SIDECAR_PRESENT',
      errorCode: 'HOST_SNAPSHOT_V3_SQLITE_SIDECAR_AMBIGUOUS',
    });

    const unknown = candidateFixture('unknown');
    const unknownPath = path.join(unknown.directory, 'unowned.bin');
    fs.writeFileSync(unknownPath, 'caller-owned');
    const modifiedAt = fs.statSync(unknownPath).mtimeMs;
    expect(inspect(unknown.candidate)).toMatchObject({
      classification: 'AMBIGUOUS_OR_UNOWNED_RESIDUE',
      errorCode: 'HOST_SNAPSHOT_V3_RESIDUE_OWNERSHIP_UNPROVEN',
    });
    expect(fs.readFileSync(unknownPath, 'utf8')).toBe('caller-owned');
    expect(fs.statSync(unknownPath).mtimeMs).toBe(modifiedAt);
  });

  it('revalidates a complete candidate/report and emits no absolute path or data text', () => {
    const value = restoreComplete('verified');
    const candidateModifiedAt = fs.statSync(value.candidate).mtimeMs;
    const reportModifiedAt = fs.statSync(value.report).mtimeMs;
    const plan = inspect(value.candidate);
    expect(plan).toMatchObject({
      classification: 'CANDIDATE_AND_FINAL_REPORT_PRESENT',
      successRevalidation: 'verified',
    });
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(value.candidate);
    expect(serialized).not.toContain('CREATE TABLE');
    expect(fs.statSync(value.candidate).mtimeMs).toBe(candidateModifiedAt);
    expect(fs.statSync(value.report).mtimeMs).toBe(reportModifiedAt);
  });

  it('rejects report binding mismatch, corrupt report, and non-regular report', () => {
    const mismatch = restoreComplete('report-mismatch');
    const parsed = JSON.parse(fs.readFileSync(mismatch.report, 'utf8')) as Record<string, unknown>;
    parsed.hostManifestDigest = '0'.repeat(64);
    fs.writeFileSync(mismatch.report, JSON.stringify(parsed));
    expect(inspect(mismatch.candidate)).toMatchObject({
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_CANDIDATE_REPORT_BINDING_MISMATCH',
    });

    const corrupt = restoreComplete('report-corrupt');
    fs.writeFileSync(corrupt.report, '{');
    expect(inspect(corrupt.candidate)).toMatchObject({
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_REPORT_INCOMPLETE',
    });

    const nonRegular = candidateFixture('report-directory');
    fs.writeFileSync(nonRegular.candidate, 'incomplete');
    fs.mkdirSync(nonRegular.report);
    expect(inspect(nonRegular.candidate)).toMatchObject({
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_REPORT_INCOMPLETE',
    });
  });

  it('rejects OfferFlow and NovaWing component changes after a complete restore', () => {
    const offerFlow = restoreComplete('offerflow-tamper');
    const offerFlowDb = new Database(offerFlow.candidate);
    offerFlowDb.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)')
      .run('tamper-marker', 'changed', Date.now());
    offerFlowDb.close();
    expect(inspect(offerFlow.candidate)).toMatchObject({
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_CANDIDATE_INCOMPLETE',
    });

    const novaWing = restoreComplete('novawing-tamper');
    const novaWingDb = new DatabaseSync(novaWing.candidate);
    novaWingDb.prepare("UPDATE nw_meta SET updated_at = 'tampered' WHERE key = 'schema_version'").run();
    novaWingDb.close();
    expect(inspect(novaWing.candidate)).toMatchObject({
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_CANDIDATE_INCOMPLETE',
    });
  });
});
