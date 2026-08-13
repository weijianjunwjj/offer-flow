import type { SqliteDatabase } from '../db';

/**
 * v0.9 Phase 1 / V9-1 Schema Migration（v9，仅限沙箱/测试/演练库）。
 *
 * 四项变更：
 * (1) 表重建 `radar_capture_snapshots`：扩展 `capture_method` CHECK 新增
 *     `'search_discovery'` 和 `'open_web_fetch'`；
 * (2) `radar_candidate_versions` 新增 additive 列 `evidence_level` 带 DEFAULT 'FULL_EVIDENCE'；
 * (3) 表重建 `radar_candidate_versions`：扩展 `origin_type` CHECK 新增 `'evidence_upgrade'`；
 * (4) 新增 `daily_job_briefs` 表的 `discovery_item_ids_json` 列（如果该表已存在，ALTER TABLE ADD COLUMN）。
 *
 * 不修改 v1-v8 既有表的其余语义与数据。
 *
 * 设计依据：
 *   specs/001-daily-job-hunter/tasks.md T009–T011
 *   specs/001-daily-job-hunter/plan.md v3.0 §2.2
 *   specs/001-daily-job-hunter/data-model.md v2.0
 *
 * 迁移方式：
 *   - 两张表各采用 SQLite 官方"表重建"流程（与 schema v8 的 radar_actions 表重建流程一致）；
 *   - 先 CREATE TABLE ..._v9_new（同结构 + 扩展 CHECK），再 INSERT INTO ... SELECT 复制既有行；
 *   - DROP 旧表 → RENAME 新表回原名 → 补索引；
 *   - 被引用表的表重建需要在 foreign_keys=OFF 条件下执行；
 *   - 重建期间开启 legacy_alter_table=ON，使 RENAME 不改写子表引用；
 *   - 重建后 runMigrations 恢复 foreign_keys 并执行 foreign_key_check 自检；
 *   - evidence_level 采用 ALTER TABLE ADD COLUMN（additive，不改既有行数据）。
 *
 * 关键约束：
 *   - 绝对禁止 PRAGMA writable_schema；
 *   - capture_method 既有值（boss_current_page / generic_visible_text / pasted_text /
 *     shared_link_and_text / json_import）逐字节保留；
 *   - origin_type 既有值（captured / manual_correction / source_change / merge_resolution）逐字节保留；
 *   - evidence_level 新列 DEFAULT 'FULL_EVIDENCE' 对既有行兼容（v0.8 CandidateVersion 均为 FULL_EVIDENCE）；
 *   - 所有既有行按原顺序复制，不改写任何数据。
 */

// ── (1) radar_capture_snapshots 表重建：capture_method CHECK 扩展 ─────────

/**
 * 重建 radar_capture_snapshots：
 * - capture_method CHECK 新增 'search_discovery' + 'open_web_fetch'
 * - 既有行逐字节复制
 * - 重建索引（外键由引用方保持，本表 DROP 后重建）
 */
const REBUILD_CAPTURE_SNAPSHOTS_SQL = `
CREATE TABLE radar_capture_snapshots_v9_new (
  id TEXT PRIMARY KEY,
  capture_session_id TEXT REFERENCES radar_capture_sessions(id) ON DELETE SET NULL,
  capture_method TEXT NOT NULL CHECK (
    capture_method IN (
      'boss_current_page', 'generic_visible_text',
      'pasted_text', 'shared_link_and_text', 'json_import',
      'search_discovery',
      'open_web_fetch'
    )
  ),
  provider_key TEXT,
  provider_version TEXT,
  source_domain TEXT,
  source_url TEXT,
  normalized_source_url TEXT,
  external_record_id TEXT,
  page_title TEXT,
  visible_text TEXT NOT NULL,
  raw_snapshot_json TEXT NOT NULL,
  raw_content_hash TEXT NOT NULL CHECK (length(trim(raw_content_hash)) > 0),
  captured_at INTEGER NOT NULL CHECK (typeof(captured_at) = 'integer' AND captured_at >= 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

INSERT INTO radar_capture_snapshots_v9_new (
  id, capture_session_id, capture_method, provider_key, provider_version,
  source_domain, source_url, normalized_source_url, external_record_id,
  page_title, visible_text, raw_snapshot_json, raw_content_hash,
  captured_at, created_at
)
SELECT
  id, capture_session_id, capture_method, provider_key, provider_version,
  source_domain, source_url, normalized_source_url, external_record_id,
  page_title, visible_text, raw_snapshot_json, raw_content_hash,
  captured_at, created_at
FROM radar_capture_snapshots
ORDER BY created_at, id;

DROP TABLE radar_capture_snapshots;
ALTER TABLE radar_capture_snapshots_v9_new RENAME TO radar_capture_snapshots;

CREATE INDEX radar_capture_snapshots_provider_idx
  ON radar_capture_snapshots(provider_key, external_record_id);
CREATE INDEX radar_capture_snapshots_source_url_idx
  ON radar_capture_snapshots(normalized_source_url);
CREATE INDEX radar_capture_snapshots_content_hash_idx
  ON radar_capture_snapshots(raw_content_hash);
CREATE INDEX radar_capture_snapshots_captured_at_idx
  ON radar_capture_snapshots(captured_at);
`;

// ── (2) radar_candidate_versions：evidence_level additive column ───────────

const ADD_EVIDENCE_LEVEL_COLUMN_SQL = `
ALTER TABLE radar_candidate_versions
ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'FULL_EVIDENCE' CHECK (
  evidence_level IN ('SEARCH_EVIDENCE', 'FULL_EVIDENCE', 'MANUAL_REVIEW_REQUIRED')
);
`;

// ── (3) radar_candidate_versions 表重建：origin_type CHECK 扩展 ───────────

/**
 * 重建 radar_candidate_versions：
 * - origin_type CHECK 新增 'evidence_upgrade'
 * - 保留 evidence_level 列
 * - 既有行逐字节复制
 * - 重建 UNIQUE 约束和索引
 */
const REBUILD_CANDIDATE_VERSIONS_SQL = `
CREATE TABLE radar_candidate_versions_v9_new (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (typeof(version_no) = 'integer' AND version_no >= 1),
  normalized_json TEXT NOT NULL,
  quality_issues_json TEXT NOT NULL,
  source_snapshot_ids_json TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0),
  origin_type TEXT NOT NULL CHECK (
    origin_type IN ('captured', 'manual_correction', 'source_change', 'merge_resolution', 'evidence_upgrade')
  ),
  evidence_level TEXT NOT NULL DEFAULT 'FULL_EVIDENCE' CHECK (
    evidence_level IN ('SEARCH_EVIDENCE', 'FULL_EVIDENCE', 'MANUAL_REVIEW_REQUIRED')
  ),
  correction_note TEXT,
  supersedes_version_id TEXT REFERENCES radar_candidate_versions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  UNIQUE (candidate_id, version_no),
  UNIQUE (candidate_id, content_hash),
  CHECK (supersedes_version_id IS NULL OR supersedes_version_id <> id)
);

INSERT INTO radar_candidate_versions_v9_new (
  id, candidate_id, version_no, normalized_json, quality_issues_json,
  source_snapshot_ids_json, content_hash, origin_type, evidence_level,
  correction_note, supersedes_version_id, created_at
)
SELECT
  id, candidate_id, version_no, normalized_json, quality_issues_json,
  source_snapshot_ids_json, content_hash, origin_type, evidence_level,
  correction_note, supersedes_version_id, created_at
FROM radar_candidate_versions
ORDER BY candidate_id, version_no;

DROP TABLE radar_candidate_versions;
ALTER TABLE radar_candidate_versions_v9_new RENAME TO radar_candidate_versions;

CREATE INDEX radar_candidate_versions_candidate_idx
  ON radar_candidate_versions(candidate_id, version_no DESC);
`;

// ── (4) daily_job_briefs：discovery_item_ids_json additive column ──────────

/**
 * 如果 daily_job_briefs 表已在 v0.9 之前创建（例如之前 Phase 创建的空表），
 * 补齐 discovery_item_ids_json 列。如果表尚未创建，此语句会静默跳过。
 *
 * 实际执行时：如果表已存在 → ADD COLUMN；如果表不存在 → 跳过（本迁移不负责建表，
 * daily_job_briefs 表的完整 DDL 由 Phase 4 完成）。
 *
 * ⚠️ Phase 4 约束：daily_job_briefs 的初始 CREATE TABLE DDL 必须包含
 * discovery_item_ids_json TEXT 列（允许 NULL）。该列用于存储 SEARCH_EVIDENCE /
 * MANUAL_REVIEW_REQUIRED 候选版本 ID 的 JSON 数组，非权威推荐集合。
 * 如果 Phase 4 建表时未包含此列，需在此 migration 中再次尝试 ADD COLUMN 补齐。
 */
const ADD_DISCOVERY_ITEM_IDS_SQL = `
ALTER TABLE daily_job_briefs ADD COLUMN discovery_item_ids_json TEXT;
`;

// ── Up function ────────────────────────────────────────────────────────────

export function createDailyJobHunterSchemaV9(db: SqliteDatabase): void {
  // Step 1: 重建 radar_capture_snapshots（扩展 capture_method CHECK）
  // foreign_keys 已由 runMigrations 在事务外关闭，legacy_alter_table=ON 确保
  // RENAME 不改写引用本表的外键（radar_source_records.latest_snapshot_id）。
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(REBUILD_CAPTURE_SNAPSHOTS_SQL);
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }

  // Step 2: radar_candidate_versions 新增 evidence_level 列
  // 必须在表重建之前执行，因为重建后的表定义也包含此列。
  db.exec(ADD_EVIDENCE_LEVEL_COLUMN_SQL);

  // Step 3: 重建 radar_candidate_versions（扩展 origin_type CHECK）
  // 该表被 radar_candidates 的 active_version_id FK 引用，
  // 也被 analysis_tasks、job_match_analysis_records、radar_actions、
  // radar_promotions 等表引用。RENAME 不改写子表引用。
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(REBUILD_CANDIDATE_VERSIONS_SQL);
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }

  // Step 4: daily_job_briefs 补齐 discovery_item_ids_json
  // 如果表不存在则跳过（ALTE TABLE 无 IF NOT EXISTS，需通过 try/catch）。
  try {
    db.exec(ADD_DISCOVERY_ITEM_IDS_SQL);
  } catch {
    // 表不存在——daily_job_briefs 由 Phase 4 完整建表。
    // 此时 discovery_item_ids_json 不适用，静默跳过。
  }
}
