import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getDbPath } from '../db';
import type { DoctorResult } from './types';

function firstColumnAsString(row: Record<string, unknown>): string {
  const firstKey = Object.keys(row)[0];
  const value = firstKey === undefined ? undefined : row[firstKey];
  return typeof value === 'string' ? value : String(value ?? '');
}

export function doctorDatabase(dbPath = getDbPath()): DoctorResult {
  if (!fs.existsSync(dbPath)) {
    return {
      ok: true,
      dbPath,
      dbExists: false,
      integrity: ['database file does not exist yet'],
      foreignKeyViolations: [],
      warnings: ['database file does not exist yet'],
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<
      Record<string, unknown>
    >;
    const integrity = integrityRows.map(firstColumnAsString);
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all() as Array<
      Record<string, unknown>
    >;
    const integrityOk = integrity.length === 1 && integrity[0] === 'ok';
    return {
      ok: integrityOk && foreignKeyViolations.length === 0,
      dbPath,
      dbExists: true,
      integrity,
      foreignKeyViolations,
      warnings: foreignKeyViolations.length > 0 ? ['foreign key violations found'] : [],
    };
  } catch (error) {
    return {
      ok: false,
      dbPath,
      dbExists: true,
      integrity: [],
      foreignKeyViolations: [],
      warnings: [],
      error: (error as Error).message,
    };
  } finally {
    db?.close();
  }
}
