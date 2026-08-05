import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDatabaseSchemaVersion } from '../migrations';
import { initSchema } from '../schema';
import { openDb } from '../db';
import { readAppVersion } from '../sync/appVersion';
import { atomicWriteJson, sha256Hex, toStableJson } from '../sync/hash';
import {
  getPrimaryKeyColumns,
  getTableColumns,
  quoteIdent,
  readSnapshotTable,
} from '../sync/tables';
import type {
  LegacyOfferFlowSnapshotV1 as OfferFlowSnapshotV1,
  LegacySnapshotManifestV1 as SnapshotManifestV1,
  SnapshotTable,
  SyncTableName,
} from '../sync/types';
import { SNAPSHOT_V2_COVERAGE, type SnapshotV2Coverage } from '../sync/types';
import { runLegacyBackfill, type LegacyBackfillSummary } from '../job-memory/upgrade/legacyBackfill';
import { assertNoSymbolicLinks, isPathInside } from '../job-memory/upgrade/pathSafety';

export const SNAPSHOT_SCHEMA_VERSION_V2 = 2 as const;
export const SNAPSHOT_V2_TABLES = [
  'profiles',
  'jobs',
  'resume_versions',
  'applications',
  'feedback_events',
  'import_logs',
  'app_meta',
] as const;

export type SnapshotV2TableName = (typeof SNAPSHOT_V2_TABLES)[number];

export interface OfferFlowSnapshotV2 {
  schemaVersion: 2;
  databaseSchemaVersion: 2;
  exportedAt: string;
  deviceId: string;
  appVersion: string;
  coverage?: SnapshotV2Coverage;
  tables: Record<SnapshotV2TableName, SnapshotTable>;
}

export interface SnapshotManifestV2 {
  schemaVersion: 2;
  databaseSchemaVersion: 2;
  exportedAt: string;
  deviceId: string;
  appVersion: string;
  coverage?: SnapshotV2Coverage;
  snapshotHash: string;
  tableCounts: Record<SnapshotV2TableName, number>;
}

export interface ExplicitSnapshotV2Context {
  databasePath: string;
  snapshotDirectory: string;
  workingDirectory: string;
  workspaceDirectory: string;
  schemaTarget: 2;
  capability: 'job-memory-v2';
  mode: 'temporary_clone';
}

export interface SnapshotV2ExportResult {
  schemaVersion: 2;
  snapshotHash: string;
  tableCounts: Record<SnapshotV2TableName, number>;
}

export interface SnapshotV2ImportResult {
  schemaVersion: 2;
  importedRows: Record<SnapshotV2TableName, number>;
  integrity: string[];
  foreignKeyViolationCount: number;
}

export interface SnapshotV2ConsistencyReport {
  ok: boolean;
  schemaVersion: 2;
  tables: Record<SnapshotV2TableName, {
    databaseCount: number;
    snapshotCount: number;
    differenceCount: number;
  }>;
}

interface ResolvedSnapshotContext extends ExplicitSnapshotV2Context {
  databasePath: string;
  snapshotDirectory: string;
  workingDirectory: string;
  workspaceDirectory: string;
}

function resolveContext(
  input: ExplicitSnapshotV2Context,
  allowMissingDatabase = false,
): ResolvedSnapshotContext {
  if (
    input.schemaTarget !== 2
    || input.capability !== 'job-memory-v2'
    || input.mode !== 'temporary_clone'
  ) throw new Error('snapshot v2 需要显式 schema target、capability 和 temporary_clone mode');
  const context: ResolvedSnapshotContext = {
    ...input,
    databasePath: path.resolve(input.databasePath),
    snapshotDirectory: path.resolve(input.snapshotDirectory),
    workingDirectory: path.resolve(input.workingDirectory),
    workspaceDirectory: path.resolve(input.workspaceDirectory),
  };
  if (!fs.existsSync(context.workingDirectory) || !fs.statSync(context.workingDirectory).isDirectory()) {
    throw new Error('snapshot v2 workingDirectory 必须已存在');
  }
  if (
    isPathInside(context.workspaceDirectory, context.workingDirectory)
    || context.workingDirectory === context.workspaceDirectory
  ) throw new Error('snapshot v2 工作目录必须位于源码工作区之外');
  if (!isPathInside(context.workingDirectory, context.databasePath)) {
    throw new Error('snapshot v2 数据库必须位于显式临时工作目录');
  }
  if (!isPathInside(context.workingDirectory, context.snapshotDirectory)) {
    throw new Error('snapshot v2 输出必须位于显式临时工作目录');
  }
  assertNoSymbolicLinks(context.workingDirectory);
  assertNoSymbolicLinks(context.databasePath);
  assertNoSymbolicLinks(context.snapshotDirectory);
  if (
    !allowMissingDatabase
    && (!fs.existsSync(context.databasePath) || !fs.statSync(context.databasePath).isFile())
  ) throw new Error('snapshot v2 数据库不存在');
  return context;
}

function snapshotPaths(snapshotDirectory: string): { snapshotPath: string; manifestPath: string } {
  return {
    snapshotPath: path.join(snapshotDirectory, 'offerflow.snapshot.json'),
    manifestPath: path.join(snapshotDirectory, 'offerflow.manifest.json'),
  };
}

function readVerifiedSnapshotV2(snapshotDirectory: string): OfferFlowSnapshotV2 {
  const paths = snapshotPaths(snapshotDirectory);
  if (!fs.existsSync(paths.snapshotPath) || !fs.existsSync(paths.manifestPath)) {
    throw new Error('snapshot v2 与 manifest 必须同时存在');
  }
  const snapshotText = fs.readFileSync(paths.snapshotPath, 'utf8');
  const snapshot = JSON.parse(snapshotText) as OfferFlowSnapshotV2;
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8')) as SnapshotManifestV2;
  if (
    snapshot.schemaVersion !== 2
    || snapshot.databaseSchemaVersion !== 2
    || manifest.schemaVersion !== 2
    || manifest.databaseSchemaVersion !== 2
  ) throw new Error('snapshot v2 schema mismatch');
  if (manifest.snapshotHash !== sha256Hex(snapshotText)) throw new Error('snapshot v2 hash mismatch');
  for (const table of SNAPSHOT_V2_TABLES) {
    if (snapshot.tables[table] === undefined) throw new Error(`snapshot v2 缺少表 ${table}`);
  }
  return snapshot;
}

export function exportSnapshotV2(contextInput: ExplicitSnapshotV2Context): SnapshotV2ExportResult {
  const context = resolveContext(contextInput);
  const db = new Database(context.databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    if (getDatabaseSchemaVersion(db) !== 2) throw new Error('snapshot v2 只接受 schema v2 数据库');
    const tables = {} as OfferFlowSnapshotV2['tables'];
    const tableCounts = {} as SnapshotManifestV2['tableCounts'];
    for (const table of SNAPSHOT_V2_TABLES) {
      const snapshotTable = readSnapshotTable(db, table as SyncTableName);
      tables[table] = snapshotTable;
      tableCounts[table] = snapshotTable.rows.length;
    }
    const exportedAt = new Date().toISOString();
    const appVersion = readAppVersion();
    const deviceId = `b7-a-temporary-${crypto.randomUUID()}`;
    const snapshot: OfferFlowSnapshotV2 = {
      schemaVersion: 2,
      databaseSchemaVersion: 2,
      exportedAt,
      deviceId,
      appVersion,
      coverage: SNAPSHOT_V2_COVERAGE,
      tables,
    };
    const snapshotHash = sha256Hex(toStableJson(snapshot));
    fs.mkdirSync(context.snapshotDirectory, { recursive: true });
    const paths = snapshotPaths(context.snapshotDirectory);
    atomicWriteJson(paths.snapshotPath, snapshot);
    atomicWriteJson(paths.manifestPath, {
      schemaVersion: 2,
      databaseSchemaVersion: 2,
      exportedAt,
      deviceId,
      appVersion,
      coverage: SNAPSHOT_V2_COVERAGE,
      snapshotHash,
      tableCounts,
    } satisfies SnapshotManifestV2);
    return { schemaVersion: 2, snapshotHash, tableCounts };
  } finally {
    db.close();
  }
}
function tableIsEmpty(db: Database.Database, table: SnapshotV2TableName): boolean {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`).get() as { count: number }).count) === 0;
}

function assertRestoreTargetEmpty(db: Database.Database): void {
  for (const table of SNAPSHOT_V2_TABLES.filter((name) => name !== 'app_meta')) {
    if (!tableIsEmpty(db, table)) throw new Error('snapshot v2 restore 目标业务表必须为空');
  }
}

function restoreTable(
  db: Database.Database,
  table: string,
  snapshotTable: SnapshotTable,
  skipSchemaVersion = false,
): number {
  const localColumns = getTableColumns(db, table);
  if (JSON.stringify(localColumns) !== JSON.stringify(snapshotTable.columns)) {
    throw new Error(`snapshot 表结构不匹配：${table}`);
  }
  const primaryKey = getPrimaryKeyColumns(db, table);
  if (primaryKey.length === 0) throw new Error(`snapshot 目标表缺少主键：${table}`);
  const columns = snapshotTable.columns;
  const updateColumns = columns.filter((column) => !primaryKey.includes(column));
  const statement = db.prepare(`
    INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT(${primaryKey.map(quoteIdent).join(', ')}) DO UPDATE SET
      ${updateColumns.map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`).join(', ')}
  `);
  let imported = 0;
  for (const row of snapshotTable.rows) {
    if (skipSchemaVersion && table === 'app_meta' && row.key === 'schema_version') continue;
    statement.run(...columns.map((column) => row[column] ?? null));
    imported += 1;
  }
  return imported;
}

function databaseHealth(db: Database.Database): { integrity: string[]; foreignKeyViolationCount: number } {
  const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>)
    .map((row) => String(row[Object.keys(row)[0] ?? ''] ?? ''));
  const foreignKeyViolationCount = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
  return { integrity, foreignKeyViolationCount };
}

export function importSnapshotV2(contextInput: ExplicitSnapshotV2Context): SnapshotV2ImportResult {
  const context = resolveContext(contextInput, true);
  const snapshot = readVerifiedSnapshotV2(context.snapshotDirectory);
  fs.mkdirSync(path.dirname(context.databasePath), { recursive: true });
  const db = openDb(context.databasePath);
  try {
    initSchema(db, { targetVersion: 2 });
    assertRestoreTargetEmpty(db);
    const importedRows = {} as Record<SnapshotV2TableName, number>;
    const restore = db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      for (const table of SNAPSHOT_V2_TABLES) {
        importedRows[table] = restoreTable(db, table, snapshot.tables[table]);
      }
    });
    restore();
    const health = databaseHealth(db);
    if (health.integrity[0] !== 'ok' || health.foreignKeyViolationCount !== 0) {
      throw new Error('snapshot v2 import 后 integrity/FK 失败');
    }
    return { schemaVersion: 2, importedRows, ...health };
  } finally {
    db.close();
  }
}

function tableDifference(databaseTable: SnapshotTable, snapshotTable: SnapshotTable): number {
  if (
    JSON.stringify(databaseTable.columns) !== JSON.stringify(snapshotTable.columns)
    || JSON.stringify(databaseTable.primaryKey) !== JSON.stringify(snapshotTable.primaryKey)
  ) return Math.max(databaseTable.rows.length, snapshotTable.rows.length, 1);
  const databaseRows = new Map(databaseTable.rows.map((row) => [
    JSON.stringify(databaseTable.primaryKey.map((column) => row[column] ?? null)),
    sha256Hex(JSON.stringify(databaseTable.columns.map((column) => row[column] ?? null))),
  ]));
  const snapshotRows = new Map(snapshotTable.rows.map((row) => [
    JSON.stringify(snapshotTable.primaryKey.map((column) => row[column] ?? null)),
    sha256Hex(JSON.stringify(snapshotTable.columns.map((column) => row[column] ?? null))),
  ]));
  const keys = new Set([...databaseRows.keys(), ...snapshotRows.keys()]);
  return [...keys].filter((key) => databaseRows.get(key) !== snapshotRows.get(key)).length;
}

export function auditSnapshotV2Consistency(
  contextInput: ExplicitSnapshotV2Context,
): SnapshotV2ConsistencyReport {
  const context = resolveContext(contextInput);
  const snapshot = readVerifiedSnapshotV2(context.snapshotDirectory);
  const db = new Database(context.databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const tables = {} as SnapshotV2ConsistencyReport['tables'];
    for (const table of SNAPSHOT_V2_TABLES) {
      const databaseTable = readSnapshotTable(db, table as SyncTableName);
      const snapshotTable = snapshot.tables[table];
      tables[table] = {
        databaseCount: databaseTable.rows.length,
        snapshotCount: snapshotTable.rows.length,
        differenceCount: tableDifference(databaseTable, snapshotTable),
      };
    }
    return {
      ok: SNAPSHOT_V2_TABLES.every((table) => tables[table].differenceCount === 0),
      schemaVersion: 2,
      tables,
    };
  } finally {
    db.close();
  }
}

export interface SnapshotV2RoundtripReport {
  exportImportOk: boolean;
  consistencyOk: boolean;
  tableCounts: Record<SnapshotV2TableName, number>;
  activeResumePointerPreserved: boolean;
  projectionPersisted: false;
  eventPayloadPreserved: boolean;
}

function readMeta(databasePath: string, key: string): string | null {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  } finally {
    db.close();
  }
}

export function runSnapshotV2Roundtrip(
  contextInput: ExplicitSnapshotV2Context,
): SnapshotV2RoundtripReport {
  const context = resolveContext(contextInput);
  const exported = exportSnapshotV2(context);
  const importedDatabasePath = path.join(context.workingDirectory, 'snapshot-v2-roundtrip.sqlite3');
  if (fs.existsSync(importedDatabasePath)) throw new Error('snapshot v2 roundtrip 目标已存在');
  importSnapshotV2({ ...context, databasePath: importedDatabasePath });
  const consistency = auditSnapshotV2Consistency({ ...context, databasePath: importedDatabasePath });
  const snapshot = readVerifiedSnapshotV2(context.snapshotDirectory);
  const sourcePayloads = snapshot.tables.feedback_events.rows.map((row) => row.payload_json);
  const importedDb = new Database(importedDatabasePath, { readonly: true, fileMustExist: true });
  let importedPayloads: unknown[] = [];
  try {
    importedPayloads = (importedDb.prepare(
      'SELECT payload_json FROM feedback_events ORDER BY id',
    ).all() as Array<{ payload_json: string }>).map((row) => row.payload_json);
  } finally {
    importedDb.close();
  }
  const applicationColumns = snapshot.tables.applications.columns;
  const projectionPersisted = applicationColumns.some((column) => (
    ['stage', 'outcome', 'communication_status', 'projection'].includes(column)
  ));
  if (projectionPersisted) throw new Error('snapshot v2 不得持久化 Projection');
  return {
    exportImportOk: true,
    consistencyOk: consistency.ok,
    tableCounts: exported.tableCounts,
    activeResumePointerPreserved: readMeta(context.databasePath, 'active_resume_version_id')
      === readMeta(importedDatabasePath, 'active_resume_version_id'),
    projectionPersisted: false,
    eventPayloadPreserved: JSON.stringify(importedPayloads) === JSON.stringify(sourcePayloads),
  };
}

export interface LegacySnapshotUpgradeContext extends ExplicitSnapshotV2Context {
  legacySnapshotDirectory: string;
}

export interface LegacySnapshotUpgradeResult {
  importedRows: number;
  backfill: LegacyBackfillSummary;
}

function readVerifiedLegacySnapshot(directory: string): OfferFlowSnapshotV1 {
  const snapshotPath = path.join(directory, 'offerflow.snapshot.json');
  const manifestPath = path.join(directory, 'offerflow.manifest.json');
  const text = fs.readFileSync(snapshotPath, 'utf8');
  const snapshot = JSON.parse(text) as OfferFlowSnapshotV1;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifestV1;
  if (snapshot.schemaVersion !== 1 || manifest.schemaVersion !== 1) {
    throw new Error('legacy upgrade 只接受 snapshot v1');
  }
  if (manifest.snapshotHash !== sha256Hex(text)) throw new Error('legacy snapshot hash mismatch');
  return snapshot;
}

export function upgradeLegacySnapshotV1OnTemporaryDatabase(
  contextInput: LegacySnapshotUpgradeContext,
): LegacySnapshotUpgradeResult {
  const context = resolveContext(contextInput, true);
  const legacyDirectory = path.resolve(contextInput.legacySnapshotDirectory);
  if (!isPathInside(context.workingDirectory, legacyDirectory)) {
    throw new Error('legacy snapshot 必须先复制到临时工作目录');
  }
  const snapshot = readVerifiedLegacySnapshot(legacyDirectory);
  fs.mkdirSync(path.dirname(context.databasePath), { recursive: true });
  const db = openDb(context.databasePath);
  try {
    initSchema(db, { targetVersion: 2 });
    for (const table of ['resume_versions', 'applications', 'feedback_events'] as const) {
      if (!tableIsEmpty(db, table)) throw new Error('v1 snapshot 不得覆盖已有 v2 求职记忆数据');
    }
    for (const table of ['profiles', 'jobs', 'import_logs'] as const) {
      if (!tableIsEmpty(db, table)) throw new Error('legacy snapshot upgrade 目标 v1 业务表必须为空');
    }
    let importedRows = 0;
    const restore = db.transaction(() => {
      for (const table of ['profiles', 'jobs', 'import_logs', 'app_meta'] as const) {
        const snapshotTable = snapshot.tables[table];
        if (snapshotTable !== undefined) {
          importedRows += restoreTable(db, table, snapshotTable, table === 'app_meta');
        }
      }
    });
    restore();
    const backfill = runLegacyBackfill(db);
    return { importedRows, backfill };
  } finally {
    db.close();
  }
}
