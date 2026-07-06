import type Database from 'better-sqlite3';
import { SYNC_TABLES, type SnapshotTable, type SyncTableName } from './types';

interface TableInfoRow {
  name: string;
  pk: number;
}

export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function listExistingSyncTables(db: Database.Database): SyncTableName[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((row) => row.name));
  // OfferFlow v1 sync intentionally syncs only current business tables.
  return SYNC_TABLES.filter((table) => existing.has(table));
}

export function getTableInfo(db: Database.Database, table: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as TableInfoRow[];
}

export function getTableColumns(db: Database.Database, table: string): string[] {
  return getTableInfo(db, table).map((row) => row.name);
}

export function getPrimaryKeyColumns(db: Database.Database, table: string): string[] {
  const primaryKeys = getTableInfo(db, table)
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
  if (primaryKeys.length > 0) {
    return primaryKeys;
  }
  const columns = getTableColumns(db, table);
  return columns.includes('id') ? ['id'] : [];
}

export function readSnapshotTable(db: Database.Database, table: SyncTableName): SnapshotTable {
  const columns = getTableColumns(db, table);
  const primaryKey = getPrimaryKeyColumns(db, table);
  const orderColumns =
    primaryKey.length > 0
      ? primaryKey
      : columns.includes('created_at')
        ? ['created_at']
        : columns.includes('updated_at')
          ? ['updated_at']
          : ['rowid'];
  const orderBy = orderColumns.map((column) => quoteIdent(column)).join(', ');
  const rows = db
    .prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)} ORDER BY ${orderBy}`)
    .all() as Array<Record<string, unknown>>;
  return {
    primaryKey,
    columns,
    rows: rows.map((row) => orderRowColumns(row, columns)),
  };
}

export function orderRowColumns(
  row: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const column of columns) {
    ordered[column] = row[column] ?? null;
  }
  return ordered;
}

export function rowIdentity(
  row: Record<string, unknown>,
  primaryKey: readonly string[],
): unknown[] | null {
  if (primaryKey.length === 0) {
    return null;
  }
  const values = primaryKey.map((key) => row[key]);
  return values.some((value) => value === undefined || value === null) ? null : values;
}

export function updatedAtValue(row: Record<string, unknown>): number | null {
  const raw = row.updated_at ?? row.updatedAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
