import fs from 'node:fs';
import { getDbPath, openDb } from '../db';
import { initSchema } from '../schema';

export function ensureInitializedDatabase(dbPath = getDbPath()): void {
  const db = openDb(dbPath);
  try {
    initSchema(db);
  } finally {
    db.close();
  }
}

export function databaseExists(dbPath = getDbPath()): boolean {
  return fs.existsSync(dbPath);
}
