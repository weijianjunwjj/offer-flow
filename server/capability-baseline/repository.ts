import {
  CapabilityBaselineStateSchema,
  createEmptyCapabilityBaselineState,
  type CandidateEvidence,
  type CapabilityBaselineProposal,
  type CapabilityBaselineState,
  type CapabilityBaselineVersion,
  type CapabilityCommandReceipt,
} from '../../src/domain/capability-baseline';
import type { SqliteDatabase } from '../db';

const META_ID = 'default';

export class CapabilityStateVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('能力基线状态版本冲突');
    this.name = 'CapabilityStateVersionConflictError';
  }
}

interface MetaRow {
  state_version: number;
  active_version_id: string | null;
}

/**
 * 能力基线正式持久化仓库。
 * 候选证据、基线提案、正式版本、命令回执各自独立成表；
 * 单次命令在一个事务内以乐观并发（state_version）读改写整份状态。
 */
export class CapabilityBaselineRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private readMeta(): MetaRow | null {
    return (this.db
      .prepare('SELECT state_version, active_version_id FROM capability_baseline_meta WHERE id = ?')
      .get(META_ID) as MetaRow | undefined) ?? null;
  }

  getState(): CapabilityBaselineState {
    const meta = this.readMeta();
    if (meta === null) return createEmptyCapabilityBaselineState();
    const evidence = (this.db
      .prepare('SELECT data_json FROM candidate_evidence ORDER BY created_at, id')
      .all() as Array<{ data_json: string }>)
      .map((row) => JSON.parse(row.data_json) as CandidateEvidence);
    const proposals = (this.db
      .prepare('SELECT data_json FROM capability_baseline_proposals ORDER BY created_at, id')
      .all() as Array<{ data_json: string }>)
      .map((row) => JSON.parse(row.data_json) as CapabilityBaselineProposal);
    const versions = (this.db
      .prepare('SELECT data_json FROM capability_baseline_versions ORDER BY version')
      .all() as Array<{ data_json: string }>)
      .map((row) => JSON.parse(row.data_json) as CapabilityBaselineVersion);
    const commandReceipts = this.db
      .prepare(
        `SELECT idempotency_key AS idempotencyKey, command_type AS commandType,
                target_id AS targetId, result_id AS resultId,
                request_hash AS requestHash, created_at AS createdAt
         FROM capability_command_receipts ORDER BY created_at, idempotency_key`,
      )
      .all() as CapabilityCommandReceipt[];
    return CapabilityBaselineStateSchema.parse({
      stateVersion: meta.state_version,
      activeVersionId: meta.active_version_id,
      evidence,
      versions,
      proposals,
      commandReceipts,
    });
  }

  private persist(state: CapabilityBaselineState): void {
    this.db.prepare('DELETE FROM candidate_evidence').run();
    this.db.prepare('DELETE FROM capability_baseline_proposals').run();
    this.db.prepare('DELETE FROM capability_baseline_versions').run();
    this.db.prepare('DELETE FROM capability_command_receipts').run();

    const insertEvidence = this.db.prepare(
      `INSERT INTO candidate_evidence
        (id, capability_key, polarity, strength, source_type, source_id, generated_by, status, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of state.evidence) {
      insertEvidence.run(
        item.id, item.capabilityKey, item.polarity, item.strength, item.sourceType,
        item.sourceId, item.generatedBy, item.status, JSON.stringify(item), item.createdAt,
      );
    }

    const insertProposal = this.db.prepare(
      `INSERT INTO capability_baseline_proposals
        (id, status, generated_by, input_fingerprint, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of state.proposals) {
      insertProposal.run(
        item.id, item.status, item.generatedBy, item.inputFingerprint,
        JSON.stringify(item), item.createdAt,
      );
    }

    const insertVersion = this.db.prepare(
      `INSERT INTO capability_baseline_versions
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
      `INSERT INTO capability_command_receipts
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
        `INSERT INTO capability_baseline_meta (id, state_version, active_version_id, updated_at)
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
    update: (current: CapabilityBaselineState) => CapabilityBaselineState,
  ): CapabilityBaselineState {
    const transaction = this.db.transaction(() => {
      const current = this.getState();
      if (current.stateVersion !== expectedStateVersion) {
        throw new CapabilityStateVersionConflictError(current.stateVersion);
      }
      const next = CapabilityBaselineStateSchema.parse(update(structuredClone(current)));
      this.persist(next);
      return next;
    });
    return transaction.immediate();
  }
}
