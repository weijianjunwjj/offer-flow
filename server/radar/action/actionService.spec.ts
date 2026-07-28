/**
 * RC-10 第一波 · 雷达动作领域核心测试。
 *
 * 覆盖：可追踪、幂等、撤销只改 Radar 决策状态、撤销不删除/篡改已晋升正式事实、
 * no_response 不产生拒绝/能力反证、动作绑定 active 版本、只写 radar_actions。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { RadarCaptureService } from '../service';
import { RadarActionRepository } from '../actionRepository';
import { PromotionService } from '../promotion/promotionService';
import { RadarActionService } from './actionService';
import { RadarActionError } from './actionErrors';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

let seq = 0;

function setup(): { db: SqliteDatabase; service: RadarActionService; clock: () => number } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-action-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 8 });
  let t = 3_000_000;
  const service = new RadarActionService(db, { now: () => (t += 1000), createId: () => `act-${(seq += 1)}` });
  cleanups.push(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { db, service, clock: () => t };
}

/** 经真实采集链路播种一个候选，返回其 id 与当前 active 版本 id。 */
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

function tableCount(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('可追踪：append-only 事件流绑定 active 版本', () => {
  it('save 写入一条 saved 事件，绑定候选 active 版本且状态生效', () => {
    const { db, service } = setup();
    const { candidateId, versionId } = seedCandidate(db, 'trace-1');
    const outcome = service.save(candidateId, { reasonCode: 'high_match', reasonText: '高匹配' });
    expect(outcome.changed).toBe(true);
    expect(outcome.action).toMatchObject({
      candidateId, candidateVersionId: versionId, actionType: 'saved',
      reasonCode: 'high_match', revertedByActionId: null,
    });
    expect(outcome.state.saved).toBe(true);
    const persisted = new RadarActionRepository(db).listByCandidate(candidateId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.actionType).toBe('saved');
  });

  it('save→unsave→save 全过程可回放，旧事件永不物理删除', () => {
    const { db, service } = setup();
    const { candidateId } = seedCandidate(db, 'trace-2');
    service.save(candidateId);
    service.unsave(candidateId);
    service.save(candidateId);
    const log = new RadarActionRepository(db).listByCandidate(candidateId);
    expect(log.map((a) => a.actionType).sort()).toEqual(['saved', 'saved', 'unsaved']);
    expect(service.getState(candidateId).saved).toBe(true);
  });
});

describe('幂等', () => {
  it('重复 save 不产生第二条事件（no-op，changed=false）', () => {
    const { db, service } = setup();
    const { candidateId } = seedCandidate(db, 'idem-1');
    const first = service.save(candidateId);
    const second = service.save(candidateId);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.action).toBeNull();
    expect(new RadarActionRepository(db).listByCandidate(candidateId)).toHaveLength(1);
  });

  it('对未 save 的候选 unsave 是 no-op，不写任何事件', () => {
    const { db, service } = setup();
    const { candidateId } = seedCandidate(db, 'idem-2');
    const outcome = service.unsave(candidateId);
    expect(outcome.changed).toBe(false);
    expect(outcome.action).toBeNull();
    expect(new RadarActionRepository(db).listByCandidate(candidateId)).toHaveLength(0);
  });

  it('四族相互独立：save 不影响 ignore/priority/appliedPending', () => {
    const { db, service } = setup();
    const { candidateId } = seedCandidate(db, 'idem-3');
    service.save(candidateId);
    expect(service.getState(candidateId)).toEqual({
      saved: true, ignored: false, priority: false, appliedPending: false,
    });
  });
});

describe('撤销只撤销 Radar 决策状态', () => {
  it('unsave 追加 unsaved 事件并回填 saved 的 reverted_by_action_id', () => {
    const { db, service } = setup();
    const { candidateId } = seedCandidate(db, 'rev-1');
    const saved = service.save(candidateId).action!;
    const revert = service.unsave(candidateId).action!;
    expect(revert.actionType).toBe('unsaved');
    expect((revert.metadata as { revertsActionId: string }).revertsActionId).toBe(saved.id);
    const reloaded = new RadarActionRepository(db).getById(saved.id)!;
    expect(reloaded.revertedByActionId).toBe(revert.id);
    expect(service.getState(candidateId).saved).toBe(false);
  });

  it('ignore/restore 与 priority 撤销均只翻转对应族', () => {
    const { db, service } = setup();
    const { candidateId } = seedCandidate(db, 'rev-2');
    service.ignore(candidateId);
    service.markPriority(candidateId);
    service.restore(candidateId);
    const state = service.getState(candidateId);
    expect(state.ignored).toBe(false);
    expect(state.priority).toBe(true);
  });
});

describe('动作必须绑定候选 active 版本', () => {
  it('候选不存在时拒绝，不写任何事件', () => {
    const { db, service } = setup();
    expect(() => service.save('no-such-candidate')).toThrow(RadarActionError);
    expect(tableCount(db, 'radar_actions')).toBe(0);
  });
});

describe('INV-06 · no_response 不变成拒绝或能力反证', () => {
  it('markAppliedPending 只写 radar_actions，不产生 Application / 负反馈 / 能力反证', () => {
    const { db, service } = setup();
    const { candidateId } = seedCandidate(db, 'noresp-1');
    const before = {
      applications: tableCount(db, 'applications'),
      feedback: tableCount(db, 'feedback_events'),
      evidence: tableCount(db, 'candidate_evidence'),
    };
    const outcome = service.markAppliedPending(candidateId, {
      appliedAt: 3_100_000, followUpDueAt: 3_900_000, sourceSnapshotId: null, channel: 'boss',
    });
    expect(outcome.action!.actionType).toBe('marked_applied_pending');
    expect(outcome.state.appliedPending).toBe(true);
    // 无回复语义：正式表零新增，绝无拒绝 FeedbackEvent / 负向 CandidateEvidence。
    expect(tableCount(db, 'applications')).toBe(before.applications);
    expect(tableCount(db, 'feedback_events')).toBe(before.feedback);
    expect(tableCount(db, 'candidate_evidence')).toBe(before.evidence);
  });

  it('撤销 applied_pending 同样零正式写入，只翻转 Radar 状态', () => {
    const { db, service } = setup();
    const { candidateId } = seedCandidate(db, 'noresp-2');
    service.markAppliedPending(candidateId, { appliedAt: 3_100_000, followUpDueAt: null, sourceSnapshotId: null, channel: null });
    const outcome = service.revertAppliedPending(candidateId);
    expect(outcome.action!.actionType).toBe('applied_pending_reverted');
    expect(outcome.state.appliedPending).toBe(false);
    expect(tableCount(db, 'feedback_events')).toBe(0);
    expect(tableCount(db, 'candidate_evidence')).toBe(0);
  });
});

describe('RC-11 · 撤销雷达动作不删除或篡改已晋升正式事实', () => {
  it('候选晋升出 Job/Application/FeedbackEvent 后，撤销雷达动作不动这三类正式行', () => {
    const { db, service } = setup();
    const { candidateId, versionId } = seedCandidate(db, 'promoted-1');
    // 用真实晋升服务写出正式事实（feedback 深度 → Job + Application + FeedbackEvent 各一条）。
    let pt = 3_200_000;
    const promotion = new PromotionService({ db, now: () => (pt += 1), createId: () => `promo-${(seq += 1)}` });
    const promoted = promotion.promote(versionId, { trigger: 'hr_replied', requestedDepth: 'feedback' });
    expect(promoted.created).toBe(true);

    const snapshot = () => ({
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      applications: db.prepare('SELECT * FROM applications ORDER BY id').all(),
      feedback: db.prepare('SELECT * FROM feedback_events ORDER BY id').all(),
      promotions: db.prepare('SELECT * FROM radar_promotions ORDER BY id').all(),
    });
    const before = snapshot();
    expect(before.jobs).toHaveLength(1);
    expect(before.applications).toHaveLength(1);
    expect(before.feedback).toHaveLength(1);

    // 在已晋升候选上做整套雷达动作与撤销。
    service.save(candidateId);
    service.unsave(candidateId);
    service.ignore(candidateId);
    service.restore(candidateId);
    service.markPriority(candidateId);
    service.unmarkPriority(candidateId);
    service.markAppliedPending(candidateId, { appliedAt: pt, followUpDueAt: null, sourceSnapshotId: null, channel: 'boss' });
    service.revertAppliedPending(candidateId);

    // 正式四表逐行 byte-identical：撤销只作用于 radar_actions，从不删除/篡改正式事实。
    expect(snapshot()).toEqual(before);
    // 且 candidate_version_id 锚点仍指向晋升所用版本（未被动作流改写）。
    expect(service.getState(candidateId)).toEqual({ saved: false, ignored: false, priority: false, appliedPending: false });
    expect(versionId).toBe((before.promotions[0] as { candidate_version_id: string }).candidate_version_id);
  });
});
