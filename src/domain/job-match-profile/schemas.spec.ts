import { describe, expect, it } from 'vitest';
import {
  JOB_MATCH_CITY_CODES,
  JobMatchProfileDraftSchema,
  JobMatchProfileStateSchema,
  createEmptyJobMatchProfileDraft,
  createEmptyJobMatchProfileState,
} from './index';
import { makeJobMatchProfileDraftFixture } from './testFixtures';

describe('岗位匹配画像 · 严格 Draft Schema', () => {
  it('接受结构完整的画像草案（fixture）', () => {
    expect(() => JobMatchProfileDraftSchema.parse(makeJobMatchProfileDraftFixture())).not.toThrow();
  });

  it('空草案默认置信为样本不足，四城市齐备', () => {
    const draft = createEmptyJobMatchProfileDraft();
    expect(draft.confidence).toBe('insufficient');
    expect(draft.cityProfiles.map((c) => c.city).sort()).toEqual([...JOB_MATCH_CITY_CODES].sort());
    expect(draft.cityProfiles.every((c) => c.confidence === 'insufficient')).toBe(true);
  });

  it('必须且只能包含苏州、无锡、上海、杭州四个城市', () => {
    const missing = makeJobMatchProfileDraftFixture();
    missing.cityProfiles = missing.cityProfiles.filter((c) => c.city !== 'hangzhou');
    expect(() => JobMatchProfileDraftSchema.parse(missing)).toThrow();

    const duplicated = makeJobMatchProfileDraftFixture();
    duplicated.cityProfiles.push({ ...duplicated.cityProfiles[0]! });
    expect(() => JobMatchProfileDraftSchema.parse(duplicated)).toThrow();
  });

  it('薪资区间最低不得高于最高', () => {
    const draft = makeJobMatchProfileDraftFixture();
    draft.primaryRoles.salaryRange = { minK: 40, maxK: 20, note: '非法区间' };
    expect(() => JobMatchProfileDraftSchema.parse(draft)).toThrow();
  });

  it('拒绝未知字段（strictObject）', () => {
    const draft = { ...makeJobMatchProfileDraftFixture(), unexpectedField: true };
    expect(() => JobMatchProfileDraftSchema.parse(draft)).toThrow();
  });

  it('跨城借用证据必须带来源、原因、降权说明与不适用范围', () => {
    const draft = JobMatchProfileDraftSchema.parse(makeJobMatchProfileDraftFixture());
    const wuxi = draft.cityProfiles.find((c) => c.city === 'wuxi');
    expect(wuxi?.borrowedEvidence[0]).toMatchObject({
      sourceCity: 'suzhou',
    });
    expect(wuxi?.borrowedEvidence[0]?.reason.length).toBeGreaterThan(0);
    expect(wuxi?.borrowedEvidence[0]?.discountNote.length).toBeGreaterThan(0);
    expect(wuxi?.borrowedEvidence[0]?.notApplicableTo).toContain('薪资');

    const broken = makeJobMatchProfileDraftFixture();
    const target = broken.cityProfiles.find((c) => c.city === 'wuxi')!;
    // 删除必填的降权说明应导致校验失败
    delete (target.borrowedEvidence[0] as { discountNote?: string }).discountNote;
    expect(() => JobMatchProfileDraftSchema.parse(broken)).toThrow();
  });
});

describe('岗位匹配画像 · State 不变量', () => {
  it('空状态可解析且无激活版本', () => {
    const state = JobMatchProfileStateSchema.parse(createEmptyJobMatchProfileState());
    expect(state.stateVersion).toBe(0);
    expect(state.activeVersionId).toBeNull();
    expect(state.versions).toHaveLength(0);
  });

  it('activeVersionId 指向不存在的版本时校验失败', () => {
    expect(() => JobMatchProfileStateSchema.parse({
      stateVersion: 1,
      activeVersionId: 'missing-version',
      versions: [],
      proposals: [],
      commandReceipts: [],
    })).toThrow();
  });
});
