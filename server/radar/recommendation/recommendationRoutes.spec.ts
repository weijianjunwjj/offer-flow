import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { buildServer } from '../../index';
import { initSchema } from '../../schema';
import { RadarCaptureService } from '../service';
import { AnalysisRecordRepository } from '../analysisRecordRepository';
import { seedActiveResumeAndProfile } from '../analysis/analysisInputFixture';
import { validPayload } from '../analysis/contractFixtures';
import { JOB_MATCH_ANALYSIS_POLICY_VERSION, JOB_MATCH_ANALYSIS_PROMPT_VERSION } from '../analysis/analysisPrompt';
import type { JobMatchAnalysisRecord, JobMatchRecommendation } from '../../../src/domain/radar';

const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function headers(extra: Record<string, string> = {}) {
  return { [CAPTURE_CLIENT_HEADER]: 'test-extension', ...extra };
}

let seq = 0;
function captureDeps() {
  let s = 0;
  return { now: () => 1_700_000_000 + s, createId: () => `cap-${(seq += 1)}-${(s += 1)}` };
}

function setup(opts: { analysisEnabled?: boolean } = {}): { app: FastifyInstance; db: SqliteDatabase } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-rec-routes-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 8 });
  seedActiveResumeAndProfile(db, 1_700_000_000);
  let clock = 1_800_000_000;
  const app = buildServer({
    db,
    radar: {
      enabled: true,
      analysisEnabled: opts.analysisEnabled ?? true,
      serviceDeps: captureDeps(),
      recommendationDeps: { now: () => (clock += 1), createBatchId: () => `batch-${(seq += 1)}` },
    },
  });
  cleanups.push(() => { void app.close(); db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { app, db };
}

function seedCandidateWithRecord(db: SqliteDatabase, tag: string, rec: JobMatchRecommendation): string {
  const capture = new RadarCaptureService(db, captureDeps());
  const s = capture.createSession({ sourceType: 'browser' });
  capture.addItem(s.session.id, {
    captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
    sourceUrl: `https://www.zhipin.com/job_detail/${tag}.html`, sourceDomain: 'zhipin.com', pageTitle: null,
    visibleText: `岗位：后端 @ 公司${tag} 苏州`, externalRecordId: tag,
    recognizedFields: {
      company: `公司${tag}`, role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 35,
      salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科',
    },
    extractionMetadata: null, capturedAt: null,
  });
  const outcome = capture.commitSession(s.session.id, { confirmedIndexes: [0], corrections: [] }).outcomes[0]!;
  const record: JobMatchAnalysisRecord = {
    id: `rec-${tag}`, candidateId: outcome.candidateId!, candidateVersionId: outcome.candidateVersionId!,
    resumeVersionId: 'resume-ver-1', jobMatchProfileVersionId: 'jmp-ver-1', cityCode: 'suzhou',
    capabilityBaselineVersionId: null, marketPositionVersionId: null, strategyVersionId: null,
    ruleVersion: 'none', promptVersion: JOB_MATCH_ANALYSIS_PROMPT_VERSION,
    analysisPolicyVersion: JOB_MATCH_ANALYSIS_POLICY_VERSION, modelProvider: 'fake', modelName: 'fake-model',
    modelVersion: null, inputHash: `hash-${tag}`, recommendation: rec, confidence: 'high',
    payload: validPayload({ recommendation: rec, confidence: 'high' }), createdAt: 1_700_000_500, supersedesAnalysisId: null,
  };
  new AnalysisRecordRepository(db).insert(record);
  return outcome.candidateVersionId!;
}

async function post(app: FastifyInstance, url: string, body: unknown, extra: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: headers(extra), payload: body as object });
}
async function get(app: FastifyInstance, url: string) {
  return app.inject({ method: 'GET', url, headers: headers() });
}

describe('推荐批次 HTTP — 创建/查询/安全出参', () => {
  it('creates a batch (201) and returns a safe view without internal fields', async () => {
    const { app, db } = setup();
    const v = seedCandidateWithRecord(db, 'r1', 'apply_now');
    const res = await post(app, '/radar/recommendation-batches', { candidateVersionIds: [v] });
    expect(res.statusCode).toBe(201);
    const view = res.json() as Record<string, unknown>;
    expect(view.selectedCandidateVersionIds).toEqual([v]);
    expect(view).toHaveProperty('recommendationSet');
    // 严格白名单：绝不外泄 batchKey / handledStateHash / profileVersions。
    expect(view).not.toHaveProperty('batchKey');
    expect(view).not.toHaveProperty('handledStateHash');
    expect(view).not.toHaveProperty('profileVersions');
  });

  it('reuses the same batch on repeat request (200, same id)', async () => {
    const { app, db } = setup();
    const v = seedCandidateWithRecord(db, 'r2', 'apply_now');
    const first = await post(app, '/radar/recommendation-batches', { candidateVersionIds: [v] });
    const second = await post(app, '/radar/recommendation-batches', { candidateVersionIds: [v] });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
  });

  it('GET by id returns the batch; unknown id is 404', async () => {
    const { app, db } = setup();
    const v = seedCandidateWithRecord(db, 'r3', 'stretch');
    const created = await post(app, '/radar/recommendation-batches', { candidateVersionIds: [v] });
    const id = (created.json() as { id: string }).id;
    const got = await get(app, `/radar/recommendation-batches/${id}`);
    expect(got.statusCode).toBe(200);
    expect((got.json() as { id: string }).id).toBe(id);
    const missing = await get(app, '/radar/recommendation-batches/nope');
    expect(missing.statusCode).toBe(404);
  });

  it('GET list returns recent batches', async () => {
    const { app, db } = setup();
    const v = seedCandidateWithRecord(db, 'r4', 'apply_now');
    await post(app, '/radar/recommendation-batches', { candidateVersionIds: [v] });
    const list = await get(app, '/radar/recommendation-batches');
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid body (empty array) with 400', async () => {
    const { app } = setup();
    const res = await post(app, '/radar/recommendation-batches', { candidateVersionIds: [] });
    expect(res.statusCode).toBe(400);
  });

  it('is not registered when analysis gate is off (404)', async () => {
    const { app, db } = setup({ analysisEnabled: false });
    const v = seedCandidateWithRecord(db, 'r5', 'apply_now');
    const res = await post(app, '/radar/recommendation-batches', { candidateVersionIds: [v] });
    expect(res.statusCode).toBe(404);
  });

  it('requires the capture-client header (security gateway)', async () => {
    const { app, db } = setup();
    const v = seedCandidateWithRecord(db, 'r6', 'apply_now');
    const res = await app.inject({
      method: 'POST', url: '/radar/recommendation-batches', payload: { candidateVersionIds: [v] },
    });
    expect(res.statusCode).toBe(403);
  });
});
