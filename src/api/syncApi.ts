import { apiGet, apiSend } from './client';

export interface SyncDoctorResult {
  ok: boolean;
  dbPath: string;
  dbExists: boolean;
  integrity: string[];
  foreignKeyViolations: Array<Record<string, unknown>>;
  warnings: string[];
  error?: string;
}

export interface SyncStatus {
  doctor: SyncDoctorResult;
  deviceId: string;
  snapshotExists: boolean;
  manifestExists: boolean;
  lastSyncAt: string | null;
  snapshotHash: string | null;
  shortSnapshotHash: string | null;
  tableCounts: Record<string, number> | null;
  activeLock: boolean;
  warnings: string[];
}

export interface SyncImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  warnings: string[];
  snapshotHash: string;
}

export interface SyncExportResult {
  snapshotPath: string;
  manifestPath: string;
  snapshotHash: string;
  tableCounts: Record<string, number>;
  exportedAt: string;
  deviceId: string;
}

export interface SyncBackupResult {
  sqliteBackupPath?: string;
  snapshotBackupPath?: string;
  manifestBackupPath?: string;
  ok: boolean;
  warnings: string[];
}

export interface SyncRunResult {
  doctor: SyncDoctorResult;
  importResult: SyncImportResult | null;
  exportResult: SyncExportResult;
  backupResult: SyncBackupResult;
  warnings: string[];
}

export const syncApi = {
  status(): Promise<SyncStatus> {
    return apiGet<SyncStatus>('/api/sync/status');
  },
  doctor(): Promise<SyncDoctorResult> {
    return apiSend<SyncDoctorResult>('/api/sync/doctor', 'POST');
  },
  run(): Promise<SyncRunResult> {
    return apiSend<SyncRunResult>('/api/sync/run', 'POST');
  },
  export(): Promise<SyncExportResult> {
    return apiSend<SyncExportResult>('/api/sync/export', 'POST');
  },
  import(): Promise<SyncImportResult> {
    return apiSend<SyncImportResult>('/api/sync/import', 'POST');
  },
};
