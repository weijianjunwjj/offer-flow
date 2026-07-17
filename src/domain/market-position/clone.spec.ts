import { describe, expect, it } from 'vitest';
import { cloneMarketPositionDraft, marketPositionDraftFromVersion } from './clone';
import { makeMarketPositionDraftFixture } from './testFixtures';
import type { MarketPositionVersion } from './types';

describe('marketPositionDraftFromVersion', () => {
  function makeVersion(): MarketPositionVersion {
    return {
      ...makeMarketPositionDraftFixture(),
      id: 'mpv-1',
      version: 1,
      status: 'active',
      inputSnapshot: {
        jobMatchProfileVersionId: 'jmp-1',
        capabilityBaselineVersionId: 'cb-1',
        acceptedEvidenceIds: [],
        funnelCutoffAt: 1,
        funnelQueryFingerprint: 'a'.repeat(64),
        inputHash: 'b'.repeat(64),
        capturedAt: 1,
      },
      createdAt: 1,
      activatedAt: 1,
      supersedesVersionId: null,
      proposalId: 'mpp-1',
    };
  }

  it('剥离版本专属字段，仅保留草稿字段', () => {
    const draft = marketPositionDraftFromVersion(makeVersion());
    expect(Object.keys(draft).sort()).toEqual(['cityProfiles', 'dataCutoffAt', 'generatedFrom', 'global']);
  });

  it('抽取结果可被 cloneMarketPositionDraft 严格解析（复现手工建立提案的种子路径）', () => {
    const version = makeVersion();
    // 直接克隆整个版本应因多余字段被拒绝。
    expect(() => cloneMarketPositionDraft(version as never)).toThrow();
    // 抽取草稿后克隆成功。
    expect(() => cloneMarketPositionDraft(marketPositionDraftFromVersion(version))).not.toThrow();
  });
});
