import type { SqliteDatabase } from '../db';
import type { SearchCoverage } from '../search-provider/types';
import type { SourceRun, SourceRunPhase, SourceRunStatus } from './types';

/**
 * OfferFlow v0.9 — SourceRun Repository。
 *
 * Task: T029
 *
 * 纯持久化层：不做 Scheduler 调度、不触发 DailyPipeline、不触发 DailyJobBrief、
 * 不计算 CostSummary。SourceRun 是运行记录，本 Repository 只负责可靠写入/读取与
 * 合法状态转移。
 */

const COLUMNS = `
  id, search_plan_version_id, source_key, source_version, trigger_type,
  retry_of_run_id, status, phase, scheduled_for, started_at, finished_at,
  queries_attempted, queries_succeeded, queries_failed, results_discovered,
  relevant_results, new_count, changed_count, duplicate_count, conflict_count,
  blocked_count, search_evidence_persisted, manual_review_required,
  full_evidence_count, analysis_eligible_count, analysis_requested_count,
  analysis_succeeded_count, selected_count, alerted_count, failed_count,
  estimated_search_credits, actual_search_credits, coverage_json, progress_json,
  cost_summary_json, error_code, error_message, created_at, updated_at
`;

interface SourceRunRow {
  id: unknown; search_plan_version_id: unknown; source_key: unknown; source_version: unknown;
  trigger_type: unknown; retry_of_run_id: unknown; status: unknown; phase: unknown;
  scheduled_for: unknown; started_at: unknown; finished_at: unknown;
  queries_attempted: unknown; queries_succeeded: unknown; queries_failed: unknown;
  results_discovered: unknown; relevant_results: unknown; new_count: unknown;
  changed_count: unknown; duplicate_count: unknown; conflict_count: unknown;
  blocked_count: unknown; search_evidence_persisted: unknown; manual_review_required: unknown;
  full_evidence_count: unknown; analysis_eligible_count: unknown; analysis_requested_count: unknown;
  analysis_succeeded_count: unknown; selected_count: unknown; alerted_count: unknown;
  failed_count: unknown; estimated_search_credits: unknown; actual_search_credits: unknown;
  coverage_json: unknown; progress_json: unknown; cost_summary_json: unknown;
  error_code: unknown; error_message: unknown; created_at: unknown; updated_at: unknown;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : (value as string);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : (value as number);
}

function rowToSourceRun(row: SourceRunRow): SourceRun {
  return {
    id: row.id as string,
    searchPlanVersionId: row.search_plan_version_id as string,
    sourceKey: row.source_key as string,
    sourceVersion: row.source_version as string,
    triggerType: row.trigger_type as SourceRun['triggerType'],
    retryOfRunId: asNullableString(row.retry_of_run_id),
    status: row.status as SourceRunStatus,
    phase: row.phase as SourceRunPhase,
    scheduledFor: row.scheduled_for as number,
    startedAt: asNullableNumber(row.started_at),
    finishedAt: asNullableNumber(row.finished_at),
    queriesAttempted: row.queries_attempted as number,
    queriesSucceeded: row.queries_succeeded as number,
    queriesFailed: row.queries_failed as number,
    resultsDiscovered: row.results_discovered as number,
    relevantResults: row.relevant_results as number,
    newCount: row.new_count as number,
    changedCount: row.changed_count as number,
    duplicateCount: row.duplicate_count as number,
    conflictCount: row.conflict_count as number,
    blockedCount: row.blocked_count as number,
    searchEvidencePersisted: row.search_evidence_persisted as number,
    manualReviewRequired: row.manual_review_required as number,
    fullEvidenceCount: row.full_evidence_count as number,
    analysisEligibleCount: row.analysis_eligible_count as number,
    analysisRequestedCount: row.analysis_requested_count as number,
    analysisSucceededCount: row.analysis_succeeded_count as number,
    selectedCount: row.selected_count as number,
    alertedCount: row.alerted_count as number,
    failedCount: row.failed_count as number,
    estimatedSearchCredits: asNullableNumber(row.estimated_search_credits),
    actualSearchCredits: asNullableNumber(row.actual_search_credits),
    coverage: parseJson<SearchCoverage>(row.coverage_json, { queriesCompleted: 0, queriesFailed: 0, failedScopes: [], queryResults: [] }),
    progressJson: parseJson<Record<string, unknown>>(row.progress_json, {}),
    costSummaryJson: parseJson<Record<string, unknown>>(row.cost_summary_json, {}),
    errorCode: asNullableString(row.error_code),
    errorMessage: asNullableString(row.error_message),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function sourceRunToParams(run: SourceRun): Record<string, unknown> {
  return {
    id: run.id,
    searchPlanVersionId: run.searchPlanVersionId,
    sourceKey: run.sourceKey,
    sourceVersion: run.sourceVersion,
    triggerType: run.triggerType,
    retryOfRunId: run.retryOfRunId,
    status: run.status,
    phase: run.phase,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    queriesAttempted: run.queriesAttempted,
    queriesSucceeded: run.queriesSucceeded,
    queriesFailed: run.queriesFailed,
    resultsDiscovered: run.resultsDiscovered,
    relevantResults: run.relevantResults,
    newCount: run.newCount,
    changedCount: run.changedCount,
    duplicateCount: run.duplicateCount,
    conflictCount: run.conflictCount,
    blockedCount: run.blockedCount,
    searchEvidencePersisted: run.searchEvidencePersisted,
    manualReviewRequired: run.manualReviewRequired,
    fullEvidenceCount: run.fullEvidenceCount,
    analysisEligibleCount: run.analysisEligibleCount,
    analysisRequestedCount: run.analysisRequestedCount,
    analysisSucceededCount: run.analysisSucceededCount,
    selectedCount: run.selectedCount,
    alertedCount: run.alertedCount,
    failedCount: run.failedCount,
    estimatedSearchCredits: run.estimatedSearchCredits,
    actualSearchCredits: run.actualSearchCredits,
    coverageJson: JSON.stringify(run.coverage),
    progressJson: JSON.stringify(run.progressJson),
    costSummaryJson: JSON.stringify(run.costSummaryJson),
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/**
 * 合法状态转移表。终态不可再转移；PENDING 必须先 RUNNING 才能进入终态
 * （CANCELLED 例外，允许在未运行时直接取消）。转移目标即目标终态时的
 * finished_at 由 transitionStatus 自动写入。
 */
const VALID_STATUS_TRANSITIONS: Readonly<Record<SourceRunStatus, readonly SourceRunStatus[]>> = {
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['WAITING_FOR_USER', 'SUCCEEDED', 'FAILED', 'PARTIALLY_SUCCEEDED', 'CANCELLED', 'INTERRUPTED'],
  WAITING_FOR_USER: ['RUNNING', 'CANCELLED'],
  PARTIALLY_SUCCEEDED: [],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
};

const TERMINAL_STATUSES: ReadonlySet<SourceRunStatus> = new Set([
  'PARTIALLY_SUCCEEDED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
]);

export interface SourceRunStatusTransition {
  toStatus: SourceRunStatus;
  finishedAt?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface SourceRunProgressPatch {
  phase?: SourceRunPhase;
  queriesAttempted?: number;
  queriesSucceeded?: number;
  queriesFailed?: number;
  resultsDiscovered?: number;
  relevantResults?: number;
  newCount?: number;
  changedCount?: number;
  duplicateCount?: number;
  conflictCount?: number;
  blockedCount?: number;
  searchEvidencePersisted?: number;
  manualReviewRequired?: number;
  fullEvidenceCount?: number;
  analysisEligibleCount?: number;
  analysisRequestedCount?: number;
  analysisSucceededCount?: number;
  selectedCount?: number;
  alertedCount?: number;
  failedCount?: number;
  estimatedSearchCredits?: number | null;
  actualSearchCredits?: number | null;
  coverage?: SearchCoverage;
  progressJson?: Record<string, unknown>;
  costSummaryJson?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export class SourceRunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(run: SourceRun): void {
    this.db.prepare(`
      INSERT INTO source_runs (
        id, search_plan_version_id, source_key, source_version, trigger_type,
        retry_of_run_id, status, phase, scheduled_for, started_at, finished_at,
        queries_attempted, queries_succeeded, queries_failed, results_discovered,
        relevant_results, new_count, changed_count, duplicate_count, conflict_count,
        blocked_count, search_evidence_persisted, manual_review_required,
        full_evidence_count, analysis_eligible_count, analysis_requested_count,
        analysis_succeeded_count, selected_count, alerted_count, failed_count,
        estimated_search_credits, actual_search_credits, coverage_json, progress_json,
        cost_summary_json, error_code, error_message, created_at, updated_at
      ) VALUES (
        @id, @searchPlanVersionId, @sourceKey, @sourceVersion, @triggerType,
        @retryOfRunId, @status, @phase, @scheduledFor, @startedAt, @finishedAt,
        @queriesAttempted, @queriesSucceeded, @queriesFailed, @resultsDiscovered,
        @relevantResults, @newCount, @changedCount, @duplicateCount, @conflictCount,
        @blockedCount, @searchEvidencePersisted, @manualReviewRequired,
        @fullEvidenceCount, @analysisEligibleCount, @analysisRequestedCount,
        @analysisSucceededCount, @selectedCount, @alertedCount, @failedCount,
        @estimatedSearchCredits, @actualSearchCredits, @coverageJson, @progressJson,
        @costSummaryJson, @errorCode, @errorMessage, @createdAt, @updatedAt
      )
    `).run(sourceRunToParams(run));
  }

  getById(id: string): SourceRun | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM source_runs WHERE id = ?`)
      .get(id) as SourceRunRow | undefined;
    return row === undefined ? null : rowToSourceRun(row);
  }

  listByPlanVersion(planVersionId: string): SourceRun[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM source_runs
         WHERE search_plan_version_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(planVersionId) as SourceRunRow[];
    return rows.map(rowToSourceRun);
  }

  listRecent(limit: number): SourceRun[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM source_runs ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 100))) as SourceRunRow[];
    return rows.map(rowToSourceRun);
  }

  /**
   * 状态转移：终态不可再转移；转移目标必须命中合法转移表。
   * 相同状态重复转移为幂等 no-op；进入 RUNNING 自动补 started_at，
   * 进入终态自动补 finished_at（可被 transition.finishedAt 覆盖）。
   */
  transitionStatus(id: string, transition: SourceRunStatusTransition): void {
    const existing = this.getById(id);
    if (existing === null) {
      throw new Error(`source run not found: ${id}`);
    }
    if (existing.status === transition.toStatus) {
      return; // 幂等 no-op
    }
    if (!VALID_STATUS_TRANSITIONS[existing.status].includes(transition.toStatus)) {
      throw new Error(
        `illegal source run status transition: ${existing.status} -> ${transition.toStatus}`,
      );
    }
    const now = Date.now();
    const startedAt = transition.toStatus === 'RUNNING' ? (existing.startedAt ?? now) : existing.startedAt;
    const finishedAt = TERMINAL_STATUSES.has(transition.toStatus)
      ? (transition.finishedAt ?? now)
      : null;
    this.db.prepare(`
      UPDATE source_runs
      SET status = @toStatus, started_at = @startedAt, finished_at = @finishedAt,
          error_code = @errorCode, error_message = @errorMessage, updated_at = @now
      WHERE id = @id
    `).run({
      id,
      toStatus: transition.toStatus,
      startedAt,
      finishedAt,
      errorCode: transition.errorCode === undefined ? existing.errorCode : transition.errorCode,
      errorMessage: transition.errorMessage === undefined ? existing.errorMessage : transition.errorMessage,
      now,
    });
  }

  /** 更新阶段/计数/coverage/progress/error 等进度字段（read-modify-write）。 */
  updateProgress(id: string, patch: SourceRunProgressPatch): void {
    const existing = this.getById(id);
    if (existing === null) return;
    const next: SourceRun = { ...existing, ...patch, updatedAt: Date.now() };
    this.db.prepare(`
      UPDATE source_runs
      SET phase = @phase, queries_attempted = @queriesAttempted, queries_succeeded = @queriesSucceeded,
          queries_failed = @queriesFailed, results_discovered = @resultsDiscovered,
          relevant_results = @relevantResults, new_count = @newCount, changed_count = @changedCount,
          duplicate_count = @duplicateCount, conflict_count = @conflictCount,
          blocked_count = @blockedCount, search_evidence_persisted = @searchEvidencePersisted,
          manual_review_required = @manualReviewRequired, full_evidence_count = @fullEvidenceCount,
          analysis_eligible_count = @analysisEligibleCount, analysis_requested_count = @analysisRequestedCount,
          analysis_succeeded_count = @analysisSucceededCount, selected_count = @selectedCount,
          alerted_count = @alertedCount, failed_count = @failedCount,
          estimated_search_credits = @estimatedSearchCredits, actual_search_credits = @actualSearchCredits,
          coverage_json = @coverageJson, progress_json = @progressJson,
          cost_summary_json = @costSummaryJson, error_code = @errorCode,
          error_message = @errorMessage, updated_at = @updatedAt
      WHERE id = @id
    `).run({ ...sourceRunToParams(next), id });
  }
}
