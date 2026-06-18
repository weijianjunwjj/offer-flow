// 公司画像相关枚举的中文标签 / 选项（v0.2）。
// 单一信源，供主战场表单、机会雷达卡、列表筛选复用。

import type {
  ApplyAdvice,
  CompanySizeTier,
  GrowthPotential,
  RiskLevel,
  StabilityLevel,
} from '../storage';

/** 公司规模档位中文标签 */
export const COMPANY_SIZE_LABELS: Record<CompanySizeTier, string> = {
  giant: '大厂（10000+）',
  large: '大中厂（1000-9999）',
  medium: '中厂（100-999）',
  small: '小厂（20-99）',
  micro: '微厂（0-20）',
  unknown: '未知 / 未填',
};

/** 公司规模下拉选项（顺序：大 → 小 → 未知） */
export const COMPANY_SIZE_OPTIONS: { label: string; value: CompanySizeTier }[] = (
  Object.keys(COMPANY_SIZE_LABELS) as CompanySizeTier[]
).map((value) => ({ value, label: COMPANY_SIZE_LABELS[value] }));

/** 稳定性 / 成长性等三档（含 unknown）通用标签 */
export const LEVEL_LABELS: Record<StabilityLevel & GrowthPotential, string> = {
  high: '高',
  medium: '中',
  low: '低',
  unknown: '未知',
};

/** 风险等级标签 */
export const RISK_LABELS: Record<RiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  unknown: '未知',
};

/** 置信度标签 */
export const CONFIDENCE_LABELS: Record<'high' | 'medium' | 'low', string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** 投递建议四档标签（含未给出） */
export const APPLY_ADVICE_LABELS: Record<ApplyAdvice | '', string> = {
  strongly: '强烈建议沟通',
  ok: '可以沟通',
  cautious: '谨慎沟通',
  skip: '不建议浪费精力',
  '': '未给出',
};
