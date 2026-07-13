import { describe, expect, it } from 'vitest';
import {
  projectApplication,
  type ApplicationMemory,
} from '../../domain/job-memory';
import { makeApplication, makeEvent } from '../../domain/job-memory/testFixtures';
import {
  buildApplicationUpdateRequest,
  createApplicationEditDraft,
  createEmptyApplicationDraft,
  defaultApplicationId,
  newIdempotencyKey,
  reconcileSelectedApplicationId,
  sortApplicationMemories,
} from './applicationSectionModel';

function memory(
  id: string,
  createdAt: number,
  events = [makeEvent('application_created', { applicationId: id, createdAt })],
): ApplicationMemory {
  const record = makeApplication({ id, createdAt, updatedAt: createdAt });
  const normalizedEvents = events.map((event) => ({ ...event, applicationId: id }));
  return { record, events: normalizedEvents, projection: projectApplication(record, normalizedEvents) };
}

describe('ApplicationSection 页面模型', () => {
  it('覆盖 0/1/多流程默认选择、手动选择保留与作废后重选', () => {
    expect(defaultApplicationId([])).toBeNull();
    const older = memory('older', 10);
    const newer = memory('newer', 20);
    expect(defaultApplicationId([older])).toBe('older');
    expect(defaultApplicationId([older, newer])).toBe('newer');
    expect(reconcileSelectedApplicationId([older, newer], 'older')).toBe('older');

    const voidedRecord = makeApplication({
      ...older.record,
      id: 'older',
      voidedAt: 30,
      voidReason: '误录',
    });
    const voided = {
      ...older,
      record: voidedRecord,
      projection: projectApplication(voidedRecord, older.events),
    };
    expect(reconcileSelectedApplicationId([voided, newer], 'older')).toBe('newer');
    expect(sortApplicationMemories([older, newer], 'older').map(({ record }) => record.id))
      .toEqual(['older', 'newer']);
  });

  it('全部 invalid 时不伪造默认流程', () => {
    const candidate = memory('broken', 10);
    candidate.projection = {
      ...candidate.projection,
      projectionStatus: 'invalid',
      errors: [{ code: 'INVALID_PROJECTION_OUTPUT', message: 'broken' }],
    };
    expect(defaultApplicationId([candidate])).toBeNull();
    expect(reconcileSelectedApplicationId([candidate], null)).toBeNull();
  });

  it('active 简历只做可见预选，归档版本不可预选且允许 null', () => {
    const versions = [
      {
        id: 'active', name: '当前', source: 'pasted_text' as const, contentHash: 'hash-active',
        summary: '', contentSnapshot: { resumeText: '', projectExperience: '' },
        createdAt: 1, archivedAt: null, rowVersion: 1,
      },
      {
        id: 'archived', name: '归档', source: 'pasted_text' as const, contentHash: 'hash-archived',
        summary: '', contentSnapshot: { resumeText: '', projectExperience: '' },
        createdAt: 2, archivedAt: 3, rowVersion: 2,
      },
    ];
    expect(createEmptyApplicationDraft(versions, 'active', '苏州').resumeVersionId).toBe('active');
    expect(createEmptyApplicationDraft(versions, 'archived', '苏州').resumeVersionId).toBeNull();
  });

  it('每次创建命令生成新幂等键，重试草稿本身不会换键', () => {
    const first = newIdempotencyKey();
    const second = newIdempotencyKey();
    expect(first).not.toBe(second);
    const draft = createEmptyApplicationDraft([], null, '');
    expect(draft.idempotencyKey).toBe(draft.idempotencyKey);
  });

  it('元数据纠正只发送变化白名单字段，并禁止 no-op', () => {
    const record = makeApplication({ channel: 'boss' });
    const noOp = createApplicationEditDraft(record);
    noOp.reason = '检查';
    expect(buildApplicationUpdateRequest(record, noOp)).toBeNull();

    const changed = createApplicationEditDraft(record);
    changed.channel = 'referral';
    changed.reason = '实际为内推';
    expect(buildApplicationUpdateRequest(record, changed)).toEqual({
      expectedVersion: 1,
      reason: '实际为内推',
      channel: 'referral',
    });
    expect(buildApplicationUpdateRequest(record, changed)).not.toHaveProperty('origin');
    expect(buildApplicationUpdateRequest(record, changed)).not.toHaveProperty('projection');
  });
});
