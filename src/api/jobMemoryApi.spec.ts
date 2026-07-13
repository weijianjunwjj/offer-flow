import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCompanyInput, type JobRecord } from '../storage';
import { ApplicationApiError, jobMemoryApi } from './jobMemoryApi';

function job(): JobRecord {
  return {
    id: 'job-1', createdAt: 1, updatedAt: 1, company: '公司', role: '前端', city: '苏州',
    salaryRange: '', jdText: '', promptText: '', aiRawResult: '', aiPastedAt: null,
    parseStatus: 'none', report: null, matchScore: '', companyInput: emptyCompanyInput(),
    companyAssessment: null, opportunityAnalysis: null, communicationStatus: 'not_contacted',
    followupCount: 0,
  };
}

const emptyMemory = { applications: [], resumeVersions: [], activeResumeVersionId: null };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Application API Adapter', () => {
  it('覆盖 Bundle/summaries/Application/Event 写入，读取传 signal，写入不绑定 read signal', async () => {
    const currentJob = job();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        jobId: currentJob.id,
        job: currentJob,
        profile: null,
        allJobs: [currentJob],
        applicationSummariesByJob: { [currentJob.id]: [] },
        memory: emptyMemory,
      }))
      .mockResolvedValueOnce(jsonResponse([{
        job: currentJob,
        applicationCount: 0,
        activeApplicationCount: 0,
        defaultApplication: null,
        defaultResumeVersionName: null,
        projectionDiagnostics: [],
      }]))
      .mockResolvedValueOnce(jsonResponse(emptyMemory))
      .mockResolvedValueOnce(jsonResponse(emptyMemory))
      .mockResolvedValueOnce(jsonResponse(emptyMemory))
      .mockResolvedValueOnce(jsonResponse(emptyMemory))
      .mockResolvedValueOnce(jsonResponse(emptyMemory));
    vi.stubGlobal('fetch', fetchSpy);
    const controller = new AbortController();

    await jobMemoryApi.getJobDetailBundle('job/1', { signal: controller.signal });
    await jobMemoryApi.getJobSummaries({ signal: controller.signal });
    await jobMemoryApi.createApplication('job/1', {
      idempotencyKey: 'create-key', resumeVersionId: null, origin: 'outbound', channel: 'boss',
      channelOtherLabel: null,
      recruitingEntity: { kind: 'unknown', name: null, employerGroupKey: null, endClientName: null },
      primaryContact: null,
      cityContext: { jobCity: '苏州', marketCity: null, workMode: 'unknown' },
      draftMessageText: null,
      initialEvent: null,
    });
    await jobMemoryApi.updateApplication('app/1', {
      expectedVersion: 1, reason: '纠正', channel: 'referral',
    });
    await jobMemoryApi.voidApplication('app/1', {
      expectedVersion: 2, reason: '误录', supersededByApplicationId: null,
    });
    await jobMemoryApi.appendFeedbackEvent('app/1', {
      idempotencyKey: 'event-key', expectedApplicationVersion: 3,
      eventType: 'greeting_sent', eventAt: null, timePrecision: 'unknown', actor: 'user',
      sourceConfidence: 'exact', evidenceLevel: 'medium', channel: 'boss', note: null,
      reasonCode: null, payload: {},
    });
    await jobMemoryApi.voidFeedbackEvent('event/1', {
      idempotencyKey: 'void-key', expectedApplicationVersion: 4, reason: '误录', replacementEvent: null,
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toContain('/jobs/job%2F1/bundle');
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(fetchSpy.mock.calls[1]?.[1]?.signal).toBe(controller.signal);
    expect(fetchSpy.mock.calls[2]?.[1]).not.toHaveProperty('signal');
    expect(fetchSpy.mock.calls[3]?.[0]).toContain('/applications/app%2F1');
    expect(fetchSpy.mock.calls[4]?.[0]).toContain('/applications/app%2F1/void');
    expect(fetchSpy.mock.calls[5]?.[0]).toContain('/applications/app%2F1/events');
    expect(fetchSpy.mock.calls[6]?.[0]).toContain('/feedback-events/event%2F1/void');
    expect(fetchSpy.mock.calls[5]?.[1]).not.toHaveProperty('signal');
    expect(fetchSpy.mock.calls[6]?.[1]).not.toHaveProperty('signal');
  });

  it('严格拒绝缺少摘要字段或 Bundle jobId 不一致的成功响应', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ job: job(), applicationCount: 0 }]))
      .mockResolvedValueOnce(jsonResponse({
        jobId: 'other', job: job(), profile: null, allJobs: [job()],
        applicationSummariesByJob: { 'job-1': [] }, memory: emptyMemory,
      })));
    await expect(jobMemoryApi.getJobSummaries()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(jobMemoryApi.getJobDetailBundle('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    [404, 'JOB_NOT_FOUND', {}],
    [404, 'APPLICATION_NOT_FOUND', {}],
    [404, 'FEEDBACK_EVENT_NOT_FOUND', {}],
    [404, 'RESUME_VERSION_NOT_FOUND', {}],
    [409, 'VERSION_CONFLICT', { currentVersion: 4 }],
    [409, 'IDEMPOTENCY_KEY_REUSED', { existingId: 'existing' }],
    [409, 'APPLICATION_ALREADY_VOIDED', {}],
    [409, 'EVENT_ALREADY_VOIDED', {}],
    [422, 'ARCHIVED_RESUME_NOT_SELECTABLE', {}],
    [422, 'NO_EFFECTIVE_CHANGE', {}],
    [422, 'VALIDATION_ERROR', { fieldErrors: { channel: ['invalid'] } }],
    [422, 'BUSINESS_RULE_VIOLATION', {}],
    [422, 'AUDIT_EVENT_NOT_USER_CREATABLE', {}],
    [422, 'INVALID_REPLACEMENT_EVENT', {}],
  ])('只按结构化 HTTP %i / %s 分支', async (status, code, details) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      code, message: '自由文本不参与分支', ...details,
    }, status)));
    await expect(jobMemoryApi.getJobSummaries()).rejects.toMatchObject({ code, ...details });
  });

  it('隐藏 500 细节，保留 AbortError，其余网络失败归一化', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INTERNAL_ERROR', message: 'SQLite secret' }, 500))
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
      .mockRejectedValueOnce(new TypeError('offline')));
    const internal = await jobMemoryApi.getJobSummaries().catch((error: unknown) => error);
    expect(internal).toMatchObject({ code: 'INTERNAL_ERROR', message: '求职流程存储暂时不可用' });
    expect(String(internal)).not.toContain('SQLite');
    await expect(jobMemoryApi.getJobSummaries()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(jobMemoryApi.getJobSummaries()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    } satisfies Partial<ApplicationApiError>);
  });

  it('Event 响应必须通过共享 Bundle Schema，网络未知重试保持调用方原幂等键', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ applications: [] }))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse(emptyMemory));
    vi.stubGlobal('fetch', fetchSpy);
    const request = {
      idempotencyKey: 'stable-retry-key', expectedApplicationVersion: 1,
      eventType: 'applied' as const, eventAt: null, timePrecision: 'unknown' as const,
      actor: 'user' as const, sourceConfidence: 'recalled' as const, evidenceLevel: 'weak' as const,
      channel: 'boss' as const, note: null, reasonCode: null, payload: {},
    };
    await expect(jobMemoryApi.appendFeedbackEvent('app-1', request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    await expect(jobMemoryApi.appendFeedbackEvent('app-1', request)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    await jobMemoryApi.appendFeedbackEvent('app-1', request);
    const bodies = fetchSpy.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { idempotencyKey: string });
    expect(bodies.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      'stable-retry-key', 'stable-retry-key', 'stable-retry-key',
    ]);
  });

  it('void 网络结果未知时由同一草稿请求复用原幂等键', async () => {
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse(emptyMemory));
    vi.stubGlobal('fetch', fetchSpy);
    const request = {
      idempotencyKey: 'stable-void-key', expectedApplicationVersion: 2,
      reason: '误录', replacementEvent: null,
    };
    await expect(jobMemoryApi.voidFeedbackEvent('event-1', request)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    await jobMemoryApi.voidFeedbackEvent('event-1', request);
    expect(fetchSpy.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).idempotencyKey))
      .toEqual(['stable-void-key', 'stable-void-key']);
  });
});
