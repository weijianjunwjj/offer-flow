import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResumeVersionRecord } from '../domain/job-memory';
import {
  ResumeVersionApiError,
  resumeVersionsApi,
} from './resumeVersionsApi';

function version(overrides: Partial<ResumeVersionRecord> = {}): ResumeVersionRecord {
  return {
    id: 'resume-1',
    name: '主简历',
    source: 'profile_snapshot',
    contentHash: '0123456789abcdef',
    summary: 'Vue',
    contentSnapshot: { resumeText: 'Vue', projectExperience: 'OfferFlow' },
    createdAt: 10,
    archivedAt: null,
    rowVersion: 1,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ResumeVersion API Adapter', () => {
  it('覆盖 list/create/update/activate/archive 并校验请求 DTO', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ resumeVersions: [version()], activeResumeVersionId: null }))
      .mockResolvedValueOnce(jsonResponse(version()))
      .mockResolvedValueOnce(jsonResponse(version({ name: '更新', rowVersion: 2 })))
      .mockResolvedValueOnce(jsonResponse({ resumeVersion: version({ rowVersion: 2 }), activeResumeVersionId: 'resume-1' }))
      .mockResolvedValueOnce(jsonResponse({
        resumeVersion: version({ rowVersion: 3, archivedAt: 20 }),
        activeResumeVersionId: null,
      }));
    vi.stubGlobal('fetch', fetchSpy);

    const controller = new AbortController();
    await expect(resumeVersionsApi.list({ signal: controller.signal })).resolves.toMatchObject({
      resumeVersions: [{ id: 'resume-1' }],
    });
    await resumeVersionsApi.create({
      idempotencyKey: 'create-key',
      name: '主简历',
      source: 'profile_snapshot',
      summary: 'Vue',
      contentSnapshot: { resumeText: 'Vue', projectExperience: 'OfferFlow' },
    });
    await resumeVersionsApi.updateMetadata('resume/1', { expectedVersion: 1, name: '更新' });
    await resumeVersionsApi.activate('resume/1', { expectedVersion: 2 });
    await resumeVersionsApi.archive('resume/1', { expectedVersion: 2, clearActive: true });

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(fetchSpy.mock.calls[1]?.[1]).not.toHaveProperty('signal');
    expect(fetchSpy.mock.calls[2]?.[0]).toContain('/resume-versions/resume%2F1');
    expect(JSON.parse(String(fetchSpy.mock.calls[4]?.[1]?.body))).toEqual({
      expectedVersion: 2,
      clearActive: true,
    });
  });

  it('拒绝未通过共享 Schema 的成功响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      resumeVersions: [{ ...version(), rowVersion: 0 }],
      activeResumeVersionId: null,
    })));
    await expect(resumeVersionsApi.list()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    } satisfies Partial<ResumeVersionApiError>);
  });

  it.each([
    [409, 'VERSION_CONFLICT', { currentVersion: 4 }],
    [409, 'CONTENT_HASH_EXISTS', { existingId: 'resume-existing' }],
    [422, 'NO_EFFECTIVE_CHANGE', {}],
    [422, 'VALIDATION_ERROR', { fieldErrors: { name: ['必填'] } }],
    [422, 'ARCHIVED_RESUME_NOT_SELECTABLE', {}],
    [404, 'RESUME_VERSION_NOT_FOUND', {}],
  ])('按结构化 code 处理 HTTP %i %s，不解析 message', async (status, code, details) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      code,
      message: '这段自由文本包含 SQLite、冲突、重复等词也不参与决策',
      ...details,
    }, status)));
    await expect(resumeVersionsApi.list()).rejects.toMatchObject({ code, ...details });
  });

  it('把无 v2 路由的 404 识别为 capability 不可用', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      message: 'Route GET:/resume-versions not found',
      error: 'Not Found',
      statusCode: 404,
    }, 404)));
    await expect(resumeVersionsApi.list()).rejects.toMatchObject({
      code: 'FEATURE_UNAVAILABLE',
    });
  });

  it('500 不透传原始存储细节', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      code: 'INTERNAL_ERROR',
      message: 'SQLite content_json 原始错误',
    }, 500)));
    const error = await resumeVersionsApi.list().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', message: '简历版本存储暂时不可用' });
    expect(String(error)).not.toContain('SQLite');
  });

  it('保留 AbortError，并将其他 fetch 失败归为 NETWORK_ERROR', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(abortError).mockRejectedValueOnce(new TypeError('offline')));
    await expect(resumeVersionsApi.list()).rejects.toBe(abortError);
    await expect(resumeVersionsApi.list()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
