import type { ApplicationRecord } from '../../src/domain/job-memory';
import type { SqliteDatabase } from '../db';
import {
  applicationToParams,
  rowToApplication,
  type ApplicationRow,
  type StoredApplication,
} from './rowMappers';

const SELECT_COLUMNS = `
  id, job_id, resume_version_id, origin, channel, channel_other_label,
  job_city_snapshot, market_city, work_mode, recruiting_entity_kind,
  recruiting_entity_name, employer_group_key, end_client_name,
  primary_contact_json, draft_message_text, created_at, updated_at,
  voided_at, void_reason, superseded_by_application_id, row_version,
  idempotency_key, request_hash, migration_key
`;

export class ApplicationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listApplicationsByJob(jobId: string): ApplicationRecord[] {
    const rows = this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM applications
      WHERE job_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(jobId) as ApplicationRow[];
    return rows.map((row) => rowToApplication(row).record);
  }

  listApplications(): ApplicationRecord[] {
    const rows = this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM applications
      ORDER BY created_at DESC, id DESC
    `).all() as ApplicationRow[];
    return rows.map((row) => rowToApplication(row).record);
  }

  getApplication(id: string): ApplicationRecord | null {
    return this.getStoredBy('id', id)?.record ?? null;
  }

  findByIdempotencyKey(idempotencyKey: string): StoredApplication | null {
    return this.getStoredBy('idempotency_key', idempotencyKey);
  }

  insert(stored: StoredApplication): void {
    this.db.prepare(`
      INSERT INTO applications (
        id, job_id, resume_version_id, origin, channel, channel_other_label,
        job_city_snapshot, market_city, work_mode, recruiting_entity_kind,
        recruiting_entity_name, employer_group_key, end_client_name,
        primary_contact_json, draft_message_text, created_at, updated_at,
        voided_at, void_reason, superseded_by_application_id, row_version,
        idempotency_key, request_hash, migration_key
      ) VALUES (
        @id, @jobId, @resumeVersionId, @origin, @channel, @channelOtherLabel,
        @jobCitySnapshot, @marketCity, @workMode, @recruitingEntityKind,
        @recruitingEntityName, @employerGroupKey, @endClientName,
        @primaryContactJson, @draftMessageText, @createdAt, @updatedAt,
        @voidedAt, @voidReason, @supersededByApplicationId, @rowVersion,
        @idempotencyKey, @requestHash, @migrationKey
      )
    `).run(applicationToParams(stored));
  }

  updateApplication(record: ApplicationRecord, expectedVersion: number): boolean {
    const params = applicationToParams({
      record,
      idempotencyKey: 'not-updated',
      requestHash: 'not-updated',
      migrationKey: null,
    });
    const result = this.db.prepare(`
      UPDATE applications
      SET resume_version_id = @resumeVersionId,
          origin = @origin,
          channel = @channel,
          channel_other_label = @channelOtherLabel,
          job_city_snapshot = @jobCitySnapshot,
          market_city = @marketCity,
          work_mode = @workMode,
          recruiting_entity_kind = @recruitingEntityKind,
          recruiting_entity_name = @recruitingEntityName,
          employer_group_key = @employerGroupKey,
          end_client_name = @endClientName,
          primary_contact_json = @primaryContactJson,
          draft_message_text = @draftMessageText,
          updated_at = @updatedAt,
          voided_at = @voidedAt,
          void_reason = @voidReason,
          superseded_by_application_id = @supersededByApplicationId,
          row_version = @rowVersion
      WHERE id = @id AND row_version = @expectedVersion
    `).run({ ...params, expectedVersion });
    return result.changes === 1;
  }

  incrementVersion(id: string, expectedVersion: number, updatedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE applications
      SET row_version = row_version + 1,
          updated_at = @updatedAt
      WHERE id = @id AND row_version = @expectedVersion
    `).run({ id, expectedVersion, updatedAt });
    return result.changes === 1;
  }

  private getStoredBy(column: 'id' | 'idempotency_key', value: string): StoredApplication | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM applications WHERE ${column} = ?`)
      .get(value) as ApplicationRow | undefined;
    return row === undefined ? null : rowToApplication(row);
  }
}
