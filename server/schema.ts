import { pathToFileURL } from 'node:url';
import { openDb, type SqliteDatabase } from './db';
import { runMigrations } from './migrations';

export function initSchema(db: SqliteDatabase): void {
  runMigrations(db);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  initSchema(db);
  db.close();
}
