import type { SqliteDatabase } from '../db';
import type {
  DailySearchPlan,
  DailySearchPlanStatus,
  DailySearchPlanVersion,
  SearchPlanCity,
  SearchPlanHardConstraint,
  SearchSourceConfig,
} from './types';

/**
 * OfferFlow v0.9 — DailySearchPlan / DailySearchPlanVersion Repository。
 *
 * Task: T021
 *
 * 纯持久化层：不做配置校验（由上层 DTO/服务负责）、不做 Scheduler 调度。
 * DailySearchPlanVersion 不可变——本 Repository 只 INSERT 版本，不提供 UPDATE 版本。
 */

const PLAN_COLUMNS = 'id, name, status, active_version_id, created_at, updated_at, deleted_at';
const VERSION_COLUMNS = `
  id, search_plan_id, version, cities_json, role_directions_json, base_keywords_json,
  expanded_keywords_json, hard_constraints_json, source_configs_json, schedule_json,
  scan_budget_json, analysis_budget_json, brief_policy_json, exploration_policy_json,
  notification_policy_json, latest_catch_up_time, created_at, activated_at,
  supersedes_version_id
`;

interface DailySearchPlanRow {
  id: unknown; name: unknown; status: unknown; active_version_id: unknown;
  created_at: unknown; updated_at: unknown; deleted_at: unknown;
}

interface DailySearchPlanVersionRow {
  id: unknown; search_plan_id: unknown; version: unknown; cities_json: unknown;
  role_directions_json: unknown; base_keywords_json: unknown; expanded_keywords_json: unknown;
  hard_constraints_json: unknown; source_configs_json: unknown; schedule_json: unknown;
  scan_budget_json: unknown; analysis_budget_json: unknown; brief_policy_json: unknown;
  exploration_policy_json: unknown; notification_policy_json: unknown;
  latest_catch_up_time: unknown; created_at: unknown; activated_at: unknown;
  supersedes_version_id: unknown;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToPlan(row: DailySearchPlanRow): DailySearchPlan {
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as DailySearchPlanStatus,
    activeVersionId: row.active_version_id === null ? null : (row.active_version_id as string),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    deletedAt: row.deleted_at === null ? null : (row.deleted_at as number),
  };
}

function planToParams(plan: DailySearchPlan): Record<string, unknown> {
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    activeVersionId: plan.activeVersionId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    deletedAt: plan.deletedAt,
  };
}

function rowToVersion(row: DailySearchPlanVersionRow): DailySearchPlanVersion {
  return {
    id: row.id as string,
    searchPlanId: row.search_plan_id as string,
    version: row.version as number,
    cities: parseJson<SearchPlanCity[]>(row.cities_json, []),
    roleDirections: parseJson<string[]>(row.role_directions_json, []),
    baseKeywords: parseJson<string[]>(row.base_keywords_json, []),
    expandedKeywords: parseJson<string[]>(row.expanded_keywords_json, []),
    hardConstraints: parseJson<SearchPlanHardConstraint[]>(row.hard_constraints_json, []),
    sourceConfigs: parseJson<SearchSourceConfig[]>(row.source_configs_json, []),
    schedule: parseJson<Record<string, unknown>>(row.schedule_json, {}),
    scanBudget: parseJson<Record<string, unknown>>(row.scan_budget_json, {}),
    analysisBudget: parseJson<Record<string, unknown>>(row.analysis_budget_json, {}),
    briefPolicy: parseJson<Record<string, unknown>>(row.brief_policy_json, {}),
    explorationPolicy: parseJson<Record<string, unknown>>(row.exploration_policy_json, {}),
    notificationPolicy: parseJson<Record<string, unknown>>(row.notification_policy_json, {}),
    latestCatchUpTime: row.latest_catch_up_time as string,
    createdAt: row.created_at as number,
    activatedAt: row.activated_at === null ? null : (row.activated_at as number),
    supersedesVersionId: row.supersedes_version_id === null ? null : (row.supersedes_version_id as string),
  };
}

function versionToParams(version: DailySearchPlanVersion): Record<string, unknown> {
  return {
    id: version.id,
    searchPlanId: version.searchPlanId,
    version: version.version,
    citiesJson: JSON.stringify(version.cities),
    roleDirectionsJson: JSON.stringify(version.roleDirections),
    baseKeywordsJson: JSON.stringify(version.baseKeywords),
    expandedKeywordsJson: JSON.stringify(version.expandedKeywords),
    hardConstraintsJson: JSON.stringify(version.hardConstraints),
    sourceConfigsJson: JSON.stringify(version.sourceConfigs),
    scheduleJson: JSON.stringify(version.schedule),
    scanBudgetJson: JSON.stringify(version.scanBudget),
    analysisBudgetJson: JSON.stringify(version.analysisBudget),
    briefPolicyJson: JSON.stringify(version.briefPolicy),
    explorationPolicyJson: JSON.stringify(version.explorationPolicy),
    notificationPolicyJson: JSON.stringify(version.notificationPolicy),
    latestCatchUpTime: version.latestCatchUpTime,
    createdAt: version.createdAt,
    activatedAt: version.activatedAt,
    supersedesVersionId: version.supersedesVersionId,
  };
}

export interface DailySearchPlanPatch {
  name?: string;
  status?: DailySearchPlanStatus;
  activeVersionId?: string | null;
  deletedAt?: number | null;
}

export class SearchPlanRepository {
  constructor(private readonly db: SqliteDatabase) {}

  // ── Plan ───────────────────────────────────────────────────────────────────

  insertPlan(plan: DailySearchPlan): void {
    this.db.prepare(`
      INSERT INTO daily_search_plans (
        id, name, status, active_version_id, created_at, updated_at, deleted_at
      ) VALUES (
        @id, @name, @status, @activeVersionId, @createdAt, @updatedAt, @deletedAt
      )
    `).run(planToParams(plan));
  }

  getPlan(id: string): DailySearchPlan | null {
    const row = this.db
      .prepare(`SELECT ${PLAN_COLUMNS} FROM daily_search_plans WHERE id = ?`)
      .get(id) as DailySearchPlanRow | undefined;
    return row === undefined ? null : rowToPlan(row);
  }

  listPlans(): DailySearchPlan[] {
    const rows = this.db
      .prepare(`SELECT ${PLAN_COLUMNS} FROM daily_search_plans ORDER BY created_at DESC, id DESC`)
      .all() as DailySearchPlanRow[];
    return rows.map(rowToPlan);
  }

  /** 返回 status='active' 且有 activeVersionId 的计划（Scheduler 触发用）。 */
  listActivePlans(): DailySearchPlan[] {
    const rows = this.db
      .prepare(
        `SELECT ${PLAN_COLUMNS} FROM daily_search_plans
         WHERE status = 'active' AND active_version_id IS NOT NULL
         ORDER BY created_at DESC, id DESC`,
      )
      .all() as DailySearchPlanRow[];
    return rows.map(rowToPlan);
  }

  /** 部分更新（name/status/activeVersionId/deletedAt）。updated_at 由本方法置为当前时间。 */
  updatePlan(id: string, patch: DailySearchPlanPatch): void {
    const existing = this.getPlan(id);
    if (existing === null) return;
    const next: DailySearchPlan = {
      ...existing,
      name: patch.name ?? existing.name,
      status: patch.status ?? existing.status,
      activeVersionId: patch.activeVersionId === undefined ? existing.activeVersionId : patch.activeVersionId,
      deletedAt: patch.deletedAt === undefined ? existing.deletedAt : patch.deletedAt,
      updatedAt: Date.now(),
    };
    this.db.prepare(`
      UPDATE daily_search_plans
      SET name = @name, status = @status, active_version_id = @activeVersionId,
          updated_at = @updatedAt, deleted_at = @deletedAt
      WHERE id = @id
    `).run({
      id: next.id,
      name: next.name,
      status: next.status,
      activeVersionId: next.activeVersionId,
      updatedAt: next.updatedAt,
      deletedAt: next.deletedAt,
    });
  }

  // ── Version ────────────────────────────────────────────────────────────────

  insertVersion(version: DailySearchPlanVersion): void {
    this.db.prepare(`
      INSERT INTO daily_search_plan_versions (
        id, search_plan_id, version, cities_json, role_directions_json, base_keywords_json,
        expanded_keywords_json, hard_constraints_json, source_configs_json, schedule_json,
        scan_budget_json, analysis_budget_json, brief_policy_json, exploration_policy_json,
        notification_policy_json, latest_catch_up_time, created_at, activated_at,
        supersedes_version_id
      ) VALUES (
        @id, @searchPlanId, @version, @citiesJson, @roleDirectionsJson, @baseKeywordsJson,
        @expandedKeywordsJson, @hardConstraintsJson, @sourceConfigsJson, @scheduleJson,
        @scanBudgetJson, @analysisBudgetJson, @briefPolicyJson, @explorationPolicyJson,
        @notificationPolicyJson, @latestCatchUpTime, @createdAt, @activatedAt,
        @supersedesVersionId
      )
    `).run(versionToParams(version));
  }

  getVersion(id: string): DailySearchPlanVersion | null {
    const row = this.db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM daily_search_plan_versions WHERE id = ?`)
      .get(id) as DailySearchPlanVersionRow | undefined;
    return row === undefined ? null : rowToVersion(row);
  }

  listVersionsByPlan(planId: string): DailySearchPlanVersion[] {
    const rows = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM daily_search_plan_versions
         WHERE search_plan_id = ? ORDER BY version DESC`,
      )
      .all(planId) as DailySearchPlanVersionRow[];
    return rows.map(rowToVersion);
  }

  getActiveVersion(planId: string): DailySearchPlanVersion | null {
    const plan = this.getPlan(planId);
    if (plan === null || plan.activeVersionId === null) return null;
    return this.getVersion(plan.activeVersionId);
  }

  /** 激活版本：更新 plan.active_version_id 并记录 version.activated_at。 */
  setActiveVersion(planId: string, versionId: string): void {
    const version = this.getVersion(versionId);
    if (version === null || version.searchPlanId !== planId) return;
    const now = Date.now();
    this.db.prepare(`
      UPDATE daily_search_plans
      SET active_version_id = @versionId, updated_at = @now
      WHERE id = @planId
    `).run({ versionId, now, planId });
    this.db.prepare(`
      UPDATE daily_search_plan_versions
      SET activated_at = @now
      WHERE id = @versionId
    `).run({ now, versionId });
  }
}
