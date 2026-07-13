import type { ResumeVersionRecord } from '../../src/domain/job-memory';
import type { SqliteDatabase } from '../db';
import {
  resumeVersionToParams,
  rowToResumeVersion,
  type ResumeVersionRow,
  type StoredResumeVersion,
} from './rowMappers';

const SELECT_COLUMNS = `
  id, name, source, content_hash, summary, content_json,
  created_at, archived_at, row_version, idempotency_key, request_hash
`;

export class ResumeVersionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listResumeVersions(): ResumeVersionRecord[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM resume_versions ORDER BY created_at DESC, id DESC`)
      .all() as ResumeVersionRow[];
    return rows.map((row) => rowToResumeVersion(row).record);
  }

  getResumeVersion(id: string): ResumeVersionRecord | null {
    return this.getStoredBy('id', id)?.record ?? null;
  }

  findByIdempotencyKey(idempotencyKey: string): StoredResumeVersion | null {
    return this.getStoredBy('idempotency_key', idempotencyKey);
  }

  findByContentHash(contentHash: string): ResumeVersionRecord | null {
    return this.getStoredBy('content_hash', contentHash)?.record ?? null;
  }

  insert(stored: StoredResumeVersion): void {
    this.db.prepare(`
      INSERT INTO resume_versions (
        id, name, source, content_hash, summary, content_json,
        created_at, archived_at, row_version, idempotency_key, request_hash
      ) VALUES (
        @id, @name, @source, @contentHash, @summary, @contentJson,
        @createdAt, @archivedAt, @rowVersion, @idempotencyKey, @requestHash
      )
    `).run(resumeVersionToParams(stored));
  }

  updateMetadata(
    id: string,
    expectedVersion: number,
    name: string,
    summary: string,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE resume_versions
      SET name = @name,
          summary = @summary,
          row_version = row_version + 1
      WHERE id = @id AND row_version = @expectedVersion
    `).run({ id, expectedVersion, name, summary });
    return result.changes === 1;
  }

  archive(id: string, expectedVersion: number, archivedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE resume_versions
      SET archived_at = @archivedAt,
          row_version = row_version + 1
      WHERE id = @id AND row_version = @expectedVersion
    `).run({ id, expectedVersion, archivedAt });
    return result.changes === 1;
  }

  getActiveResumeVersionId(): string | null {
    const row = this.db
      .prepare("SELECT value FROM app_meta WHERE key = 'active_resume_version_id'")
      .get() as { value: unknown } | undefined;
    if (row === undefined) return null;
    return typeof row.value === 'string' && row.value.trim() !== '' ? row.value : null;
  }

  setActiveResumeVersionId(id: string | null, updatedAt: number): void {
    if (id === null) {
      this.db.prepare("DELETE FROM app_meta WHERE key = 'active_resume_version_id'").run();
      return;
    }
    this.db.prepare(`
      INSERT INTO app_meta (key, value, updated_at)
      VALUES ('active_resume_version_id', @id, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run({ id, updatedAt });
  }

  private getStoredBy(column: 'id' | 'idempotency_key' | 'content_hash', value: string): StoredResumeVersion | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM resume_versions WHERE ${column} = ?`)
      .get(value) as ResumeVersionRow | undefined;
    return row === undefined ? null : rowToResumeVersion(row);
  }
}
