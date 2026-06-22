import type { JobRecord, JobCreateInput } from './types';
import type { StorageDriver } from './driver';
import type { StoredJobRecord } from './defaults';
import { emptyCompanyInput, withJobRecordDefaults } from './defaults';
import { jobKey, isJobKey } from './keys';
import { newId } from './id';

/** Job records: many, one storage entry per id, no umbrella blob. */
export class JobStore {
  constructor(private readonly driver: StorageDriver) {}

  createJob(input: JobCreateInput = {}): JobRecord {
    const now = Date.now();
    const job: JobRecord = {
      id: newId(),
      createdAt: now,
      updatedAt: now,

      company: input.company ?? '',
      role: input.role ?? '',
      city: input.city ?? '',
      salaryRange: input.salaryRange ?? '',
      jdText: input.jdText ?? '',

      promptText: '',

      aiRawResult: '',
      aiPastedAt: null,
      parseStatus: 'none',

      report: null,
      matchScore: '',

      companyInput: emptyCompanyInput(),
      companyAssessment: null,
      opportunityAnalysis: null,

      communicationStatus: 'not_contacted',
    };
    this.write(job);
    return job;
  }

  getJob(id: string): JobRecord | null {
    const raw = this.driver.getItem(jobKey(id));
    if (raw === null) {
      return null;
    }
    try {
      // 旧岗位可能缺 v0.2 字段：读取后统一补默认值，保证返回完整 JobRecord。
      return withJobRecordDefaults(JSON.parse(raw) as StoredJobRecord);
    } catch (error) {
      throw new Error(
        `[OfferFlow] Job "${id}" is corrupted and cannot be parsed: ${(error as Error).message}`,
      );
    }
  }

  listJobs(): JobRecord[] {
    const jobs: JobRecord[] = [];
    for (const key of this.driver.keys()) {
      if (!isJobKey(key)) {
        continue;
      }
      const raw = this.driver.getItem(key);
      if (raw === null) {
        continue;
      }
      try {
        jobs.push(withJobRecordDefaults(JSON.parse(raw) as StoredJobRecord));
      } catch (error) {
        // One bad row shouldn't sink the whole list — warn, don't crash, don't hide.
        console.warn(
          `[OfferFlow] Skipped a corrupted job at "${key}": ${(error as Error).message}`,
        );
      }
    }
    return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  updateJob(id: string, patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>>): JobRecord {
    const current = this.getJob(id);
    if (current === null) {
      throw new Error(`[OfferFlow] Cannot update — job "${id}" does not exist.`);
    }
    const next: JobRecord = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    };
    this.write(next);
    return next;
  }

  deleteJob(id: string): boolean {
    const existed = this.driver.getItem(jobKey(id)) !== null;
    this.driver.removeItem(jobKey(id));
    return existed;
  }

  private write(job: JobRecord): void {
    this.driver.setItem(jobKey(job.id), JSON.stringify(job));
  }
}
