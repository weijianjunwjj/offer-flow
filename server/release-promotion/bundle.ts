import type Database from 'better-sqlite3';
import { canonicalJson, sha256RequestHash } from '../job-memory/requestHash';
import { getDatabaseSchemaVersion, STRATEGY_WINDOW_SCHEMA_VERSION } from '../migrations';

export const PROMOTION_BUNDLE_VERSION = 1;
const ACCEPTED_STATUSES = new Set(['accepted', 'modified_and_accepted']);

export class PromotionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PromotionError';
  }
}

export interface PromotionBundle {
  bundleVersion: number;
  exportedAt: number;
  sourceDatabasePath: string;
  sourceDatabaseHash: string;
  sourceSchemaVersion: number;
  dataCutoff: number;
  sourceVersionIds: {
    jobMatchProfileVersionId: string | null;
    capabilityBaselineVersionId: string | null;
    marketPositionVersionId: string | null;
  };
  marketPosition: {
    activeVersionId: string;
    metaStateVersion: number;
    version: Record<string, unknown>;
    sourceProposal: Record<string, unknown>;
  };
  strategy: {
    activeWindowId: string;
    activeVersionId: string;
    metaStateVersion: number;
    version: Record<string, unknown>;
    sourceProposal: Record<string, unknown>;
  };
  payloadCanonicalHash: string;
}

export interface PromotionAttestation {
  bundleVersion: number;
  exportedAt: number;
  sourceDatabasePath: string;
  sourceDatabaseHash: string;
  sourceSchemaVersion: number;
  dataCutoff: number;
  g4ActiveVersionId: string;
  g4ActiveVersionHash: string;
  g5ActiveWindowId: string;
  g5ActiveWindowHash: string;
  g5ActiveVersionId: string;
  g5ActiveVersionHash: string;
  sourceVersionIds: PromotionBundle['sourceVersionIds'];
  payloadCanonicalHash: string;
  bundleHash: string;
}

interface MetaRow { active_version_id: string | null; state_version: number }
interface VersionRow { id: string; data_json: string }
interface ProposalRow { id: string; status: string; data_json: string }

function readActiveVersion(db: Database.Database, table: string, metaTable: string): {
  activeVersionId: string; stateVersion: number; version: Record<string, unknown>;
} {
  const meta = db.prepare(`SELECT active_version_id, state_version FROM ${metaTable} WHERE id='default'`).get() as MetaRow | undefined;
  if (meta === undefined || meta.active_version_id === null) {
    throw new PromotionError('NO_ACTIVE_VERSION', `${metaTable} 缺少 active 版本，无法晋升（来源尚未在沙箱验收激活）`);
  }
  const activeVersionId = meta.active_version_id;
  const row = db.prepare(`SELECT id, data_json FROM ${table} WHERE id=?`).get(activeVersionId) as VersionRow | undefined;
  if (row === undefined) {
    throw new PromotionError('NO_ACTIVE_VERSION', `${table} 的 active 版本 ${activeVersionId} 不存在`);
  }
  const version = JSON.parse(row.data_json) as Record<string, unknown>;
  if (version.status !== 'active') {
    throw new PromotionError('NO_ACTIVE_VERSION', `${table} 的 ${activeVersionId} 状态不是 active`);
  }
  return { activeVersionId, stateVersion: meta.state_version, version };
}

function readSourceProposal(db: Database.Database, table: string, proposalId: string): Record<string, unknown> {
  const row = db.prepare(`SELECT id, status, data_json FROM ${table} WHERE id=?`).get(proposalId) as ProposalRow | undefined;
  if (row === undefined) {
    throw new PromotionError('PROPOSAL_MISSING', `晋升来源提案 ${proposalId} 不存在`);
  }
  if (!ACCEPTED_STATUSES.has(row.status)) {
    throw new PromotionError('PROPOSAL_NOT_ACCEPTED', `晋升来源提案 ${proposalId} 状态为 ${row.status}，只允许 accepted / modified_and_accepted`);
  }
  return JSON.parse(row.data_json) as Record<string, unknown>;
}

/**
 * 从沙箱来源库导出 G4/G5 正式版本晋升包（只读来源，不修改）。
 * 只包含 active 版本及其 accepted/modified_and_accepted 来源提案，绝不包含 pending/rejected/
 * deferred/stale 提案、命令回执、Job/Application/FeedbackEvent 或其他无关版本。
 */
export function exportPromotionBundle(
  db: Database.Database,
  options: { sourceDatabasePath: string; sourceDatabaseHash: string; now?: () => number },
): { bundle: PromotionBundle; attestation: PromotionAttestation } {
  const schemaVersion = getDatabaseSchemaVersion(db);
  if (schemaVersion !== STRATEGY_WINDOW_SCHEMA_VERSION) {
    throw new PromotionError('BAD_SOURCE_SCHEMA', `晋升来源 schema 必须为 v${STRATEGY_WINDOW_SCHEMA_VERSION}，实际 v${schemaVersion}`);
  }
  const now = (options.now ?? Date.now)();

  const mp = readActiveVersion(db, 'market_position_versions', 'market_position_meta');
  const mpProposalId = mp.version.proposalId as string;
  const mpProposal = readSourceProposal(db, 'market_position_proposals', mpProposalId);

  const sw = readActiveVersion(db, 'strategy_versions', 'strategy_meta');
  const swProposalId = sw.version.proposalId as string;
  const swProposal = readSourceProposal(db, 'strategy_proposals', swProposalId);

  // 版本↔提案关系完整。
  if (mpProposal.id !== mp.version.proposalId) {
    throw new PromotionError('BROKEN_LINK', 'G4 版本与来源提案关系不一致');
  }
  if (swProposal.id !== sw.version.proposalId) {
    throw new PromotionError('BROKEN_LINK', 'G5 版本与来源提案关系不一致');
  }

  // G5 引用的 G4 version 必须与当前 active G4 version 一致。
  const swWindow = sw.version.window as Record<string, unknown>;
  const swSourceIds = swWindow.sourceVersionIds as Record<string, unknown>;
  if (swSourceIds.marketPositionVersionId !== mp.activeVersionId) {
    throw new PromotionError('G4_REF_MISMATCH', 'G5 策略窗口引用的 G4 版本与当前 active G4 版本不一致');
  }
  const swSnapshot = sw.version.inputSnapshot as Record<string, unknown>;
  if (swSnapshot.marketPositionVersionId !== mp.activeVersionId) {
    throw new PromotionError('G4_REF_MISMATCH', 'G5 输入快照引用的 G4 版本与当前 active G4 版本不一致');
  }

  // Evidence ID 必须来自正式 accepted 证据（若来源库存在能力基线表）。
  const evidenceIds = (swSnapshot.acceptedEvidenceIds as string[] | undefined) ?? [];
  if (evidenceIds.length > 0 && tableExists(db, 'candidate_evidence')) {
    const accepted = new Set(
      (db.prepare("SELECT id FROM candidate_evidence WHERE status IN ('accepted','modified_and_accepted')").all() as Array<{ id: string }>).map((r) => r.id),
    );
    const bad = evidenceIds.find((id) => !accepted.has(id));
    if (bad !== undefined) {
      throw new PromotionError('EVIDENCE_INVALID', `晋升来源引用了非正式接受的证据 ID：${bad}`);
    }
  }

  const bundleCore = {
    bundleVersion: PROMOTION_BUNDLE_VERSION,
    exportedAt: now,
    sourceDatabasePath: options.sourceDatabasePath,
    sourceDatabaseHash: options.sourceDatabaseHash,
    sourceSchemaVersion: schemaVersion,
    dataCutoff: (swWindow.dataCutoffAt as number) ?? (swSnapshot.capturedAt as number) ?? now,
    sourceVersionIds: {
      jobMatchProfileVersionId: (swSourceIds.jobMatchProfileVersionId as string | null) ?? null,
      capabilityBaselineVersionId: (swSourceIds.capabilityBaselineVersionId as string | null) ?? null,
      marketPositionVersionId: mp.activeVersionId,
    },
    marketPosition: {
      activeVersionId: mp.activeVersionId,
      metaStateVersion: mp.stateVersion,
      version: mp.version,
      sourceProposal: mpProposal,
    },
    strategy: {
      activeWindowId: swWindow.id as string,
      activeVersionId: sw.activeVersionId,
      metaStateVersion: sw.stateVersion,
      version: sw.version,
      sourceProposal: swProposal,
    },
  };
  const payloadCanonicalHash = sha256RequestHash({
    mpVersion: mp.version, mpProposal, swVersion: sw.version, swProposal,
  });
  const bundle: PromotionBundle = { ...bundleCore, payloadCanonicalHash };
  const attestation: PromotionAttestation = {
    bundleVersion: PROMOTION_BUNDLE_VERSION,
    exportedAt: now,
    sourceDatabasePath: options.sourceDatabasePath,
    sourceDatabaseHash: options.sourceDatabaseHash,
    sourceSchemaVersion: schemaVersion,
    dataCutoff: bundle.dataCutoff,
    g4ActiveVersionId: mp.activeVersionId,
    g4ActiveVersionHash: sha256RequestHash(mp.version),
    g5ActiveWindowId: swWindow.id as string,
    g5ActiveWindowHash: sha256RequestHash(swWindow),
    g5ActiveVersionId: sw.activeVersionId,
    g5ActiveVersionHash: sha256RequestHash(sw.version),
    sourceVersionIds: bundle.sourceVersionIds,
    payloadCanonicalHash,
    bundleHash: sha256RequestHash(bundle),
  };
  return { bundle, attestation };
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function assertKnownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new PromotionError('UNKNOWN_FIELD', `晋升包 ${where} 含未知字段：${key}`);
    }
  }
}

const BUNDLE_KEYS = [
  'bundleVersion', 'exportedAt', 'sourceDatabasePath', 'sourceDatabaseHash', 'sourceSchemaVersion',
  'dataCutoff', 'sourceVersionIds', 'marketPosition', 'strategy', 'payloadCanonicalHash',
];

export interface ImportResult {
  applied: boolean;
  alreadyApplied: boolean;
  marketPositionVersionId: string;
  strategyVersionId: string;
}

/**
 * 将晋升包事务性导入目标候选库（schema v6，G4/G5 表为空）。失败零写入。
 * 幂等：相同 bundle 且所有 id/payload hash 完全一致时返回 alreadyApplied，不重复写入；
 * 相同 id 但 payload/hash 不同，或目标已有其它 active 版本，立即停止。
 */
export function importPromotionBundle(
  db: Database.Database,
  bundle: PromotionBundle,
  attestation: PromotionAttestation,
): ImportResult {
  if (bundle.bundleVersion !== PROMOTION_BUNDLE_VERSION) {
    throw new PromotionError('BAD_BUNDLE_VERSION', `不支持的晋升包版本：${bundle.bundleVersion}`);
  }
  assertKnownKeys(bundle as unknown as Record<string, unknown>, BUNDLE_KEYS, 'root');
  const schemaVersion = getDatabaseSchemaVersion(db);
  if (schemaVersion !== STRATEGY_WINDOW_SCHEMA_VERSION) {
    throw new PromotionError('BAD_TARGET_SCHEMA', `导入目标 schema 必须为 v${STRATEGY_WINDOW_SCHEMA_VERSION}，实际 v${schemaVersion}`);
  }
  // 校验 payload hash 与 bundle hash 一致，防止篡改。
  const recomputedPayload = sha256RequestHash({
    mpVersion: bundle.marketPosition.version, mpProposal: bundle.marketPosition.sourceProposal,
    swVersion: bundle.strategy.version, swProposal: bundle.strategy.sourceProposal,
  });
  if (recomputedPayload !== bundle.payloadCanonicalHash || recomputedPayload !== attestation.payloadCanonicalHash) {
    throw new PromotionError('PAYLOAD_HASH_MISMATCH', '晋升包 payload hash 与内容不一致，拒绝导入');
  }
  if (sha256RequestHash(bundle) !== attestation.bundleHash) {
    throw new PromotionError('BUNDLE_HASH_MISMATCH', '晋升包 bundle hash 与 attestation 不一致，拒绝导入');
  }

  const mpMeta = db.prepare("SELECT active_version_id, state_version FROM market_position_meta WHERE id='default'").get() as MetaRow | undefined;
  const swMeta = db.prepare("SELECT active_version_id, state_version FROM strategy_meta WHERE id='default'").get() as MetaRow | undefined;

  const mpTargetActive = mpMeta?.active_version_id ?? null;
  const swTargetActive = swMeta?.active_version_id ?? null;

  // alreadyApplied 判定：目标 active 与 bundle 完全一致（id + payload hash）。
  if (mpTargetActive !== null || swTargetActive !== null) {
    const mpSame = mpTargetActive === bundle.marketPosition.activeVersionId
      && sameVersionPayload(db, 'market_position_versions', bundle.marketPosition.activeVersionId, bundle.marketPosition.version);
    const swSame = swTargetActive === bundle.strategy.activeVersionId
      && sameVersionPayload(db, 'strategy_versions', bundle.strategy.activeVersionId, bundle.strategy.version);
    if (mpSame && swSame) {
      return { applied: false, alreadyApplied: true, marketPositionVersionId: bundle.marketPosition.activeVersionId, strategyVersionId: bundle.strategy.activeVersionId };
    }
    // 目标已有 active 版本但与 bundle 不同：拒绝。
    throw new PromotionError('TARGET_HAS_ACTIVE', '目标候选库已存在与晋升包不一致的 active G4/G5 版本，拒绝导入');
  }

  // 目标存在相同 id 但 payload 不同（历史归档等）→ 停止。
  assertNoConflictingId(db, 'market_position_versions', bundle.marketPosition.activeVersionId, bundle.marketPosition.version);
  assertNoConflictingId(db, 'strategy_versions', bundle.strategy.activeVersionId, bundle.strategy.version);

  const tx = db.transaction(() => {
    const now = Date.now();
    upsertMeta(db, 'market_position_meta', bundle.marketPosition.activeVersionId, bundle.marketPosition.metaStateVersion, now);
    insertVersion(db, 'market_position_versions', bundle.marketPosition.version);
    insertProposal(db, 'market_position_proposals', bundle.marketPosition.sourceProposal);
    upsertMeta(db, 'strategy_meta', bundle.strategy.activeVersionId, bundle.strategy.metaStateVersion, now);
    insertVersion(db, 'strategy_versions', bundle.strategy.version);
    insertProposal(db, 'strategy_proposals', bundle.strategy.sourceProposal);
  });
  tx();
  return { applied: true, alreadyApplied: false, marketPositionVersionId: bundle.marketPosition.activeVersionId, strategyVersionId: bundle.strategy.activeVersionId };
}

function sameVersionPayload(db: Database.Database, table: string, id: string, expected: Record<string, unknown>): boolean {
  const row = db.prepare(`SELECT data_json FROM ${table} WHERE id=?`).get(id) as { data_json: string } | undefined;
  if (row === undefined) return false;
  return canonicalJson(JSON.parse(row.data_json)) === canonicalJson(expected);
}

function assertNoConflictingId(db: Database.Database, table: string, id: string, expected: Record<string, unknown>): void {
  const row = db.prepare(`SELECT data_json FROM ${table} WHERE id=?`).get(id) as { data_json: string } | undefined;
  if (row !== undefined && canonicalJson(JSON.parse(row.data_json)) !== canonicalJson(expected)) {
    throw new PromotionError('ID_PAYLOAD_CONFLICT', `目标库已存在 ${table} 中相同 id ${id} 但 payload 不同，拒绝导入`);
  }
}

function upsertMeta(db: Database.Database, table: string, activeId: string, stateVersion: number, now: number): void {
  db.prepare(
    `INSERT INTO ${table} (id, state_version, active_version_id, updated_at) VALUES ('default', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state_version=excluded.state_version, active_version_id=excluded.active_version_id, updated_at=excluded.updated_at`,
  ).run(stateVersion, activeId, now);
}

function insertVersion(db: Database.Database, table: string, version: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO ${table} (id, version, status, proposal_id, data_json, created_at, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    version.id, version.version, version.status, version.proposalId,
    JSON.stringify(version), version.createdAt, version.activatedAt,
  );
}

function insertProposal(db: Database.Database, table: string, proposal: Record<string, unknown>): void {
  const snapshot = proposal.inputSnapshot as Record<string, unknown>;
  db.prepare(
    `INSERT INTO ${table} (id, status, generated_by, input_fingerprint, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    proposal.id, proposal.status, proposal.generatedBy, snapshot.inputHash,
    JSON.stringify(proposal), proposal.createdAt,
  );
}
