/**
 * V8-4 单岗位分析 · 编排层（服务）。
 *
 * 把已完成的可靠性/契约原语串成对外服务面：createTask（固定输入 → 幂等 queued 任务）、
 * runTask（注入 analyze/buildRecord 委托 AnalysisExecutor 执行）、cancel/retry/recover、
 * getAnalysis/listCandidateAnalyses（stale 有效性投影）。本波次不注册 HTTP 路由、不触前端。
 *
 * 严格边界：
 * - createTask 只组装固定输入并落 queued，**绝不**调用 Provider、绝不自动运行；
 * - 相同固定输入命中确定性主键 → 复用已有任务（含 cancelled，不自动重跑）；
 * - runTask 内注入的 analyze 只做「解析快照 → LLM 输入 → 生成+一次修复」，Envelope 版本字段由 buildRecord 附加；
 * - retry 仅 failed→queued，复用原 inputSnapshot，不重跑 snapshot builder，且不立即执行；
 * - Service 不创建/修改 Job / Application / FeedbackEvent / CandidateVersion / RuleAssessment / RadarAction；
 * - 错误只含稳定语义，绝不回显快照全文 / JD / Prompt / Provider 原文 / Token / API key。
 */
import { randomUUID } from 'node:crypto';
import type {
  AnalysisTask,
  JobMatchAnalysisRecord,
  JobMatchConfidence,
  JobMatchRecommendation,
} from '../../../src/domain/radar';
import type { SqliteDatabase } from '../../db';
import { AnalysisTaskRepository } from '../analysisTaskRepository';
import { AnalysisRecordRepository } from '../analysisRecordRepository';
import { RadarCandidateRepository } from '../candidateRepository';
import { normalizeJobMatchCity } from '../../job-match-profile/inputSnapshot';
import { buildJobMatchAnalysisInputSnapshot } from './inputSnapshot';
import { buildJobMatchAnalysisTaskId } from './inputHash';
import { parseJobMatchAnalysisInputSnapshot } from './contracts';
import { buildJobMatchAnalysisLlmInput } from './llmInput';
import { generateAndParseJobMatchAnalysis } from './repair';
import { deepSeekJobMatchAnalysisProvider } from './deepSeekProvider';
import type { JobMatchAnalysisProvider } from './provider';
import {
  JOB_MATCH_ANALYSIS_PROMPT_VERSION,
  JOB_MATCH_ANALYSIS_POLICY_VERSION,
  JOB_MATCH_ANALYSIS_PROVIDER_POLICY_VERSION,
} from './analysisPrompt';
import { createQueuedTask, manualRetryTask } from './taskStateMachine';
import { invalidTransition, stateConflict } from './errors';
import { AnalysisExecutor, type AnalyzeResult, type RunOutcome } from './executor';
import {
  deriveAnalysisValidity,
  readCurrentAnalysisVersions,
  type AnalysisStaleReason,
} from './validity';

/** createTask 结果：created 区分「本次新建」与「命中已有（含 cancelled）」。 */
export interface CreateAnalysisTaskResult {
  task: AnalysisTask;
  created: boolean;
}

/** listCandidateAnalyses 单项：不可变 record + 查询期派生的有效性投影（不新增字段）。 */
export interface CandidateAnalysisView {
  record: JobMatchAnalysisRecord;
  validity: { status: 'current' | 'stale'; staleReasons: AnalysisStaleReason[] };
}

/** 构造依赖：db 必填；provider/now/id 生成器可注入（测试注入 fake provider，绝不读真实环境变量）。 */
export interface AnalysisServiceDeps {
  db: SqliteDatabase;
  provider?: JobMatchAnalysisProvider;
  now?: () => number;
  createTaskId?: (inputHash: string) => string;
  createRecordId?: () => string;
}


const ENTITY_TYPE = 'radar_candidate_version';

export class AnalysisService {
  private readonly db: SqliteDatabase;
  private readonly provider: JobMatchAnalysisProvider;
  private readonly now: () => number;
  private readonly createTaskId: (inputHash: string) => string;
  private readonly createRecordId: () => string;
  private readonly tasks: AnalysisTaskRepository;
  private readonly records: AnalysisRecordRepository;
  /** 单一执行器实例：cancel 依赖的进程内 inflight AbortController 与 runTask 共享同一实例。 */
  private readonly executor: AnalysisExecutor;

  constructor(deps: AnalysisServiceDeps) {
    this.db = deps.db;
    this.provider = deps.provider ?? deepSeekJobMatchAnalysisProvider;
    this.now = deps.now ?? Date.now;
    this.createTaskId = deps.createTaskId ?? buildJobMatchAnalysisTaskId;
    this.createRecordId = deps.createRecordId ?? randomUUID;
    this.tasks = new AnalysisTaskRepository(this.db);
    this.records = new AnalysisRecordRepository(this.db);
    this.executor = new AnalysisExecutor({
      db: this.db,
      analyze: (task, signal) => this.analyze(task, signal),
      buildRecord: (args) => this.buildRecord(args),
      now: this.now,
      createRecordId: this.createRecordId,
    });
  }

  /**
   * 注入执行器的 analyze 边界：从任务冻结的 inputSnapshot 严格解析 → 派生模型可见 LLM 输入
   * （含 allowedEvidenceKeys）→ 生成 + 至多一次结构修复。只回业务 Payload 与 provider/model 元数据。
   */
  private async analyze(task: AnalysisTask, signal: AbortSignal): Promise<AnalyzeResult> {
    const snapshot = parseJobMatchAnalysisInputSnapshot(task.inputSnapshot);
    const { llmInput, allowedEvidenceKeys } = buildJobMatchAnalysisLlmInput(snapshot);
    const result = await generateAndParseJobMatchAnalysis({
      provider: this.provider,
      llmInput,
      allowedEvidenceKeys,
      signal,
    });
    return { payload: result.payload, provider: result.provider, model: result.model };
  }

  /**
   * 注入执行器的 buildRecord：从任务冻结的 inputSnapshot 附加不可变 Envelope 版本字段，
   * recommendation/confidence 取自业务 Payload；supersedesAnalysisId 指向该候选当前最新旧记录
   * （仅链接，绝不 UPDATE 旧记录）；不改任何 Candidate/Rule/Action 事实。
   */
  private buildRecord(args: {
    recordId: string;
    task: AnalysisTask;
    result: AnalyzeResult;
    now: number;
  }): JobMatchAnalysisRecord {
    const snapshot = parseJobMatchAnalysisInputSnapshot(args.task.inputSnapshot);
    const payload = args.result.payload as {
      recommendation: JobMatchRecommendation;
      confidence: JobMatchConfidence;
    };
    const prior = this.records.listByCandidate(snapshot.candidate.candidateId);
    return {
      id: args.recordId,
      candidateId: snapshot.candidate.candidateId,
      candidateVersionId: snapshot.candidate.candidateVersionId,
      resumeVersionId: snapshot.resume.versionId,
      jobMatchProfileVersionId: snapshot.jobMatchProfile.versionId,
      cityCode: normalizeJobMatchCity(snapshot.candidate.normalizedFacts.city),
      capabilityBaselineVersionId: snapshot.capabilityBaseline?.versionId ?? null,
      marketPositionVersionId: snapshot.marketPosition?.versionId ?? null,
      strategyVersionId: snapshot.strategy?.versionId ?? null,
      ruleVersion: snapshot.ruleProjection.version,
      promptVersion: snapshot.promptVersion,
      analysisPolicyVersion: snapshot.analysisPolicyVersion,
      modelProvider: args.result.provider,
      modelName: args.result.model,
      modelVersion: null,
      inputHash: args.task.inputHash,
      recommendation: payload.recommendation,
      confidence: payload.confidence,
      payload: args.result.payload,
      createdAt: args.now,
      supersedesAnalysisId: prior[0]?.id ?? null,
    };
  }

  /** 读取任务（不存在返回 null）。 */
  getTask(taskId: string): AnalysisTask | null {
    return this.tasks.getById(taskId);
  }

  /** 读取分析记录（不存在返回 null）。 */
  getAnalysis(analysisId: string): JobMatchAnalysisRecord | null {
    return this.records.getById(analysisId);
  }

  /**
   * 组装固定输入并幂等创建 queued 任务（attemptCount=0）。绝不调用 Provider、绝不自动运行。
   * 相同固定输入命中确定性主键 → 复用已有任务；已 cancelled 任务在输入未变时**原样返回**，不自动重跑。
   */
  createTask(candidateVersionId: string): CreateAnalysisTaskResult {
    const built = buildJobMatchAnalysisInputSnapshot(this.db, candidateVersionId, {
      promptVersion: JOB_MATCH_ANALYSIS_PROMPT_VERSION,
      analysisPolicyVersion: JOB_MATCH_ANALYSIS_POLICY_VERSION,
      providerPolicyVersion: JOB_MATCH_ANALYSIS_PROVIDER_POLICY_VERSION,
      provider: {
        providerName: this.provider.providerName(),
        modelName: this.provider.modelName(),
        modelVersion: null,
      },
      now: this.now,
    });
    const taskId = this.createTaskId(built.inputHash);
    // 幂等确定性主键由 inputHash 派生（不含 createdAt）：同一固定输入的重复调用会算出相同
    // taskId 但 snapshot.createdAt 不同。故先按 id + inputHash 命中即复用，绝不用新 createdAt
    // 触发假的 TASK_INPUT_CONFLICT，也不自动重跑已 cancelled 的任务。
    const existing = this.tasks.getById(taskId);
    if (existing !== null && existing.inputHash === built.inputHash) {
      return { task: existing, created: false };
    }
    const queued = createQueuedTask({
      id: taskId,
      taskType: 'job_match_analysis',
      entityType: ENTITY_TYPE,
      entityId: candidateVersionId,
      inputHash: built.inputHash,
      inputSnapshot: built.snapshot,
      now: this.now(),
    });
    const { task, created } = this.tasks.insertOrGet(queued);
    return { task, created };
  }

  /** 执行一个 queued 任务直到终态/迟到丢弃（委托共享执行器）。不组装输入、不改前端。 */
  async runTask(taskId: string): Promise<RunOutcome> {
    return this.executor.runTask(taskId);
  }

  /** 取消任务（严格先落 cancelled 再 abort；幂等；succeeded 拒绝取消）。 */
  cancelTask(taskId: string): AnalysisTask {
    return this.executor.cancel(taskId);
  }

  /**
   * 人工「重新分析」：仅 failed→queued，复用原 inputSnapshot（不重跑 snapshot builder）。
   * 允许在自动预算（maxAttempts）耗尽后继续，但受硬上限约束（见 manualRetryTask），杜绝无限重试；
   * attemptCount 历史保留（不清零），越预算时抬升 maxAttempts 恰好放行一次。
   * cancelled 不允许 retry（状态机拒绝）。不立即执行——调用方随后 runTask 才真正运行。
   */
  retryTask(taskId: string): AnalysisTask {
    const current = this.tasks.getById(taskId);
    if (current === null) throw invalidTransition('missing', 'retry');
    const requeued = manualRetryTask(current, { now: this.now() });
    const ok = this.tasks.transition({
      taskId,
      expectedStatus: 'failed',
      expectedAttemptCount: current.attemptCount,
      next: requeued,
    });
    if (!ok) {
      const after = this.tasks.getById(taskId)!;
      if (after.status === 'queued') return after; // 并发已 retry：收敛到同一 queued。
      throw stateConflict('retry 时任务状态已被并发改动');
    }
    return requeued;
  }

  /** §10 进程恢复：遗留 running→failed(PROCESS_RESTART_INTERRUPTED)，queued 交回执行队列。 */
  recoverOnStartup(): { interrupted: string[]; requeued: string[] } {
    return this.executor.recoverOnStartup();
  }

  /**
   * 列出候选全部分析记录（新→旧），每条附查询期派生的有效性投影。
   * 有效性由记录冻结版本与当前 active 版本 + policy 常量比较派生，不新增字段；
   * model_name 变化默认不 stale（仅显式 Model Policy 判定才产生 model_policy_invalidated）。
   */
  listCandidateAnalyses(candidateId: string): CandidateAnalysisView[] {
    const candidate = new RadarCandidateRepository(this.db).getCandidate(candidateId);
    const current = readCurrentAnalysisVersions(this.db, candidateId, {
      ruleVersion: this.currentRuleVersion(candidate?.activeVersionId ?? null),
      promptVersion: JOB_MATCH_ANALYSIS_PROMPT_VERSION,
      analysisPolicyVersion: JOB_MATCH_ANALYSIS_POLICY_VERSION,
    });
    return this.records.listByCandidate(candidateId).map((record) => {
      const validity = deriveAnalysisValidity(record, current);
      return { record, validity: { status: validity.state, staleReasons: validity.reasons } };
    });
  }

  /**
   * 派生候选当前 active 版本的规则版本，与快照 ruleProjection.version 同构：
   * active 版本全部 rule_version 去重、升序、逗号连接（无评估为 'none'），截断 80。
   * 无 active 版本 → 'none'。列存在性无关（只读 rule_version 列，v7/v8 皆有）。
   */
  private currentRuleVersion(activeVersionId: string | null): string {
    if (activeVersionId === null) return 'none';
    const rows = this.db
      .prepare('SELECT DISTINCT rule_version FROM radar_rule_assessments WHERE candidate_version_id = ?')
      .all(activeVersionId) as Array<{ rule_version: string }>;
    const versions = rows.map((row) => row.rule_version).sort();
    return (versions.join(',') || 'none').slice(0, 80);
  }
}
