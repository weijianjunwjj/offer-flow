import type { RadarSourceRecord } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  radarSourceRecordToParams,
  rowToRadarSourceRecord,
  type RadarSourceRecordRow,
} from './rowMappers';

const COLUMNS = `
  id, provider_key, external_record_id, normalized_source_url,
  first_seen_at, last_seen_at, last_changed_at, latest_snapshot_id,
  source_status, created_at, updated_at
`;

/**
 * 来源记录基础读写。identity 优先级（TD §5.2）由上层标准化流程实现，
 * 此处只提供按 providerKey+externalRecordId / normalizedSourceUrl 的基础查找。
 */
export class RadarSourceRecordRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(record: RadarSourceRecord): void {
    this.db.prepare(`
      INSERT INTO radar_source_records (
        id, provider_key, external_record_id, normalized_source_url,
        first_seen_at, last_seen_at, last_changed_at, latest_snapshot_id,
        source_status, created_at, updated_at
      ) VALUES (
        @id, @providerKey, @externalRecordId, @normalizedSourceUrl,
        @firstSeenAt, @lastSeenAt, @lastChangedAt, @latestSnapshotId,
        @sourceStatus, @createdAt, @updatedAt
      )
    `).run(radarSourceRecordToParams(record));
  }

  getById(id: string): RadarSourceRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_source_records WHERE id = ?`)
      .get(id) as RadarSourceRecordRow | undefined;
    return row === undefined ? null : rowToRadarSourceRecord(row);
  }

  findByProviderKey(providerKey: string, externalRecordId: string): RadarSourceRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_source_records WHERE provider_key = ? AND external_record_id = ?`)
      .get(providerKey, externalRecordId) as RadarSourceRecordRow | undefined;
    return row === undefined ? null : rowToRadarSourceRecord(row);
  }

  findByNormalizedSourceUrl(normalizedSourceUrl: string): RadarSourceRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_source_records WHERE normalized_source_url = ?`)
      .get(normalizedSourceUrl) as RadarSourceRecordRow | undefined;
    return row === undefined ? null : rowToRadarSourceRecord(row);
  }

  /**
   * V8-3 Tier-2 身份查找：按 provider_key + normalized_source_url 返回全部命中。
   * normalized_source_url 无唯一约束，可能多命中；调用方对 ≥2 命中判定 identity_conflict，
   * 绝不任取其一（设计 §4）。providerKey 为空时不做 Tier-2 查找。
   */
  findAllByProviderAndUrl(providerKey: string, normalizedSourceUrl: string): RadarSourceRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_source_records WHERE provider_key = ? AND normalized_source_url = ? ORDER BY created_at, id`)
      .all(providerKey, normalizedSourceUrl) as RadarSourceRecordRow[];
    return rows.map(rowToRadarSourceRecord);
  }

  updateLatestSnapshot(id: string, latestSnapshotId: string, lastSeenAt: number, lastChangedAt: number | null, updatedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE radar_source_records
      SET latest_snapshot_id = @latestSnapshotId, last_seen_at = @lastSeenAt,
          last_changed_at = @lastChangedAt, updated_at = @updatedAt
      WHERE id = @id
    `).run({ id, latestSnapshotId, lastSeenAt, lastChangedAt, updatedAt });
    return result.changes === 1;
  }
}
