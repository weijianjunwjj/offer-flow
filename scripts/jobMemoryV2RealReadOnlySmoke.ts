import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import {
  JobDetailBundleV2Schema,
  JobSummariesResponseSchema,
  ResumeVersionListResponseSchema,
} from '../src/domain/job-memory';
import { getDbPath } from '../server/db';
import { buildServer } from '../server/index';
import { verifyUpgradeBackup } from '../server/job-memory/upgrade/backup';
import {
  B7B_APPROVAL_TOKEN,
  B7B_APPROVED_BACKUP_ID,
  B7B_EXPECTED_BACKUP_HASH,
  B7B_EXPECTED_SOURCE_FINGERPRINT,
  getB7BStatePaths,
  readApplyResult,
  writeB7BPrivateJson,
} from '../server/job-memory/upgrade/realApply';
import { verifyRealUpgradeDatabase } from '../server/job-memory/upgrade/realVerification';
import { sha256Hex } from '../server/sync/hash';
import { getSyncPaths } from '../server/sync/paths';

export interface RealReadOnlySmokeReport {
  ok: true;
  gitCommit: string;
  summariesStatus: 200;
  summaryCount: 13;
  migratedBundleStatus: 200;
  skippedBundleStatus: 200;
  migratedBundleHasApplication: true;
  skippedBundleHasApplication: false;
  resumeVersionsStatus: 200;
  resumeVersionCount: 0;
  businessDataUnchanged: true;
  formalSnapshotUnchanged: true;
  portReleased: true;
}

async function jsonGet(baseUrl: string, url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${url}`);
  return { status: response.status, body: await response.json() as unknown };
}

function snapshotFingerprint(dbPath: string): string {
  const paths = getSyncPaths(dbPath);
  return sha256Hex(JSON.stringify([
    sha256Hex(fs.readFileSync(paths.snapshotPath)),
    sha256Hex(fs.readFileSync(paths.manifestPath)),
  ]));
}

export async function runRealReadOnlySmoke(
  workspaceDirectory = process.cwd(),
  backupDirectory = path.join(process.cwd(), 'backups', 'job-memory-v2'),
): Promise<RealReadOnlySmokeReport> {
  const databasePath = getDbPath();
  const authorization = {
    sourceDatabasePath: databasePath,
    backupDirectory,
    workspaceDirectory,
    backupId: B7B_APPROVED_BACKUP_ID,
    confirmBackupId: B7B_APPROVED_BACKUP_ID,
    expectedSourceFingerprint: B7B_EXPECTED_SOURCE_FINGERPRINT,
    expectedBackupHash: B7B_EXPECTED_BACKUP_HASH,
    approvalToken: B7B_APPROVAL_TOKEN,
  };
  const approved = await verifyUpgradeBackup(authorization);
  const apply = readApplyResult(backupDirectory);
  verifyRealUpgradeDatabase(databasePath, approved.manifest);
  const sourceHashBefore = sha256Hex(fs.readFileSync(databasePath));
  const snapshotBefore = snapshotFingerprint(databasePath);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const migrated = db.prepare(
    'SELECT job_id AS jobId FROM applications ORDER BY job_id LIMIT 1',
  ).get() as { jobId: string } | undefined;
  const skipped = db.prepare(`
    SELECT jobs.id AS jobId FROM jobs
    LEFT JOIN applications ON applications.job_id = jobs.id
    WHERE applications.id IS NULL
    ORDER BY jobs.id LIMIT 1
  `).get() as { jobId: string } | undefined;
  if (migrated === undefined || skipped === undefined) throw new Error('真实只读 smoke 缺少迁移/跳过样本');
  const app = buildServer({ db });
  let baseUrl = '';
  let portReleased = false;
  try {
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const summariesResponse = await jsonGet(baseUrl, '/jobs/summaries');
    const migratedResponse = await jsonGet(baseUrl, `/jobs/${encodeURIComponent(migrated.jobId)}/bundle`);
    const skippedResponse = await jsonGet(baseUrl, `/jobs/${encodeURIComponent(skipped.jobId)}/bundle`);
    const resumeResponse = await jsonGet(baseUrl, '/resume-versions');
    if (
      summariesResponse.status !== 200
      || migratedResponse.status !== 200
      || skippedResponse.status !== 200
      || resumeResponse.status !== 200
    ) throw new Error('真实只读 smoke HTTP 状态不是 2xx');
    const summaries = JobSummariesResponseSchema.parse(summariesResponse.body);
    const migratedBundle = JobDetailBundleV2Schema.parse(migratedResponse.body);
    const skippedBundle = JobDetailBundleV2Schema.parse(skippedResponse.body);
    const resumes = ResumeVersionListResponseSchema.parse(resumeResponse.body);
    if (
      summaries.length !== 13
      || migratedBundle.memory.applications.length === 0
      || skippedBundle.memory.applications.length !== 0
      || resumes.resumeVersions.length !== 0
      || resumes.activeResumeVersionId !== null
    ) throw new Error('真实只读 smoke 响应聚合不符合预期');
  } finally {
    await app.close();
    db.close();
    if (baseUrl !== '') {
      try {
        await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      } catch {
        portReleased = true;
      }
    }
  }
  const businessDataUnchanged = sha256Hex(fs.readFileSync(databasePath)) === sourceHashBefore;
  const formalSnapshotUnchanged = snapshotFingerprint(databasePath) === snapshotBefore;
  if (!businessDataUnchanged || !formalSnapshotUnchanged || !portReleased) {
    throw new Error('真实只读 smoke 检测到数据变化或端口未释放');
  }
  const report: RealReadOnlySmokeReport = {
    ok: true,
    gitCommit: apply.applyGitCommit,
    summariesStatus: 200,
    summaryCount: 13,
    migratedBundleStatus: 200,
    skippedBundleStatus: 200,
    migratedBundleHasApplication: true,
    skippedBundleHasApplication: false,
    resumeVersionsStatus: 200,
    resumeVersionCount: 0,
    businessDataUnchanged: true,
    formalSnapshotUnchanged: true,
    portReleased: true,
  };
  writeB7BPrivateJson(getB7BStatePaths(path.resolve(backupDirectory)).smoke, report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealReadOnlySmoke().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
