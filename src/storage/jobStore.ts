import type { JobRecord, JobCreateInput } from './types';
import type { StorageDriver } from './driver';
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

      contactStatus: 'not_contacted',
      contactStatusUpdatedAt: now,
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
      return JSON.parse(raw) as JobRecord;
    } catch (error) {
      throw new Error(
        `[OfferPilot] Job "${id}" is corrupted and cannot be parsed: ${(error as Error).message}`,
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
        jobs.push(JSON.parse(raw) as JobRecord);
      } catch (error) {
        // One bad row shouldn't sink the whole list — warn, don't crash, don't hide.
        console.warn(
          `[OfferPilot] Skipped a corrupted job at "${key}": ${(error as Error).message}`,
        );
      }
    }
    return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  updateJob(id: string, patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>>): JobRecord {
    const current = this.getJob(id);
    if (current === null) {
      throw new Error(`[OfferPilot] Cannot update — job "${id}" does not exist.`);
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
