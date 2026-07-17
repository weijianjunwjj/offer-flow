import {
  MarketPositionStateSchema,
  createEmptyMarketPositionState,
  type MarketPositionProposal,
  type MarketPositionState,
  type MarketPositionVersion,
} from '../../src/domain/market-position';
import type { SqliteDatabase } from '../db';

const META_ID = 'default';

export class MarketPositionStateVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('市场位置画像状态版本冲突');
    this.name = 'MarketPositionStateVersionConflictError';
  }
}

interface MetaRow {
  state_version: number;
  active_version_id: string | null;
}

/**
 * 市场位置画像（G4）正式持久化仓库。
 * 提案、正式版本、命令回执各自独立成表；单次命令在一个事务内以乐观并发
 * （state_version）读改写整份状态，与 G2 能力基线的持久化模式一致。
 */
export class MarketPositionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private readMeta(): MetaRow | null {
    return (this.db
      .prepare('SELECT state_version, active_version_id FROM market_position_meta WHERE id = ?')
      .get(META_ID) as MetaRow | undefined) ?? null;
  }

  getState(): MarketPositionState {
    const meta = this.readMeta();
    if (meta === null) return createEmptyMarketPositionState();
    const proposals = (this.db
      .prepare('SELECT data_json FROM market_position_proposals ORDER BY created_at, id')
      .all() as Array<{ data_json: string }>)
      .map((row) => JSON.parse(row.data_json) as MarketPositionProposal);
    const versions = (this.db
      .prepare('SELECT data_json FROM market_position_versions ORDER BY version')
      .all() as Array<{ data_json: string }>)
      .map((row) => JSON.parse(row.data_json) as MarketPositionVersion);
    const commandReceipts = this.db
      .prepare(
        `SELECT idempotency_key AS idempotencyKey, command_type AS commandType,
                target_id AS targetId, result_id AS resultId,
                request_hash AS requestHash, created_at AS createdAt
         FROM market_position_receipts ORDER BY created_at, idempotency_key`,
      )
      .all() as MarketPositionState['commandReceipts'];
    return MarketPositionStateSchema.parse({
      stateVersion: meta.state_version,
      activeVersionId: meta.active_version_id,
      versions,
      proposals,
      commandReceipts,
    });
  }

  private persist(state: MarketPositionState): void {
    this.db.prepare('DELETE FROM market_position_proposals').run();
    this.db.prepare('DELETE FROM market_position_versions').run();
    this.db.prepare('DELETE FROM market_position_receipts').run();

    const insertProposal = this.db.prepare(
      `INSERT INTO market_position_proposals
        (id, status, generated_by, input_fingerprint, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of state.proposals) {
      insertProposal.run(
        item.id, item.status, item.generatedBy, item.inputSnapshot.inputHash,
        JSON.stringify(item), item.createdAt,
      );
    }

    const insertVersion = this.db.prepare(
      `INSERT INTO market_position_versions
        (id, version, status, proposal_id, data_json, created_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of state.versions) {
      insertVersion.run(
        item.id, item.version, item.status, item.proposalId,
        JSON.stringify(item), item.createdAt, item.activatedAt,
      );
    }

    const insertReceipt = this.db.prepare(
      `INSERT INTO market_position_receipts
        (idempotency_key, command_type, target_id, result_id, request_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const receipt of state.commandReceipts) {
      insertReceipt.run(
        receipt.idempotencyKey, receipt.commandType, receipt.targetId,
        receipt.resultId, receipt.requestHash, receipt.createdAt,
      );
    }

    this.db
      .prepare(
        `INSERT INTO market_position_meta (id, state_version, active_version_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state_version = excluded.state_version,
           active_version_id = excluded.active_version_id,
           updated_at = excluded.updated_at`,
      )
      .run(META_ID, state.stateVersion, state.activeVersionId, Date.now());
  }

  updateState(
    expectedStateVersion: number,
    update: (current: MarketPositionState) => MarketPositionState,
  ): MarketPositionState {
    const transaction = this.db.transaction(() => {
      const current = this.getState();
      if (current.stateVersion !== expectedStateVersion) {
        throw new MarketPositionStateVersionConflictError(current.stateVersion);
      }
      const next = MarketPositionStateSchema.parse(update(structuredClone(current)));
      this.persist(next);
      return next;
    });
    return transaction.immediate();
  }
}
