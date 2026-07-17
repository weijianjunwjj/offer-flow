import type { SqliteDatabase } from '../db';

/**
 * G4 市场位置画像正式持久化（schema v5，仅限沙箱/临时库）。
 * 纯新增表，不修改 v2/v3/v4 既有表与数据；提案、正式版本、命令回执各自独立成表，
 * 与 G2 能力基线的持久化模式一致。真实生产库（PRODUCTION_SCHEMA_VERSION 固定为 2）
 * 不得升级到 v5，也不在真实服务入口开启本能力。
 */
export const MARKET_POSITION_SCHEMA_V5_SQL = `
CREATE TABLE market_position_meta (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(state_version) = 'integer' AND state_version >= 0
  ),
  active_version_id TEXT,
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);

CREATE TABLE market_position_proposals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'accepted', 'modified_and_accepted', 'rejected', 'deferred')
  ),
  generated_by TEXT NOT NULL CHECK (generated_by IN ('ai', 'manual')),
  input_fingerprint TEXT NOT NULL CHECK (length(trim(input_fingerprint)) > 0),
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE TABLE market_position_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  proposal_id TEXT NOT NULL CHECK (length(trim(proposal_id)) > 0),
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  activated_at INTEGER NOT NULL CHECK (typeof(activated_at) = 'integer' AND activated_at >= 0)
);

CREATE TABLE market_position_receipts (
  idempotency_key TEXT PRIMARY KEY CHECK (length(trim(idempotency_key)) > 0),
  command_type TEXT NOT NULL CHECK (
    command_type IN (
      'generate_proposal', 'manual_proposal', 'accept_proposal',
      'reject_proposal', 'defer_proposal', 'activate_version'
    )
  ),
  target_id TEXT,
  result_id TEXT,
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE INDEX market_position_proposals_status_idx
  ON market_position_proposals(status, created_at);
CREATE INDEX market_position_versions_status_idx
  ON market_position_versions(status, version);
`;

export function createMarketPositionSchemaV5(db: SqliteDatabase): void {
  db.exec(MARKET_POSITION_SCHEMA_V5_SQL);
}
