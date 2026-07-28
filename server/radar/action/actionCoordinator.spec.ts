/**
 * RC-10 第二波 · 雷达动作协调层 + 推荐资格影响测试。
 *
 * 覆盖：
 * - getView / apply / revert / history（append-only、幂等 no-op、changed 语义）；
 * - appliedPending 服务端补齐 appliedAt 与 sourceSnapshotId（客户端不可伪造锚点）；
 * - ignored / applied_pending 使候选被推荐排除，revert 后恢复资格；
 * - 动作变化使推荐 batchKey 改变（旧批次不静默续用）；
 * - 动作与撤销全过程对正式 Job/Application/FeedbackEvent 零写入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { RadarCaptureService } from '../service';
import { AnalysisRecordRepository } from '../analysisRecordRepository';
import { seedActiveResumeAndProfile } from '../analysis/analysisInputFixture';
import { validPayload } from '../analysis/contractFixtures';
import { JOB_MATCH_ANALYSIS_POLICY_VERSION, JOB_MATCH_ANALYSIS_PROMPT_VERSION } from '../analysis/analysisPrompt';
import type { JobMatchAnalysisRecord, JobMatchRecommendation } from '../../../src/domain/radar';
import { RecommendationBatchService } from '../recommendation/recommendationBatchService';
import { RadarActionCoordinator } from './actionCoordinator';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

let seq = 0;

function setup(): { db: SqliteDatabase; coordinator: RadarActionCoordinator; snapshotById: Map<string, string> } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-action-coord-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 8 });
  seedActiveResumeAndProfile(db, 1_700_000_000);
  let t = 4_000_000;
  // 路由注入的快照解析器：这里用显式 map 模拟 review.getCandidateDecisionDetail(...).latestSnapshotId。
  const snapshotById = new Map<string, string>();
  const coordinator = new RadarActionCoordinator(db, {
    now: () => (t += 1000),
    createId: () => `act-${(seq += 1)}`,
    resolveLatestSnapshotId: (candidateId) => snapshotById.get(candidateId) ?? null,
  });
  cleanups.push(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { db, coordinator, snapshotById };
}

function seedCandidate(db: SqliteDatabase, tag: string): { candidateId: string; versionId: string } {
  let s = 0;
  const capture = new RadarCaptureService(db, { now: () => 1_700_000_000 + s, createId: () => `cap-${tag}-${(s += 1)}` });
  const session = capture.createSession({ sourceType: 'browser' });
  capture.addItem(session.session.id, {
    captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
    sourceUrl: `https://www.zhipin.com/job_detail/${tag}.html`, sourceDomain: 'zhipin.com',
    pageTitle: null, visibleText: `岗位：后端 @ 公司${tag} 苏州`, externalRecordId: tag,
    recognizedFields: {
      company: `公司${tag}`, role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 35,
      salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科',
    },
    extractionMetadata: null, capturedAt: null,
  });
  const outcome = capture.commitSession(session.session.id, { confirmedIndexes: [0], corrections: [] }).outcomes[0]!;
  return { candidateId: outcome.candidateId!, versionId: outcome.candidateVersionId! };
}

function insertCurrentRecord(
  db: SqliteDatabase,
  c: { candidateId: string; versionId: string },
  opts: { recommendation: JobMatchRecommendation; tag: string },
): void {
  const record: JobMatchAnalysisRecord = {
    id: `rec-${opts.tag}`, candidateId: c.candidateId, candidateVersionId: c.versionId,
    resumeVersionId: 'resume-ver-1', jobMatchProfileVersionId: 'jmp-ver-1', cityCode: 'suzhou',
    capabilityBaselineVersionId: null, marketPositionVersionId: null, strategyVersionId: null,
    ruleVersion: 'none', promptVersion: JOB_MATCH_ANALYSIS_PROMPT_VERSION,
    analysisPolicyVersion: JOB_MATCH_ANALYSIS_POLICY_VERSION, modelProvider: 'fake', modelName: 'fake-model',
    modelVersion: null, inputHash: `hash-${opts.tag}`, recommendation: opts.recommendation, confidence: 'high',
    payload: validPayload({ recommendation: opts.recommendation, confidence: 'high' }),
    createdAt: 1_700_000_500, supersedesAnalysisId: null,
  };
  new AnalysisRecordRepository(db).insert(record);
}

function tableCount(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('RadarActionCoordinator：视图 / 执行 / 撤销 / 历史', () => {
  it('getView 返回四族生效态与升序 append-only 历史', () => {
    const { db, coordinator } = setup();
    const { candidateId, versionId } = seedCandidate(db, 'view-1');
    expect(coordinator.getView(candidateId).state).toEqual({
      saved: false, ignored: false, priority: false, appliedPending: false,
    });
    coordinator.apply({ candidateId, family: 'save' });
    coordinator.apply({ candidateId, family: 'priority' });
    coordinator.revert({ candidateId, family: 'save' });
    const view = coordinator.getView(candidateId);
    expect(view.activeCandidateVersionId).toBe(versionId);
    expect(view.state).toEqual({ saved: false, ignored: false, priority: true, appliedPending: false });
    // 升序（旧→新）：saved → marked_priority → unsaved；saved 已被 unsaved 撤销。
    expect(view.history.map((h) => h.actionType)).toEqual(['saved', 'marked_priority', 'unsaved']);
    const saved = view.history.find((h) => h.actionType === 'saved')!;
    expect(saved).toMatchObject({ family: 'save', isSet: true, reverted: true, candidateVersionId: versionId });
    expect(view.history.find((h) => h.actionType === 'unsaved')).toMatchObject({ family: 'save', isSet: false });
  });

  it('apply 幂等：重复置位 changed=false，不新增事件', () => {
    const { db, coordinator } = setup();
    const { candidateId } = seedCandidate(db, 'idem-1');
    expect(coordinator.apply({ candidateId, family: 'ignore' }).changed).toBe(true);
    const second = coordinator.apply({ candidateId, family: 'ignore' });
    expect(second.changed).toBe(false);
    expect(second.view.state.ignored).toBe(true);
    expect(second.view.history.filter((h) => h.actionType === 'ignored')).toHaveLength(1);
  });

  it('revert 无生效 set 时幂等 no-op：changed=false，不写事件', () => {
    const { db, coordinator } = setup();
    const { candidateId } = seedCandidate(db, 'idem-2');
    const out = coordinator.revert({ candidateId, family: 'save' });
    expect(out.changed).toBe(false);
    expect(out.view.history).toHaveLength(0);
  });

  it('appliedPending 由服务端补齐 appliedAt 与 sourceSnapshotId（客户端仅给 channel/followUp）', () => {
    const { db, coordinator, snapshotById } = setup();
    const { candidateId } = seedCandidate(db, 'ap-1');
    snapshotById.set(candidateId, 'snap-server-resolved');
    const out = coordinator.apply({ candidateId, family: 'appliedPending', channel: 'boss', followUpDueAt: 9_999 });
    expect(out.changed).toBe(true);
    expect(out.view.state.appliedPending).toBe(true);
    const row = db.prepare(
      `SELECT metadata_json FROM radar_actions WHERE candidate_id = ? AND action_type = 'marked_applied_pending'`,
    ).get(candidateId) as { metadata_json: string };
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(meta.sourceSnapshotId).toBe('snap-server-resolved');
    expect(meta.channel).toBe('boss');
    expect(meta.followUpDueAt).toBe(9_999);
    expect(typeof meta.appliedAt).toBe('number');
  });
});

describe('RC-10 × V8-5：动作对推荐资格的影响', () => {
  function batchService(db: SqliteDatabase): RecommendationBatchService {
    let clock = 1_800_000_000;
    return new RecommendationBatchService({ db, now: () => (clock += 1), createBatchId: () => `batch-${(seq += 1)}` });
  }
  type Set = { recommendations: { candidateVersionId: string }[]; blocked: { candidateVersionId: string; reason: string }[] };
  function setOf(batch: { scope: unknown }): Set {
    return (batch.scope as { recommendationSet: Set }).recommendationSet;
  }

  it('ignore 使候选被排除（ignored_unchanged），revert 后恢复推荐资格', () => {
    const { db, coordinator } = setup();
    const c = seedCandidate(db, 'elig-1');
    insertCurrentRecord(db, c, { recommendation: 'apply_now', tag: 'elig-1' });
    const svc = batchService(db);

    // 未忽略：进入推荐。
    expect(setOf(svc.createBatch([c.versionId]).batch).recommendations.map((r) => r.candidateVersionId))
      .toEqual([c.versionId]);

    // 忽略：从推荐排除，理由 ignored_unchanged。
    coordinator.apply({ candidateId: c.candidateId, family: 'ignore' });
    const blockedSet = setOf(svc.createBatch([c.versionId]).batch);
    expect(blockedSet.recommendations).toHaveLength(0);
    expect(blockedSet.blocked).toContainEqual(
      expect.objectContaining({ candidateVersionId: c.versionId, reason: 'ignored_unchanged' }),
    );

    // 恢复：重新获得推荐资格。
    coordinator.revert({ candidateId: c.candidateId, family: 'ignore' });
    expect(setOf(svc.createBatch([c.versionId]).batch).recommendations.map((r) => r.candidateVersionId))
      .toEqual([c.versionId]);
  });

  it('appliedPending 使候选被排除（applied_pending），revert 后恢复', () => {
    const { db, coordinator } = setup();
    const c = seedCandidate(db, 'elig-2');
    insertCurrentRecord(db, c, { recommendation: 'apply_now', tag: 'elig-2' });
    const svc = batchService(db);

    coordinator.apply({ candidateId: c.candidateId, family: 'appliedPending' });
    const blocked = setOf(svc.createBatch([c.versionId]).batch);
    expect(blocked.recommendations).toHaveLength(0);
    expect(blocked.blocked).toContainEqual(
      expect.objectContaining({ candidateVersionId: c.versionId, reason: 'applied_pending' }),
    );

    coordinator.revert({ candidateId: c.candidateId, family: 'appliedPending' });
    expect(setOf(svc.createBatch([c.versionId]).batch).recommendations.map((r) => r.candidateVersionId))
      .toEqual([c.versionId]);
  });

  it('动作变化使 batchKey 改变：忽略后新建批次而非命中旧批次（旧推荐不静默续用）', () => {
    const { db, coordinator } = setup();
    const c = seedCandidate(db, 'key-1');
    insertCurrentRecord(db, c, { recommendation: 'apply_now', tag: 'key-1' });
    const svc = batchService(db);

    const first = svc.createBatch([c.versionId]);
    expect(first.created).toBe(true);
    // 同输入立即重算：命中同 batchKey（created=false），证明 key 由确定性输入派生。
    expect(svc.createBatch([c.versionId]).created).toBe(false);

    // 忽略后再算：handledStateHash 改变 → 新 batchKey → created=true 且不同 batch id。
    coordinator.apply({ candidateId: c.candidateId, family: 'ignore' });
    const afterIgnore = svc.createBatch([c.versionId]);
    expect(afterIgnore.created).toBe(true);
    expect(afterIgnore.batch.id).not.toBe(first.batch.id);
  });
});

describe('RC-11：动作与撤销全过程不触碰正式事实', () => {
  it('save/ignore/priority/appliedPending 及其撤销后 jobs/applications/feedback_events 零写入', () => {
    const { db, coordinator, snapshotById } = setup();
    const { candidateId } = seedCandidate(db, 'rc11');
    snapshotById.set(candidateId, 'snap-rc11');
    for (const family of ['save', 'ignore', 'priority', 'appliedPending'] as const) {
      coordinator.apply({ candidateId, family });
      coordinator.revert({ candidateId, family });
    }
    expect(tableCount(db, 'jobs')).toBe(0);
    expect(tableCount(db, 'applications')).toBe(0);
    expect(tableCount(db, 'feedback_events')).toBe(0);
    // 事件确实写入了 radar_actions（8 条：4 set + 4 revert）。
    expect(tableCount(db, 'radar_actions')).toBe(8);
  });
});
