import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getDbPath, openDb } from '../db';
import { getDatabaseSchemaVersion } from '../migrations';
import { initSchema } from '../schema';
import { backupDatabase } from './backup';
import { doctorDatabase } from './doctor';
import { sha256Hex } from './hash';
import { ensureSyncDirs, getSyncPaths } from './paths';
import {
  getPrimaryKeyColumns,
  getTableColumns,
  orderRowColumns,
  quoteIdent,
  rowIdentity,
  updatedAtValue,
} from './tables';
import {
  SNAPSHOT_SCHEMA_VERSION,
  SYNC_TABLES,
  type ImportSnapshotResult,
  type OfferFlowSnapshot,
  type SnapshotManifest,
  type SnapshotTable,
  type SyncTableName,
} from './types';

interface ImportOptions {
  backupBeforeImport?: boolean;
}

function parseJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function assertSnapshotShape(value: OfferFlowSnapshot): void {
  if (
    value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || value.databaseSchemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || typeof value.tables !== 'object'
  ) {
    throw new Error(`unsupported snapshot schemaVersion: ${String(value.schemaVersion)}`);
  }
}

function assertManifestShape(value: SnapshotManifest): void {
  if (
    value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    value.databaseSchemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    typeof value.snapshotHash !== 'string' ||
    value.snapshotHash === ''
  ) {
    throw new Error('invalid snapshot manifest');
  }
}

function selectLocalRow(
  db: Database.Database,
  table: string,
  primaryKey: readonly string[],
  identity: readonly unknown[],
): Record<string, unknown> | null {
  const where = primaryKey.map((column) => `${quoteIdent(column)} = ?`).join(' AND ');
  const row = db
    .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${where}`)
    .get(...identity) as Record<string, unknown> | undefined;
  return row ?? null;
}

function insertOrReplaceRow(
  db: Database.Database,
  table: string,
  columns: readonly string[],
  primaryKey: readonly string[],
  row: Record<string, unknown>,
): void {
  const quotedColumns = columns.map(quoteIdent).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const updateColumns = columns.filter((column) => !primaryKey.includes(column));
  const updateSql =
    updateColumns.length > 0
      ? ` DO UPDATE SET ${updateColumns
          .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
          .join(', ')}`
      : ' DO NOTHING';
  db.prepare(
    `INSERT INTO ${quoteIdent(table)} (${quotedColumns})
     VALUES (${placeholders})
     ON CONFLICT(${primaryKey.map(quoteIdent).join(', ')})${updateSql}`,
  ).run(...columns.map((column) => row[column] ?? null));
}

function mergeTable(
  db: Database.Database,
  table: SyncTableName,
  snapshotTable: SnapshotTable,
  result: ImportSnapshotResult,
): void {
  const localColumns = getTableColumns(db, table);
  const localPrimaryKey = getPrimaryKeyColumns(db, table);
  const snapshotPrimaryKey = snapshotTable.primaryKey;
  const primaryKey = localPrimaryKey.length > 0 ? localPrimaryKey : snapshotPrimaryKey;
  if (primaryKey.length === 0) {
    result.warnings.push(`${table}: no primary key; skipped table`);
    return;
  }
  const columns = snapshotTable.columns.filter((column) => localColumns.includes(column));
  const droppedColumns = snapshotTable.columns.filter((column) => !localColumns.includes(column));
  if (droppedColumns.length > 0) {
    result.warnings.push(`${table}: ignored unknown columns ${droppedColumns.join(', ')}`);
  }
  if (primaryKey.some((column) => !columns.includes(column))) {
    result.warnings.push(`${table}: primary key missing from snapshot columns; skipped table`);
    return;
  }

  for (const rawRow of snapshotTable.rows) {
    const row = orderRowColumns(rawRow, columns);
    const identity = rowIdentity(row, primaryKey);
    if (identity === null) {
      result.skipped += 1;
      result.warnings.push(`${table}: skipped row with missing primary key`);
      continue;
    }

    const localRow = selectLocalRow(db, table, primaryKey, identity);
    if (localRow === null) {
      insertOrReplaceRow(db, table, columns, primaryKey, row);
      result.inserted += 1;
      continue;
    }

    if (table === 'app_meta') {
      if (JSON.stringify(orderRowColumns(localRow, columns)) === JSON.stringify(row)) {
        result.skipped += 1;
      } else {
        insertOrReplaceRow(db, table, columns, primaryKey, row);
        result.updated += 1;
      }
      continue;
    }

    const remoteUpdatedAt = updatedAtValue(row);
    const localUpdatedAt = updatedAtValue(localRow);
    if (remoteUpdatedAt !== null && localUpdatedAt !== null) {
      if (remoteUpdatedAt > localUpdatedAt) {
        insertOrReplaceRow(db, table, columns, primaryKey, row);
        result.updated += 1;
      } else {
        result.skipped += 1;
      }
      continue;
    }

    if (JSON.stringify(orderRowColumns(localRow, columns)) === JSON.stringify(row)) {
      result.skipped += 1;
      continue;
    }

    result.skipped += 1;
    result.warnings.push(
      `${table}: local row exists and updated_at is unavailable; kept local row ${identity.join(':')}`,
    );
  }
}

export function importSnapshot(
  dbPath = getDbPath(),
  options: ImportOptions = {},
): ImportSnapshotResult {
  const paths = getSyncPaths(dbPath);
  ensureSyncDirs(paths);
  if (!fs.existsSync(paths.snapshotPath)) {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      warnings: ['snapshot does not exist; skipped import'],
      snapshotHash: '',
    };
  }
  if (!fs.existsSync(paths.manifestPath)) {
    throw new Error('snapshot manifest does not exist; refusing import');
  }

  const snapshotJson = fs.readFileSync(paths.snapshotPath, 'utf8');
  const snapshotHash = sha256Hex(snapshotJson);
  const manifest = parseJsonFile<SnapshotManifest>(paths.manifestPath);
  assertManifestShape(manifest);
  if (manifest.snapshotHash !== snapshotHash) {
    throw new Error('snapshot hash mismatch; refusing import');
  }
  const snapshot = JSON.parse(snapshotJson) as OfferFlowSnapshot;
  assertSnapshotShape(snapshot);

  if (options.backupBeforeImport ?? true) {
    backupDatabase(dbPath);
  }

  const db = openDb(dbPath);
  try {
    const currentVersion = getDatabaseSchemaVersion(db);
    if (currentVersion === 1) {
      throw new Error('schema v1 数据库必须先完成授权 B7-B 升级，禁止普通 snapshot import 自动迁移');
    }
    if (currentVersion === 0) initSchema(db, { targetVersion: 2 });
    if (getDatabaseSchemaVersion(db) !== 2) throw new Error('snapshot v2 import 目标 schema 不为 2');
    const result: ImportSnapshotResult = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      warnings: [],
      snapshotHash,
    };
    const merge = db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      for (const table of SYNC_TABLES) {
        const snapshotTable = snapshot.tables[table];
        if (snapshotTable !== undefined) {
          mergeTable(db, table, snapshotTable, result);
        }
      }
    });
    merge();
    const doctor = doctorDatabase(dbPath);
    if (!doctor.ok) {
      throw new Error(`database integrity check failed after import: ${doctor.error ?? doctor.integrity.join('; ')}`);
    }
    return result;
  } finally {
    db.close();
  }
}
