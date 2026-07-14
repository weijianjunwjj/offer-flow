import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getDbPath } from '../db';
import { sha256Hex } from './hash';
import { getSyncPaths } from './paths';
import { orderRowColumns, readSnapshotTable, rowIdentity, updatedAtValue } from './tables';
import {
  SNAPSHOT_SCHEMA_VERSION,
  SYNC_TABLES,
  type OfferFlowSnapshot,
  type SnapshotManifest,
  type SnapshotTable,
} from './types';

export const BUSINESS_SYNC_TABLES = SYNC_TABLES;

export interface ChangedSnapshotRecord {
  id: string;
  databaseUpdatedAt: number | null;
  snapshotUpdatedAt: number | null;
  databaseHash: string;
  snapshotHash: string;
}

export interface SnapshotTableConsistency {
  databaseCount: number;
  snapshotCount: number;
  databaseIds: string[];
  snapshotIds: string[];
  onlyInDatabase: string[];
  onlyInSnapshot: string[];
  changed: ChangedSnapshotRecord[];
}

export interface SnapshotConsistencyReport {
  ok: boolean;
  databasePath: string;
  snapshotPath: string;
  snapshotSchemaVersion: number;
  snapshotAppVersion: string;
  snapshotExportedAt: string;
  tables: Record<(typeof BUSINESS_SYNC_TABLES)[number], SnapshotTableConsistency>;
}

interface RowSummary {
  id: string;
  updatedAt: number | null;
  hash: string;
}

function readVerifiedSnapshot(dbPath: string): OfferFlowSnapshot {
  const paths = getSyncPaths(dbPath);
  if (!fs.existsSync(paths.snapshotPath) || !fs.existsSync(paths.manifestPath)) {
    throw new Error(
      '正式 snapshot 和 manifest 缺失；全新 clone 请先初始化本地 v2 数据库并显式导出，'
      + '恢复场景请使用批准备份，不能将缺失视为 consistency 已通过',
    );
  }
  const snapshotJson = fs.readFileSync(paths.snapshotPath, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8')) as SnapshotManifest;
  if (
    manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || manifest.databaseSchemaVersion !== SNAPSHOT_SCHEMA_VERSION
  ) {
    throw new Error(`unsupported snapshot manifest schemaVersion: ${String(manifest.schemaVersion)}`);
  }
  if (manifest.snapshotHash !== sha256Hex(snapshotJson)) {
    throw new Error('snapshot hash mismatch during consistency verification');
  }
  const snapshot = JSON.parse(snapshotJson) as OfferFlowSnapshot;
  if (
    snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || snapshot.databaseSchemaVersion !== SNAPSHOT_SCHEMA_VERSION
  ) {
    throw new Error(`unsupported snapshot schemaVersion: ${String(snapshot.schemaVersion)}`);
  }
  return snapshot;
}

function summarizeTable(table: SnapshotTable): Map<string, RowSummary> {
  const summaries = new Map<string, RowSummary>();
  for (const rawRow of table.rows) {
    const row = orderRowColumns(rawRow, table.columns);
    const identity = rowIdentity(row, table.primaryKey);
    if (identity === null) {
      throw new Error('snapshot consistency verification found a row without a primary key');
    }
    const id = identity.map(String).join(':');
    summaries.set(id, {
      id,
      updatedAt: updatedAtValue(row),
      hash: sha256Hex(JSON.stringify(table.columns.map((column) => row[column] ?? null))),
    });
  }
  return summaries;
}

function compareTables(
  databaseTable: SnapshotTable,
  snapshotTable: SnapshotTable,
): SnapshotTableConsistency {
  if (JSON.stringify(databaseTable.columns) !== JSON.stringify(snapshotTable.columns)) {
    throw new Error('database and snapshot columns differ during consistency verification');
  }
  const databaseRows = summarizeTable(databaseTable);
  const snapshotRows = summarizeTable(snapshotTable);
  const databaseIds = [...databaseRows.keys()].sort();
  const snapshotIds = [...snapshotRows.keys()].sort();
  const onlyInDatabase = databaseIds.filter((id) => !snapshotRows.has(id));
  const onlyInSnapshot = snapshotIds.filter((id) => !databaseRows.has(id));
  const changed = databaseIds
    .filter((id) => snapshotRows.has(id))
    .flatMap((id): ChangedSnapshotRecord[] => {
      const databaseRow = databaseRows.get(id);
      const snapshotRow = snapshotRows.get(id);
      if (databaseRow === undefined || snapshotRow === undefined || databaseRow.hash === snapshotRow.hash) {
        return [];
      }
      return [
        {
          id,
          databaseUpdatedAt: databaseRow.updatedAt,
          snapshotUpdatedAt: snapshotRow.updatedAt,
          databaseHash: databaseRow.hash,
          snapshotHash: snapshotRow.hash,
        },
      ];
    });
  return {
    databaseCount: databaseRows.size,
    snapshotCount: snapshotRows.size,
    databaseIds,
    snapshotIds,
    onlyInDatabase,
    onlyInSnapshot,
    changed,
  };
}

export function auditSnapshotConsistency(dbPath = getDbPath()): SnapshotConsistencyReport {
  const snapshot = readVerifiedSnapshot(dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const reports = {} as SnapshotConsistencyReport['tables'];
    for (const tableName of BUSINESS_SYNC_TABLES) {
      const snapshotTable = snapshot.tables[tableName];
      if (snapshotTable === undefined) {
        throw new Error(`snapshot is missing business table ${tableName}`);
      }
      reports[tableName] = compareTables(readSnapshotTable(db, tableName), snapshotTable);
    }
    const ok = BUSINESS_SYNC_TABLES.every((tableName) => {
      const report = reports[tableName];
      return (
        report.onlyInDatabase.length === 0 &&
        report.onlyInSnapshot.length === 0 &&
        report.changed.length === 0
      );
    });
    return {
      ok,
      databasePath: dbPath,
      snapshotPath: getSyncPaths(dbPath).snapshotPath,
      snapshotSchemaVersion: snapshot.schemaVersion,
      snapshotAppVersion: snapshot.appVersion,
      snapshotExportedAt: snapshot.exportedAt,
      tables: reports,
    };
  } finally {
    db.close();
  }
}
