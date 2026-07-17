import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  ApplicationRecordSchema,
  type ApplicationRecord,
  type FeedbackEventRecord,
  type ResumeVersionRecord,
} from '../../src/domain/job-memory';
import type { JobRecord } from '../../src/storage';
import type { SqliteDatabase } from '../db';
import { JobRepository } from '../repositories/jobRepository';
import { changedApplicationFields, mergeApplicationMetadata } from './applicationMetadata';
import { ApplicationRepository } from './applicationRepository';
import {
  ActivateResumeVersionRequestSchema,
  AppendFeedbackEventRequestSchema,
  ArchiveResumeVersionRequestSchema,
  CreateApplicationRequestSchema,
  CreateResumeVersionRequestSchema,
  UpdateApplicationMetadataRequestSchema,
  UpdateResumeVersionMetadataRequestSchema,
  UserFeedbackEventInputSchema,
  VoidApplicationRequestSchema,
  VoidFeedbackEventRequestSchema,
  type CreateApplicationRequest,
  type UserFeedbackEventInput,
} from './dtoSchemas';
import {
  conflict,
  notFound,
  ruleViolation,
  validationError,
} from './errors';
import { makeFeedbackEvent, makeUserFeedbackEvent } from './eventFactory';
import { FeedbackEventRepository } from './feedbackEventRepository';
import { JobMemoryQueries } from './jobMemoryQueries';
import { sha256RequestHash } from './requestHash';
import { ResumeVersionRepository } from './resumeVersionRepository';
import type {
  ActiveResumeResult,
  ApplicationMemory,
  JobDetailBundleV2,
  JobMemoryBundle,
  JobSummary,
} from './types';

export interface JobMemoryServiceDeps {
  now: () => number;
  createId: () => string;
}

const AUDIT_ONLY_EVENT_TYPES = new Set([
  'application_created',
  'application_voided',
  'application_metadata_corrected',
  'event_voided',
  'legacy_status_imported',
]);

function parseDto<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function eventTypeOf(value: unknown): unknown {
  return value !== null && typeof value === 'object' && 'eventType' in value
    ? (value as { eventType?: unknown }).eventType
    : undefined;
}

function rejectAuditOnlyEvent(value: unknown): void {
  const eventType = eventTypeOf(value);
  if (typeof eventType === 'string' && AUDIT_ONLY_EVENT_TYPES.has(eventType)) {
    throw ruleViolation(
      'AUDIT_EVENT_NOT_USER_CREATABLE',
      `事件类型 ${eventType} 只能由专用事务或 migration 创建`,
    );
  }
}

function rejectInvalidReplacementEvent(value: unknown): void {
  const eventType = eventTypeOf(value);
  if (typeof eventType === 'string' && AUDIT_ONLY_EVENT_TYPES.has(eventType)) {
    throw ruleViolation(
      'INVALID_REPLACEMENT_EVENT',
      `替代事件不能使用审计类型 ${eventType}`,
    );
  }
}

function nestedValue(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function versionConflict(currentVersion: number): never {
  throw conflict('VERSION_CONFLICT', '资源版本已变化，请重新读取后再提交', { currentVersion });
}

function assertVersion(currentVersion: number, expectedVersion: number): void {
  if (currentVersion !== expectedVersion) versionConflict(currentVersion);
}

export class JobMemoryService {
  private readonly resumeVersions: ResumeVersionRepository;
  private readonly applications: ApplicationRepository;
  private readonly events: FeedbackEventRepository;
  private readonly jobs: JobRepository;
  private readonly queries: JobMemoryQueries;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly deps: JobMemoryServiceDeps = {
      now: Date.now,
      createId: randomUUID,
    },
  ) {
    this.resumeVersions = new ResumeVersionRepository(db);
    this.applications = new ApplicationRepository(db);
    this.events = new FeedbackEventRepository(db);
    this.jobs = new JobRepository(db);
    this.queries = new JobMemoryQueries(db);
  }

  listResumeVersions(): { resumeVersions: ResumeVersionRecord[]; activeResumeVersionId: string | null } {
    return this.queries.listResumeVersions();
  }

  getResumeVersion(id: string): ResumeVersionRecord {
    const record = this.resumeVersions.getResumeVersion(id);
    if (record === null) throw notFound('RESUME_VERSION_NOT_FOUND', '简历版本不存在');
    return record;
  }

  getActiveResumeVersionId(): string | null {
    return this.queries.getActiveResumeVersionId();
  }

  createResumeVersion(value: unknown): ResumeVersionRecord {
    const request = parseDto(CreateResumeVersionRequestSchema, value);
    const requestHash = sha256RequestHash(request);
    const contentHash = sha256RequestHash(request.contentSnapshot);

    return this.transact(() => {
      const replay = this.resumeVersions.findByIdempotencyKey(request.idempotencyKey);
      if (replay !== null) {
        if (replay.requestHash !== requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同的简历版本请求');
        }
        return replay.record;
      }
      const duplicate = this.resumeVersions.findByContentHash(contentHash);
      if (duplicate !== null) {
        throw conflict('CONTENT_HASH_EXISTS', '相同内容的简历版本已存在', {
          existingId: duplicate.id,
        });
      }
      const record: ResumeVersionRecord = {
        id: this.deps.createId(),
        name: request.name,
        source: request.source,
        contentHash,
        summary: request.summary,
        contentSnapshot: request.contentSnapshot,
        createdAt: this.deps.now(),
        archivedAt: null,
        rowVersion: 1,
      };
      this.resumeVersions.insert({
        record,
        idempotencyKey: request.idempotencyKey,
        requestHash,
      });
      return this.getResumeVersion(record.id);
    });
  }

  updateResumeVersionMetadata(id: string, value: unknown): ResumeVersionRecord {
    const request = parseDto(UpdateResumeVersionMetadataRequestSchema, value);
    return this.transact(() => {
      const current = this.getResumeVersion(id);
      assertVersion(current.rowVersion, request.expectedVersion);
      const name = request.name ?? current.name;
      const summary = request.summary ?? current.summary;
      if (name === current.name && summary === current.summary) {
        throw ruleViolation('NO_EFFECTIVE_CHANGE', '简历版本元数据没有实际变化');
      }
      if (!this.resumeVersions.updateMetadata(id, request.expectedVersion, name, summary)) {
        const latest = this.getResumeVersion(id);
        versionConflict(latest.rowVersion);
      }
      return this.getResumeVersion(id);
    });
  }

  activateResumeVersion(id: string, value: unknown): ActiveResumeResult {
    const request = parseDto(ActivateResumeVersionRequestSchema, value);
    return this.transact(() => {
      const current = this.getResumeVersion(id);
      assertVersion(current.rowVersion, request.expectedVersion);
      if (current.archivedAt !== null) {
        throw ruleViolation('BUSINESS_RULE_VIOLATION', '已归档的简历版本不能激活');
      }
      this.resumeVersions.setActiveResumeVersionId(id, this.deps.now());
      return { resumeVersion: current, activeResumeVersionId: id };
    });
  }

  archiveResumeVersion(id: string, value: unknown): ActiveResumeResult {
    const request = parseDto(ArchiveResumeVersionRequestSchema, value);
    return this.transact(() => {
      const current = this.getResumeVersion(id);
      assertVersion(current.rowVersion, request.expectedVersion);
      if (current.archivedAt !== null) {
        throw ruleViolation('NO_EFFECTIVE_CHANGE', '简历版本已经归档');
      }
      const activeId = this.resumeVersions.getActiveResumeVersionId();
      let nextActiveId = activeId;
      if (activeId === id) {
        if (request.replacementResumeVersionId !== undefined) {
          if (request.replacementResumeVersionId === id) {
            throw conflict('ACTIVE_RESUME_CONFLICT', '替代简历版本不能是被归档版本自身');
          }
          const replacement = this.getResumeVersion(request.replacementResumeVersionId);
          if (replacement.archivedAt !== null) {
            throw conflict('ACTIVE_RESUME_CONFLICT', '替代简历版本已归档');
          }
          nextActiveId = replacement.id;
        } else if (request.clearActive === true) {
          nextActiveId = null;
        } else {
          throw conflict(
            'ACTIVE_RESUME_CONFLICT',
            '归档当前激活版本时必须指定替代版本或明确清空 active pointer',
          );
        }
      } else if (request.replacementResumeVersionId !== undefined || request.clearActive === true) {
        throw ruleViolation('BUSINESS_RULE_VIOLATION', '只有归档当前激活版本时才能调整 active pointer');
      }
      const archivedAt = this.deps.now();
      if (!this.resumeVersions.archive(id, request.expectedVersion, archivedAt)) {
        const latest = this.getResumeVersion(id);
        versionConflict(latest.rowVersion);
      }
      if (activeId === id) {
        this.resumeVersions.setActiveResumeVersionId(nextActiveId, archivedAt);
      }
      return {
        resumeVersion: this.getResumeVersion(id),
        activeResumeVersionId: nextActiveId,
      };
    });
  }

  listApplicationsByJob(jobId: string): ApplicationMemory[] {
    this.requireJob(jobId);
    return this.queries.listApplicationsByJob(jobId);
  }

  getApplication(id: string): ApplicationMemory {
    const record = this.requireApplication(id);
    return this.queries.toMemory(record);
  }

  createApplication(jobId: string, value: unknown): JobMemoryBundle {
    rejectAuditOnlyEvent(nestedValue(value, 'initialEvent'));
    const request = parseDto(CreateApplicationRequestSchema, value);
    const requestHash = sha256RequestHash({ jobId, ...request });
    const resultJobId = this.transact(() => {
      const replay = this.applications.findByIdempotencyKey(request.idempotencyKey);
      if (replay !== null) {
        if (replay.requestHash !== requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同的 Application 创建请求');
        }
        return replay.record.jobId;
      }
      this.requireJob(jobId);
      this.assertSelectableResumeVersion(request.resumeVersionId);
      const now = this.deps.now();
      const record = ApplicationRecordSchema.parse({
        id: this.deps.createId(),
        jobId,
        resumeVersionId: request.resumeVersionId,
        origin: request.origin,
        channel: request.channel,
        channelOtherLabel: request.channelOtherLabel,
        recruitingEntity: request.recruitingEntity,
        primaryContact: request.primaryContact,
        cityContext: request.cityContext,
        draftMessageText: request.draftMessageText,
        createdAt: now,
        updatedAt: now,
        voidedAt: null,
        voidReason: null,
        supersededByApplicationId: null,
        rowVersion: 1,
      });
      this.applications.insert({
        record,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        migrationKey: null,
      });

      const createdKey = `${request.idempotencyKey}:application-created`;
      const createdHash = sha256RequestHash({
        command: 'application_created',
        applicationId: record.id,
        applicationRequestHash: requestHash,
      });
      this.assertInternalEventKeyAvailable(createdKey);
      this.events.insert(makeFeedbackEvent(this.deps, {
        applicationId: record.id,
        input: {
          eventType: 'application_created',
          eventAt: now,
          timePrecision: 'exact',
          actor: 'system',
          sourceConfidence: 'exact',
          evidenceLevel: 'strong',
          channel: record.channel,
          note: null,
          reasonCode: null,
          payload: {},
        },
        idempotencyKey: createdKey,
        requestHash: createdHash,
        createdAt: now,
      }));

      if (request.initialEvent !== null) {
        const initialKey = `${request.idempotencyKey}:initial-event`;
        const initialHash = sha256RequestHash({
          command: 'initial_event',
          applicationId: record.id,
          event: request.initialEvent,
        });
        this.assertInternalEventKeyAvailable(initialKey);
        this.events.insert(makeUserFeedbackEvent(
          this.deps,
          record.id,
          request.initialEvent,
          initialKey,
          initialHash,
        ));
      }
      return jobId;
    });
    return this.getJobMemoryBundle(resultJobId);
  }

  updateApplicationMetadata(id: string, value: unknown): JobMemoryBundle {
    const request = parseDto(UpdateApplicationMetadataRequestSchema, value);
    const jobId = this.transact(() => {
      const current = this.requireApplication(id);
      if (current.voidedAt !== null) {
        throw conflict('APPLICATION_ALREADY_VOIDED', '已作废的 Application 不能修改');
      }
      assertVersion(current.rowVersion, request.expectedVersion);
      const candidate = mergeApplicationMetadata(current, request);
      this.assertSelectableResumeVersion(candidate.resumeVersionId);
      const parsedCandidate = ApplicationRecordSchema.safeParse(candidate);
      if (!parsedCandidate.success) throw validationError(parsedCandidate.error);
      const { correctedFields, before, after } = changedApplicationFields(current, parsedCandidate.data);
      if (correctedFields.length === 0) {
        throw ruleViolation('NO_EFFECTIVE_CHANGE', 'Application 元数据没有实际变化');
      }
      const now = this.deps.now();
      const next: ApplicationRecord = {
        ...parsedCandidate.data,
        updatedAt: now,
        rowVersion: current.rowVersion + 1,
      };
      if (!this.applications.updateApplication(next, current.rowVersion)) {
        versionConflict(this.requireApplication(id).rowVersion);
      }
      const auditKey = `application:${id}:metadata:${next.rowVersion}`;
      this.assertInternalEventKeyAvailable(auditKey);
      const payload = { correctedFields, before, after, reason: request.reason };
      this.events.insert(makeFeedbackEvent(this.deps, {
        applicationId: id,
        input: {
          eventType: 'application_metadata_corrected',
          eventAt: now,
          timePrecision: 'exact',
          actor: 'user',
          sourceConfidence: 'exact',
          evidenceLevel: 'strong',
          channel: next.channel,
          note: null,
          reasonCode: null,
          payload,
        },
        idempotencyKey: auditKey,
        requestHash: sha256RequestHash({ applicationId: id, expectedVersion: current.rowVersion, payload }),
        createdAt: now,
      }));
      return current.jobId;
    });
    return this.getJobMemoryBundle(jobId);
  }

  voidApplication(id: string, value: unknown): JobMemoryBundle {
    const request = parseDto(VoidApplicationRequestSchema, value);
    const jobId = this.transact(() => {
      const current = this.requireApplication(id);
      if (current.voidedAt !== null) {
        throw conflict('APPLICATION_ALREADY_VOIDED', 'Application 已经作废');
      }
      assertVersion(current.rowVersion, request.expectedVersion);
      if (request.supersededByApplicationId !== null) {
        const target = this.requireApplication(request.supersededByApplicationId);
        if (target.id === current.id || target.jobId !== current.jobId || target.voidedAt !== null) {
          throw ruleViolation(
            'BUSINESS_RULE_VIOLATION',
            'superseded target 必须是同一 Job 下未作废的其他 Application',
          );
        }
      }
      const now = this.deps.now();
      const next: ApplicationRecord = {
        ...current,
        updatedAt: now,
        voidedAt: now,
        voidReason: request.reason,
        supersededByApplicationId: request.supersededByApplicationId,
        rowVersion: current.rowVersion + 1,
      };
      if (!this.applications.updateApplication(next, current.rowVersion)) {
        versionConflict(this.requireApplication(id).rowVersion);
      }
      const auditKey = `application:${id}:void:${next.rowVersion}`;
      this.assertInternalEventKeyAvailable(auditKey);
      this.events.insert(makeFeedbackEvent(this.deps, {
        applicationId: id,
        input: {
          eventType: 'application_voided',
          eventAt: now,
          timePrecision: 'exact',
          actor: 'user',
          sourceConfidence: 'exact',
          evidenceLevel: 'strong',
          channel: current.channel,
          note: null,
          reasonCode: null,
          payload: { reason: request.reason },
        },
        idempotencyKey: auditKey,
        requestHash: sha256RequestHash({ applicationId: id, ...request }),
        createdAt: now,
      }));
      return current.jobId;
    });
    return this.getJobMemoryBundle(jobId);
  }

  listEventsByApplication(applicationId: string): FeedbackEventRecord[] {
    this.requireApplication(applicationId);
    return this.events.listEventsByApplication(applicationId);
  }

  appendFeedbackEvent(applicationId: string, value: unknown): JobMemoryBundle {
    rejectAuditOnlyEvent(value);
    const request = parseDto(AppendFeedbackEventRequestSchema, value);
    const requestHash = sha256RequestHash({ applicationId, ...request });
    const jobId = this.transact(() => {
      const replay = this.events.findByIdempotencyKey(request.idempotencyKey);
      if (replay !== null) {
        if (replay.requestHash !== requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同的事件追加请求');
        }
        return this.requireApplication(replay.record.applicationId).jobId;
      }
      const application = this.requireApplication(applicationId);
      this.assertApplicationWritable(application, request.expectedApplicationVersion);
      this.events.insert(makeUserFeedbackEvent(
        this.deps,
        applicationId,
        request.event,
        request.idempotencyKey,
        requestHash,
      ));
      const now = this.deps.now();
      if (!this.applications.incrementVersion(applicationId, application.rowVersion, now)) {
        versionConflict(this.requireApplication(applicationId).rowVersion);
      }
      return application.jobId;
    });
    return this.getJobMemoryBundle(jobId);
  }

  voidFeedbackEvent(eventId: string, value: unknown): JobMemoryBundle {
    rejectInvalidReplacementEvent(nestedValue(value, 'replacementEvent'));
    const request = parseDto(VoidFeedbackEventRequestSchema, value);
    const requestHash = sha256RequestHash({ eventId, ...request });
    const jobId = this.transact(() => {
      const replay = this.events.findByIdempotencyKey(request.idempotencyKey);
      if (replay !== null) {
        if (replay.requestHash !== requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同的事件作废请求');
        }
        return this.requireApplication(replay.record.applicationId).jobId;
      }
      const target = this.events.getFeedbackEvent(eventId);
      if (target === null) throw notFound('FEEDBACK_EVENT_NOT_FOUND', '反馈事件不存在');
      if (target.eventType === 'event_voided') {
        throw ruleViolation('BUSINESS_RULE_VIOLATION', '不能作废另一个 event_voided');
      }
      const application = this.requireApplication(target.applicationId);
      this.assertApplicationWritable(application, request.expectedApplicationVersion);
      if (this.events.findVoidByTarget(target.id) !== null) {
        throw conflict('EVENT_ALREADY_VOIDED', '反馈事件已经作废');
      }
      const now = this.deps.now();
      this.events.insert(makeFeedbackEvent(this.deps, {
        applicationId: application.id,
        input: {
          eventType: 'event_voided',
          eventAt: now,
          timePrecision: 'exact',
          actor: 'user',
          sourceConfidence: 'exact',
          evidenceLevel: 'strong',
          channel: target.channel,
          note: null,
          reasonCode: null,
          payload: {
            targetEventId: target.id,
            targetEventType: target.eventType,
            reason: request.reason,
          },
          targetEventId: target.id,
        },
        idempotencyKey: request.idempotencyKey,
        requestHash,
        createdAt: now,
      }));
      if (request.replacementEvent !== null) {
        const replacementKey = `${request.idempotencyKey}:replacement`;
        this.assertInternalEventKeyAvailable(replacementKey);
        this.events.insert(makeUserFeedbackEvent(
          this.deps,
          application.id,
          request.replacementEvent,
          replacementKey,
          sha256RequestHash({ eventId, replacementEvent: request.replacementEvent }),
        ));
      }
      if (!this.applications.incrementVersion(application.id, application.rowVersion, now)) {
        versionConflict(this.requireApplication(application.id).rowVersion);
      }
      return application.jobId;
    });
    return this.getJobMemoryBundle(jobId);
  }

  getJobMemoryBundle(jobId: string): JobMemoryBundle {
    return this.queries.getJobMemoryBundle(jobId);
  }

  getJobSummaries(): JobSummary[] {
    return this.queries.getJobSummaries();
  }

  getJobDetailBundle(jobId: string): JobDetailBundleV2 {
    return this.queries.getJobDetailBundle(jobId);
  }

  private requireJob(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (job === null) throw notFound('JOB_NOT_FOUND', '岗位不存在');
    return job;
  }

  private requireApplication(id: string): ApplicationRecord {
    const application = this.applications.getApplication(id);
    if (application === null) throw notFound('APPLICATION_NOT_FOUND', 'Application 不存在');
    return application;
  }

  private assertSelectableResumeVersion(id: string | null): void {
    if (id === null) return;
    const resumeVersion = this.resumeVersions.getResumeVersion(id);
    if (resumeVersion === null) throw notFound('RESUME_VERSION_NOT_FOUND', '简历版本不存在');
    if (resumeVersion.archivedAt !== null) {
      throw ruleViolation('ARCHIVED_RESUME_NOT_SELECTABLE', '已归档简历版本不能用于新的 Application');
    }
  }

  private assertApplicationWritable(application: ApplicationRecord, expectedVersion: number): void {
    if (application.voidedAt !== null) {
      throw conflict('APPLICATION_ALREADY_VOIDED', '已作废的 Application 不能追加或纠正事件');
    }
    assertVersion(application.rowVersion, expectedVersion);
  }

  private assertInternalEventKeyAvailable(idempotencyKey: string): void {
    if (this.events.findByIdempotencyKey(idempotencyKey) !== null) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', '派生事件幂等键已被占用');
    }
  }

  private transact<Result>(run: () => Result): Result {
    return this.db.transaction(run)();
  }
}

export function parseUserFeedbackEventInput(value: unknown): UserFeedbackEventInput {
  rejectAuditOnlyEvent(value);
  return parseDto(UserFeedbackEventInputSchema, value);
}

export type { CreateApplicationRequest };
