/**
 * V8-5 第二波 · 推荐批次编排服务（RecommendationService）。
 *
 * 把第一波纯领域收敛（buildRecommendationSet）接到真实数据：从用户选定的候选版本集合出发，
 * 读取每个候选的 current 成功分析（stale 排除）、规则评估、RadarAction 处理状态，投影为输入，
 * 收敛出 0～8 条建议，按确定性 batchKey 幂等落 radar_recommendation_batches（复用现有表/Repository）。
 *
 * 严格边界（对齐 AGENTS.md §5.8 / TD §13.3）：
 * - 只读 Candidate / AnalysisRecord / RuleAssessment / RadarAction；
 * - **绝不**写 Job / Application / FeedbackEvent / CandidateVersion / RuleAssessment / RadarAction；
 * - 相同 scope + 相同分析/处理状态 → 相同 batchKey → 复用同一批次（不插第二份）；
 * - 本波次不生成误区诊断（diagnosis_status 固定 insufficient_evidence，payload=null，留给后续波次）。
 */
import { randomUUID } from 'node:crypto';
import type {
  RadarRecommendationBatch,
  RadarRecommendationDiagnosisStatus,
} from '../../../src/domain/radar';
import type { SqliteDatabase } from '../../db';
import { sha256RequestHash } from '../../job-memory/requestHash';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarRuleAssessmentRepository } from '../ruleAssessmentRepository';
import { RadarActionRepository } from '../actionRepository';
import { RadarRecommendationBatchRepository } from '../recommendationBatchRepository';
import {
  AnalysisService,
  type AnalysisValidityRequestContext,
} from '../analysis/analysisService';
import type { NovaWingHostAdapter } from '../analysis/novaWingHostAdapter';
import { JOB_MATCH_ANALYSIS_POLICY_VERSION } from '../analysis/analysisPrompt';
import { ProfileRepository } from '../../repositories/profileRepository';
import { ResumeVersionRepository } from '../../job-memory/resumeVersionRepository';
import { CapabilityBaselineRepository } from '../../capability-baseline/repository';
import { MarketPositionRepository } from '../../market-position/repository';
import { StrategyRepository } from '../../strategy-window/repository';
import { JobMatchAnalysisPayloadV1Schema } from '../analysis/analysisPayload';
import { buildRecommendationSet, type RecommendationCandidateInput } from './recommendationService';
import { deriveHandledState, hasHardConstraintHit, projectRecommendationInput, projectMissingInput } from './recommendationProjection';
import { RECOMMENDATION_CONTRACT_VERSION, type RecommendationSetV1 } from './recommendationContract';
import { candidateNotFound, emptyScope, tooManyScopeItems } from './recommendationErrors';

/** 推荐规则语义版本：参与 batchKey 与批次版本戳，语义变化即产出不同批次。 */
export const RECOMMENDATION_RULE_VERSION = 'radar-recommendation:v1';

/** 单批 scope 上限（设计建议 5～20；此处放宽上限至 50 以覆盖边界，仍拒绝空 scope）。 */
export const MAX_SCOPE_ITEMS = 50;

export interface RecommendationBatchServiceDeps {
  db: SqliteDatabase;
  now?: () => number;
  createBatchId?: () => string;
  novaWingAnalysisContextEnabled?: boolean;
  novaWingHostAdapter?: NovaWingHostAdapter;
}

/** createBatch 结果：created 区分本次新建与命中已有批次（幂等复用）。 */
export interface CreateBatchResult {
  batch: RadarRecommendationBatch;
  created: boolean;
}

const NO_DIAGNOSIS: RadarRecommendationDiagnosisStatus = 'insufficient_evidence';

/** 单候选解析中间态：绑定候选版本 + 其推荐输入投影 + 当前分析记录 id（用于 batchKey 指纹）。 */
interface ResolvedCandidate {
  candidateVersionId: string;
  input: RecommendationCandidateInput;
  analysisIdentity: string;
}

export class RecommendationBatchService {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  private readonly createBatchId: () => string;
  private readonly candidates: RadarCandidateRepository;
  private readonly rules: RadarRuleAssessmentRepository;
  private readonly actions: RadarActionRepository;
  private readonly batches: RadarRecommendationBatchRepository;
  private readonly analysis: AnalysisService;

  constructor(deps: RecommendationBatchServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.createBatchId = deps.createBatchId ?? randomUUID;
    this.candidates = new RadarCandidateRepository(this.db);
    this.rules = new RadarRuleAssessmentRepository(this.db);
    this.actions = new RadarActionRepository(this.db);
    this.batches = new RadarRecommendationBatchRepository(this.db);
    // 复用分析服务的有效性投影（current/stale），避免重复实现 ruleVersion/stale 派生。
    this.analysis = new AnalysisService({
      db: this.db,
      novaWingAnalysisContextEnabled: deps.novaWingAnalysisContextEnabled,
      novaWingHostAdapter: deps.novaWingHostAdapter,
    });
  }

  /**
   * 从候选版本 scope 幂等生成/复用推荐批次。scope 去重后按稳定顺序解析每个候选，
   * 投影 → 收敛 → 计算 batchKey → 命中则复用、未命中则落库。绝不写任何正式事实对象。
   */
  createBatch(rawScope: readonly string[]): CreateBatchResult {
    const scope = [...new Set(rawScope)];
    if (scope.length === 0) throw emptyScope();
    if (scope.length > MAX_SCOPE_ITEMS) throw tooManyScopeItems(MAX_SCOPE_ITEMS);

    // One request-scoped read at most. The revision is reused for every candidate to prevent N+1.
    const validityContext = this.analysis.createValidityRequestContext();
    const resolved = scope.map((versionId) => this.resolveCandidate(versionId, validityContext));
    const set = buildRecommendationSet(resolved.map((r) => r.input));
    const batchKey = this.computeBatchKey(resolved, set);

    const existing = this.batches.findByBatchKey(batchKey);
    if (existing !== null) return { batch: existing, created: false };

    const batch = this.assembleBatch(batchKey, scope, resolved, set);
    // 并发下同 batchKey 唯一约束冲突 → 复用已落库批次（幂等），不插第二份。
    try {
      this.batches.insert(batch);
      return { batch, created: true };
    } catch (error) {
      const raced = this.batches.findByBatchKey(batchKey);
      if (raced === null) throw error;
      return { batch: raced, created: false };
    }
  }

  getBatch(id: string): RadarRecommendationBatch | null {
    return this.batches.getById(id);
  }

  listRecentBatches(limit: number): RadarRecommendationBatch[] {
    return this.batches.listRecent(Math.max(1, Math.min(limit, 100)));
  }

  /**
   * 解析单个候选版本为推荐输入：定位候选 → 取其 current 成功分析（stale 排除）→
   * 读规则评估/行为流 → 投影。缺失/stale 走 no-payload 投影（将以对应阻断原因排除）。
   */
  private resolveCandidate(
    candidateVersionId: string,
    validityContext: AnalysisValidityRequestContext,
  ): ResolvedCandidate {
    const version = this.candidates.getVersion(candidateVersionId);
    if (version === null) throw candidateNotFound();
    const candidateId = version.candidateId;

    const views = this.analysis.listCandidateAnalyses(candidateId, validityContext);
    // 只认绑定该版本、且 current 的分析（listByCandidate 已按 createdAt DESC，取最新 current）。
    const currentView = views.find(
      (v) => v.record.candidateVersionId === candidateVersionId && v.validity.status === 'current',
    );
    const handled = deriveHandledState(this.actions.listByCandidate(candidateId), candidateVersionId);

    if (currentView === undefined) {
      const anyForVersion = views.some((v) => v.record.candidateVersionId === candidateVersionId);
      const input = projectMissingInput(
        candidateId, candidateVersionId, null, anyForVersion ? 'stale' : 'none', handled,
      );
      return { candidateVersionId, input, analysisIdentity: `none:${anyForVersion ? 'stale' : 'missing'}` };
    }

    const record = currentView.record;
    const payload = JobMatchAnalysisPayloadV1Schema.parse(record.payload);
    const assessments = this.rules.listByCandidateVersion(candidateVersionId);
    const input = projectRecommendationInput(record, payload, assessments, handled);
    // 硬约束命中也参与身份指纹：override 变化 → 身份变化 → 新批次。
    const identity = `${record.id}:${record.inputHash}:${hasHardConstraintHit(assessments) ? 'hc' : 'ok'}:${handled.ignoredUnchanged ? 'ig' : '-'}${handled.appliedPending ? 'ap' : '-'}`;
    return { candidateVersionId, input, analysisIdentity: identity };
  }

  /**
   * 确定性 batchKey：scope（排序）+ 每候选分析身份指纹（排序）+ 推荐规则/分析策略版本。
   * 相同 scope 且各候选分析记录/处理状态未变 → 相同 key → 幂等复用；任一变化即新批次。
   */
  private computeBatchKey(resolved: readonly ResolvedCandidate[], set: RecommendationSetV1): string {
    const identity = [...resolved]
      .map((r) => `${r.candidateVersionId}=${r.analysisIdentity}`)
      .sort();
    return sha256RequestHash({
      contractVersion: RECOMMENDATION_CONTRACT_VERSION,
      recommendationRuleVersion: RECOMMENDATION_RULE_VERSION,
      analysisPolicyVersion: JOB_MATCH_ANALYSIS_POLICY_VERSION,
      identity,
      emptyReason: set.emptyReason,
    });
  }

  /** 装配批次行：selectedCandidateVersionIds 与建议结果严格一致；完整 set 冻结进 scope。 */
  private assembleBatch(
    batchKey: string,
    scope: readonly string[],
    resolved: readonly ResolvedCandidate[],
    set: RecommendationSetV1,
  ): RadarRecommendationBatch {
    const now = this.now();
    const selected = set.recommendations.map((r) => r.candidateVersionId);
    return {
      id: this.createBatchId(),
      batchKey,
      status: 'succeeded',
      // scope 冻结请求集合 + 完整收敛结果（含富建议项与阻断清单），供查询/前端消费。
      scope: { requestedCandidateVersionIds: [...scope], recommendationSet: set },
      candidateVersionIds: resolved.map((r) => r.candidateVersionId),
      selectedCandidateVersionIds: selected,
      profileVersions: this.readActiveProfileVersions(),
      ruleVersion: RECOMMENDATION_RULE_VERSION,
      recommendationRuleVersion: RECOMMENDATION_RULE_VERSION,
      analysisPolicyVersion: JOB_MATCH_ANALYSIS_POLICY_VERSION,
      handledStateHash: sha256RequestHash(resolved.map((r) => r.analysisIdentity)),
      diagnosisStatus: NO_DIAGNOSIS,
      diagnosisPayload: null,
      emptyReason: set.emptyReason,
      generatedAt: now,
      createdAt: now,
    };
  }

  /** 当前正式画像上下文版本（只读快照，用于批次可追溯；缺失记 null）。 */
  private readActiveProfileVersions(): Record<string, string | null> {
    return {
      jobMatchProfileVersionId: new ProfileRepository(this.db).get()?.jobMatchProfile?.activeVersionId ?? null,
      resumeVersionId: new ResumeVersionRepository(this.db).getActiveResumeVersionId(),
      capabilityBaselineVersionId: new CapabilityBaselineRepository(this.db).getState().activeVersionId,
      marketPositionVersionId: new MarketPositionRepository(this.db).getState().activeVersionId,
      strategyVersionId: new StrategyRepository(this.db).getState().activeVersionId,
    };
  }
}
