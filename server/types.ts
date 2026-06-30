import type { JobRecord, JobSeekerProfile } from '../src/storage';

export interface ApiImportWarning {
  key: string;
  reason: string;
}

export interface ImportSummary {
  profileCount: number;
  jobCount: number;
  ignoredKeyCount: number;
  parseErrorCount: number;
  warnings: ApiImportWarning[];
  imported: boolean;
}

export interface ParsedLocalStorageBackup {
  profile: JobSeekerProfile | null;
  jobs: JobRecord[];
  summary: ImportSummary;
}

export interface ImportApplyResult extends ImportSummary {
  importLogId: string;
}
