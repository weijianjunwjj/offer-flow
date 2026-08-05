import { DatabaseSync } from 'node:sqlite';
import {
  NOVAWING_AUTHORITATIVE_TABLES,
  createInjectedSqliteNovaWingStore,
  verifyNovaWingAfterSnapshotRestore,
  type NovaWingSnapshotManifest,
} from '@weijianjunwjj/nova-wing/sqlite';
import type { JsonPrimitive } from '@weijianjunwjj/nova-wing/host-snapshot';
import { hostSnapshotError } from './errors';
import type { SnapshotComponentData, SnapshotTableData } from './types';

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function asPrimitive(value: unknown): JsonPrimitive {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 仅接受可验证的 SQLite 标量');
}

function sqliteColumns(connection: DatabaseSync, table: string): string[] {
  return (connection.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: unknown }>)
    .map((row) => String(row.name));
}

export function readNovaWingComponentData(connection: DatabaseSync): SnapshotComponentData {
  return {
    component: 'novawing',
    tables: NOVAWING_AUTHORITATIVE_TABLES.map((descriptor) => {
      const columns = sqliteColumns(connection, descriptor.name);
      if (columns.length === 0) {
        throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', 'NovaWing Snapshot 表结构不完整');
      }
      const rows = connection.prepare(
        `SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(descriptor.name)} ORDER BY ${descriptor.restoreOrderBy.map(quoteIdent).join(', ')}`,
      ).all() as Array<Record<string, unknown>>;
      return {
        name: descriptor.name,
        primaryKey: [...descriptor.primaryKey],
        columns,
        rows: rows.map((row) => Object.fromEntries(
          columns.map((column) => [column, asPrimitive(row[column])]),
        )),
      };
    }),
  };
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', `${label} 无效`);
  }
  return [...value];
}

function assertTableData(value: unknown): SnapshotTableData {
  if (value === null || typeof value !== 'object') {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Snapshot table 无效');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || candidate.name === '') {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Snapshot table 名称无效');
  }
  const columns = assertStringArray(candidate.columns, 'Snapshot columns');
  const primaryKey = assertStringArray(candidate.primaryKey, 'Snapshot primaryKey');
  if (!Array.isArray(candidate.rows)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Snapshot rows 无效');
  }
  const rows = candidate.rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Snapshot row 无效');
    }
    const record = row as Record<string, unknown>;
    if (
      Object.keys(record).length !== columns.length
      || Object.keys(record).some((key) => !columns.includes(key))
    ) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Snapshot row 列集合不匹配');
    }
    return Object.fromEntries(columns.map((column) => [column, asPrimitive(record[column])])) as Record<string, JsonPrimitive>;
  });
  return { name: candidate.name, columns, primaryKey, rows };
}

export function assertComponentData(value: unknown): SnapshotComponentData {
  if (value === null || typeof value !== 'object') {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Snapshot component data 无效');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.component !== 'string' || !Array.isArray(candidate.tables)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Snapshot component data 无效');
  }
  const tables = candidate.tables.map(assertTableData);
  if (new Set(tables.map((table) => table.name)).size !== tables.length) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Snapshot component 存在重复表');
  }
  return { component: candidate.component, tables };
}

function assertNovaWingTableSet(data: SnapshotComponentData): void {
  const expected = NOVAWING_AUTHORITATIVE_TABLES.map((table) => table.name);
  if (
    data.component !== 'novawing'
    || data.tables.length !== expected.length
    || data.tables.some((table, index) => table.name !== expected[index])
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'NovaWing component 权威表集合不匹配');
  }
}

export function restoreNovaWingComponentData(
  connection: DatabaseSync,
  data: SnapshotComponentData,
): void {
  assertNovaWingTableSet(data);
  for (const [index, descriptor] of NOVAWING_AUTHORITATIVE_TABLES.entries()) {
    const table = data.tables[index]!;
    const localColumns = sqliteColumns(connection, descriptor.name);
    if (
      JSON.stringify(localColumns) !== JSON.stringify(table.columns)
      || JSON.stringify(descriptor.primaryKey) !== JSON.stringify(table.primaryKey)
    ) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', 'NovaWing component 表结构不匹配');
    }
  }

  connection.exec('BEGIN IMMEDIATE');
  try {
    for (const descriptor of [...NOVAWING_AUTHORITATIVE_TABLES].reverse()) {
      connection.exec(`DELETE FROM ${quoteIdent(descriptor.name)}`);
    }
    for (const table of data.tables) {
      const statement = connection.prepare(
        `INSERT INTO ${quoteIdent(table.name)} (${table.columns.map(quoteIdent).join(', ')}) VALUES (${table.columns.map(() => '?').join(', ')})`,
      );
      for (const row of table.rows) {
        statement.run(...table.columns.map((column) => {
          const value = row[column] ?? null;
          return typeof value === 'boolean' ? Number(value) : value;
        }));
      }
    }
    connection.exec('COMMIT');
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch { /* Preserve the stable restore failure. */ }
    throw error;
  }
}

export function verifyNovaWingDataInMemory(
  data: SnapshotComponentData,
  manifest: NovaWingSnapshotManifest,
): void {
  const connection = new DatabaseSync(':memory:');
  let store: ReturnType<typeof createInjectedSqliteNovaWingStore> | undefined;
  try {
    store = createInjectedSqliteNovaWingStore({ connection, migrationMode: 'apply' });
    store.close();
    store = undefined;
    restoreNovaWingComponentData(connection, data);
    verifyNovaWingAfterSnapshotRestore(connection, manifest);
  } catch {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'NovaWing component 数据摘要不一致');
  } finally {
    try { store?.close(); } finally { connection.close(); }
  }
}

const SECRET_KEY = /^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie|environment|env)$/iu;
const SECRET_VALUE = /^(?:gh[opsu]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|Bearer\s+\S+)$/u;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root|etc|var)\/)/u;

function inspectJsonValue(value: unknown, key = ''): void {
  if (SECRET_KEY.test(key)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_SENSITIVE_DATA', 'Snapshot 检测到不允许的凭证字段');
  }
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value) || ABSOLUTE_PATH.test(value) || value.includes('process.env')) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_SENSITIVE_DATA', 'Snapshot 检测到不允许的敏感值');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectJsonValue(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) inspectJsonValue(childValue, childKey);
  }
}

export function assertSnapshotDataSafety(components: readonly SnapshotComponentData[]): void {
  for (const component of components) {
    for (const table of component.tables) {
      for (const row of table.rows) {
        for (const [column, value] of Object.entries(row)) {
          if (SECRET_KEY.test(column)) {
            throw hostSnapshotError('HOST_SNAPSHOT_V3_SENSITIVE_DATA', 'Snapshot 检测到不允许的凭证列');
          }
          if (typeof value === 'string' && column.endsWith('_json')) {
            let parsed: unknown;
            try { parsed = JSON.parse(value); } catch {
              throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Snapshot JSON 权威字段无法验证');
            }
            inspectJsonValue(parsed);
          } else {
            inspectJsonValue(value, column);
          }
        }
      }
    }
  }
}
