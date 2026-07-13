import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { JobRepository } from '../repositories/jobRepository';
import { initSchema } from '../schema';
import type { UserFeedbackEventInput } from './dtoSchemas';
import { JobMemoryError, StorageCorruptionError } from './errors';
import { JobMemoryService } from './jobMemoryService';
import { ResumeVersionRepository } from './resumeVersionRepository';

interface Harness {
  db: SqliteDatabase;
  service: JobMemoryService;
}

function withHarness(run: (harness: Harness) => void, ids?: readonly string[]): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-job-memory-service-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 2 });
  new JobRepository(db).create({
    id: 'job-1',
    company: '示例公司',
    role: '前端工程师',
    city: '苏州',
    salaryRange: '20-30K',
    jdText: 'Vue TypeScript',
  });
  let idIndex = 0;
  let now = 1_000;
  const service = new JobMemoryService(db, {
    now: () => ++now,
    createId: () => ids?.[idIndex++] ?? `generated-${++idIndex}`,
  });
  try {
    run({ db, service });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function resumeRequest(key = 'resume-key', name = '主简历') {
  return {
    idempotencyKey: key,
    name,
    source: 'pasted_text' as const,
    summary: '前端方向',
    contentSnapshot: {
      resumeText: 'Vue\r\nTypeScript',
      projectExperience: 'OfferFlow',
    },
  };
}

function eventInput(
  eventType: UserFeedbackEventInput['eventType'],
  payload: Record<string, unknown> = {},
): UserFeedbackEventInput {
  return {
    eventType,
    eventAt: 2_000,
    timePrecision: 'exact',
    actor: 'user',
    sourceConfidence: 'exact',
    evidenceLevel: 'strong',
    channel: 'boss',
    note: null,
    reasonCode: null,
    payload,
  } as UserFeedbackEventInput;
}

function applicationRequest(
  key = 'application-key',
  resumeVersionId: string | null = null,
  initialEvent: UserFeedbackEventInput | null = null,
) {
  return {
    idempotencyKey: key,
    resumeVersionId,
    origin: 'outbound' as const,
    channel: 'boss' as const,
    channelOtherLabel: null,
    recruitingEntity: {
      kind: 'direct_employer' as const,
      name: '示例公司',
      employerGroupKey: null,
      endClientName: null,
    },
    primaryContact: null,
    cityContext: { jobCity: '苏州', marketCity: '苏州', workMode: 'onsite' as const },
    draftMessageText: null,
    initialEvent,
  };
}

function appendEventRequest(
  idempotencyKey: string,
  expectedApplicationVersion: number,
  event: UserFeedbackEventInput,
) {
  return { idempotencyKey, expectedApplicationVersion, ...event };
}

function captureJobMemoryError(run: () => unknown): JobMemoryError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(JobMemoryError);
    return error as JobMemoryError;
  }
  throw new Error('预期 JobMemoryError，但调用成功');
}

describe('JobMemoryService ResumeVersion', () => {
  it('创建、规范化、replay、幂等冲突和 content hash 去重', () => {
    withHarness(({ service }) => {
      const created = service.createResumeVersion(resumeRequest());
      expect(created.rowVersion).toBe(1);
      expect(created.contentSnapshot.resumeText).toBe('Vue\nTypeScript');
      expect(service.createResumeVersion(resumeRequest())).toEqual(created);
      expect(service.listResumeVersions()).toEqual({
        resumeVersions: [created],
        activeResumeVersionId: null,
      });

      const reused = captureJobMemoryError(() => (
        service.createResumeVersion(resumeRequest('resume-key', '另一个名字'))
      ));
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const duplicate = captureJobMemoryError(() => (
        service.createResumeVersion(resumeRequest('another-key'))
      ));
      expect(duplicate.body).toMatchObject({ code: 'CONTENT_HASH_EXISTS', existingId: created.id });
    });
  });

  it('用 expectedVersion 修改元数据并保护 active 归档', () => {
    withHarness(({ service }) => {
      const first = service.createResumeVersion(resumeRequest('resume-1', '版本一'));
      const second = service.createResumeVersion({
        ...resumeRequest('resume-2', '版本二'),
        contentSnapshot: { resumeText: '第二版', projectExperience: '项目二' },
      });
      const updated = service.updateResumeVersionMetadata(first.id, {
        expectedVersion: 1,
        name: '版本一（更新）',
      });
      expect(updated.rowVersion).toBe(2);
      expect(updated.contentHash).toBe(first.contentHash);
      expect(captureJobMemoryError(() => service.updateResumeVersionMetadata(first.id, {
        expectedVersion: 1,
        summary: '过期写入',
      })).body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });

      expect(service.activateResumeVersion(first.id, { expectedVersion: 2 }).activeResumeVersionId)
        .toBe(first.id);
      expect(captureJobMemoryError(() => service.archiveResumeVersion(first.id, {
        expectedVersion: 2,
      })).body.code).toBe('ACTIVE_RESUME_CONFLICT');

      const archived = service.archiveResumeVersion(first.id, {
        expectedVersion: 2,
        replacementResumeVersionId: second.id,
      });
      expect(archived.resumeVersion.rowVersion).toBe(3);
      expect(archived.resumeVersion.archivedAt).not.toBeNull();
      expect(archived.activeResumeVersionId).toBe(second.id);
      expect(captureJobMemoryError(() => service.activateResumeVersion(first.id, {
        expectedVersion: 3,
      })).body.code).toBe('BUSINESS_RULE_VIOLATION');
    });
  });

  it('把损坏 JSON 映射为明确存储损坏错误', () => {
    withHarness(({ db, service }) => {
      service.createResumeVersion(resumeRequest());
      db.prepare("UPDATE resume_versions SET content_json = '{broken'").run();
      expect(() => new ResumeVersionRepository(db).listResumeVersions())
        .toThrow(StorageCorruptionError);
    });
  });
});

describe('JobMemoryService Application transaction', () => {
  it('创建 Application、application_created 与 initialEvent，且 rowVersion 保持 1', () => {
    withHarness(({ service }) => {
      const bundle = service.createApplication(
        'job-1',
        applicationRequest('application-1', null, eventInput('applied')),
      );
      expect(bundle.applications).toHaveLength(1);
      expect(bundle.applications[0]?.record.rowVersion).toBe(1);
      expect(bundle.applications[0]?.events.map((event) => event.eventType))
        .toEqual(['application_created', 'applied']);
      expect(bundle.applications[0]?.projection.submissionState).toBe('applied');
      expect(service.createApplication(
        'job-1',
        applicationRequest('application-1', null, eventInput('applied')),
      ).applications).toHaveLength(1);

      const duplicateFlow = service.createApplication('job-1', applicationRequest('application-2'));
      expect(duplicateFlow.applications).toHaveLength(2);
    });
  });

  it('拒绝不存在 Job/ResumeVersion 和归档 ResumeVersion', () => {
    withHarness(({ service }) => {
      expect(captureJobMemoryError(() => (
        service.createApplication('missing-job', applicationRequest())
      )).body.code).toBe('JOB_NOT_FOUND');
      expect(captureJobMemoryError(() => (
        service.createApplication('job-1', applicationRequest('missing-resume-app', 'missing-resume'))
      )).body.code).toBe('RESUME_VERSION_NOT_FOUND');

      const resume = service.createResumeVersion(resumeRequest());
      service.archiveResumeVersion(resume.id, { expectedVersion: 1 });
      expect(captureJobMemoryError(() => (
        service.createApplication('job-1', applicationRequest('archived-app', resume.id))
      )).body.code).toBe('ARCHIVED_RESUME_NOT_SELECTABLE');
    });
  });

  it('initialEvent 写入失败时回滚 Application 和自动审计事件', () => {
    withHarness(({ db, service }) => {
      expect(() => service.createApplication(
        'job-1',
        applicationRequest('rollback-app', null, eventInput('applied')),
      )).toThrow();
      expect((db.prepare('SELECT COUNT(*) AS count FROM applications').get() as { count: number }).count)
        .toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS count FROM feedback_events').get() as { count: number }).count)
        .toBe(0);
    }, ['application-id', 'duplicate-event-id', 'duplicate-event-id']);
  });

  it('元数据纠正更新行、递增版本并追加 before/after 审计', () => {
    withHarness(({ service }) => {
      const created = service.createApplication('job-1', applicationRequest());
      const application = created.applications[0]?.record;
      expect(application).toBeDefined();
      if (application === undefined) return;

      const updated = service.updateApplicationMetadata(application.id, {
        expectedVersion: 1,
        reason: '修正渠道',
        channel: 'email',
        channelOtherLabel: null,
      });
      const memory = updated.applications[0];
      expect(memory?.record).toMatchObject({ channel: 'email', rowVersion: 2 });
      const audit = memory?.events.find((event) => event.eventType === 'application_metadata_corrected');
      expect(audit?.payload).toMatchObject({
        correctedFields: ['channel'],
        before: { channel: 'boss' },
        after: { channel: 'email' },
      });
      expect(captureJobMemoryError(() => service.updateApplicationMetadata(application.id, {
        expectedVersion: 2,
        reason: '没有变化',
        channel: 'email',
      })).body.code).toBe('NO_EFFECTIVE_CHANGE');
      expect(captureJobMemoryError(() => service.updateApplicationMetadata(application.id, {
        expectedVersion: 1,
        reason: '过期写入',
        channel: 'boss',
      })).body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    });
  });

  it('元数据审计写入失败时回滚 Application 行和 rowVersion', () => {
    withHarness(({ service }) => {
      const created = service.createApplication('job-1', applicationRequest());
      const application = created.applications[0]?.record;
      expect(application).toBeDefined();
      if (application === undefined) return;
      service.appendFeedbackEvent(application.id, appendEventRequest(
        `application:${application.id}:metadata:3`,
        1,
        eventInput('greeting_sent'),
      ));
      expect(captureJobMemoryError(() => service.updateApplicationMetadata(application.id, {
        expectedVersion: 2,
        reason: '触发审计键冲突',
        channel: 'email',
        channelOtherLabel: null,
      })).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(service.getApplication(application.id).record)
        .toMatchObject({ channel: 'boss', rowVersion: 2 });
    });
  });

  it('Application 作废与审计同事务，并校验 superseded target', () => {
    withHarness(({ service }) => {
      const firstBundle = service.createApplication('job-1', applicationRequest('first-app'));
      const first = firstBundle.applications.find((item) => item.record.id !== undefined)?.record;
      const secondBundle = service.createApplication('job-1', applicationRequest('second-app'));
      const second = secondBundle.applications.find((item) => item.record.id !== first?.id)?.record;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (first === undefined || second === undefined) return;

      const result = service.voidApplication(first.id, {
        expectedVersion: 1,
        reason: '重复录入',
        supersededByApplicationId: second.id,
      });
      const voided = result.applications.find((item) => item.record.id === first.id);
      expect(voided?.record).toMatchObject({
        voidReason: '重复录入',
        supersededByApplicationId: second.id,
        rowVersion: 2,
      });
      expect(voided?.events.some((event) => event.eventType === 'application_voided')).toBe(true);
      expect(captureJobMemoryError(() => service.voidApplication(first.id, {
        expectedVersion: 2,
        reason: '再次作废',
      })).body.code).toBe('APPLICATION_ALREADY_VOIDED');
    });
  });

  it('Application 作废审计失败时回滚生命周期字段', () => {
    withHarness(({ service }) => {
      const created = service.createApplication('job-1', applicationRequest());
      const application = created.applications[0]?.record;
      expect(application).toBeDefined();
      if (application === undefined) return;
      service.appendFeedbackEvent(application.id, appendEventRequest(
        `application:${application.id}:void:3`,
        1,
        eventInput('greeting_sent'),
      ));
      expect(captureJobMemoryError(() => service.voidApplication(application.id, {
        expectedVersion: 2,
        reason: '触发审计键冲突',
      })).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(service.getApplication(application.id).record)
        .toMatchObject({ voidedAt: null, voidReason: null, rowVersion: 2 });
    });
  });
});

describe('JobMemoryService FeedbackEvent', () => {
  it('追加事件只递增一次 rowVersion，并支持 replay 与幂等冲突', () => {
    withHarness(({ service }) => {
      const created = service.createApplication('job-1', applicationRequest());
      const application = created.applications[0]?.record;
      expect(application).toBeDefined();
      if (application === undefined) return;
      const request = appendEventRequest('event-key', 1, eventInput('greeting_sent'));
      const appended = service.appendFeedbackEvent(application.id, request);
      expect(appended.applications[0]?.record.rowVersion).toBe(2);
      expect(appended.applications[0]?.projection.communicationStatus).toBe('greeted_unread');
      expect(service.appendFeedbackEvent(application.id, request).applications[0]?.events).toHaveLength(2);
      expect(captureJobMemoryError(() => service.appendFeedbackEvent(application.id, {
        ...request,
        ...eventInput('hr_replied'),
      })).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(captureJobMemoryError(() => service.appendFeedbackEvent(
        application.id,
        appendEventRequest('stale-event', 1, eventInput('hr_replied')),
      )).body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    });
  });

  it('拒绝用户直接创建 audit-only 事件', () => {
    withHarness(({ service }) => {
      const created = service.createApplication('job-1', applicationRequest());
      const application = created.applications[0]?.record;
      expect(application).toBeDefined();
      if (application === undefined) return;
      const error = captureJobMemoryError(() => service.appendFeedbackEvent(application.id, {
        ...appendEventRequest('audit-key', 1, eventInput('applied')),
        eventType: 'event_voided',
      }));
      expect(error.body.code).toBe('AUDIT_EVENT_NOT_USER_CREATABLE');
    });
  });

  it('event void 与 replacement 同事务且 Application 版本只增加一次', () => {
    withHarness(({ service }) => {
      const created = service.createApplication('job-1', applicationRequest());
      const application = created.applications[0]?.record;
      expect(application).toBeDefined();
      if (application === undefined) return;
      const appended = service.appendFeedbackEvent(
        application.id,
        appendEventRequest('greeting-key', 1, eventInput('greeting_sent')),
      );
      const target = appended.applications[0]?.events.find((event) => event.eventType === 'greeting_sent');
      expect(target).toBeDefined();
      if (target === undefined) return;

      const voidRequest = {
        idempotencyKey: 'void-key',
        expectedApplicationVersion: 2,
        reason: '事件类型录错',
        replacementEvent: eventInput('hr_replied'),
      };
      const corrected = service.voidFeedbackEvent(target.id, voidRequest);
      expect(corrected.applications[0]?.record.rowVersion).toBe(3);
      expect(corrected.applications[0]?.events).toHaveLength(4);
      expect(corrected.applications[0]?.projection.communicationStatus).toBe('replied');
      expect(service.voidFeedbackEvent(target.id, voidRequest).applications[0]?.events).toHaveLength(4);
      expect(captureJobMemoryError(() => service.voidFeedbackEvent(target.id, {
        ...voidRequest,
        reason: '不同请求',
      })).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(captureJobMemoryError(() => service.voidFeedbackEvent(target.id, {
        idempotencyKey: 'second-void-key',
        expectedApplicationVersion: 3,
        reason: '再次作废',
      })).body.code).toBe('EVENT_ALREADY_VOIDED');
    });
  });

  it('replacement 写入失败时回滚 event_voided 和 Application 版本', () => {
    withHarness(({ service }) => {
      const created = service.createApplication('job-1', applicationRequest());
      const application = created.applications[0]?.record;
      expect(application).toBeDefined();
      if (application === undefined) return;
      const targetBundle = service.appendFeedbackEvent(
        application.id,
        appendEventRequest('rollback-target', 1, eventInput('greeting_sent')),
      );
      const target = targetBundle.applications[0]?.events.find(
        (event) => event.eventType === 'greeting_sent',
      );
      expect(target).toBeDefined();
      if (target === undefined) return;
      service.appendFeedbackEvent(
        application.id,
        appendEventRequest('rollback-void:replacement', 2, eventInput('message_viewed')),
      );
      expect(captureJobMemoryError(() => service.voidFeedbackEvent(target.id, {
        idempotencyKey: 'rollback-void',
        expectedApplicationVersion: 3,
        reason: '触发 replacement key 冲突',
        replacementEvent: eventInput('hr_replied'),
      })).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const after = service.getApplication(application.id);
      expect(after.record.rowVersion).toBe(3);
      expect(after.events.some((event) => event.eventType === 'event_voided')).toBe(false);
      expect(after.projection.communicationStatus).toBe('greeted_read_no_reply');
    });
  });

  it('Application 作废后不能追加事件', () => {
    withHarness(({ service }) => {
      const created = service.createApplication('job-1', applicationRequest());
      const application = created.applications[0]?.record;
      expect(application).toBeDefined();
      if (application === undefined) return;
      service.voidApplication(application.id, { expectedVersion: 1, reason: '误录' });
      expect(captureJobMemoryError(() => service.appendFeedbackEvent(
        application.id,
        appendEventRequest('after-void', 2, eventInput('hr_replied')),
      )).body.code).toBe('APPLICATION_ALREADY_VOIDED');
    });
  });

  it('Bundle 与 summaries 使用事件投影且不修改 legacy Job 字段', () => {
    withHarness(({ db, service }) => {
      const legacyBefore = db.prepare('SELECT data_json FROM jobs WHERE id = ?').get('job-1');
      const created = service.createApplication('job-1', applicationRequest());
      const application = created.applications[0]?.record;
      expect(application).toBeDefined();
      if (application === undefined) return;
      service.appendFeedbackEvent(
        application.id,
        appendEventRequest('summary-event', 1, eventInput('interview_scheduled')),
      );
      const summaries = service.getJobSummaries();
      expect(summaries[0]).toMatchObject({
        applicationCount: 1,
        defaultApplication: { projection: { stage: 'interviewing' } },
      });
      const detail = service.getJobDetailBundle('job-1');
      expect(detail.memory.applications[0]?.projection.stage).toBe('interviewing');
      expect(detail.applicationSummariesByJob['job-1']?.[0]?.projection.stage).toBe('interviewing');
      expect(db.prepare('SELECT data_json FROM jobs WHERE id = ?').get('job-1')).toEqual(legacyBefore);
      const projectionTables = db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND lower(name) LIKE '%projection%'
      `).all();
      expect(projectionTables).toEqual([]);
    });
  });
});
