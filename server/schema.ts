import { pathToFileURL } from 'node:url';
import { openDb, type SqliteDatabase } from './db';
import {
  runMigrations,
  type MigrationRunOptions,
  type MigrationRunResult,
} from './migrations';

export function initSchema(
  db: SqliteDatabase,
  options: MigrationRunOptions = {},
): MigrationRunResult {
  return runMigrations(db, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  initSchema(db);
  db.close();
}
