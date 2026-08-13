import type { SqliteDatabase } from '../db';
import type { SearchCoverage } from '../search-provider/types';
import type { CostSummary, DailyJobBrief, DailyJobBriefStatus } from './types';

/**
 * OfferFlow v0.9 — DailyJobBrief Repository。
 *
 * Task: T040
 *
 * 纯持久化层，是下游 projection / persistence，不是第二个 Pipeline：
 *   - 不调用 RecommendationBatchService.createBatch（只引用既有 batch）；
 *   - 不调用 AnalysisService / EvidenceUpgradeService / ContentFetcher / SearchProvider；
 *   - 不实现 CostSummary 计算（T043）。
 *
 * 幂等：brief 的 authoritative identity = (brief_date, search_plan_version_id)。
 *   source_run_ids 是可增长的可变列表（SCHEDULED/CATCH_UP/MANUAL/RETRY 都会追加 run id），
 *   不属于 stable identity。
 * 持久化层幂等由 v13 唯一索引 (brief_date, search_plan_version_id) 强制执行：
 *   两个独立调用即使 brief.id 不同，只要 identity 相同，第二次 insert 必然被 UNIQUE 拒绝。
 * findByLogicalIdentity 供上层读侧精确查询同一 logical brief；insert 对相同 identity 由唯一索引拒绝。
 */

const COLUMNS = `
  id, brief_date, search_plan_version_id, source_run_ids_json,
  recommendation_batch_id, discovery_item_ids_json, status, coverage_json,
  cost_summary_json, empty_reason, generated_at, completed_at, created_at, updated_at
`;

interface DailyJobBriefRow {
  id: unknown; brief_date: unknown; search_plan_version_id: unknown;
  source_run_ids_json: unknown; recommendation_batch_id: unknown;
  discovery_item_ids_json: unknown; status: unknown; coverage_json: unknown;
  cost_summary_json: unknown; empty_reason: unknown; generated_at: unknown;
  completed_at: unknown; created_at: unknown; updated_at: unknown;
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

function rowToBrief(row: DailyJobBriefRow): DailyJobBrief {
  return {
    id: row.id as string,
    briefDate: row.brief_date as string,
    searchPlanVersionId: row.search_plan_version_id as string,
    sourceRunIds: parseJson<string[]>(row.source_run_ids_json, []),
    recommendationBatchId: row.recommendation_batch_id as string,
    discoveryItemIds: parseJson<string[]>(row.discovery_item_ids_json, []),
    status: row.status as DailyJobBriefStatus,
    coverage: parseJson<SearchCoverage>(row.coverage_json, { queriesCompleted: 0, queriesFailed: 0, failedScopes: [], queryResults: [] }),
    costSummaryJson: parseJson<CostSummary | null>(row.cost_summary_json, null),
    emptyReason: asNullableString(row.empty_reason),
    generatedAt: row.generated_at as number,
    completedAt: asNullableNumber(row.completed_at),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function briefToParams(brief: DailyJobBrief): Record<string, unknown> {
  return {
    id: brief.id,
    briefDate: brief.briefDate,
    searchPlanVersionId: brief.searchPlanVersionId,
    sourceRunIdsJson: JSON.stringify(brief.sourceRunIds),
    recommendationBatchId: brief.recommendationBatchId,
    discoveryItemIdsJson: JSON.stringify(brief.discoveryItemIds),
    status: brief.status,
    coverageJson: JSON.stringify(brief.coverage),
    costSummaryJson: brief.costSummaryJson === null ? null : JSON.stringify(brief.costSummaryJson),
    emptyReason: brief.emptyReason,
    generatedAt: brief.generatedAt,
    completedAt: brief.completedAt,
    createdAt: brief.createdAt,
    updatedAt: brief.updatedAt,
  };
}

const VALID_STATUS_TRANSITIONS: Readonly<Record<DailyJobBriefStatus, readonly DailyJobBriefStatus[]>> = {
  GENERATING: ['READY', 'FAILED'],
  READY: ['IN_REVIEW', 'FAILED'],
  IN_REVIEW: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

const TERMINAL_STATUSES: ReadonlySet<DailyJobBriefStatus> = new Set(['COMPLETED', 'FAILED']);

export class DailyBriefRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(brief: DailyJobBrief): void {
    this.db.prepare(`
      INSERT INTO daily_job_briefs (
        id, brief_date, search_plan_version_id, source_run_ids_json,
        recommendation_batch_id, discovery_item_ids_json, status, coverage_json,
        cost_summary_json, empty_reason, generated_at, completed_at, created_at, updated_at
      ) VALUES (
        @id, @briefDate, @searchPlanVersionId, @sourceRunIdsJson,
        @recommendationBatchId, @discoveryItemIdsJson, @status, @coverageJson,
        @costSummaryJson, @emptyReason, @generatedAt, @completedAt, @createdAt, @updatedAt
      )
    `).run(briefToParams(brief));
  }

  getById(id: string): DailyJobBrief | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM daily_job_briefs WHERE id = ?`)
      .get(id) as DailyJobBriefRow | undefined;
    return row === undefined ? null : rowToBrief(row);
  }

  /** 按 logical identity (brief_date, search_plan_version_id) 精确查询同一逻辑 brief。 */
  findByLogicalIdentity(briefDate: string, searchPlanVersionId: string): DailyJobBrief | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM daily_job_briefs
         WHERE brief_date = ? AND search_plan_version_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(briefDate, searchPlanVersionId) as DailyJobBriefRow | undefined;
    return row === undefined ? null : rowToBrief(row);
  }

  /** 按日期列出该自然日全部 brief（可能含不同 plan version 的多份，不是幂等键）。 */
  findByDate(briefDate: string): DailyJobBrief[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM daily_job_briefs WHERE brief_date = ? ORDER BY created_at DESC, id DESC`)
      .all(briefDate) as DailyJobBriefRow[];
    return rows.map(rowToBrief);
  }

  listRecent(limit: number): DailyJobBrief[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM daily_job_briefs ORDER BY brief_date DESC, created_at DESC, id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 100))) as DailyJobBriefRow[];
    return rows.map(rowToBrief);
  }

  /**
   * 状态转移：终态不可再转移；进入终态自动补 completed_at。
   * 相同状态重复转移为幂等 no-op。
   */
  updateStatus(id: string, status: DailyJobBriefStatus): void {
    const existing = this.getById(id);
    if (existing === null) {
      throw new Error(`daily job brief not found: ${id}`);
    }
    if (existing.status === status) return;
    if (!VALID_STATUS_TRANSITIONS[existing.status].includes(status)) {
      throw new Error(`illegal daily job brief status transition: ${existing.status} -> ${status}`);
    }
    const now = Date.now();
    const completedAt = TERMINAL_STATUSES.has(status) ? now : null;
    this.db.prepare(`
      UPDATE daily_job_briefs
      SET status = @status, completed_at = @completedAt, updated_at = @now
      WHERE id = @id
    `).run({ id, status, completedAt, now });
  }
}
