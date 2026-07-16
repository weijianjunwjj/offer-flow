import { StrategyProposalDraftSchema } from './schemas';
import type { StrategyProposalDraft } from './types';

/** 深拷贝并重新校验一份策略草稿，供编辑器种子与版本快照使用。 */
export function cloneStrategyDraft(draft: StrategyProposalDraft): StrategyProposalDraft {
  return StrategyProposalDraftSchema.parse(JSON.parse(JSON.stringify(draft))) as StrategyProposalDraft;
}
