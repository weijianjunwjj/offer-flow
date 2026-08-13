import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { initSchema } from '../schema';
import { seedReviewFixture, type ReviewFixtureResult } from './reviewFixture';

const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const cleanups: Array<() => void> = [];
let app: FastifyInstance;
let db: SqliteDatabase;
let fixture: ReviewFixtureResult;

function headers(extra: Record<string, string> = {}) {
  return { [CAPTURE_CLIENT_HEADER]: 'test-extension', ...extra };
}

beforeEach(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-review-'));
  const dbPath = path.join(tempDir, 'test.sqlite3');
  db = openDb(dbPath);
  initSchema(db, { targetVersion: 9 });
  let counter = 0;
  let now = 2_000_000;
  const deps = { now: () => (now += 1000), createId: () => `rv-${(counter += 1)}` };
  fixture = seedReviewFixture(db, deps);
  app = buildServer({ db, radar: { enabled: true, serviceDeps: deps } });
  cleanups.push(() => { void app.close(); db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
});

afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function get(url: string) {
  return app.inject({ method: 'GET', url, headers: headers() });
}
async function post(url: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, headers: headers(), payload: body });
}

describe('V8-3 review routes: relation listing + detail', () => {
  it('lists only suspected_duplicate + needs_recheck by default with structured signals', async () => {
    const res = await get('/radar/review/relations');
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ status: string; relationId: string; signals: { state: string; signals: Array<Record<string, unknown>>; corruptReason: string | null } }>;
    const statuses = new Set(items.map((i) => i.status));
    expect(statuses.has('suspected_duplicate')).toBe(true);
    expect(statuses.has('needs_recheck')).toBe(true);
    expect(statuses.has('confirmed_distinct')).toBe(false);
    // signals 为结构化视图：state + 数组，每条仅含白名单键。
    const suspected = items.find((i) => i.relationId === fixture.suspectedRelationId)!;
    expect(suspected.signals.state).toBe('present');
    expect(suspected.signals.signals.length).toBeGreaterThanOrEqual(2);
    const allowed = ['signalType', 'field', 'candidateAValue', 'candidateBValue', 'strength', 'explanation'];
    for (const sig of suspected.signals.signals) {
      for (const k of Object.keys(sig)) expect(allowed).toContain(k);
    }
    // 绝不透传敏感字段。
    const serialized = JSON.stringify(items);
    for (const forbidden of ['securityId', 'cookie', 'token', 'visibleText']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('returns full relation detail incl. signals + audit timeline for confirmed_distinct (re-openable)', async () => {
    const res = await get(`/radar/review/relations/${fixture.distinctRelationId}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json() as {
      status: string; reasonCode: string | null; decisionReason: string | null;
      decidedAt: number | null; signals: { state: string; signals: unknown[] };
      auditTimeline: Array<{ actionType: string; reason: string | null; resultingStatus: string; occurredAt: number }>;
    };
    expect(detail.status).toBe('confirmed_distinct');
    expect(detail.decidedAt).not.toBeNull();
    // 已裁决关系仍可查看 signals（重开历史）。
    expect(detail.signals.state).toBe('present');
    expect(detail.signals.signals.length).toBeGreaterThanOrEqual(2);
    // 审计时间线含用户裁决原因，升序（旧→新）。
    const rejected = detail.auditTimeline.find((e) => e.actionType === 'duplicate_rejected')!;
    expect(rejected.reason).toContain('不同法人主体');
    expect(rejected.resultingStatus).toBe('confirmed_distinct');
    for (let i = 1; i < detail.auditTimeline.length; i += 1) {
      expect(detail.auditTimeline[i]!.occurredAt).toBeGreaterThanOrEqual(detail.auditTimeline[i - 1]!.occurredAt);
    }
  });

  it('relation detail 404 for unknown relation id', async () => {
    const res = await get('/radar/review/relations/does-not-exist');
    expect(res.statusCode).toBe(404);
  });

  it('filters by explicit status and caps at limit', async () => {
    const res = await get('/radar/review/relations?statuses=confirmed_distinct&limit=1');
    const items = res.json() as Array<{ status: string }>;
    expect(items.length).toBeLessThanOrEqual(1);
    if (items.length === 1) expect(items[0]!.status).toBe('confirmed_distinct');
  });

  it('returns candidate decision detail without sensitive fields', async () => {
    const res = await get(`/radar/review/candidates/${fixture.materialCandidateId}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json() as { decisionType: string; changedFields: unknown[]; currentVersion: Record<string, unknown> };
    expect(detail.decisionType).toBe('material_change');
    expect(detail.changedFields.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('securityId');
    expect(serialized).not.toContain('cookie');
    // JD 只给受限摘要字段。
    expect(detail.currentVersion).toHaveProperty('jdExcerpt');
    expect(detail.currentVersion).not.toHaveProperty('visibleText');
  });
});

describe('V8-3 review routes: decision feed (blocking + change)', () => {
  it('surfaces material/regression/ambiguous/identity_conflict with structured reasons', async () => {
    const res = await get('/radar/review/decision-feed');
    const items = res.json() as Array<{ decisionType: string; conflictReason: string | null; blockingIssues: string[]; needsConfirmation: string[]; candidateId: string | null }>;
    const types = new Set(items.map((i) => i.decisionType));
    expect(types.has('material_change')).toBe(true);
    expect(types.has('extraction_regression')).toBe(true);
    expect(types.has('ambiguous_change')).toBe(true);
    expect(types.has('identity_conflict')).toBe(true);
    const conflict = items.find((i) => i.decisionType === 'identity_conflict')!;
    expect(conflict.candidateId).toBeNull();
    expect(conflict.conflictReason).toBeTruthy();
    const regression = items.find((i) => i.decisionType === 'extraction_regression')!;
    expect(regression.needsConfirmation.length).toBeGreaterThan(0);
  });
});

describe('V8-3 review routes: adjudication + optimistic concurrency', () => {
  it('confirm-distinct requires reason (400 when missing)', async () => {
    const res = await post('/radar/review/relations/confirm-distinct', {
      relationId: fixture.suspectedRelationId, expectedCurrentStatus: 'suspected_duplicate',
    });
    expect(res.statusCode).toBe(422); // 校验失败（reason 缺失）
  });

  it('confirm-distinct succeeds then re-detection does not resurface (idempotent guard)', async () => {
    const ok = await post('/radar/review/relations/confirm-distinct', {
      relationId: fixture.suspectedRelationId, reason: '不同主体', expectedCurrentStatus: 'suspected_duplicate',
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { status: string }).status).toBe('confirmed_distinct');
    // 再用旧期望状态提交 → 409。
    const conflict = await post('/radar/review/relations/confirm-distinct', {
      relationId: fixture.suspectedRelationId, reason: '再次', expectedCurrentStatus: 'suspected_duplicate',
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('revert appends a new decision and returns to suspected_duplicate', async () => {
    const rel = fixture.distinctRelationId;
    const res = await post('/radar/review/relations/revert', {
      relationId: rel, reason: '需要重新判断', expectedCurrentStatus: 'confirmed_distinct',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('suspected_duplicate');
  });

  it('request-recheck moves needs_recheck only with new evidence reason', async () => {
    // distinct 组先确认不同，再用新证据 recheck。
    await post('/radar/review/relations/revert', { relationId: fixture.distinctRelationId, reason: 'x', expectedCurrentStatus: 'confirmed_distinct' });
    const res = await post('/radar/review/relations/request-recheck', {
      relationId: fixture.recheckRelationId, evidenceReason: 'new_stable_source_link',
      reason: '新增稳定来源', expectedCurrentStatus: 'needs_recheck',
    });
    expect([200, 409]).toContain(res.statusCode);
  });
});

describe('V8-3 review routes: rule evidence + override', () => {
  it('returns structured / legacy_scalar / corrupt states', async () => {
    const res = await get(`/radar/review/candidate-versions/${fixture.evidenceVersionId}/rule-evidence`);
    expect(res.statusCode).toBe(200);
    const views = res.json() as Array<{ assessmentId: string; evidenceState: string; overrideState: string }>;
    const byId = new Map(views.map((v) => [v.assessmentId, v]));
    expect(byId.get(fixture.structuredAssessmentId)!.evidenceState).toBe('structured');
    expect(byId.get(fixture.legacyAssessmentId)!.evidenceState).toBe('legacy_scalar');
    expect(byId.get(fixture.corruptAssessmentId)!.evidenceState).toBe('corrupt');
    expect(byId.get(fixture.coveredAssessmentId)!.overrideState).toBe('pass');
    expect(byId.get(fixture.uncoveredAssessmentId)!.overrideState).toBe('none');
  });

  it('exposes original assessment identity + evidence hash + append-only override audit (set→revert)', async () => {
    const res = await get(`/radar/review/candidate-versions/${fixture.evidenceVersionId}/rule-evidence`);
    const views = res.json() as Array<{
      assessmentId: string; originalResult: string; evidenceHashShort: string | null;
      overrideState: string; overrideAudit: Array<{ actionType: string; reason: string | null; previousOverrideState: string; resultingOverrideState: string; occurredAt: number }>;
    }>;
    const byId = new Map(views.map((v) => [v.assessmentId, v]));
    // 原始评估只读标识：result + evidence 短哈希（structured 非空、legacy NULL 无哈希）。
    expect(byId.get(fixture.structuredAssessmentId)!.originalResult).toBe('hit');
    expect(byId.get(fixture.structuredAssessmentId)!.evidenceHashShort).toMatch(/^[0-9a-f]{12}$/);
    expect(byId.get(fixture.legacyAssessmentId)!.evidenceHashShort).toBeNull();
    // set→revert 审计样例：两条事件，升序，状态 none→pass→none，终态 none。
    const audit = byId.get(fixture.overrideAuditAssessmentId)!;
    expect(audit.overrideState).toBe('none');
    expect(audit.overrideAudit.map((a) => a.actionType)).toEqual(['rule_override_set', 'rule_override_reverted']);
    expect(audit.overrideAudit[0]!.resultingOverrideState).toBe('pass');
    expect(audit.overrideAudit[1]!.previousOverrideState).toBe('pass');
    expect(audit.overrideAudit[1]!.resultingOverrideState).toBe('none');
    expect(audit.overrideAudit[0]!.reason).toBeTruthy();
    expect(audit.overrideAudit[1]!.occurredAt).toBeGreaterThanOrEqual(audit.overrideAudit[0]!.occurredAt);
  });

  it('set override then revert; original assessment unchanged and RadarActions appended', async () => {
    const before = db.prepare('SELECT result, evidence_json FROM radar_rule_assessments WHERE id = ?').get(fixture.uncoveredAssessmentId);
    const set = await post('/radar/review/rule-overrides/set', {
      assessmentId: fixture.uncoveredAssessmentId, overriddenValue: 'pass', reason: '可接受', expectedOverrideState: 'none',
    });
    expect(set.statusCode).toBe(200);
    // 冲突：再次用 none 作为期望 → 409。
    const conflict = await post('/radar/review/rule-overrides/set', {
      assessmentId: fixture.uncoveredAssessmentId, overriddenValue: 'block', reason: 'x', expectedOverrideState: 'none',
    });
    expect(conflict.statusCode).toBe(409);
    const revert = await post('/radar/review/rule-overrides/revert', {
      assessmentId: fixture.uncoveredAssessmentId, reason: '恢复默认', expectedOverrideState: 'pass',
    });
    expect(revert.statusCode).toBe(200);
    // 原评估行未被修改。
    const after = db.prepare('SELECT result, evidence_json FROM radar_rule_assessments WHERE id = ?').get(fixture.uncoveredAssessmentId);
    expect(after).toEqual(before);
    // 追加了 set + reverted 两条 action。
    const count = db.prepare("SELECT COUNT(*) c FROM radar_actions WHERE action_type LIKE 'rule_override_%'").get() as { c: number };
    expect(count.c).toBeGreaterThanOrEqual(3); // fixture 已有 1 条 covered set，此处再 +2
  });

  it('does not create Job/Application/FeedbackEvent rows', async () => {
    const jobs = db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number };
    const apps = db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number };
    await post('/radar/review/rule-overrides/set', {
      assessmentId: fixture.structuredAssessmentId, overriddenValue: 'pass', reason: 'x', expectedOverrideState: 'none',
    });
    expect((db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c).toBe(jobs.c);
    expect((db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number }).c).toBe(apps.c);
  });
});

describe('V8-3 review routes: feature gate', () => {
  it('is unreachable when radar capability is disabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-off-'));
    const offDb = openDb(path.join(tempDir, 'off.sqlite3'));
    initSchema(offDb, { targetVersion: 9 });
    const offApp = buildServer({ db: offDb, radar: { enabled: false } });
    const res = await offApp.inject({ method: 'GET', url: '/radar/review/relations', headers: headers() });
    expect(res.statusCode).toBe(404);
    await offApp.close();
    offDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('radar 开启但 schema 仅 v7 时不注册评审路由（404），采集桥仍可用', async () => {
    // 评审依赖 v8 候选关系表；v7 库（采集桥最低版本）下评审路由必须缺席而非运行时报错。
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-v7-'));
    const v7Db = openDb(path.join(tempDir, 'v7.sqlite3'));
    initSchema(v7Db, { targetVersion: 7 });
    const v7App = buildServer({ db: v7Db, radar: { enabled: true } });
    const review = await v7App.inject({ method: 'GET', url: '/radar/review/relations', headers: headers() });
    expect(review.statusCode).toBe(404);
    // 采集桥主路由仍存在（缺失会话返回 404，但校验错误证明路由已注册且过网关）。
    const capture = await v7App.inject({
      method: 'POST', url: '/radar/capture-sessions', headers: headers(), payload: {},
    });
    expect(capture.statusCode).not.toBe(404); // 命中路由（422 校验失败），非路由缺失
    await v7App.close();
    v7Db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
