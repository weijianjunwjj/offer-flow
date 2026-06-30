import { apiSend } from './client';

export interface ImportWarning {
  key: string;
  reason: string;
}

export interface ImportSummary {
  profileCount: number;
  jobCount: number;
  ignoredKeyCount: number;
  parseErrorCount: number;
  warnings: ImportWarning[];
  imported: boolean;
}

export interface ImportApplyResult extends ImportSummary {
  importLogId: string;
}

export const importApi = {
  preview(backup: unknown): Promise<ImportSummary> {
    return apiSend<ImportSummary>('/imports/localstorage/preview', 'POST', backup);
  },
  apply(backup: unknown): Promise<ImportApplyResult> {
    return apiSend<ImportApplyResult>('/imports/localstorage/apply', 'POST', backup);
  },
};
