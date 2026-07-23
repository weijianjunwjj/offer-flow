import type { RadarCaptureSession, RadarCaptureSnapshot } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  radarCaptureSessionToParams,
  radarCaptureSnapshotToParams,
  rowToRadarCaptureSession,
  rowToRadarCaptureSnapshot,
  type RadarCaptureSessionRow,
  type RadarCaptureSnapshotRow,
} from './rowMappers';

const SESSION_COLUMNS = `
  id, source_type, status, raw_input_json, preview_items_json,
  created_at, expires_at, committed_at
`;

const SNAPSHOT_COLUMNS = `
  id, capture_session_id, capture_method, provider_key, provider_version,
  source_domain, source_url, normalized_source_url, external_record_id,
  page_title, visible_text, raw_snapshot_json, raw_content_hash, captured_at, created_at
`;

/** 采集会话与快照的基础读写。会话短生命周期、可清理；快照一经写入不可变。 */
export class RadarCaptureRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insertSession(session: RadarCaptureSession): void {
    this.db.prepare(`
      INSERT INTO radar_capture_sessions (
        id, source_type, status, raw_input_json, preview_items_json,
        created_at, expires_at, committed_at
      ) VALUES (
        @id, @sourceType, @status, @rawInputJson, @previewItemsJson,
        @createdAt, @expiresAt, @committedAt
      )
    `).run(radarCaptureSessionToParams(session));
  }

  getSession(id: string): RadarCaptureSession | null {
    const row = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM radar_capture_sessions WHERE id = ?`)
      .get(id) as RadarCaptureSessionRow | undefined;
    return row === undefined ? null : rowToRadarCaptureSession(row);
  }

  updateSessionStatus(id: string, status: RadarCaptureSession['status'], committedAt: number | null): boolean {
    const result = this.db.prepare(`
      UPDATE radar_capture_sessions SET status = @status, committed_at = @committedAt WHERE id = @id
    `).run({ id, status, committedAt });
    return result.changes === 1;
  }

  updateSessionContent(id: string, rawInput: unknown, previewItems: unknown): boolean {
    const result = this.db.prepare(`
      UPDATE radar_capture_sessions SET raw_input_json = @rawInputJson, preview_items_json = @previewItemsJson
      WHERE id = @id
    `).run({ id, rawInputJson: JSON.stringify(rawInput), previewItemsJson: JSON.stringify(previewItems) });
    return result.changes === 1;
  }

  insertSnapshot(snapshot: RadarCaptureSnapshot): void {
    this.db.prepare(`
      INSERT INTO radar_capture_snapshots (
        id, capture_session_id, capture_method, provider_key, provider_version,
        source_domain, source_url, normalized_source_url, external_record_id,
        page_title, visible_text, raw_snapshot_json, raw_content_hash, captured_at, created_at
      ) VALUES (
        @id, @captureSessionId, @captureMethod, @providerKey, @providerVersion,
        @sourceDomain, @sourceUrl, @normalizedSourceUrl, @externalRecordId,
        @pageTitle, @visibleText, @rawSnapshotJson, @rawContentHash, @capturedAt, @createdAt
      )
    `).run(radarCaptureSnapshotToParams(snapshot));
  }

  getSnapshot(id: string): RadarCaptureSnapshot | null {
    const row = this.db
      .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM radar_capture_snapshots WHERE id = ?`)
      .get(id) as RadarCaptureSnapshotRow | undefined;
    return row === undefined ? null : rowToRadarCaptureSnapshot(row);
  }

  listSnapshotsBySession(captureSessionId: string): RadarCaptureSnapshot[] {
    const rows = this.db
      .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM radar_capture_snapshots WHERE capture_session_id = ? ORDER BY created_at, id`)
      .all(captureSessionId) as RadarCaptureSnapshotRow[];
    return rows.map(rowToRadarCaptureSnapshot);
  }

  /**
   * 列出全部 committed 会话（按 committedAt 升序），供只读评审工作台从 committedResult 载体中
   * 还原「每个候选/快照最近一次 commit 决策」。仅读取本机受控库，不触碰真实生产库。
   */
  listCommittedSessions(): RadarCaptureSession[] {
    const rows = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM radar_capture_sessions WHERE status = 'committed' ORDER BY committed_at, id`)
      .all() as RadarCaptureSessionRow[];
    return rows.map(rowToRadarCaptureSession);
  }
}
