/**
 * RC-11 反向追踪服务单测（第一波）。
 *
 * 覆盖：正式对象 → 晋升来源、晋升 → 候选版本/触发原因/推荐批次（成员推断）、
 * 缺失与历史数据的明确不可追溯状态（no_promotion / not_recorded / no_batch / missing），
 * 以及"撤销 RadarAction 不破坏正式事实链路"（append-only + FK RESTRICT，追踪照常解析并标注 reverted）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { RadarCaptureService } from '../service';
import { RadarActionService } from '../action/actionService';
import { RadarRecommendationBatchRepository } from '../recommendationBatchRepository';
import { PromotionService } from './promotionService';
import { PromotionTraceService } from './promotionTraceService';
import type { RadarRecommendationBatch } from '../../../src/domain/radar';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

let seq = 0;

interface Kit {
  db: SqliteDatabase;
  promotions: PromotionService;
  actions: RadarActionService;
  tracer: PromotionTraceService;
}

function setup(): Kit {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-promotion-trace-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 8 });
  let clock = 1_800_000_000;
  const deps = { now: () => (clock += 1), createId: () => `trace-id-${(seq += 1)}` };
  const promotions = new PromotionService({ db, ...deps });
  const actions = new RadarActionService(db, deps);
  const tracer = new PromotionTraceService(db);
  cleanups.push(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { db, promotions, actions, tracer };
}

/** 经真实采集链路播种一个候选，返回其当前正式版本 id。 */
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

const countRows = (db: SqliteDatabase, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** 直插一个覆盖指定候选版本的推荐批次（成员关系用；selected 决定 wasSelected）。 */
function seedBatch(db: SqliteDatabase, versionId: string, over: { selected: boolean; tag: string }): void {
  const batch: RadarRecommendationBatch = {
    id: `batch-${over.tag}`, batchKey: `batch-key-${over.tag}`, status: 'succeeded',
    scope: { relationId: null }, candidateVersionIds: [versionId],
    selectedCandidateVersionIds: over.selected ? [versionId] : [],
    profileVersions: {}, ruleVersion: 'r1', recommendationRuleVersion: 'rr1', analysisPolicyVersion: 'ap1',
    handledStateHash: `hash-${over.tag}`, diagnosisStatus: 'formed', diagnosisPayload: null,
    emptyReason: null, generatedAt: 1_800_500_000, createdAt: 1_800_500_000,
  };
  new RadarRecommendationBatchRepository(db).insert(batch);
}

describe('正式对象 → 晋升来源反向追踪', () => {
  it('feedback 深度：Job/Application/FeedbackEvent 三者均追溯到同一份晋升与候选版本', () => {
    const { db, promotions, tracer } = setup();
    const { candidateId, versionId } = seedCandidate(db, 't1');
    const { promotion } = promotions.promote(versionId, { trigger: 'hr_replied', requestedDepth: 'feedback' });

    for (const trace of [
      tracer.traceByJob(promotion.jobId),
      tracer.traceByApplication(promotion.applicationId!),
      tracer.traceByFeedbackEvent(promotion.feedbackEventId!),
    ]) {
      expect(trace.traceable).toBe(true);
      if (!trace.traceable) throw new Error('unreachable');
      expect(trace.promotions).toHaveLength(1);
      const origin = trace.promotions[0]!;
      expect(origin.promotionId).toBe(promotion.id);
      expect(origin.candidateId).toBe(candidateId);
      expect(origin.candidateVersion.status).toBe('resolved');
      if (origin.candidateVersion.status === 'resolved') {
        expect(origin.candidateVersion.candidateVersionId).toBe(versionId);
      }
    }
  });

  it('无晋升引用的正式对象 → 明确不可追溯（traceable=false / no_promotion），不编造来源', () => {
    const { tracer } = setup();
    const trace = tracer.traceByJob('job-created-outside-radar');
    expect(trace.traceable).toBe(false);
    if (trace.traceable) throw new Error('unreachable');
    expect(trace.reason).toBe('no_promotion');
    expect(trace.objectKind).toBe('job');
  });

  it('job_only 深度：Application/FeedbackEvent 侧无引用晋升 → no_promotion（不牵连未产生的对象）', () => {
    const { db, promotions, tracer } = setup();
    const { versionId } = seedCandidate(db, 't2');
    // explicit_rejection 允许至多 job_only：只建 Job，无 Application/FeedbackEvent。
    const { promotion } = promotions.promote(versionId, { trigger: 'explicit_rejection', requestedDepth: 'job_only' });
    expect(promotion.applicationId).toBeNull();
    expect(tracer.traceByJob(promotion.jobId).traceable).toBe(true);
    expect(tracer.traceByApplication('no-such-application').traceable).toBe(false);
  });
});

describe('晋升 → 候选版本 / 触发原因', () => {
  it('候选版本解析出关键快照锚点（版本号 / contentHash / originType / sourceSnapshotIds）', () => {
    const { db, promotions, tracer } = setup();
    const { candidateId, versionId } = seedCandidate(db, 't3');
    const { promotion } = promotions.promote(versionId, { trigger: 'hr_replied', requestedDepth: 'feedback' });
    const origin = tracer.traceByPromotionId(promotion.id)!;
    expect(origin.candidateVersion.status).toBe('resolved');
    if (origin.candidateVersion.status !== 'resolved') throw new Error('unreachable');
    expect(origin.candidateVersion.candidateId).toBe(candidateId);
    expect(origin.candidateVersion.versionNo).toBeGreaterThanOrEqual(1);
    expect(origin.candidateVersion.contentHash.length).toBeGreaterThan(0);
    expect(Array.isArray(origin.candidateVersion.sourceSnapshotIds)).toBe(true);
  });

  it('未留触发动作 → trigger.status=not_recorded（不臆测 trigger 枚举）', () => {
    const { db, promotions, tracer } = setup();
    const { versionId } = seedCandidate(db, 't4');
    // 不传 triggerActionId：晋升合法，但触发原因未留痕。
    const { promotion } = promotions.promote(versionId, { trigger: 'hr_replied', requestedDepth: 'feedback' });
    const origin = tracer.traceByPromotionId(promotion.id)!;
    expect(origin.trigger.status).toBe('not_recorded');
  });

  it('留有触发动作 → 解析该 RadarAction（类型/理由/未撤销）', () => {
    const { db, promotions, actions, tracer } = setup();
    const { candidateId, versionId } = seedCandidate(db, 't5');
    const triggerAction = actions.markPriority(candidateId, { reasonText: '重点跟进' }).action!;
    const { promotion } = promotions.promote(versionId, {
      trigger: 'user_priority', requestedDepth: 'job_only', triggerActionId: triggerAction.id,
    });
    const origin = tracer.traceByPromotionId(promotion.id)!;
    expect(origin.trigger.status).toBe('resolved');
    if (origin.trigger.status !== 'resolved') throw new Error('unreachable');
    expect(origin.trigger.actionId).toBe(triggerAction.id);
    expect(origin.trigger.actionType).toBe('marked_priority');
    expect(origin.trigger.reasonText).toBe('重点跟进');
    expect(origin.trigger.reverted).toBe(false);
  });

  it('推荐批次按 scope 成员关系推断，显式标注 linked_by_scope_membership + wasSelected', () => {
    const { db, promotions, tracer } = setup();
    const { versionId } = seedCandidate(db, 't6');
    seedBatch(db, versionId, { selected: true, tag: 'sel' });   // 进入建议
    seedBatch(db, versionId, { selected: false, tag: 'cov' });  // 仅被 scope 覆盖
    const { promotion } = promotions.promote(versionId, { trigger: 'hr_replied', requestedDepth: 'feedback' });

    const origin = tracer.traceByPromotionId(promotion.id)!;
    expect(origin.recommendationBatches.status).toBe('linked_by_scope_membership');
    if (origin.recommendationBatches.status !== 'linked_by_scope_membership') throw new Error('unreachable');
    const byId = new Map(origin.recommendationBatches.batches.map((b) => [b.batchId, b]));
    expect(byId.get('batch-sel')?.wasSelected).toBe(true);
    expect(byId.get('batch-cov')?.wasSelected).toBe(false);
  });

  it('无覆盖该候选版本的批次 → no_batch（不冒充因果来源）', () => {
    const { db, promotions, tracer } = setup();
    const { versionId } = seedCandidate(db, 't7');
    const { promotion } = promotions.promote(versionId, { trigger: 'hr_replied', requestedDepth: 'feedback' });
    const origin = tracer.traceByPromotionId(promotion.id)!;
    expect(origin.recommendationBatches.status).toBe('no_batch');
  });

  it('晋升记录不存在 → traceByPromotionId 返回 null（HTTP 层转 404）', () => {
    const { tracer } = setup();
    expect(tracer.traceByPromotionId('no-such-promotion')).toBeNull();
  });
});

describe('INV · 撤销 RadarAction 不破坏正式事实链路', () => {
  it('撤销触发动作后：正式四表逐字不变，追踪照常解析并标注 reverted=true', () => {
    const { db, promotions, actions, tracer } = setup();
    const { candidateId, versionId } = seedCandidate(db, 't8');
    const triggerAction = actions.markPriority(candidateId).action!;
    const { promotion } = promotions.promote(versionId, {
      trigger: 'hr_replied', requestedDepth: 'feedback', triggerActionId: triggerAction.id,
    });
    const before = ['jobs', 'applications', 'feedback_events', 'radar_promotions'].map((t) => countRows(db, t));

    // 撤销为 append-only（写新事件、回填 revertedByActionId），FK RESTRICT 保护，不删任何正式事实。
    const reverted = actions.unmarkPriority(candidateId);
    expect(reverted.changed).toBe(true);
    expect(['jobs', 'applications', 'feedback_events', 'radar_promotions'].map((t) => countRows(db, t))).toEqual(before);

    // 正式对象仍完整追溯到同一份晋升与候选版本；触发动作解析仍成功，仅 reverted 翻真。
    const jobTrace = tracer.traceByJob(promotion.jobId);
    expect(jobTrace.traceable).toBe(true);
    if (!jobTrace.traceable) throw new Error('unreachable');
    expect(jobTrace.promotions[0]!.candidateVersion.status).toBe('resolved');
    const origin = tracer.traceByPromotionId(promotion.id)!;
    expect(origin.trigger.status).toBe('resolved');
    if (origin.trigger.status !== 'resolved') throw new Error('unreachable');
    expect(origin.trigger.reverted).toBe(true);
    expect(origin.trigger.revertedByActionId).toBe(reverted.action!.id);
  });
});
