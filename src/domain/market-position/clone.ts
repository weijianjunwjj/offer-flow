import { MarketPositionDraftSchema } from './schemas';
import type { MarketPositionDraft, MarketPositionVersion } from './types';

/**
 * 从正式版本中抽取纯草稿部分（剥离 id/version/status/inputSnapshot 等版本专属字段）。
 * MarketPositionVersion 继承 MarketPositionDraft，但 MarketPositionDraftSchema 为 strict object，
 * 直接克隆整个版本会因多余的版本字段被拒绝——手工建立/修改提案的种子必须只取草稿字段。
 */
export function marketPositionDraftFromVersion(version: MarketPositionVersion): MarketPositionDraft {
  return {
    global: version.global,
    cityProfiles: version.cityProfiles,
    generatedFrom: version.generatedFrom,
    dataCutoffAt: version.dataCutoffAt,
  };
}

export function cloneMarketPositionDraft(value: MarketPositionDraft): MarketPositionDraft {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  return MarketPositionDraftSchema.parse(plain);
}
