import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { RADAR_DOMAIN_SCHEMA_VERSION } from '../migrations';
import { initSchema } from '../schema';

const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

interface Harness {
  app: FastifyInstance;
  db: SqliteDatabase;
}

function createHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-api-'));
  const dbPath = path.join(tempDir, 'test.sqlite3');
  const db = openDb(dbPath);
  initSchema(db, { targetVersion: RADAR_DOMAIN_SCHEMA_VERSION });
  let counter = 0;
  let now = 1_000_000;
  const app = buildServer({
    db,
    radar: {
      enabled: true,
      serviceDeps: { now: () => (now += 1000), createId: () => `test-${(counter += 1)}` },
    },
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

function captureHeaders(extra: Record<string, string> = {}) {
  return { [CAPTURE_CLIENT_HEADER]: 'test-extension', ...extra };
}

describe('Radar capture routes (V8-2)', () => {
  it('rejects requests missing the capture-client header', async () => {
    const { app } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      payload: { sourceType: 'browser' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
  });

  it('rejects a disallowed Origin header even with the capture-client header present', async () => {
    const { app } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders({ origin: 'https://evil.example.com' }),
      payload: { sourceType: 'browser' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
  });

  it('rejects malformed create-session payloads with a 422 and fieldErrors', async () => {
    const { app } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'not_a_real_source_type' },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.fieldErrors).toBeDefined();
  });

  it('does not expose the removed JSON object/array input processor', async () => {
    const { app } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions/removed-input/json-items',
      headers: captureHeaders(),
      payload: { visibleText: '不应被处理' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects all deprecated manual-input source and capture methods on the shared extension protocol', async () => {
    const { app } = createHarness();
    for (const sourceType of ['pasted_text', 'shared_link_and_text', 'json']) {
      const response = await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType },
      });
      expect(response.statusCode).toBe(422);
    }

    const created = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    for (const captureMethod of ['pasted_text', 'shared_link_and_text', 'json_import']) {
      const response = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${created.session.id}/items`,
        headers: captureHeaders(),
        payload: {
          captureMethod,
          sourceUrl: 'https://deprecated.example/job',
          visibleText: '废弃入口不得写入',
        },
      });
      expect(response.statusCode).toBe(422);
    }
  });

  it('creates a session, adds an item, and returns it in the preview without writing to Candidate tables yet', async () => {
    const { app, db } = createHarness();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.session.status).toBe('preview');
    const sessionId = created.session.id as string;

    const addResponse = await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/items`,
      headers: captureHeaders(),
      payload: {
        captureMethod: 'boss_current_page',
        providerKey: 'boss',
        sourceUrl: 'https://www.zhipin.com/job_detail/abc123.html?utm=1',
        visibleText: '某公司招聘后端工程师，薪资20-30K',
        recognizedFields: {
          company: 'Acme', role: '后端工程师', city: '苏州',
          salaryMinK: 20, salaryMaxK: 30, salaryPeriod: 'month',
          experienceRequirement: null, educationRequirement: null,
        },
      },
    });
    expect(addResponse.statusCode).toBe(200);
    const added = addResponse.json();
    expect(added.items).toHaveLength(1);
    expect(added.items[0]).toMatchObject({ index: 0, sourceDomain: null });
    expect(added.items[0].normalizedSourceUrl).toBe('https://www.zhipin.com/job_detail/abc123.html?utm=1');

    const candidateCountRow = db.prepare('SELECT COUNT(*) AS n FROM radar_candidates').get() as { n: number };
    expect(candidateCountRow.n).toBe(0);
    const snapshotCountRow = db.prepare('SELECT COUNT(*) AS n FROM radar_capture_snapshots').get() as { n: number };
    expect(snapshotCountRow.n).toBe(0);
  });

  it('keeps the extension generic visible-text fallback available without writing formal Radar data before confirmation', async () => {
    const { app, db } = createHarness();
    const created = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    const sessionId = created.session.id as string;

    const addResponse = await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/items`,
      headers: captureHeaders(),
      payload: {
        captureMethod: 'generic_visible_text',
        sourceUrl: 'https://fixture.example/jobs/frontend?from=test',
        pageTitle: '普通招聘页面',
        visibleText: '前端工程师\n负责 Vue 与 TypeScript 项目交付',
        recognizedFields: null,
      },
    });

    expect(addResponse.statusCode).toBe(200);
    expect(addResponse.json().items[0]).toMatchObject({
      captureMethod: 'generic_visible_text',
      sourceUrl: 'https://fixture.example/jobs/frontend?from=test',
      pageTitle: '普通招聘页面',
      recognizedFields: null,
    });
    const previewResponse = await app.inject({
      method: 'GET',
      url: `/radar/capture-sessions/${sessionId}`,
      headers: captureHeaders(),
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json().items[0]).toMatchObject({
      captureMethod: 'generic_visible_text',
      visibleText: '前端工程师\n负责 Vue 与 TypeScript 项目交付',
      recognizedFields: null,
    });

    for (const table of [
      'radar_capture_snapshots', 'radar_source_records', 'radar_candidates',
      'radar_candidate_versions', 'radar_candidate_sources',
    ]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n).toBe(0);
    }
  });

  it('does not write anything if a session is cancelled instead of committed', async () => {
    const { app, db } = createHarness();
    const created = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    const sessionId = created.session.id as string;

    await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/items`,
      headers: captureHeaders(),
      payload: { captureMethod: 'generic_visible_text', visibleText: '某职位描述文本' },
    });

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/cancel`,
      headers: captureHeaders(),
      payload: {},
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json().status).toBe('cancelled');

    const commitAfterCancel = await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/commit`,
      headers: captureHeaders(),
      payload: { confirmedIndexes: [0] },
    });
    expect(commitAfterCancel.statusCode).toBe(409);
    expect(commitAfterCancel.json()).toMatchObject({ code: 'SESSION_NOT_DRAFTABLE' });

    const candidateCountRow = db.prepare('SELECT COUNT(*) AS n FROM radar_candidates').get() as { n: number };
    expect(candidateCountRow.n).toBe(0);
  });

  it('persists rich extractionMetadata (district/address/provenance) into raw_snapshot_json, not into the 8 fields (§四)', async () => {
    const { app, db } = createHarness();
    const created = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    const sessionId = created.session.id as string;

    const metadata = {
      kind: 'boss_extraction',
      layout: 'job_detail',
      district: '吴中区',
      address: '苏州吴中区苏州国际科技园',
      fields: {
        city: { value: '苏州', source: 'boss_dom', confidence: 'medium', qualityIssues: ['城市由地址解析得到，请人工确认'] },
        company: { value: '赞同科技', source: 'boss_dom', confidence: 'high', qualityIssues: [] },
      },
    };
    await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/items`,
      headers: captureHeaders(),
      payload: {
        captureMethod: 'boss_current_page',
        sourceUrl: 'https://www.zhipin.com/job_detail/rich1.html',
        visibleText: '岗位职责：负责前端开发',
        recognizedFields: { company: '赞同科技', role: 'web前端', city: '苏州', salaryMinK: 11, salaryMaxK: 16, salaryPeriod: 'month', experienceRequirement: null, educationRequirement: null },
        extractionMetadata: metadata,
      },
    });
    await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/commit`,
      headers: captureHeaders(),
      payload: { confirmedIndexes: [0] },
    });

    const snapshotRow = db.prepare('SELECT raw_snapshot_json FROM radar_capture_snapshots').get() as { raw_snapshot_json: string };
    const raw = JSON.parse(snapshotRow.raw_snapshot_json);
    expect(raw.extractionMetadata.district).toBe('吴中区');
    expect(raw.extractionMetadata.address).toBe('苏州吴中区苏州国际科技园');
    expect(raw.extractionMetadata.fields.city.source).toBe('boss_dom');
    expect(raw.extractionMetadata.fields.city.confidence).toBe('medium');
    expect(Array.isArray(raw.extractionMetadata.fields.city.qualityIssues)).toBe(true);

    // 结构化 normalized 字段绝不含 district/address（未扩大 normalized 契约）。
    const versionRow = db.prepare('SELECT normalized_json FROM radar_candidate_versions').get() as { normalized_json: string };
    const normalized = JSON.parse(versionRow.normalized_json);
    expect(normalized.city).toBe('苏州');
    expect(normalized.address).toBeUndefined();
    expect(normalized.district).toBeNull();
  });

  it('commits a confirmed item and writes Snapshot/SourceRecord/Candidate/Version in one transaction', async () => {
    const { app, db } = createHarness();
    const created = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    const sessionId = created.session.id as string;

    await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/items`,
      headers: captureHeaders(),
      payload: {
        captureMethod: 'boss_current_page',
        providerKey: 'boss',
        externalRecordId: 'abc123',
        sourceUrl: 'https://www.zhipin.com/job_detail/abc123.html',
        visibleText: '某公司招聘后端工程师',
        recognizedFields: { company: 'Acme', role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 30, salaryPeriod: 'month', experienceRequirement: null, educationRequirement: null },
      },
    });

    const commitResponse = await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/commit`,
      headers: captureHeaders(),
      payload: { confirmedIndexes: [0] },
    });
    expect(commitResponse.statusCode).toBe(200);
    const committed = commitResponse.json();
    expect(committed.session.status).toBe('committed');
    expect(committed.outcomes).toHaveLength(1);
    expect(committed.outcomes[0].kind).toBe('created');

    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_capture_snapshots').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_source_records').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_candidates').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_candidate_versions').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_candidate_sources').get() as { n: number }).n).toBe(1);

    const candidateRow = db.prepare('SELECT active_version_id, lifecycle_status FROM radar_candidates').get() as {
      active_version_id: string; lifecycle_status: string;
    };
    expect(candidateRow.lifecycle_status).toBe('active');
    expect(candidateRow.active_version_id).toBe(committed.outcomes[0].candidateVersionId);

    // 幂等：再次提交同一 externalRecordId 且内容不变的采集，不产生新 Candidate，也不产生新版本。
    const secondCreated = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    const secondSessionId = secondCreated.session.id as string;
    await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${secondSessionId}/items`,
      headers: captureHeaders(),
      payload: {
        captureMethod: 'boss_current_page',
        providerKey: 'boss',
        externalRecordId: 'abc123',
        sourceUrl: 'https://www.zhipin.com/job_detail/abc123.html',
        visibleText: '某公司招聘后端工程师',
        recognizedFields: { company: 'Acme', role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 30, salaryPeriod: 'month', experienceRequirement: null, educationRequirement: null },
      },
    });
    const secondCommit = (await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${secondSessionId}/commit`,
      headers: captureHeaders(),
      payload: { confirmedIndexes: [0] },
    })).json();
    expect(secondCommit.outcomes[0].kind).toBe('unchanged');
    expect(secondCommit.outcomes[0].candidateId).toBe(committed.outcomes[0].candidateId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_candidates').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_candidate_versions').get() as { n: number }).n).toBe(1);
  });

  it('creates a new version (not a new candidate) when a correction changes recognized fields before commit', async () => {
    const { app, db } = createHarness();
    const created = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    const sessionId = created.session.id as string;

    await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/items`,
      headers: captureHeaders(),
      payload: {
        captureMethod: 'generic_visible_text',
        visibleText: '某职位描述',
        recognizedFields: { company: 'Acme', role: null, city: null, salaryMinK: null, salaryMaxK: null, salaryPeriod: null, experienceRequirement: null, educationRequirement: null },
      },
    });

    const commitResponse = await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/commit`,
      headers: captureHeaders(),
      payload: {
        confirmedIndexes: [0],
        corrections: [{
          index: 0,
          recognizedFields: { company: 'Acme', role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 30, salaryPeriod: 'month', experienceRequirement: null, educationRequirement: null },
          correctionNote: '补充了职位名称和城市',
        }],
      },
    });
    expect(commitResponse.statusCode).toBe(200);
    const version = db.prepare('SELECT normalized_json, correction_note FROM radar_candidate_versions').get() as {
      normalized_json: string; correction_note: string | null;
    };
    expect(JSON.parse(version.normalized_json).role).toBe('后端工程师');
  });

  it('returns 404 for an unknown session id and 404 for an unknown item index on commit', async () => {
    const { app } = createHarness();
    const missing = await app.inject({
      method: 'GET',
      url: '/radar/capture-sessions/does-not-exist',
      headers: captureHeaders(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' });

    const created = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    const sessionId = created.session.id as string;
    const badCommit = await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/commit`,
      headers: captureHeaders(),
      payload: { confirmedIndexes: [0] },
    });
    expect(badCommit.statusCode).toBe(404);
    expect(badCommit.json()).toMatchObject({ code: 'ITEM_NOT_FOUND' });
  });

  it('rejects adding more than the per-session item cap', async () => {
    const { app } = createHarness();
    const created = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    const sessionId = created.session.id as string;

    for (let i = 0; i < 8; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/items`,
        headers: captureHeaders(),
        payload: { captureMethod: 'generic_visible_text', visibleText: `文本 ${i}` },
      });
      expect(response.statusCode).toBe(200);
    }
    const overflow = await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/items`,
      headers: captureHeaders(),
      payload: { captureMethod: 'generic_visible_text', visibleText: '第九条' },
    });
    expect(overflow.statusCode).toBe(422);
    expect(overflow.json()).toMatchObject({ code: 'TOO_MANY_ITEMS' });
  });

  it('rejects a commit after the session has expired', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-api-expiry-'));
    const dbPath = path.join(tempDir, 'test.sqlite3');
    const db = openDb(dbPath);
    initSchema(db, { targetVersion: RADAR_DOMAIN_SCHEMA_VERSION });
    let now = 0;
    const app = buildServer({
      db,
      radar: { enabled: true, serviceDeps: { now: () => now, createId: () => `expiry-${now}` } },
    });
    cleanups.push(async () => {
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    now = 1000;
    const created = (await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: captureHeaders(),
      payload: { sourceType: 'browser' },
    })).json();
    const sessionId = created.session.id as string;

    now = 1000 + 30 * 60 * 1000 + 1;
    const commitResponse = await app.inject({
      method: 'POST',
      url: `/radar/capture-sessions/${sessionId}/commit`,
      headers: captureHeaders(),
      payload: { confirmedIndexes: [0] },
    });
    expect(commitResponse.statusCode).toBe(409);
    expect(commitResponse.json()).toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  describe('capability lifecycle and idempotency (RC-03 scope)', () => {
    it('does not create a Candidate when a session is never confirmed (no items added, no commit)', async () => {
      const { app, db } = createHarness();
      await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType: 'browser' },
      });
      expect((db.prepare('SELECT COUNT(*) AS n FROM radar_candidates').get() as { n: number }).n).toBe(0);
    });

    it('rejects adding items after commit, but replays an identical re-commit idempotently', async () => {
      const { app, db } = createHarness();
      const created = (await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType: 'browser' },
      })).json();
      const sessionId = created.session.id as string;
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/items`,
        headers: captureHeaders(),
        payload: { captureMethod: 'generic_visible_text', visibleText: '某职位描述' },
      });
      const firstCommit = (await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/commit`,
        headers: captureHeaders(),
        payload: { confirmedIndexes: [0] },
      })).json();

      // §一.4：commit 后继续 add item 必须拒绝。
      const addAfterCommit = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/items`,
        headers: captureHeaders(),
        payload: { captureMethod: 'generic_visible_text', visibleText: '再加一条' },
      });
      expect(addAfterCommit.statusCode).toBe(409);
      expect(addAfterCommit.json()).toMatchObject({ code: 'SESSION_NOT_DRAFTABLE' });

      const candidatesAfterFirst = (db.prepare('SELECT COUNT(*) AS n FROM radar_candidates').get() as { n: number }).n;
      const versionsAfterFirst = (db.prepare('SELECT COUNT(*) AS n FROM radar_candidate_versions').get() as { n: number }).n;
      const snapshotsAfterFirst = (db.prepare('SELECT COUNT(*) AS n FROM radar_capture_snapshots').get() as { n: number }).n;

      // §一.2：完全相同的重复 commit 重放首次结果、相同 ID、零新增行。
      const replay = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/commit`,
        headers: captureHeaders(),
        payload: { confirmedIndexes: [0] },
      });
      expect(replay.statusCode).toBe(200);
      const replayBody = replay.json();
      expect(replayBody.session.status).toBe('committed');
      expect(replayBody.outcomes).toHaveLength(1);
      expect(replayBody.outcomes[0].candidateId).toBe(firstCommit.outcomes[0].candidateId);
      expect(replayBody.outcomes[0].candidateVersionId).toBe(firstCommit.outcomes[0].candidateVersionId);
      expect(replayBody.outcomes[0].snapshotId).toBe(firstCommit.outcomes[0].snapshotId);
      expect((db.prepare('SELECT COUNT(*) AS n FROM radar_candidates').get() as { n: number }).n).toBe(candidatesAfterFirst);
      expect((db.prepare('SELECT COUNT(*) AS n FROM radar_candidate_versions').get() as { n: number }).n).toBe(versionsAfterFirst);
      expect((db.prepare('SELECT COUNT(*) AS n FROM radar_capture_snapshots').get() as { n: number }).n).toBe(snapshotsAfterFirst);
    });

    it('rejects a re-commit with a different payload after the session is committed (§一.3)', async () => {
      const { app, db } = createHarness();
      const created = (await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType: 'browser' },
      })).json();
      const sessionId = created.session.id as string;
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/items`,
        headers: captureHeaders(),
        payload: { captureMethod: 'generic_visible_text', visibleText: '某职位描述' },
      });
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/items`,
        headers: captureHeaders(),
        payload: { captureMethod: 'generic_visible_text', visibleText: '第二条职位描述' },
      });
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/commit`,
        headers: captureHeaders(),
        payload: { confirmedIndexes: [0] },
      });

      const differentCommit = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/commit`,
        headers: captureHeaders(),
        payload: { confirmedIndexes: [0, 1] },
      });
      expect(differentCommit.statusCode).toBe(409);
      expect(differentCommit.json()).toMatchObject({ code: 'COMMIT_CONFLICT' });
      // 拒绝路径不得写入第二条候选。
      expect((db.prepare('SELECT COUNT(*) AS n FROM radar_candidates').get() as { n: number }).n).toBe(1);
    });

    it('rejects committing after cancel (§一.5/6)', async () => {
      const { app } = createHarness();
      const created = (await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType: 'browser' },
      })).json();
      const sessionId = created.session.id as string;
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/items`,
        headers: captureHeaders(),
        payload: { captureMethod: 'generic_visible_text', visibleText: '某职位描述' },
      });
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/cancel`,
        headers: captureHeaders(),
        payload: {},
      });
      const commitAfterCancel = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/commit`,
        headers: captureHeaders(),
        payload: { confirmedIndexes: [0] },
      });
      expect(commitAfterCancel.statusCode).toBe(409);
      expect(commitAfterCancel.json()).toMatchObject({ code: 'SESSION_NOT_DRAFTABLE' });
    });

    it('does not echo the full session id in a committed-conflict error body (§一.8)', async () => {
      const { app } = createHarness();
      const created = (await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType: 'browser' },
      })).json();
      const sessionId = created.session.id as string;
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/items`,
        headers: captureHeaders(),
        payload: { captureMethod: 'generic_visible_text', visibleText: '某职位描述' },
      });
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/commit`,
        headers: captureHeaders(),
        payload: { confirmedIndexes: [0] },
      });
      const conflict = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/commit`,
        headers: captureHeaders(),
        payload: { confirmedIndexes: [1] },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: 'COMMIT_CONFLICT' });
      expect(JSON.stringify(conflict.json())).not.toContain(sessionId);
    });

    it('invalidates the session capability after cancel (cannot add items after cancel)', async () => {
      const { app } = createHarness();
      const created = (await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType: 'browser' },
      })).json();
      const sessionId = created.session.id as string;
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/cancel`,
        headers: captureHeaders(),
        payload: {},
      });
      const addAfterCancel = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/items`,
        headers: captureHeaders(),
        payload: { captureMethod: 'generic_visible_text', visibleText: '取消后再加一条' },
      });
      expect(addAfterCancel.statusCode).toBe(409);
      expect(addAfterCancel.json()).toMatchObject({ code: 'SESSION_NOT_DRAFTABLE' });
    });

    it('invalidates the session capability after TTL expiry (cannot add items once expired)', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-api-ttl-'));
      const dbPath = path.join(tempDir, 'test.sqlite3');
      const db = openDb(dbPath);
      initSchema(db, { targetVersion: RADAR_DOMAIN_SCHEMA_VERSION });
      let now = 0;
      const app = buildServer({
        db,
        radar: { enabled: true, serviceDeps: { now: () => now, createId: () => `ttl-${now}` } },
      });
      cleanups.push(async () => {
        await app.close();
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
      });

      now = 1000;
      const created = (await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType: 'browser' },
      })).json();
      const sessionId = created.session.id as string;

      now = 1000 + 30 * 60 * 1000 + 1;
      const addAfterExpiry = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/items`,
        headers: captureHeaders(),
        payload: { captureMethod: 'generic_visible_text', visibleText: '过期后再加一条' },
      });
      expect(addAfterExpiry.statusCode).toBe(409);
      expect(addAfterExpiry.json()).toMatchObject({ code: 'SESSION_EXPIRED' });
    });
  });

  describe('security negatives (T-02/T-06)', () => {
    it('rejects a non-loopback remoteAddress even with valid headers', async () => {
      const { app } = createHarness();
      const response = await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType: 'browser' },
        remoteAddress: '203.0.113.5',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    });

    it('rejects an extension-style Origin without the capture-client header', async () => {
      const { app } = createHarness();
      const response = await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: { origin: 'chrome-extension://abcdefghijklmnop' },
        payload: { sourceType: 'browser' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    });

    it('rejects a guessed/invalid session id as if it were a forged capability, not silently succeeding', async () => {
      const { app } = createHarness();
      const response = await app.inject({
        method: 'GET',
        url: '/radar/capture-sessions/guessed-session-id-0000',
        headers: captureHeaders(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' });
      expect(JSON.stringify(response.json())).not.toContain('guessed-session-id-0000');
    });

    it('never echoes the full capability/session id back in error bodies', async () => {
      const { app } = createHarness();
      const created = (await app.inject({
        method: 'POST',
        url: '/radar/capture-sessions',
        headers: captureHeaders(),
        payload: { sourceType: 'browser' },
      })).json();
      const sessionId = created.session.id as string;
      await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/cancel`,
        headers: captureHeaders(),
        payload: {},
      });
      const commitAfterCancel = await app.inject({
        method: 'POST',
        url: `/radar/capture-sessions/${sessionId}/commit`,
        headers: captureHeaders(),
        payload: { confirmedIndexes: [0] },
      });
      expect(JSON.stringify(commitAfterCancel.json())).not.toContain(sessionId);
    });

    it('does not allow an arbitrary Origin through the global CORS headers for a normal existing API', async () => {
      const { app } = createHarness();
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://evil.example.com' },
      });
      expect(response.statusCode).toBe(200);
      // 全局 CORS 回显请求 Origin 属既有行为（非本轮引入）；Radar 自身的 Origin 白名单
      // 由 assertCaptureRequestAllowed 独立强制，不依赖这个全局头。
      expect(response.headers['access-control-allow-origin']).toBe('https://evil.example.com');
    });

    it('leaves ordinary existing APIs reachable without the radar capture-client header', async () => {
      const { app } = createHarness();
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });
    });
  });
});
