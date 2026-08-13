/**
 * V8-6 第二波 · 晋升服务落库测试。
 *
 * 覆盖：create/link、幂等重放、深度钳制、no_response 零写入、
 * 目标错配拒绝、失败原子回滚、以及"绝不写出能力反证类事件"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { RadarCaptureService } from '../service';
import { PromotionService } from './promotionService';
import { PromotionError } from './promotionErrors';
import type { PromoteRequest } from './promotionDtoSchemas';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

let seq = 0;

function setup(): { db: SqliteDatabase; service: PromotionService } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-promotion-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 9 });
  let clock = 1_800_000_000;
  const service = new PromotionService({
    db,
    now: () => (clock += 1),
    createId: () => `promo-id-${(seq += 1)}`,
  });
  cleanups.push(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { db, service };
}

/** 经真实采集链路播种一个候选，返回其当前正式版本 id。 */
function seedCandidate(db: SqliteDatabase, tag: string): { candidateId: string; versionId: string } {
  let s = 0;
  const capture = new RadarCaptureService(db, {
    now: () => 1_700_000_000 + s,
    createId: () => `cap-${tag}-${(s += 1)}`,
  });
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

function request(over: Partial<PromoteRequest> = {}): PromoteRequest {
  return { trigger: 'hr_replied', requestedDepth: 'feedback', ...over };
}

function countRows(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('V8-6 晋升服务 · 新建正式对象', () => {
  it('feedback 深度一次写出 Job + Application + FeedbackEvent + Promotion', () => {
    const { db, service } = setup();
    const { candidateId, versionId } = seedCandidate(db, 'p1');

    const result = service.promote(versionId, request());

    expect(result.created).toBe(true);
    expect(result.plan.effectiveDepth).toBe('feedback');
    expect(result.plan.job.mode).toBe('create');
    expect(result.plan.application.mode).toBe('create');
    expect(result.promotion.candidateId).toBe(candidateId);
    expect(result.promotion.promotionType).toBe('feedback');
    expect(result.promotion.applicationId).not.toBeNull();
    expect(result.promotion.feedbackEventId).not.toBeNull();
    expect(countRows(db, 'jobs')).toBe(1);
    expect(countRows(db, 'applications')).toBe(1);
    expect(countRows(db, 'radar_promotions')).toBe(1);
  });

  it('新建 Job 承载候选标准化事实（公司/岗位/城市）', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'p2');

    const { promotion } = service.promote(versionId, request());

    const job = db.prepare('SELECT data_json FROM jobs WHERE id = ?').get(promotion.jobId) as { data_json: string };
    const parsed = JSON.parse(job.data_json) as { company: string; role: string; city: string };
    expect(parsed.company).toBe('公司p2');
    expect(parsed.role).toBe('后端工程师');
    expect(parsed.city).toBe('苏州');
  });

  it('新建 Application 不编造投递渠道与主体性质（一律 unknown）', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'p3');

    const { promotion } = service.promote(versionId, request());

    const row = db.prepare('SELECT origin, channel FROM applications WHERE id = ?')
      .get(promotion.applicationId) as { origin: string; channel: string };
    expect(row.origin).toBe('unknown');
    expect(row.channel).toBe('unknown');
  });
});

describe('V8-6 晋升服务 · 优先关联既有正式对象', () => {
  it('传入既有 jobId 时复用该 Job，不新建第二份', () => {
    const { db, service } = setup();
    const first = seedCandidate(db, 'l1');
    const seededJobId = service.promote(first.versionId, request({ requestedDepth: 'job_only', trigger: 'user_priority' })).promotion.jobId;
    expect(countRows(db, 'jobs')).toBe(1);

    const second = seedCandidate(db, 'l2');
    const result = service.promote(second.versionId, request({ jobId: seededJobId }));

    expect(result.plan.job.mode).toBe('link');
    expect(result.promotion.jobId).toBe(seededJobId);
    expect(countRows(db, 'jobs')).toBe(1);
  });

  it('传入既有 applicationId 时复用该投递，不新建第二份', () => {
    const { db, service } = setup();
    const first = seedCandidate(db, 'l3');
    const seeded = service.promote(first.versionId, request({ trigger: 'user_explicit_request', requestedDepth: 'application' })).promotion;

    const second = seedCandidate(db, 'l4');
    const result = service.promote(second.versionId, request({
      jobId: seeded.jobId, applicationId: seeded.applicationId,
    }));

    expect(result.plan.application.mode).toBe('link');
    expect(result.promotion.applicationId).toBe(seeded.applicationId);
    expect(countRows(db, 'applications')).toBe(1);
  });

  it('FeedbackEvent 只追加，link 既有投递时仍写新事件', () => {
    const { db, service } = setup();
    const first = seedCandidate(db, 'l5');
    const seeded = service.promote(first.versionId, request({ trigger: 'user_explicit_request', requestedDepth: 'application' })).promotion;
    const before = countRows(db, 'feedback_events');

    const second = seedCandidate(db, 'l6');
    const result = service.promote(second.versionId, request({
      jobId: seeded.jobId, applicationId: seeded.applicationId,
    }));

    expect(result.plan.feedback.mode).toBe('create');
    expect(countRows(db, 'feedback_events')).toBe(before + 1);
  });
});

describe('V8-6 晋升服务 · 幂等重放', () => {
  it('重复晋升复用同一 Promotion，且零新增正式对象', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'i1');

    const first = service.promote(versionId, request());
    const counts = {
      jobs: countRows(db, 'jobs'),
      applications: countRows(db, 'applications'),
      events: countRows(db, 'feedback_events'),
      promotions: countRows(db, 'radar_promotions'),
    };

    const replay = service.promote(versionId, request());

    expect(replay.created).toBe(false);
    expect(replay.promotion.id).toBe(first.promotion.id);
    expect(replay.plan.clampReasons).toContain('already_promoted');
    expect(countRows(db, 'jobs')).toBe(counts.jobs);
    expect(countRows(db, 'applications')).toBe(counts.applications);
    expect(countRows(db, 'feedback_events')).toBe(counts.events);
    expect(countRows(db, 'radar_promotions')).toBe(counts.promotions);
  });

  it('首次 create 与重放（此时已有 Job）算出同一幂等键', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'i2');

    const first = service.promote(versionId, request());
    // 重放时把首次新建的 Job 指认进来：范围键由候选身份派生，键必须不变。
    const replay = service.promote(versionId, request({ jobId: first.promotion.jobId }));

    expect(replay.created).toBe(false);
    expect(replay.promotion.id).toBe(first.promotion.id);
    expect(countRows(db, 'radar_promotions')).toBe(1);
  });

  it('换触发原因但同深度同目标，仍命中同一份晋升', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'i3');

    const first = service.promote(versionId, request({ trigger: 'hr_replied' }));
    const replay = service.promote(versionId, request({ trigger: 'interview_scheduled' }));

    expect(replay.promotion.id).toBe(first.promotion.id);
    expect(countRows(db, 'radar_promotions')).toBe(1);
  });
});

describe('V8-6 晋升服务 · 深度钳制', () => {
  it('user_priority 请求 feedback 被钳到 job_only，且不写投递与事件', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'c1');

    const result = service.promote(versionId, request({ trigger: 'user_priority', requestedDepth: 'feedback' }));

    expect(result.plan.effectiveDepth).toBe('job_only');
    expect(result.plan.clampReasons).toContain('trigger_forbids_application');
    expect(result.promotion.applicationId).toBeNull();
    expect(result.promotion.feedbackEventId).toBeNull();
    expect(countRows(db, 'applications')).toBe(0);
    expect(countRows(db, 'feedback_events')).toBe(0);
  });

  it('user_explicit_request 请求 feedback 被钳到 application，不代写外部反馈', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'c2');

    const result = service.promote(versionId, request({ trigger: 'user_explicit_request', requestedDepth: 'feedback' }));

    expect(result.plan.effectiveDepth).toBe('application');
    expect(result.plan.clampReasons).toContain('trigger_forbids_feedback');
    expect(result.promotion.applicationId).not.toBeNull();
    expect(result.promotion.feedbackEventId).toBeNull();
    expect(countRows(db, 'feedback_events')).toBe(0);
  });
});

describe('V8-6 晋升服务 · 无回复不创建拒绝或能力反证', () => {
  it('trigger=no_response 抛稳定错误码，且一行都不写', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'n1');

    for (const depth of ['job_only', 'application', 'feedback'] as const) {
      expect(() => service.promote(versionId, request({ trigger: 'no_response', requestedDepth: depth })))
        .toThrow(PromotionError);
    }

    expect(countRows(db, 'jobs')).toBe(0);
    expect(countRows(db, 'applications')).toBe(0);
    expect(countRows(db, 'feedback_events')).toBe(0);
    expect(countRows(db, 'radar_promotions')).toBe(0);
  });

  it('任何允许的触发原因都不会写出 no_response_recorded 类事件', () => {
    const { db, service } = setup();
    const triggers = ['hr_replied', 'contact_exchanged', 'interview_scheduled', 'explicit_rejection'] as const;

    triggers.forEach((trigger, index) => {
      const { versionId } = seedCandidate(db, `n2-${index}`);
      service.promote(versionId, request({ trigger }));
    });

    const types = db.prepare('SELECT DISTINCT event_type AS t FROM feedback_events')
      .all() as Array<{ t: string }>;
    const written = types.map((row) => row.t);
    expect(written).not.toContain('no_response_recorded');
    expect(written.sort()).toEqual(['hr_contacted', 'hr_replied', 'interview_scheduled', 'rejected']);
  });

  it('explicit_rejection 写 rejected，与"无回复"严格区分', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'n3');

    const result = service.promote(versionId, request({ trigger: 'explicit_rejection' }));

    expect(result.plan.feedbackEventType).toBe('rejected');
    const row = db.prepare('SELECT event_type AS t FROM feedback_events WHERE id = ?')
      .get(result.promotion.feedbackEventId) as { t: string };
    expect(row.t).toBe('rejected');
  });
});

describe('V8-6 晋升服务 · 目标错配拒绝', () => {
  it('指认不存在的 jobId 时拒绝，且零写入', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'x1');

    expect(() => service.promote(versionId, request({ jobId: 'job-not-exist' }))).toThrow(PromotionError);
    expect(countRows(db, 'jobs')).toBe(0);
    expect(countRows(db, 'radar_promotions')).toBe(0);
  });

  it('application 不属于指认的 job 时拒绝晋升', () => {
    const { db, service } = setup();
    const first = seedCandidate(db, 'x2');
    const seeded = service.promote(first.versionId, request({ trigger: 'user_explicit_request', requestedDepth: 'application' })).promotion;
    const other = seedCandidate(db, 'x3');
    const otherJobId = service.promote(other.versionId, request({ trigger: 'user_priority', requestedDepth: 'job_only' })).promotion.jobId;

    const third = seedCandidate(db, 'x4');
    // 把 A 的投递挂到 B 的岗位上：必须被 PROMOTION_TARGET_CONFLICT 挡住。
    expect(() => service.promote(third.versionId, request({
      jobId: otherJobId, applicationId: seeded.applicationId,
    }))).toThrow(PromotionError);
  });

  it('非当前正式版本不允许晋升', () => {
    const { db, service } = setup();
    const { candidateId, versionId } = seedCandidate(db, 'x5');
    // 把候选的 active 版本指向别处，使传入版本变成过期版本。
    db.prepare('UPDATE radar_candidates SET active_version_id = NULL WHERE id = ?').run(candidateId);

    expect(() => service.promote(versionId, request())).toThrow(PromotionError);
    expect(countRows(db, 'radar_promotions')).toBe(0);
  });

  it('候选版本不存在时抛 CANDIDATE_VERSION_NOT_FOUND', () => {
    const { service } = setup();
    try {
      service.promote('ver-not-exist', request());
      expect.unreachable('应抛出 PromotionError');
    } catch (error) {
      expect((error as PromotionError).code).toBe('CANDIDATE_VERSION_NOT_FOUND');
    }
  });
});

describe('V8-6 晋升预览 · 零写入', () => {
  it('预览不写任何表', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'pv1');

    const plan = service.previewPromotion(versionId, request());

    expect(plan.effectiveDepth).toBe('feedback');
    expect(countRows(db, 'jobs')).toBe(0);
    expect(countRows(db, 'applications')).toBe(0);
    expect(countRows(db, 'feedback_events')).toBe(0);
    expect(countRows(db, 'radar_promotions')).toBe(0);
  });

  it('反复预览仍然零写入，且计划稳定', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'pv2');

    const first = service.previewPromotion(versionId, request());
    const second = service.previewPromotion(versionId, request());

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.effectiveDepth).toBe(first.effectiveDepth);
    expect(countRows(db, 'radar_promotions')).toBe(0);
  });

  it('预览所见 = 确认所得：深度与事件类型与实际晋升一致', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'pv3');

    const preview = service.previewPromotion(versionId, request({ trigger: 'user_explicit_request' }));
    const executed = service.promote(versionId, request({ trigger: 'user_explicit_request' }));

    expect(executed.plan.effectiveDepth).toBe(preview.effectiveDepth);
    expect(executed.plan.feedbackEventType).toBe(preview.feedbackEventType);
    expect(executed.plan.clampReasons).toEqual(preview.clampReasons);
    expect(executed.plan.idempotencyKey).toBe(preview.idempotencyKey);
  });

  it('预览钳制：user_priority 请求 feedback 显示将被钳到 job_only', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'pv4');

    const plan = service.previewPromotion(versionId, request({ trigger: 'user_priority' }));

    expect(plan.effectiveDepth).toBe('job_only');
    expect(plan.clampReasons).toContain('trigger_forbids_application');
    expect(plan.application.mode).toBe('none');
    expect(plan.feedback.mode).toBe('none');
  });

  it('预览 no_response 直接拒绝，且零写入', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'pv5');

    expect(() => service.previewPromotion(versionId, request({ trigger: 'no_response' })))
      .toThrow(PromotionError);
    expect(countRows(db, 'radar_promotions')).toBe(0);
  });

  it('已晋升过时，预览标注 already_promoted 与既有晋升 id', () => {
    const { db, service } = setup();
    const { versionId } = seedCandidate(db, 'pv6');
    const executed = service.promote(versionId, request()).promotion;

    const plan = service.previewPromotion(versionId, request());

    expect(plan.clampReasons).toContain('already_promoted');
    expect(plan.existingPromotionId).toBe(executed.id);
  });

  it('预览 link 模式：既有 Job 显示为关联而非新建', () => {
    const { db, service } = setup();
    const first = seedCandidate(db, 'pv7');
    const jobId = service.promote(first.versionId, request({ trigger: 'user_priority', requestedDepth: 'job_only' })).promotion.jobId;

    const second = seedCandidate(db, 'pv8');
    const plan = service.previewPromotion(second.versionId, request({ jobId }));

    expect(plan.job.mode).toBe('link');
    expect(plan.job.existingId).toBe(jobId);
    expect(plan.application.mode).toBe('create');
  });
});

describe('V8-6 晋升服务 · 原子性', () => {
  /**
   * 最后一步 Promotion 落库失败时，必须整体回滚。
   * 否则会留下"有 Job/Application/事件但没有 Promotion 指向"的孤儿正式对象——
   * 用户在正式列表里看到凭空多出的岗位，却无法从雷达侧追溯来源。
   */
  it('Promotion 落库失败时，已写的 Job/Application/事件全部回滚', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-promotion-atomic-'));
    const db = openDb(path.join(tempDir, 'test.sqlite3'));
    initSchema(db, { targetVersion: 9 });
    cleanups.push(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

    let clock = 1_800_000_000;
    let ids = 0;
    const nextId = () => `atomic-${(ids += 1)}`;
    const service = new PromotionService({ db, now: () => (clock += 1), createId: nextId });

    // 先正常晋升一个候选，得到一份真实存在的 Promotion 行，用它的 id 制造主键冲突。
    const seeded = seedCandidate(db, 'atomic-seed');
    const existingPromotionId = service.promote(seeded.versionId, request()).promotion.id;
    const baseline = {
      jobs: countRows(db, 'jobs'),
      applications: countRows(db, 'applications'),
      events: countRows(db, 'feedback_events'),
      promotions: countRows(db, 'radar_promotions'),
    };

    // 另一个候选：让它的 Promotion id 撞上已存在的行（幂等键不同，故会走到真正的 INSERT）。
    const target = seedCandidate(db, 'atomic-target');
    let calls = 0;
    const colliding = new PromotionService({
      db,
      now: () => (clock += 1),
      // Job → Application → FeedbackEvent → Promotion，第 4 个 id 即 Promotion 的 id。
      createId: () => ((calls += 1) === 4 ? existingPromotionId : nextId()),
    });

    // 断言失败点确实在 radar_promotions 的主键约束：否则本用例可能因"更早就失败"
    // 而假绿，根本没走到"已写正式对象后再失败"的回滚路径。
    expect(() => colliding.promote(target.versionId, request()))
      .toThrow(/radar_promotions\.id|UNIQUE constraint failed: radar_promotions/);

    // 第二次晋升的 Job/Application/事件必须全部回滚，计数回到第一次晋升后的基线。
    expect(countRows(db, 'jobs')).toBe(baseline.jobs);
    expect(countRows(db, 'applications')).toBe(baseline.applications);
    expect(countRows(db, 'feedback_events')).toBe(baseline.events);
    expect(countRows(db, 'radar_promotions')).toBe(baseline.promotions);
  });
});
