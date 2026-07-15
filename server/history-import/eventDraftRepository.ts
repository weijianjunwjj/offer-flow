import type { HistoricalEventDraft } from '../../src/domain/history-import';
import type { SqliteDatabase } from '../db';
import {
  historicalEventDraftToParams,
  rowToHistoricalEventDraft,
  type HistoricalEventDraftRow,
} from './rowMappers';

const SELECT_COLUMNS = `
  id, baseline_draft_id, event_type, event_at, time_precision, actor, source_confidence,
  evidence_level, channel, reason_code, note, created_feedback_event_id, created_at,
  updated_at, row_version
`;

export class HistoricalEventDraftRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getEventDraft(id: string): HistoricalEventDraft | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM historical_event_drafts WHERE id = ?`)
      .get(id) as HistoricalEventDraftRow | undefined;
    return row === undefined ? null : rowToHistoricalEventDraft(row);
  }

  listEventDraftsByBaseline(baselineDraftId: string): HistoricalEventDraft[] {
    const rows = this.db
      .prepare(`
        SELECT ${SELECT_COLUMNS} FROM historical_event_drafts
        WHERE baseline_draft_id = ?
        ORDER BY event_at ASC, created_at ASC, id ASC
      `)
      .all(baselineDraftId) as HistoricalEventDraftRow[];
    return rows.map(rowToHistoricalEventDraft);
  }

  insert(draft: HistoricalEventDraft): void {
    this.db.prepare(`
      INSERT INTO historical_event_drafts (
        id, baseline_draft_id, event_type, event_at, time_precision, actor, source_confidence,
        evidence_level, channel, reason_code, note, created_feedback_event_id, created_at,
        updated_at, row_version
      ) VALUES (
        @id, @baselineDraftId, @eventType, @eventAt, @timePrecision, @actor, @sourceConfidence,
        @evidenceLevel, @channel, @reasonCode, @note, @createdFeedbackEventId, @createdAt,
        @updatedAt, @rowVersion
      )
    `).run(historicalEventDraftToParams(draft));
  }

  update(draft: HistoricalEventDraft, expectedVersion: number): boolean {
    const params = historicalEventDraftToParams(draft);
    const result = this.db.prepare(`
      UPDATE historical_event_drafts
      SET event_type = @eventType,
          event_at = @eventAt,
          time_precision = @timePrecision,
          actor = @actor,
          source_confidence = @sourceConfidence,
          evidence_level = @evidenceLevel,
          channel = @channel,
          reason_code = @reasonCode,
          note = @note,
          created_feedback_event_id = @createdFeedbackEventId,
          updated_at = @updatedAt,
          row_version = @rowVersion
      WHERE id = @id AND row_version = @expectedVersion
    `).run({ ...params, expectedVersion });
    return result.changes === 1;
  }

  deleteEventDraft(id: string): void {
    this.db.prepare('DELETE FROM historical_event_drafts WHERE id = ?').run(id);
  }
}
