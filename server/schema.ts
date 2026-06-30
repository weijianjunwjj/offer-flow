import { pathToFileURL } from 'node:url';
import { openDb, type SqliteDatabase } from './db';

export function initSchema(db: SqliteDatabase): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  company TEXT,
  role TEXT,
  city TEXT,
  salary_range TEXT,
  match_score INTEGER,
  communication_status TEXT,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_logs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  profile_count INTEGER NOT NULL,
  job_count INTEGER NOT NULL,
  ignored_key_count INTEGER NOT NULL,
  warning_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
`);

  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at)
     VALUES ('schema_version', '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(Date.now());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  initSchema(db);
  db.close();
}
