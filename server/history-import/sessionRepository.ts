import type { HistoricalImportSession } from '../../src/domain/history-import';
import type { SqliteDatabase } from '../db';
import {
  historicalImportSessionToParams,
  rowToHistoricalImportSession,
  type HistoricalImportSessionRow,
} from './rowMappers';

const SELECT_COLUMNS = `
  id, status, created_at, updated_at, confirmed_at, discarded_at, row_version
`;

export class HistoricalImportSessionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getSession(id: string): HistoricalImportSession | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM historical_import_sessions WHERE id = ?`)
      .get(id) as HistoricalImportSessionRow | undefined;
    return row === undefined ? null : rowToHistoricalImportSession(row);
  }

  listSessions(): HistoricalImportSession[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM historical_import_sessions ORDER BY created_at DESC, id DESC`)
      .all() as HistoricalImportSessionRow[];
    return rows.map(rowToHistoricalImportSession);
  }

  insert(session: HistoricalImportSession): void {
    this.db.prepare(`
      INSERT INTO historical_import_sessions (
        id, status, created_at, updated_at, confirmed_at, discarded_at, row_version
      ) VALUES (
        @id, @status, @createdAt, @updatedAt, @confirmedAt, @discardedAt, @rowVersion
      )
    `).run(historicalImportSessionToParams(session));
  }

  update(session: HistoricalImportSession, expectedVersion: number): boolean {
    const params = historicalImportSessionToParams(session);
    const result = this.db.prepare(`
      UPDATE historical_import_sessions
      SET status = @status,
          updated_at = @updatedAt,
          confirmed_at = @confirmedAt,
          discarded_at = @discardedAt,
          row_version = @rowVersion
      WHERE id = @id AND row_version = @expectedVersion
    `).run({ ...params, expectedVersion });
    return result.changes === 1;
  }
}
