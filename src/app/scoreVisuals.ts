// 分数 → 视觉色调（纯函数，无副作用，不接 storage / 页面 / API）。
// DEC-019 视觉分层：机会分（主判决）、目标画像（是否我的菜）、投递建议（行动指令）
// 共用一套「色调」语义，列表与主战场据此上色，避免各处重复写阈值。
//
// 阈值口径镜像各自的等级函数（保持唯一来源在等级函数处）：
// - opportunityTone ←→ getOpportunityScoreLevel（opportunityScore.ts，§6 区间）
// - profileTone     ←→ getTargetProfileLevel（targetProfileScore.ts，DEC-018 区间）

import type { ApplyAdvice } from '../storage';

/** 六档色调：强/优/可观察/谨慎/弱/无。页面各自映射到具体配色类。 */
export type ScoreTone = 'strong' | 'good' | 'watch' | 'caution' | 'weak' | 'none';

/** 机会分色调（与 getOpportunityScoreLevel 同区间）。null → none。 */
export function opportunityTone(score: number | null): ScoreTone {
  if (score === null) return 'none';
  if (score >= 85) return 'strong';
  if (score >= 75) return 'good';
  if (score >= 65) return 'watch';
  if (score >= 50) return 'caution';
  return 'weak';
}

/** 目标画像色调（与 getTargetProfileLevel 同区间）。null → none。 */
export function profileTone(score: number | null): ScoreTone {
  if (score === null) return 'none';
  if (score >= 85) return 'strong';
  if (score >= 70) return 'good';
  if (score >= 55) return 'watch';
  if (score >= 40) return 'caution';
  return 'weak';
}

/** 投递建议 → 行动指令色调。未给出（''）→ none。 */
export function applyAdviceTone(advice: ApplyAdvice | ''): ScoreTone {
  switch (advice) {
    case 'strongly':
      return 'strong';
    case 'ok':
      return 'good';
    case 'cautious':
      return 'caution';
    case 'skip':
      return 'weak';
    default:
      return 'none';
  }
}
