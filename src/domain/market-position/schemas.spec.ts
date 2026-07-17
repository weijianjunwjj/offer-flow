import { describe, expect, it } from 'vitest';
import {
  MARKET_POSITION_CITY_CODES,
  MarketPositionDraftSchema,
  MarketPositionStateSchema,
  createEmptyMarketPositionDraft,
  createEmptyMarketPositionState,
} from './index';
import { makeMarketPositionDraftFixture } from './testFixtures';

describe('市场位置画像 · 严格 Draft Schema', () => {
  it('接受结构完整的画像草案（fixture）', () => {
    expect(() => MarketPositionDraftSchema.parse(makeMarketPositionDraftFixture())).not.toThrow();
  });

  it('空草案默认全部为 insufficient，四城市齐备', () => {
    const draft = createEmptyMarketPositionDraft();
    expect(draft.global.evidenceSufficiency.evidenceLevel).toBe('insufficient');
    expect(draft.cityProfiles.map((c) => c.scope.city).sort()).toEqual([...MARKET_POSITION_CITY_CODES].sort());
    expect(draft.cityProfiles.every((c) => c.evidenceSufficiency.evidenceLevel === 'insufficient')).toBe(true);
  });

  it('必须且只能包含苏州、无锡、上海、杭州四个城市画像', () => {
    const missing = makeMarketPositionDraftFixture();
    missing.cityProfiles = missing.cityProfiles.filter((c) => c.scope.city !== 'hangzhou');
    expect(() => MarketPositionDraftSchema.parse(missing)).toThrow();

    const duplicated = makeMarketPositionDraftFixture();
    duplicated.cityProfiles.push({ ...duplicated.cityProfiles[0]! });
    expect(() => MarketPositionDraftSchema.parse(duplicated)).toThrow();
  });

  it('每个范围必须且只能包含七个决策门各一次', () => {
    const draft = makeMarketPositionDraftFixture();
    draft.global.decisionGates = draft.global.decisionGates.filter((g) => g.gateType !== 'relocation_decision');
    expect(() => MarketPositionDraftSchema.parse(draft)).toThrow();
  });

  it('scope 与 scopeType 不一致时校验失败', () => {
    const draft = makeMarketPositionDraftFixture();
    draft.global.scope = { scopeType: 'global', city: 'suzhou', jobFamily: null };
    expect(() => MarketPositionDraftSchema.parse(draft)).toThrow();
  });

  it('拒绝未知字段（strictObject）', () => {
    const draft = { ...makeMarketPositionDraftFixture(), unexpectedField: true };
    expect(() => MarketPositionDraftSchema.parse(draft)).toThrow();
  });
});

describe('市场位置画像 · State 不变量', () => {
  it('空状态可解析且无激活版本', () => {
    const state = MarketPositionStateSchema.parse(createEmptyMarketPositionState());
    expect(state.stateVersion).toBe(0);
    expect(state.activeVersionId).toBeNull();
    expect(state.versions).toHaveLength(0);
  });

  it('activeVersionId 指向不存在的版本时校验失败', () => {
    expect(() => MarketPositionStateSchema.parse({
      stateVersion: 1,
      activeVersionId: 'missing-version',
      versions: [],
      proposals: [],
      commandReceipts: [],
    })).toThrow();
  });
});
