/**
 * V8-6 第二波 · 正式晋升服务（落库 + 原子性 + 幂等）。
 *
 * 职责：把确定性的 `PromotionPlanV1` 落成正式事实，单事务内完成
 * Job / Application / FeedbackEvent / RadarPromotion 的写入。
 *
 * 硬边界（TD §11.7 / §13.4、PRD P0-11 / US-09）：
 * - **晋升前重新读取正式对象**：既有 Job/Application 一律在事务内从库里核实后
 *   才填进 `buildPromotionPlan` 的 `existing`，绝不信任前端声称的挂载关系；
 * - **优先关联**：核实存在即 link，绝不新建第二份正式对象；
 * - **原子**：任一步失败整体回滚，不留"有 Job 没 Promotion"的半成品；
 * - **幂等**：命中 `idempotencyKey` 直接复用既有 Promotion，零新增写入；
 * - **不新造第二套流程**：复用 job-memory 既有 Repository 与 `ApplicationRecordSchema`
 *   / `makeFeedbackEvent`，与人工录入走同一套校验与事件工厂；
 * - **无回复零写入**：trigger=no_response 由计划层直接抛错，事务内一行都不写。
 */
import { randomUUID } from 'node:crypto';
import { ApplicationRecordSchema } from '../../../src/domain/job-memory';
import type { RadarCandidateVersion, RadarPromotion } from '../../../src/domain/radar';
import type { SqliteDatabase } from '../../db';
import { ApplicationRepository } from '../../job-memory/applicationRepository';
import { FeedbackEventRepository } from '../../job-memory/feedbackEventRepository';
import { makeFeedbackEvent } from '../../job-memory/eventFactory';
import { sha256RequestHash } from '../../job-memory/requestHash';
import { JobRepository } from '../../repositories/jobRepository';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarPromotionRepository } from '../promotionRepository';
import { buildPromotionPlan, type ExistingFormalObjects } from './promotionPlan';
import { computeTargetScopeKey } from './promotionTargetScope';
import type { PromotionPlanV1 } from './promotionContract';
import {
  candidateVersionNotActive,
  candidateVersionNotFound,
  targetConflict,
} from './promotionErrors';
import type { PromoteRequest } from './promotionDtoSchemas';

/** 可注入依赖：测试注入单调时钟与确定性 id，保证计划与落库结果可断言。 */
export interface PromotionServiceDeps {
  db: SqliteDatabase;
  now?: () => number;
  createId?: () => string;
}

export interface PromoteResult {
  promotion: RadarPromotion;
  plan: PromotionPlanV1;
  /** false = 命中幂等键复用既有晋升（本次零新增正式对象）。 */
  created: boolean;
}

export class PromotionService {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly candidates: RadarCandidateRepository;
  private readonly promotions: RadarPromotionRepository;
  private readonly jobs: JobRepository;
  private readonly applications: ApplicationRepository;
  private readonly events: FeedbackEventRepository;

  constructor(deps: PromotionServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? randomUUID;
    this.candidates = new RadarCandidateRepository(this.db);
    this.promotions = new RadarPromotionRepository(this.db);
    this.jobs = new JobRepository(this.db);
    this.applications = new ApplicationRepository(this.db);
    this.events = new FeedbackEventRepository(this.db);
  }

  getPromotion(id: string): RadarPromotion | null {
    return this.promotions.getById(id);
  }

  listByCandidate(candidateId: string): RadarPromotion[] {
    return this.promotions.listByCandidate(candidateId);
  }

  /**
   * 晋升候选版本为正式记录。整个流程在单事务内完成：
   * 重新读取正式对象 → 推导计划 → 幂等命中则复用 → 否则按计划写入并落 Promotion。
   *
   * @throws PromotionError 版本不存在 / 非当前版本 / 触发原因不允许 / 目标错配
   */
  promote(candidateVersionId: string, request: PromoteRequest): PromoteResult {
    // 单事务包住"重新读取 → 推导计划 → 幂等复查 → 写入"，
    // 保证计划所依据的正式对象状态与最终写入之间没有其他写入插进来。
    return this.db.transaction(() => {
      const plan = this.derivePlan(candidateVersionId, request);

      // 幂等：同版本 + 同深度 + 同目标范围只应有一份正式晋升，重放零新增写入。
      const replay = this.promotions.findByIdempotencyKey(plan.idempotencyKey);
      if (replay !== null) {
        return {
          promotion: replay,
          plan: {
            ...plan,
            existingPromotionId: replay.id,
            clampReasons: [...plan.clampReasons, 'already_promoted' as const],
          },
          created: false,
        };
      }

      return this.writePromotion(plan, request);
    })();
  }

  /**
   * 推导计划：校验版本可晋升 → 事务内重新读取正式对象 → 交给纯函数定型。
   *
   * @throws PromotionError 版本不存在 / 非当前版本 / 触发原因不允许 / 目标错配
   */
  private derivePlan(candidateVersionId: string, request: PromoteRequest): PromotionPlanV1 {
    const version = this.candidates.getVersion(candidateVersionId);
    if (version === null) throw candidateVersionNotFound();

    // 只允许晋升候选的当前正式版本：用过期版本写正式事实会把已被纠错的事实固化。
    const candidate = this.candidates.getCandidate(version.candidateId);
    if (candidate === null) throw candidateVersionNotFound();
    if (candidate.activeVersionId !== version.id) throw candidateVersionNotActive();

    return buildPromotionPlan({
      candidateId: version.candidateId,
      candidateVersionId: version.id,
      trigger: request.trigger,
      requestedDepth: request.requestedDepth,
      existing: this.reloadFormalObjects(request),
      targetScopeKey: computeTargetScopeKey({
        company: version.normalized.company,
        role: version.normalized.role,
        city: version.normalized.city,
      }),
    });
  }

  /**
   * 事务内重新读取正式对象（TD §11.7）。前端只被允许"指认" id，
   * 是否真实存在、application 归属哪个 job，一律以库内当前状态为准。
   *
   * @throws PromotionError PROMOTION_TARGET_CONFLICT（指认的 id 不存在或已作废）
   */
  private reloadFormalObjects(request: PromoteRequest): ExistingFormalObjects {
    const jobId = request.jobId ?? null;
    const applicationId = request.applicationId ?? null;

    if (jobId !== null && this.jobs.get(jobId) === null) {
      throw targetConflict('指定的岗位不存在，不能晋升');
    }

    if (applicationId === null) {
      return { jobId, applicationId: null, applicationJobId: null };
    }

    const application = this.applications.getApplication(applicationId);
    if (application === null) throw targetConflict('指定的投递不存在，不能晋升');
    // 已作废的投递不是可用挂载点：继续追加事件会把正式事实写到废弃记录上。
    if (application.voidedAt !== null) throw targetConflict('指定的投递已作废，不能晋升');

    return { jobId, applicationId, applicationJobId: application.jobId };
  }

  /** 按计划写入正式对象并落 Promotion。调用方已保证处于事务内。 */
  private writePromotion(plan: PromotionPlanV1, request: PromoteRequest): PromoteResult {
    const version = this.candidates.getVersion(plan.candidateVersionId)!;
    const now = this.now();

    const jobId = plan.job.mode === 'link'
      ? plan.job.existingId!
      : this.createJob(version.normalized, now);

    const applicationId = plan.application.mode === 'none'
      ? null
      : plan.application.mode === 'link'
        ? plan.application.existingId!
        : this.createApplication(jobId, version.normalized, plan, now);

    const feedbackEventId = plan.feedback.mode === 'create'
      ? this.createFeedbackEvent(applicationId!, plan, now)
      : null;

    const promotion: RadarPromotion = {
      id: this.createId(),
      candidateId: plan.candidateId,
      candidateVersionId: plan.candidateVersionId,
      promotionType: plan.effectiveDepth,
      jobId,
      applicationId,
      feedbackEventId,
      triggerActionId: request.triggerActionId ?? null,
      idempotencyKey: plan.idempotencyKey,
      createdAt: now,
    };

    // 撞 idempotencyKey UNIQUE 时刻意**不**吞错误：吞掉后正常返回会让事务提交，
    // 把本次新建的 Job/Application 留成没有 Promotion 指向的孤儿。让它整体回滚。
    this.promotions.insert(promotion);
    return { promotion, plan, created: true };
  }

  /** 由候选版本标准化事实新建正式 Job。时间戳显式传入以保证测试可断言。 */
  private createJob(normalized: RadarCandidateVersion['normalized'], now: number): string {
    const job = this.jobs.create({
      id: this.createId(),
      company: normalized.company ?? '',
      role: normalized.role ?? '',
      city: normalized.city ?? '',
      jdText: normalized.rawDescription,
      createdAt: now,
      updatedAt: now,
    });
    return job.id;
  }

  /**
   * 新建正式 Application。走与人工录入同一套 `ApplicationRecordSchema` 校验。
   *
   * 事实保守原则：晋升只知道"这个岗位值得正式跟进"，不知道投递渠道与主体性质，
   * 因此 origin/channel/recruitingEntity 一律填 unknown，绝不替用户编造事实。
   */
  private createApplication(
    jobId: string,
    normalized: RadarCandidateVersion['normalized'],
    plan: PromotionPlanV1,
    now: number,
  ): string {
    const record = ApplicationRecordSchema.parse({
      id: this.createId(),
      jobId,
      resumeVersionId: null,
      origin: 'unknown',
      channel: 'unknown',
      channelOtherLabel: null,
      recruitingEntity: {
        kind: 'unknown',
        name: normalized.company,
        employerGroupKey: null,
        endClientName: null,
      },
      primaryContact: null,
      cityContext: { jobCity: normalized.city, marketCity: null, workMode: 'unknown' },
      draftMessageText: null,
      createdAt: now,
      updatedAt: now,
      voidedAt: null,
      voidReason: null,
      supersededByApplicationId: null,
      rowVersion: 1,
    });
    // Application 幂等键派生自晋升幂等键：整个晋升重放时不会写出第二份投递。
    this.applications.insert({
      record,
      idempotencyKey: `${plan.idempotencyKey}:application`,
      requestHash: sha256RequestHash({ command: 'radar_promotion_application', jobId }),
      migrationKey: null,
    });
    return record.id;
  }

  /**
   * 追加正式 FeedbackEvent。事件类型只取自计划（由触发原因确定性推导），
   * 调用方无权指定——这是"无回复不创建拒绝或能力反证"的落库侧保障。
   *
   * 证据强度保守：用户在事后点击上报，发生时刻并非精确可知，
   * 故 timePrecision/sourceConfidence 取 approximate、evidenceLevel 取 medium，
   * 不把"用户顺手点了一下"抬成 exact/strong 的强证据。
   */
  private createFeedbackEvent(applicationId: string, plan: PromotionPlanV1, now: number): string {
    const eventType = plan.feedbackEventType!;
    const stored = makeFeedbackEvent({ now: this.now, createId: this.createId }, {
      applicationId,
      input: {
        eventType,
        eventAt: now,
        timePrecision: 'approximate',
        actor: 'hr',
        sourceConfidence: 'approximate',
        evidenceLevel: 'medium',
        channel: null,
        note: null,
        reasonCode: null,
        // hr_contacted 要求 submissionState；晋升不知道是否已投递，填 unknown 不臆测。
        payload: eventType === 'hr_contacted' ? { submissionState: 'unknown' } : {},
      },
      idempotencyKey: `${plan.idempotencyKey}:feedback`,
      requestHash: sha256RequestHash({ command: 'radar_promotion_feedback', eventType, applicationId }),
      createdAt: now,
    });
    this.events.insert(stored);
    return stored.record.id;
  }
}
