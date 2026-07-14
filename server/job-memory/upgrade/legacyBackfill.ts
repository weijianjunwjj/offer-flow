import { createHash } from 'node:crypto';
import {
  JobRecordSchema,
  projectApplication,
  type ApplicationRecord,
  type FeedbackEventRecord,
} from '../../../src/domain/job-memory';
import type { CommunicationStatus, JobRecord, ReviewStatus } from '../../../src/storage';
import { withJobRecordDefaults, type StoredJobRecord } from '../../../src/storage/defaults';
import type { SqliteDatabase } from '../../db';
import { getDatabaseSchemaVersion } from '../../migrations';
import { ApplicationRepository } from '../applicationRepository';
import { FeedbackEventRepository } from '../feedbackEventRepository';
import { sha256RequestHash } from '../requestHash';

const COMMUNICATION_STATUSES = [
  'not_contacted',
  'greeted_unread',
  'greeted_read_no_reply',
  'replied',
  'interviewing',
  'paused',
  'closed',
  'rejected',
] as const satisfies readonly CommunicationStatus[];

const ACTIVE_EVIDENCE_STATUSES = new Set<CommunicationStatus>([
  'greeted_unread',
  'greeted_read_no_reply',
  'replied',
  'interviewing',
]);

const REVIEW_STATUSES = new Set<ReviewStatus>([
  'pending_review',
  'confirmed',
  'deferred',
  'rejected',
]);

export interface LegacyCommunicationInput {
  communicationStatus: unknown;
  followupCount: unknown;
  lastGreetedAt?: unknown;
  lastFollowupAt?: unknown;
  lastCommunicationNote?: unknown;
  reviewStatus?: unknown;
  importStatus?: unknown;
}

export type LegacyBackfillDecision =
  | { action: 'skip'; reason: string }
  | {
      action: 'create_application';
      classification: string;
      confidence: 'weak';
      projectedLegacyStatus: CommunicationStatus;
      warnings: string[];
    }
  | { action: 'manual_review'; reason: string };

interface NormalizedLegacyFacts {
  communicationStatus: CommunicationStatus;
  followupCount: number;
  lastGreetedAt: number | null;
  lastFollowupAt: number | null;
  lastCommunicationNote: string | null;
  reviewStatus: ReviewStatus | null;
}

function optionalTimestamp(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

function normalizeLegacyFacts(input: LegacyCommunicationInput): NormalizedLegacyFacts | null {
  if (
    typeof input.communicationStatus !== 'string'
    || !COMMUNICATION_STATUSES.includes(input.communicationStatus as CommunicationStatus)
    || typeof input.followupCount !== 'number'
    || !Number.isSafeInteger(input.followupCount)
    || input.followupCount < 0
  ) return null;
  const lastGreetedAt = optionalTimestamp(input.lastGreetedAt);
  const lastFollowupAt = optionalTimestamp(input.lastFollowupAt);
  const lastCommunicationNote = optionalText(input.lastCommunicationNote);
  if (
    lastGreetedAt === undefined
    || lastFollowupAt === undefined
    || lastCommunicationNote === undefined
  ) return null;
  if (
    input.reviewStatus !== undefined
    && (typeof input.reviewStatus !== 'string' || !REVIEW_STATUSES.has(input.reviewStatus as ReviewStatus))
  ) return null;
  if (
    input.importStatus !== undefined
    && input.importStatus !== 'draft'
    && input.importStatus !== 'imported_draft'
  ) return null;
  return {
    communicationStatus: input.communicationStatus as CommunicationStatus,
    followupCount: input.followupCount,
    lastGreetedAt,
    lastFollowupAt,
    lastCommunicationNote,
    reviewStatus: (input.reviewStatus as ReviewStatus | undefined) ?? null,
  };
}

function hasInteractionEvidence(facts: NormalizedLegacyFacts): boolean {
  return ACTIVE_EVIDENCE_STATUSES.has(facts.communicationStatus)
    || facts.lastGreetedAt !== null
    || facts.lastFollowupAt !== null
    || facts.followupCount > 0;
}

export function classifyLegacyBackfill(input: LegacyCommunicationInput): LegacyBackfillDecision {
  const facts = normalizeLegacyFacts(input);
  if (facts === null) {
    return { action: 'manual_review', reason: 'legacy_fields_invalid_or_conflicting' };
  }
  const hasEvidence = hasInteractionEvidence(facts);
  if (facts.reviewStatus === 'rejected') {
    if (!hasEvidence && ['not_contacted', 'paused', 'closed', 'rejected'].includes(facts.communicationStatus)) {
      return { action: 'skip', reason: 'import_review_rejected_without_interaction' };
    }
    return { action: 'manual_review', reason: 'review_rejected_conflicts_with_interaction' };
  }
  if (
    facts.reviewStatus === 'deferred'
    && !hasEvidence
    && ['not_contacted', 'paused', 'closed', 'rejected'].includes(facts.communicationStatus)
  ) {
    return { action: 'skip', reason: 'import_review_deferred_without_interaction' };
  }
  if (facts.communicationStatus === 'not_contacted') {
    return hasEvidence
      ? { action: 'manual_review', reason: 'not_contacted_conflicts_with_interaction' }
      : { action: 'skip', reason: 'not_contacted_without_process' };
  }
  if (
    (facts.communicationStatus === 'paused'
      || facts.communicationStatus === 'closed'
      || facts.communicationStatus === 'rejected')
    && !hasEvidence
  ) {
    return { action: 'skip', reason: `${facts.communicationStatus}_without_interaction` };
  }

  const warnings: string[] = [];
  if (facts.lastGreetedAt === null && facts.lastFollowupAt === null) {
    warnings.push('interaction_time_unknown');
  }
  if (facts.followupCount > 0 && facts.lastFollowupAt === null) {
    warnings.push('followup_time_unknown');
  }
  if (facts.reviewStatus === 'deferred') warnings.push('import_review_deferred_but_interaction_present');
  const classification = ACTIVE_EVIDENCE_STATUSES.has(facts.communicationStatus)
    ? 'active_status'
    : facts.communicationStatus === 'paused'
      ? 'paused_with_interaction'
      : 'terminal_with_interaction';
  return {
    action: 'create_application',
    classification,
    confidence: 'weak',
    projectedLegacyStatus: facts.communicationStatus,
    warnings,
  };
}

function stableId(prefix: string, key: string): string {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function nullableTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : value ?? null;
}

function migrationKey(jobId: string): string {
  return `v2:legacy-job:${jobId}:communication`;
}

export interface LegacyBackfillSummary {
  totalJobs: number;
  actions: { skip: number; createApplication: number; manualReview: number };
  byLegacyStatus: Record<CommunicationStatus, number>;
  classifications: Record<string, number>;
  createdApplications: number;
  createdEvents: number;
  alreadyMigrated: number;
  auditLogCreated: boolean;
}

export interface LegacyBackfillOptions {
  now?: () => number;
  failAfterCreatedApplications?: number;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function loadValidatedJobs(db: SqliteDatabase): JobRecord[] {
  const rows = db.prepare('SELECT data_json FROM jobs ORDER BY id').all() as Array<{ data_json: string }>;
  return rows.map(({ data_json }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data_json) as unknown;
    } catch (error) {
      throw new Error(`legacy Job data_json 无法解析：${(error as Error).message}`);
    }
    const normalized = withJobRecordDefaults(parsed as StoredJobRecord);
    return JobRecordSchema.parse(normalized);
  });
}

export function runLegacyBackfill(
  db: SqliteDatabase,
  options: LegacyBackfillOptions = {},
): LegacyBackfillSummary {
  if (getDatabaseSchemaVersion(db) !== 2) {
    throw new Error('保守 backfill 只允许显式 schema v2 数据库连接');
  }
  const jobs = loadValidatedJobs(db);
  const applications = new ApplicationRepository(db);
  const events = new FeedbackEventRepository(db);
  const summary: LegacyBackfillSummary = {
    totalJobs: jobs.length,
    actions: { skip: 0, createApplication: 0, manualReview: 0 },
    byLegacyStatus: Object.fromEntries(COMMUNICATION_STATUSES.map((status) => [status, 0])) as Record<CommunicationStatus, number>,
    classifications: {},
    createdApplications: 0,
    createdEvents: 0,
    alreadyMigrated: 0,
    auditLogCreated: false,
  };
  const createdMigrationKeys: string[] = [];
  const execute = db.transaction(() => {
    for (const job of jobs) {
      summary.byLegacyStatus[job.communicationStatus] += 1;
      const decision = classifyLegacyBackfill(job);
      if (decision.action === 'skip') {
        summary.actions.skip += 1;
        increment(summary.classifications, decision.reason);
        continue;
      }
      if (decision.action === 'manual_review') {
        summary.actions.manualReview += 1;
        increment(summary.classifications, decision.reason);
        continue;
      }
      summary.actions.createApplication += 1;
      increment(summary.classifications, decision.classification);
      const key = migrationKey(job.id);
      const existing = db.prepare(
        'SELECT id, job_id FROM applications WHERE migration_key = ?',
      ).get(key) as { id: string; job_id: string } | undefined;
      const eventKey = `${key}:event`;
      if (existing !== undefined) {
        if (existing.job_id !== job.id) throw new Error('migration_key 指向错误 Job');
        const existingEvent = db.prepare(
          'SELECT application_id FROM feedback_events WHERE idempotency_key = ?',
        ).get(eventKey) as { application_id: string } | undefined;
        if (existingEvent?.application_id !== existing.id) {
          throw new Error('已存在迁移 Application 但缺少匹配 legacy seed');
        }
        summary.alreadyMigrated += 1;
        continue;
      }

      const createdAt = options.now?.() ?? Date.now();
      const applicationId = stableId('legacy_app', key);
      const application: ApplicationRecord = {
        id: applicationId,
        jobId: job.id,
        resumeVersionId: null,
        origin: 'unknown',
        channel: 'unknown',
        channelOtherLabel: null,
        recruitingEntity: {
          kind: 'unknown',
          name: null,
          employerGroupKey: null,
          endClientName: null,
        },
        primaryContact: null,
        cityContext: {
          jobCity: nullableTrimmed(job.city),
          marketCity: null,
          workMode: 'unknown',
        },
        draftMessageText: nullableTrimmed(job.draftMessageText),
        createdAt,
        updatedAt: createdAt,
        voidedAt: null,
        voidReason: null,
        supersededByApplicationId: null,
        rowVersion: 1,
      };
      applications.insert({
        record: application,
        idempotencyKey: `${key}:application`,
        requestHash: sha256RequestHash({ migrationKey: key, application }),
        migrationKey: key,
      });
      const legacyEvent: FeedbackEventRecord = {
        id: stableId('legacy_event', eventKey),
        applicationId,
        eventType: 'legacy_status_imported',
        eventAt: null,
        timePrecision: 'unknown',
        actor: 'system',
        recordedBy: 'system_migration',
        sourceConfidence: 'inferred',
        evidenceLevel: 'weak',
        channel: 'unknown',
        note: nullableTrimmed(job.lastCommunicationNote),
        reasonCode: null,
        payload: {
          legacyStatus: decision.projectedLegacyStatus,
          lastGreetedAt: job.lastGreetedAt ?? null,
          lastFollowupAt: job.lastFollowupAt ?? null,
          followupCount: job.followupCount,
          note: nullableTrimmed(job.lastCommunicationNote),
          migrationKey: key,
        },
        targetEventId: null,
        idempotencyKey: eventKey,
        createdAt,
      };
      events.insert({
        record: legacyEvent,
        requestHash: sha256RequestHash({ migrationKey: key, event: legacyEvent }),
      });
      if (projectApplication(application, [legacyEvent]).projectionStatus === 'invalid') {
        throw new Error('legacy seed 无法生成有效 Projection');
      }
      summary.createdApplications += 1;
      summary.createdEvents += 1;
      createdMigrationKeys.push(key);
      if (
        options.failAfterCreatedApplications !== undefined
        && summary.createdApplications >= options.failAfterCreatedApplications
      ) throw new Error('B7-A_TEST_INJECTED_BACKFILL_FAILURE');
    }

    if (summary.createdApplications > 0) {
      const auditId = `v2-backfill-audit-${createHash('sha256')
        .update(createdMigrationKeys.sort().join('\n'))
        .digest('hex')
        .slice(0, 24)}`;
      const aggregate = {
        version: 1,
        actions: summary.actions,
        byLegacyStatus: summary.byLegacyStatus,
        classifications: summary.classifications,
        createdApplications: summary.createdApplications,
        createdEvents: summary.createdEvents,
      };
      db.prepare(`
        INSERT INTO import_logs (
          id, source, profile_count, job_count, ignored_key_count,
          warning_count, created_at, data_json
        ) VALUES (?, ?, 0, ?, ?, ?, ?, ?)
      `).run(
        auditId,
        'job-memory-v2-backfill',
        summary.createdApplications,
        summary.actions.skip,
        summary.actions.manualReview,
        options.now?.() ?? Date.now(),
        JSON.stringify(aggregate),
      );
      summary.auditLogCreated = true;
    }
  });
  execute();
  return summary;
}
