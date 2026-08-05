export const LEGACY_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const SNAPSHOT_SCHEMA_VERSION = 2 as const;

export const LEGACY_SYNC_TABLES = ['app_meta', 'profiles', 'jobs', 'import_logs'] as const;
export const SYNC_TABLES = [
  'profiles',
  'jobs',
  'resume_versions',
  'applications',
  'feedback_events',
  'import_logs',
  'app_meta',
] as const;

export type SyncTableName = (typeof SYNC_TABLES)[number];

export interface SyncPaths {
  dbPath: string;
  dataDir: string;
  syncDir: string;
  backupsDir: string;
  corruptedDir: string;
  snapshotPath: string;
  manifestPath: string;
  lockPath: string;
  deviceIdPath: string;
}

export interface SnapshotTable {
  primaryKey: string[];
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface OfferFlowSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  databaseSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  deviceId: string;
  appVersion: string;
  coverage?: SnapshotV2Coverage;
  tables: Partial<Record<SyncTableName, SnapshotTable>>;
}

export interface SnapshotManifest {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  databaseSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  deviceId: string;
  appVersion: string;
  coverage?: SnapshotV2Coverage;
  snapshotHash: string;
  tableCounts: Partial<Record<SyncTableName, number>>;
}

/** V2 is intentionally a seven-table sync projection, never a complete host backup. */
export interface SnapshotV2Coverage {
  scope: 'offerflow-core-v2';
  novaWingIncluded: false;
  completeHostBackup: false;
}

export const SNAPSHOT_V2_COVERAGE: SnapshotV2Coverage = Object.freeze({
  scope: 'offerflow-core-v2',
  novaWingIncluded: false,
  completeHostBackup: false,
});

export function describeSnapshotV2Coverage(input: {
  novaWingFeatureEnabled: boolean;
  novaWingDataPresent: boolean;
}): SnapshotV2Coverage & { warning: string | null } {
  const incompleteForNovaWing = input.novaWingFeatureEnabled || input.novaWingDataPresent;
  return {
    ...SNAPSHOT_V2_COVERAGE,
    warning: incompleteForNovaWing
      ? 'Snapshot V2 不包含 NovaWing 数据，不能作为完整 Host 备份或 NovaWing 恢复来源'
      : null,
  };
}

export interface LegacyOfferFlowSnapshotV1 {
  schemaVersion: typeof LEGACY_SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  deviceId: string;
  appVersion: string;
  tables: Partial<Record<(typeof LEGACY_SYNC_TABLES)[number], SnapshotTable>>;
}

export interface LegacySnapshotManifestV1 {
  schemaVersion: typeof LEGACY_SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  deviceId: string;
  appVersion: string;
  snapshotHash: string;
  tableCounts: Partial<Record<(typeof LEGACY_SYNC_TABLES)[number], number>>;
}

export interface DoctorResult {
  ok: boolean;
  dbPath: string;
  dbExists: boolean;
  integrity: string[];
  foreignKeyViolations: Array<Record<string, unknown>>;
  warnings: string[];
  error?: string;
}

export interface ExportSnapshotResult {
  snapshotPath: string;
  manifestPath: string;
  snapshotHash: string;
  tableCounts: Partial<Record<SyncTableName, number>>;
  exportedAt: string;
  deviceId: string;
}

export interface ImportSnapshotResult {
  inserted: number;
  updated: number;
  skipped: number;
  warnings: string[];
  snapshotHash: string;
}

export interface BackupResult {
  sqliteBackupPath?: string;
  snapshotBackupPath?: string;
  manifestBackupPath?: string;
  ok: boolean;
  warnings: string[];
}

export interface SyncRunResult {
  doctor: DoctorResult;
  importResult: ImportSnapshotResult | null;
  exportResult: ExportSnapshotResult;
  backupResult: BackupResult;
  warnings: string[];
}
