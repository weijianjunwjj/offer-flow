import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  ApplicationRecordSchema,
  type ApplicationRecord,
} from '../../src/domain/job-memory';
import type {
  HistoricalBaselineDraft,
  HistoricalBaselineDraftWithEvents,
  HistoricalEventDraft,
  HistoricalImportConfirmOutcome,
  HistoricalImportConfirmResult,
  HistoricalImportSession,
  HistoricalImportSessionBundle,
} from '../../src/domain/history-import';
import type { SqliteDatabase } from '../db';
import { JobRepository } from '../repositories/jobRepository';
import { ApplicationRepository } from '../job-memory/applicationRepository';
import { FeedbackEventRepository } from '../job-memory/feedbackEventRepository';
import { makeFeedbackEvent } from '../job-memory/eventFactory';
import { sha256RequestHash } from '../job-memory/requestHash';
import { HistoricalBaselineDraftRepository } from './baselineDraftRepository';
import { HistoricalEventDraftRepository } from './eventDraftRepository';
import { HistoricalImportSessionRepository } from './sessionRepository';
import { HistoricalImportReceiptRepository } from './receiptRepository';
import {
  ConfirmSessionRequestSchema,
  CreateBaselineDraftRequestSchema,
  CreateEventDraftRequestSchema,
  DiscardSessionRequestSchema,
  UpdateBaselineDraftRequestSchema,
  UpdateEventDraftRequestSchema,
  type CreateBaselineDraftRequest,
  type DiscardSessionRequest,
  type UpdateBaselineDraftRequest,
} from './dtoSchemas';
import {
  conflict,
  notFound,
  ruleViolation,
  validationError,
} from './errors';

export interface HistoryImportServiceDeps {
  now: () => number;
  createId: () => string;
}

function parseDto<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function versionConflict(currentVersion: number): never {
  throw conflict('VERSION_CONFLICT', '资源版本已变化，请重新读取后再提交', { currentVersion });
}

function assertVersion(currentVersion: number, expectedVersion: number): void {
  if (currentVersion !== expectedVersion) versionConflict(currentVersion);
}

export class HistoryImportService {
  private readonly sessions: HistoricalImportSessionRepository;
  private readonly baselineDrafts: HistoricalBaselineDraftRepository;
  private readonly eventDrafts: HistoricalEventDraftRepository;
  private readonly receipts: HistoricalImportReceiptRepository;
  private readonly jobs: JobRepository;
  private readonly applications: ApplicationRepository;
  private readonly events: FeedbackEventRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly deps: HistoryImportServiceDeps = {
      now: Date.now,
      createId: randomUUID,
    },
  ) {
    this.sessions = new HistoricalImportSessionRepository(db);
    this.baselineDrafts = new HistoricalBaselineDraftRepository(db);
    this.eventDrafts = new HistoricalEventDraftRepository(db);
    this.receipts = new HistoricalImportReceiptRepository(db);
    this.jobs = new JobRepository(db);
    this.applications = new ApplicationRepository(db);
    this.events = new FeedbackEventRepository(db);
  }

  listSessions(): HistoricalImportSession[] {
    return this.sessions.listSessions();
  }

  createSession(): HistoricalImportSession {
    return this.transact(() => {
      const now = this.deps.now();
      const session: HistoricalImportSession = {
        id: this.deps.createId(),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        confirmedAt: null,
        discardedAt: null,
        rowVersion: 1,
      };
      this.sessions.insert(session);
      return session;
    });
  }

  getSessionBundle(sessionId: string): HistoricalImportSessionBundle {
    const session = this.requireSession(sessionId);
    const drafts = this.baselineDrafts.listDraftsBySession(sessionId);
    const draftsWithEvents: HistoricalBaselineDraftWithEvents[] = drafts.map((draft) => ({
      draft,
      events: this.eventDrafts.listEventDraftsByBaseline(draft.id),
    }));
    return { session, drafts: draftsWithEvents };
  }

  createBaselineDraft(sessionId: string, value: unknown): HistoricalBaselineDraft {
    const request = parseDto(CreateBaselineDraftRequestSchema, value);
    return this.transact(() => {
      const session = this.requireEditableSession(sessionId);
      const now = this.deps.now();
      const draft = this.buildBaselineDraftRecord(session.id, request, now);
      this.baselineDrafts.insert(draft);
      return draft;
    });
  }

  updateBaselineDraft(draftId: string, value: unknown): HistoricalBaselineDraft {
    const request = parseDto(UpdateBaselineDraftRequestSchema, value);
    return this.transact(() => {
      const current = this.requireBaselineDraft(draftId);
      this.requireEditableSession(current.sessionId);
      assertVersion(current.rowVersion, request.expectedVersion);
      const now = this.deps.now();
      const next: HistoricalBaselineDraft = {
        ...this.buildBaselineDraftRecord(current.sessionId, request, current.createdAt, current.id),
        updatedAt: now,
        rowVersion: current.rowVersion + 1,
        createdJobId: current.createdJobId,
        createdApplicationId: current.createdApplicationId,
      };
      if (!this.baselineDrafts.update(next, current.rowVersion)) {
        versionConflict(this.requireBaselineDraft(draftId).rowVersion);
      }
      return next;
    });
  }

  deleteBaselineDraft(draftId: string): void {
    this.transact(() => {
      const current = this.requireBaselineDraft(draftId);
      this.requireEditableSession(current.sessionId);
      this.baselineDrafts.deleteDraft(draftId);
    });
  }

  createEventDraft(baselineDraftId: string, value: unknown): HistoricalEventDraft {
    const request = parseDto(CreateEventDraftRequestSchema, value);
    return this.transact(() => {
      const baseline = this.requireBaselineDraft(baselineDraftId);
      this.requireEditableSession(baseline.sessionId);
      const now = this.deps.now();
      const draft: HistoricalEventDraft = {
        id: this.deps.createId(),
        baselineDraftId,
        createdFeedbackEventId: null,
        createdAt: now,
        updatedAt: now,
        rowVersion: 1,
        ...request,
      };
      this.eventDrafts.insert(draft);
      return draft;
    });
  }

  updateEventDraft(eventDraftId: string, value: unknown): HistoricalEventDraft {
    const request = parseDto(UpdateEventDraftRequestSchema, value);
    return this.transact(() => {
      const current = this.requireEventDraft(eventDraftId);
      const baseline = this.requireBaselineDraft(current.baselineDraftId);
      this.requireEditableSession(baseline.sessionId);
      assertVersion(current.rowVersion, request.expectedVersion);
      const now = this.deps.now();
      const next: HistoricalEventDraft = {
        ...current,
        eventType: request.eventType,
        eventAt: request.eventAt,
        timePrecision: request.timePrecision,
        actor: request.actor,
        sourceConfidence: request.sourceConfidence,
        evidenceLevel: request.evidenceLevel,
        channel: request.channel,
        reasonCode: request.reasonCode,
        note: request.note,
        updatedAt: now,
        rowVersion: current.rowVersion + 1,
      };
      if (!this.eventDrafts.update(next, current.rowVersion)) {
        versionConflict(this.requireEventDraft(eventDraftId).rowVersion);
      }
      return next;
    });
  }

  deleteEventDraft(eventDraftId: string): void {
    this.transact(() => {
      const current = this.requireEventDraft(eventDraftId);
      const baseline = this.requireBaselineDraft(current.baselineDraftId);
      this.requireEditableSession(baseline.sessionId);
      this.eventDrafts.deleteEventDraft(eventDraftId);
    });
  }

  markPreviewGenerated(sessionId: string, expectedVersion: number): HistoricalImportSession {
    return this.transact(() => {
      const current = this.requireSession(sessionId);
      if (current.status !== 'draft') {
        throw ruleViolation('SESSION_ALREADY_FINALIZED', '只有 draft 状态的会话可以进入 preview_generated');
      }
      assertVersion(current.rowVersion, expectedVersion);
      const now = this.deps.now();
      const next: HistoricalImportSession = {
        ...current,
        status: 'preview_generated',
        updatedAt: now,
        rowVersion: current.rowVersion + 1,
      };
      if (!this.sessions.update(next, current.rowVersion)) {
        versionConflict(this.requireSession(sessionId).rowVersion);
      }
      return next;
    });
  }

  confirmSession(sessionId: string, value: unknown): HistoricalImportConfirmResult {
    const request = parseDto(ConfirmSessionRequestSchema, value);
    const requestHash = sha256RequestHash({ sessionId, expectedVersion: request.expectedVersion });
    return this.transact(() => {
      const replay = this.receipts.findByIdempotencyKey(request.idempotencyKey);
      if (replay !== null) {
        if (replay.sessionId !== sessionId || replay.requestHash !== requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同的确认请求');
        }
        return JSON.parse(replay.resultJson) as HistoricalImportConfirmResult;
      }
      const current = this.requireSession(sessionId);
      if (current.status !== 'preview_generated') {
        throw ruleViolation('SESSION_ALREADY_FINALIZED', '只有 preview_generated 状态的会话可以确认');
      }
      assertVersion(current.rowVersion, request.expectedVersion);

      const drafts = this.baselineDrafts.listDraftsBySession(sessionId);
      const outcomes: HistoricalImportConfirmOutcome[] = drafts.map((draft) => (
        this.materializeBaselineDraft(draft)
      ));

      const now = this.deps.now();
      const nextSession: HistoricalImportSession = {
        ...current,
        status: 'confirmed',
        confirmedAt: now,
        updatedAt: now,
        rowVersion: current.rowVersion + 1,
      };
      if (!this.sessions.update(nextSession, current.rowVersion)) {
        versionConflict(this.requireSession(sessionId).rowVersion);
      }
      const result: HistoricalImportConfirmResult = { session: nextSession, outcomes };
      this.receipts.insert({
        idempotencyKey: request.idempotencyKey,
        sessionId,
        requestHash,
        resultJson: JSON.stringify(result),
        createdAt: now,
      });
      return result;
    });
  }

  discardSession(sessionId: string, value: unknown): HistoricalImportSession {
    const request = parseDto(DiscardSessionRequestSchema, value) as DiscardSessionRequest;
    return this.transact(() => {
      const current = this.requireSession(sessionId);
      if (current.status === 'confirmed' || current.status === 'discarded') {
        throw ruleViolation('SESSION_ALREADY_FINALIZED', '会话已经终结，不能再次丢弃');
      }
      assertVersion(current.rowVersion, request.expectedVersion);
      const now = this.deps.now();
      const next: HistoricalImportSession = {
        ...current,
        status: 'discarded',
        discardedAt: now,
        updatedAt: now,
        rowVersion: current.rowVersion + 1,
      };
      if (!this.sessions.update(next, current.rowVersion)) {
        versionConflict(this.requireSession(sessionId).rowVersion);
      }
      return next;
    });
  }

  private materializeBaselineDraft(draft: HistoricalBaselineDraft): HistoricalImportConfirmOutcome {
    if (draft.duplicateOfDraftId !== null && !draft.keepAsIndependentProcess) {
      return {
        baselineDraftId: draft.id,
        kind: 'skipped_duplicate',
        jobId: null,
        applicationId: null,
      };
    }

    const now = this.deps.now();
    const job = this.jobs.create({
      company: draft.company,
      role: draft.role,
      city: draft.city ?? '',
    });

    if (!draft.actuallyApplied) {
      this.baselineDrafts.update(
        { ...draft, createdJobId: job.id, updatedAt: now, rowVersion: draft.rowVersion + 1 },
        draft.rowVersion,
      );
      return {
        baselineDraftId: draft.id,
        kind: 'kept_independent_no_application',
        jobId: job.id,
        applicationId: null,
      };
    }

    const application = this.createApplicationFromDraft(job.id, draft, now);
    this.materializeEventDrafts(draft.id, application.id, now);
    this.baselineDrafts.update(
      {
        ...draft,
        createdJobId: job.id,
        createdApplicationId: application.id,
        updatedAt: now,
        rowVersion: draft.rowVersion + 1,
      },
      draft.rowVersion,
    );
    return {
      baselineDraftId: draft.id,
      kind: 'created_application',
      jobId: job.id,
      applicationId: application.id,
    };
  }

  private createApplicationFromDraft(
    jobId: string,
    draft: HistoricalBaselineDraft,
    now: number,
  ): ApplicationRecord {
    const record = ApplicationRecordSchema.parse({
      id: this.deps.createId(),
      jobId,
      resumeVersionId: draft.resumeVersionId,
      origin: 'unknown',
      channel: draft.channel,
      channelOtherLabel: draft.channel === 'other' ? '历史补录' : null,
      recruitingEntity: {
        kind: draft.recruitingEntityKind,
        name: draft.recruitingEntityName,
        employerGroupKey: null,
        endClientName: null,
      },
      primaryContact: draft.contactName === null ? null : {
        displayName: draft.contactName,
        role: 'unknown',
        platformId: null,
      },
      cityContext: {
        jobCity: draft.city,
        marketCity: null,
        workMode: 'unknown',
      },
      draftMessageText: null,
      createdAt: draft.appliedAt ?? now,
      updatedAt: now,
      voidedAt: null,
      voidReason: null,
      supersededByApplicationId: null,
      rowVersion: 1,
    }) as ApplicationRecord;
    const idempotencyKey = `history-import:${draft.id}:application`;
    this.applications.insert({
      record,
      idempotencyKey,
      requestHash: sha256RequestHash({ historicalBaselineDraftId: draft.id }),
      migrationKey: `history-import:${draft.id}`,
    });

    const createdKey = `${idempotencyKey}:application-created`;
    this.events.insert(makeFeedbackEvent(this.deps, {
      applicationId: record.id,
      input: {
        eventType: 'application_created',
        eventAt: record.createdAt,
        timePrecision: draft.timePrecision,
        actor: 'system',
        sourceConfidence: draft.sourceConfidence,
        evidenceLevel: draft.evidenceLevel,
        channel: record.channel,
        note: null,
        reasonCode: null,
        payload: {},
      },
      idempotencyKey: createdKey,
      requestHash: sha256RequestHash({ command: 'application_created', historicalBaselineDraftId: draft.id }),
      createdAt: now,
    }));
    return record;
  }

  private materializeEventDrafts(baselineDraftId: string, applicationId: string, now: number): void {
    const eventDrafts = this.eventDrafts.listEventDraftsByBaseline(baselineDraftId);
    for (const eventDraft of eventDrafts) {
      const idempotencyKey = `history-import:${eventDraft.id}:event`;
      const stored = makeFeedbackEvent(this.deps, {
        applicationId,
        input: {
          eventType: eventDraft.eventType,
          eventAt: eventDraft.eventAt,
          timePrecision: eventDraft.timePrecision,
          actor: eventDraft.actor,
          sourceConfidence: eventDraft.sourceConfidence,
          evidenceLevel: eventDraft.evidenceLevel,
          channel: eventDraft.channel,
          note: eventDraft.note,
          reasonCode: eventDraft.reasonCode,
          payload: {},
        },
        idempotencyKey,
        requestHash: sha256RequestHash({ historicalEventDraftId: eventDraft.id }),
        createdAt: now,
      });
      this.events.insert(stored);
      this.eventDrafts.update(
        {
          ...eventDraft,
          createdFeedbackEventId: stored.record.id,
          updatedAt: now,
          rowVersion: eventDraft.rowVersion + 1,
        },
        eventDraft.rowVersion,
      );
    }
  }

  private buildBaselineDraftRecord(
    sessionId: string,
    request: CreateBaselineDraftRequest | UpdateBaselineDraftRequest,
    createdAt: number,
    existingId?: string,
  ): HistoricalBaselineDraft {
    const now = this.deps.now();
    return {
      id: existingId ?? this.deps.createId(),
      sessionId,
      company: request.company,
      role: request.role,
      city: request.city,
      actuallyApplied: request.actuallyApplied,
      appliedAt: request.appliedAt,
      timePrecision: request.timePrecision,
      channel: request.channel,
      recruitingEntityKind: request.recruitingEntityKind,
      recruitingEntityName: request.recruitingEntityName,
      contactName: request.contactName,
      resumeVersionId: request.resumeVersionId,
      highestKnownStage: request.highestKnownStage,
      sourceConfidence: request.sourceConfidence,
      evidenceLevel: request.evidenceLevel,
      notes: request.notes,
      duplicateOfDraftId: request.duplicateOfDraftId,
      keepAsIndependentProcess: request.keepAsIndependentProcess,
      independentProcessReason: request.independentProcessReason,
      createdJobId: null,
      createdApplicationId: null,
      createdAt,
      updatedAt: now,
      rowVersion: 1,
    };
  }

  private requireSession(id: string): HistoricalImportSession {
    const session = this.sessions.getSession(id);
    if (session === null) throw notFound('SESSION_NOT_FOUND', '历史补录会话不存在');
    return session;
  }

  private requireEditableSession(id: string): HistoricalImportSession {
    const session = this.requireSession(id);
    if (session.status !== 'draft') {
      throw conflict('SESSION_NOT_DRAFTABLE', '只有 draft 状态的会话可以编辑草稿');
    }
    return session;
  }

  private requireBaselineDraft(id: string): HistoricalBaselineDraft {
    const draft = this.baselineDrafts.getDraft(id);
    if (draft === null) throw notFound('BASELINE_DRAFT_NOT_FOUND', '历史补录基线草稿不存在');
    return draft;
  }

  private requireEventDraft(id: string): HistoricalEventDraft {
    const draft = this.eventDrafts.getEventDraft(id);
    if (draft === null) throw notFound('EVENT_DRAFT_NOT_FOUND', '历史补录事件草稿不存在');
    return draft;
  }

  private transact<Result>(run: () => Result): Result {
    return this.db.transaction(run)();
  }
}
