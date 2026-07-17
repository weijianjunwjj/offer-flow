import type { HistoricalBaselineDraft } from '../../src/domain/history-import';
import type { SqliteDatabase } from '../db';
import {
  historicalBaselineDraftToParams,
  rowToHistoricalBaselineDraft,
  type HistoricalBaselineDraftRow,
} from './rowMappers';

const SELECT_COLUMNS = `
  id, session_id, company, role, city, actually_applied, applied_at, time_precision,
  channel, recruiting_entity_kind, recruiting_entity_name, contact_name, resume_version_id,
  highest_known_stage, source_confidence, evidence_level, notes, duplicate_of_draft_id,
  keep_as_independent_process, independent_process_reason, created_job_id,
  created_application_id, created_at, updated_at, row_version
`;

export class HistoricalBaselineDraftRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getDraft(id: string): HistoricalBaselineDraft | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM historical_baseline_drafts WHERE id = ?`)
      .get(id) as HistoricalBaselineDraftRow | undefined;
    return row === undefined ? null : rowToHistoricalBaselineDraft(row);
  }

  listDraftsBySession(sessionId: string): HistoricalBaselineDraft[] {
    const rows = this.db
      .prepare(`
        SELECT ${SELECT_COLUMNS} FROM historical_baseline_drafts
        WHERE session_id = ?
        ORDER BY updated_at DESC, id DESC
      `)
      .all(sessionId) as HistoricalBaselineDraftRow[];
    return rows.map(rowToHistoricalBaselineDraft);
  }

  insert(draft: HistoricalBaselineDraft): void {
    this.db.prepare(`
      INSERT INTO historical_baseline_drafts (
        id, session_id, company, role, city, actually_applied, applied_at, time_precision,
        channel, recruiting_entity_kind, recruiting_entity_name, contact_name, resume_version_id,
        highest_known_stage, source_confidence, evidence_level, notes, duplicate_of_draft_id,
        keep_as_independent_process, independent_process_reason, created_job_id,
        created_application_id, created_at, updated_at, row_version
      ) VALUES (
        @id, @sessionId, @company, @role, @city, @actuallyApplied, @appliedAt, @timePrecision,
        @channel, @recruitingEntityKind, @recruitingEntityName, @contactName, @resumeVersionId,
        @highestKnownStage, @sourceConfidence, @evidenceLevel, @notes, @duplicateOfDraftId,
        @keepAsIndependentProcess, @independentProcessReason, @createdJobId,
        @createdApplicationId, @createdAt, @updatedAt, @rowVersion
      )
    `).run(historicalBaselineDraftToParams(draft));
  }

  update(draft: HistoricalBaselineDraft, expectedVersion: number): boolean {
    const params = historicalBaselineDraftToParams(draft);
    const result = this.db.prepare(`
      UPDATE historical_baseline_drafts
      SET company = @company,
          role = @role,
          city = @city,
          actually_applied = @actuallyApplied,
          applied_at = @appliedAt,
          time_precision = @timePrecision,
          channel = @channel,
          recruiting_entity_kind = @recruitingEntityKind,
          recruiting_entity_name = @recruitingEntityName,
          contact_name = @contactName,
          resume_version_id = @resumeVersionId,
          highest_known_stage = @highestKnownStage,
          source_confidence = @sourceConfidence,
          evidence_level = @evidenceLevel,
          notes = @notes,
          duplicate_of_draft_id = @duplicateOfDraftId,
          keep_as_independent_process = @keepAsIndependentProcess,
          independent_process_reason = @independentProcessReason,
          created_job_id = @createdJobId,
          created_application_id = @createdApplicationId,
          updated_at = @updatedAt,
          row_version = @rowVersion
      WHERE id = @id AND row_version = @expectedVersion
    `).run({ ...params, expectedVersion });
    return result.changes === 1;
  }

  deleteDraft(id: string): void {
    this.db.prepare('DELETE FROM historical_baseline_drafts WHERE id = ?').run(id);
  }
}
