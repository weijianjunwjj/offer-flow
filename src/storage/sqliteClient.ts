import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { JobRecord, JobSeekerProfile } from './types';

export interface SQLiteClient {
  getProfile(): Promise<JobSeekerProfile | null>;
  saveProfile(profile: JobSeekerProfile): Promise<JobSeekerProfile>;
  clearProfile(): Promise<void>;
  createJob(job: JobRecord): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  listJobs(): Promise<JobRecord[]>;
  updateJob(job: JobRecord): Promise<JobRecord>;
  deleteJob(id: string): Promise<void>;
}

export interface SQLiteStorageMigrationStatus {
  migrationStatus: string | null;
  lastMigrationStatus: string | null;
}

export interface LocalStorageBackupWriteResult {
  dbPath: string;
  backupPath: string;
  fileName: string;
  checksum: string;
  sizeBytes: number;
  profileCount: number;
  jobCount: number;
  rawEntryCount: number;
  backupLogId: string;
}

export interface LocalStorageMigrationResult {
  dbPath: string;
  migrationId: string;
  status: string;
  profileCount: number;
  jobCount: number;
  backupChecksum: string;
  migrationStatus: string;
}

export interface SQLiteMigrationStatusClient {
  getStorageMigrationStatus(): Promise<SQLiteStorageMigrationStatus>;
}

export interface SQLiteControlledMigrationClient extends SQLiteMigrationStatusClient {
  writeLocalStorageBackup(payload: unknown): Promise<LocalStorageBackupWriteResult>;
  migrateLocalStorageToSqlite(payload: unknown): Promise<LocalStorageMigrationResult>;
}

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriSQLiteClient implements SQLiteClient, SQLiteControlledMigrationClient {
  constructor(private readonly invoke: TauriInvoke = tauriInvoke) {}

  getProfile(): Promise<JobSeekerProfile | null> {
    return this.invoke('sqlite_get_profile');
  }

  saveProfile(profile: JobSeekerProfile): Promise<JobSeekerProfile> {
    return this.invoke('sqlite_save_profile', {
      profileJson: JSON.stringify(profile),
    });
  }

  async clearProfile(): Promise<void> {
    await this.invoke<boolean>('sqlite_clear_profile');
  }

  createJob(job: JobRecord): Promise<JobRecord> {
    return this.invoke('sqlite_create_job', {
      jobJson: JSON.stringify(job),
    });
  }

  getJob(id: string): Promise<JobRecord | null> {
    return this.invoke('sqlite_get_job', { id });
  }

  listJobs(): Promise<JobRecord[]> {
    return this.invoke('sqlite_list_jobs');
  }

  updateJob(job: JobRecord): Promise<JobRecord> {
    return this.invoke('sqlite_update_job', {
      jobJson: JSON.stringify(job),
    });
  }

  async deleteJob(id: string): Promise<void> {
    await this.invoke<boolean>('sqlite_delete_job', { id });
  }

  getStorageMigrationStatus(): Promise<SQLiteStorageMigrationStatus> {
    return this.invoke('sqlite_get_storage_migration_status');
  }

  writeLocalStorageBackup(payload: unknown): Promise<LocalStorageBackupWriteResult> {
    return this.invoke('write_localstorage_backup', {
      payloadJson: JSON.stringify(payload),
    });
  }

  migrateLocalStorageToSqlite(payload: unknown): Promise<LocalStorageMigrationResult> {
    return this.invoke('migrate_localstorage_to_sqlite', {
      migrationPayloadJson: JSON.stringify(payload),
    });
  }
}
