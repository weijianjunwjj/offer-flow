import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

const rootDir = process.cwd();

export function getDbPath(): string {
  return process.env.OFFERFLOW_DB_PATH ?? path.join(rootDir, 'data', 'offerflow.sqlite3');
}

export function ensureDbDir(dbPath = getDbPath()): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

export function openDb(dbPath = getDbPath()): SqliteDatabase {
  ensureDbDir(dbPath);
  const db = new Database(dbPath);
  // Keep the project DB as a single Git-trackable file. WAL sidecars are ignored.
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');
  return db;
}
