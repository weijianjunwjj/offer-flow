import type { SqliteDatabase } from '../db';

/**
 * v0.9 Phase 3（T021）每日搜索计划 schema（v10，仅限沙箱/测试/演练库）。
 *
 * 纯新增两张表：
 * (1) `daily_search_plans` —— 逻辑搜索计划 identity；
 * (2) `daily_search_plan_versions` —— 不可变版本快照。
 *
 * 不修改 v1-v9 既有表的其余语义与数据。
 *
 * 关键约束：
 *   - daily_search_plan_versions 不可变（UNIQUE(search_plan_id, version) 承载版本身份）；
 *   - active_version_id 由 daily_search_plans 指向当前激活版本，SET NULL 表示尚未激活；
 *   - 两张表为纯新增，无既有行需要复制，无需表重建流程。
 */

const CREATE_DAILY_SEARCH_PLANS_SQL = `
CREATE TABLE daily_search_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
  active_version_id TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= created_at)),
  FOREIGN KEY (active_version_id) REFERENCES daily_search_plan_versions(id) ON DELETE SET NULL
);

CREATE INDEX daily_search_plans_status_idx ON daily_search_plans(status, updated_at DESC);
`;

const CREATE_DAILY_SEARCH_PLAN_VERSIONS_SQL = `
CREATE TABLE daily_search_plan_versions (
  id TEXT PRIMARY KEY,
  search_plan_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),

  cities_json TEXT NOT NULL,
  role_directions_json TEXT NOT NULL,
  base_keywords_json TEXT NOT NULL,
  expanded_keywords_json TEXT NOT NULL DEFAULT '[]',

  hard_constraints_json TEXT NOT NULL DEFAULT '[]',
  source_configs_json TEXT NOT NULL,

  schedule_json TEXT NOT NULL,
  scan_budget_json TEXT NOT NULL,
  analysis_budget_json TEXT NOT NULL,

  brief_policy_json TEXT NOT NULL,
  exploration_policy_json TEXT NOT NULL DEFAULT '{}',
  notification_policy_json TEXT NOT NULL,

  latest_catch_up_time TEXT NOT NULL,

  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  activated_at INTEGER CHECK (activated_at IS NULL OR (typeof(activated_at) = 'integer' AND activated_at >= 0)),
  supersedes_version_id TEXT,

  FOREIGN KEY (search_plan_id) REFERENCES daily_search_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (supersedes_version_id) REFERENCES daily_search_plan_versions(id) ON DELETE SET NULL,
  UNIQUE (search_plan_id, version)
);

CREATE INDEX daily_search_plan_versions_plan_idx ON daily_search_plan_versions(search_plan_id, version DESC);
`;

export function createDailySearchPlanSchemaV10(db: SqliteDatabase): void {
  db.exec(CREATE_DAILY_SEARCH_PLANS_SQL);
  db.exec(CREATE_DAILY_SEARCH_PLAN_VERSIONS_SQL);
}
