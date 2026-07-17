import type { FeedbackEventRecord } from '../../src/domain/job-memory';
import type { SqliteDatabase } from '../db';
import {
  feedbackEventToParams,
  rowToFeedbackEvent,
  type FeedbackEventRow,
  type StoredFeedbackEvent,
} from './rowMappers';

const SELECT_COLUMNS = `
  id, application_id, event_type, event_at, time_precision, actor,
  recorded_by, source_confidence, evidence_level, channel, note,
  reason_code, payload_json, target_event_id, idempotency_key,
  request_hash, created_at
`;

export class FeedbackEventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listEventsByApplication(applicationId: string): FeedbackEventRecord[] {
    const rows = this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM feedback_events
      WHERE application_id = ?
      ORDER BY created_at, id
    `).all(applicationId) as FeedbackEventRow[];
    return rows.map((row) => rowToFeedbackEvent(row).record);
  }

  getFeedbackEvent(id: string): FeedbackEventRecord | null {
    return this.getStoredBy('id', id)?.record ?? null;
  }

  findByIdempotencyKey(idempotencyKey: string): StoredFeedbackEvent | null {
    return this.getStoredBy('idempotency_key', idempotencyKey);
  }

  findVoidByTarget(targetEventId: string): FeedbackEventRecord | null {
    const row = this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM feedback_events
      WHERE event_type = 'event_voided' AND target_event_id = ?
      ORDER BY created_at, id
      LIMIT 1
    `).get(targetEventId) as FeedbackEventRow | undefined;
    return row === undefined ? null : rowToFeedbackEvent(row).record;
  }

  insert(stored: StoredFeedbackEvent): void {
    this.db.prepare(`
      INSERT INTO feedback_events (
        id, application_id, event_type, event_at, time_precision, actor,
        recorded_by, source_confidence, evidence_level, channel, note,
        reason_code, payload_json, target_event_id, idempotency_key,
        request_hash, created_at
      ) VALUES (
        @id, @applicationId, @eventType, @eventAt, @timePrecision, @actor,
        @recordedBy, @sourceConfidence, @evidenceLevel, @channel, @note,
        @reasonCode, @payloadJson, @targetEventId, @idempotencyKey,
        @requestHash, @createdAt
      )
    `).run(feedbackEventToParams(stored));
  }

  private getStoredBy(column: 'id' | 'idempotency_key', value: string): StoredFeedbackEvent | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM feedback_events WHERE ${column} = ?`)
      .get(value) as FeedbackEventRow | undefined;
    return row === undefined ? null : rowToFeedbackEvent(row);
  }
}
