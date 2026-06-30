import { nanoid } from 'nanoid';
import type { JobCreateInput, JobRecord } from '../../src/storage';
import { emptyCompanyInput } from '../../src/storage';
import { withJobRecordDefaults, type StoredJobRecord } from '../../src/storage/defaults';
import type { SqliteDatabase } from '../db';

function matchScoreToInteger(value: string): number | null {
  const match = value.match(/\d+/);
  if (!match) {
    return null;
  }
  const score = Number(match[0]);
  return Number.isFinite(score) ? score : null;
}

function rowToJob(row: { data_json: string }): JobRecord {
  return withJobRecordDefaults(JSON.parse(row.data_json) as StoredJobRecord);
}

function makeJob(input: JobCreateInput & Partial<JobRecord> = {}): JobRecord {
  const now = Date.now();
  return withJobRecordDefaults({
    id: input.id ?? nanoid(),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    company: input.company ?? '',
    role: input.role ?? '',
    city: input.city ?? '',
    salaryRange: input.salaryRange ?? '',
    jdText: input.jdText ?? '',
    promptText: input.promptText ?? '',
    aiRawResult: input.aiRawResult ?? '',
    aiPastedAt: input.aiPastedAt ?? null,
    parseStatus: input.parseStatus ?? 'none',
    report: input.report ?? null,
    matchScore: input.matchScore ?? '',
    companyInput: input.companyInput ?? emptyCompanyInput(),
    companyAssessment: input.companyAssessment ?? null,
    opportunityAnalysis: input.opportunityAnalysis ?? null,
    communicationStatus: input.communicationStatus ?? 'not_contacted',
    followupCount: input.followupCount ?? 0,
    highValueSignal: input.highValueSignal ?? false,
    lastGreetedAt: input.lastGreetedAt,
    lastFollowupAt: input.lastFollowupAt,
    lastCommunicationNote: input.lastCommunicationNote,
    strategyOverride: input.strategyOverride,
    draftMessageText: input.draftMessageText,
  });
}

export class JobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(): JobRecord[] {
    const rows = this.db
      .prepare('SELECT data_json FROM jobs ORDER BY updated_at DESC')
      .all() as Array<{ data_json: string }>;
    return rows.map(rowToJob);
  }

  get(id: string): JobRecord | null {
    const row = this.db
      .prepare('SELECT data_json FROM jobs WHERE id = ?')
      .get(id) as { data_json: string } | undefined;
    return row ? rowToJob(row) : null;
  }

  create(input: JobCreateInput & Partial<JobRecord>): JobRecord {
    const job = makeJob(input);
    this.write(job);
    return job;
  }

  replace(id: string, input: Partial<JobRecord>): JobRecord {
    const current = this.get(id);
    const createdAt = current?.createdAt ?? input.createdAt ?? Date.now();
    const next = makeJob({ ...input, id, createdAt, updatedAt: Date.now() });
    this.write(next);
    return next;
  }

  patch(id: string, patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>>): JobRecord | null {
    const current = this.get(id);
    if (current === null) {
      return null;
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

  upsert(job: JobRecord): JobRecord {
    this.write(withJobRecordDefaults(job as StoredJobRecord));
    return job;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  private write(job: JobRecord): void {
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, company, role, city, salary_range, match_score,
          communication_status, updated_at, created_at, data_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          company = excluded.company,
          role = excluded.role,
          city = excluded.city,
          salary_range = excluded.salary_range,
          match_score = excluded.match_score,
          communication_status = excluded.communication_status,
          updated_at = excluded.updated_at,
          created_at = excluded.created_at,
          data_json = excluded.data_json`,
      )
      .run(
        job.id,
        job.company,
        job.role,
        job.city,
        job.salaryRange,
        matchScoreToInteger(job.matchScore),
        job.communicationStatus,
        job.updatedAt,
        job.createdAt,
        JSON.stringify(job),
      );
  }
}
