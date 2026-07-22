import type { SqliteDatabase } from '../db';

/**
 * v0.8 V8-3 候选关系 schema（v8，仅限沙箱/测试/演练库）。
 *
 * 纯新增 1 张候选关系表 `radar_candidate_relations`，并最小扩展 `radar_actions.action_type`
 * 以承载重复裁决审计事件；不修改 v1-v7 既有表的语义与数据。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §14b。
 *
 * 关键约束：
 * - 候选对按 (candidate_id_low, candidate_id_high) 稳定排序写入，(A,B) 与 (B,A) 归一；
 * - candidate_id_low <> candidate_id_high，禁止自环；
 * - UNIQUE(candidate_id_low, candidate_id_high) 承载"当前有效关系"，防重复提示；
 * - 两个候选 ID 均外键 RESTRICT 关联 radar_candidates；
 * - resolution_action_id 外键 RESTRICT 关联 radar_actions（裁决事件）；
 * - superseded_by_relation_id 自引用，表达关系被取代的拓扑；
 * - signals_json 由上层 Zod 严格校验，DB 层仅存文本。
 *
 * action_type 扩展采用 SQLite 官方"表重建"流程修改 CHECK 约束：
 * runMigrations 已在事务外关闭 foreign_keys（PRAGMA foreign_keys 在事务内是 no-op），
 * 因此本迁移只需在重建期间开启 legacy_alter_table，使 RENAME 不改写子表
 * （radar_promotions.trigger_action_id）对本表的引用；既有 radar_actions 行按
 * created_at, id 顺序原样复制，ID/时间/metadata 逐字节保留。重建后 runMigrations
 * 恢复 foreign_keys 并执行 foreign_key_check 自检，任何悬挂引用都会触发回滚。
 */

const CREATE_CANDIDATE_RELATIONS_SQL = `
CREATE TABLE radar_candidate_relations (
  id TEXT PRIMARY KEY,
  candidate_id_low TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  candidate_id_high TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('suspected_duplicate', 'confirmed_same', 'confirmed_distinct', 'needs_recheck', 'superseded')
  ),
  reason_code TEXT,
  signals_json TEXT NOT NULL,
  first_detected_at INTEGER NOT NULL CHECK (typeof(first_detected_at) = 'integer' AND first_detected_at >= 0),
  last_detected_at INTEGER NOT NULL CHECK (
    typeof(last_detected_at) = 'integer' AND last_detected_at >= first_detected_at
  ),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR (typeof(resolved_at) = 'integer' AND resolved_at >= 0)),
  resolution_action_id TEXT REFERENCES radar_actions(id) ON DELETE RESTRICT,
  superseded_by_relation_id TEXT REFERENCES radar_candidate_relations(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  CHECK (candidate_id_low <> candidate_id_high),
  CHECK (candidate_id_low < candidate_id_high),
  CHECK (superseded_by_relation_id IS NULL OR superseded_by_relation_id <> id),
  UNIQUE (candidate_id_low, candidate_id_high)
);

CREATE INDEX radar_candidate_relations_low_idx
  ON radar_candidate_relations(candidate_id_low, status);
CREATE INDEX radar_candidate_relations_high_idx
  ON radar_candidate_relations(candidate_id_high, status);
CREATE INDEX radar_candidate_relations_status_idx
  ON radar_candidate_relations(status, last_detected_at DESC);
`;

/**
 * radar_actions.action_type 扩展 4 个重复裁决事件类型。
 * 新表用扩展后的 CHECK，按 created_at,id 顺序复制既有行，DROP 旧表后 RENAME 回原名，
 * 重建 radar_actions_candidate_idx 索引。RENAME 期间由调用方开启的 legacy_alter_table
 * 保证 radar_promotions.trigger_action_id 的引用不被改写。
 */
const REBUILD_RADAR_ACTIONS_SQL = `
CREATE TABLE radar_actions_v8_new (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  candidate_version_id TEXT NOT NULL REFERENCES radar_candidate_versions(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (
    action_type IN (
      'saved', 'unsaved', 'ignored', 'ignore_reverted',
      'marked_priority', 'priority_reverted',
      'marked_applied_pending', 'applied_pending_reverted',
      'rule_override_set', 'rule_override_reverted',
      'promotion_requested',
      'duplicate_confirmed', 'duplicate_rejected',
      'duplicate_decision_reverted', 'duplicate_recheck_requested'
    )
  ),
  reason_code TEXT,
  reason_text TEXT,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at >= 0),
  reverted_by_action_id TEXT REFERENCES radar_actions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  CHECK (reverted_by_action_id IS NULL OR reverted_by_action_id <> id)
);

INSERT INTO radar_actions_v8_new (
  id, candidate_id, candidate_version_id, action_type, reason_code, reason_text,
  metadata_json, occurred_at, reverted_by_action_id, created_at
)
SELECT
  id, candidate_id, candidate_version_id, action_type, reason_code, reason_text,
  metadata_json, occurred_at, reverted_by_action_id, created_at
FROM radar_actions
ORDER BY created_at, id;

DROP TABLE radar_actions;
ALTER TABLE radar_actions_v8_new RENAME TO radar_actions;

CREATE INDEX radar_actions_candidate_idx
  ON radar_actions(candidate_id, occurred_at DESC);
`;

export function createRadarCandidateRelationsSchemaV8(db: SqliteDatabase): void {
  // radar_actions 重建需 DROP+RENAME 一张被 radar_promotions 引用的表；
  // foreign_keys 已由 runMigrations 在事务外关闭。legacy_alter_table=ON 使 RENAME
  // 不改写子表对本表的引用；关系表放在重建之后创建，避免其 FK 影响重建流程。
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(REBUILD_RADAR_ACTIONS_SQL);
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
  db.exec(CREATE_CANDIDATE_RELATIONS_SQL);
}
