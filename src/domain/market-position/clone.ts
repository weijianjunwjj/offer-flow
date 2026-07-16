import { MarketPositionDraftSchema } from './schemas';
import type { MarketPositionDraft } from './types';

export function cloneMarketPositionDraft(value: MarketPositionDraft): MarketPositionDraft {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  return MarketPositionDraftSchema.parse(plain);
}
