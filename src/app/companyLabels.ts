// 公司画像相关枚举的中文标签 / 选项（v0.2）。
// 单一信源，供主战场表单、列表筛选、机会雷达卡复用。
// 本轮（Task 4）只需要公司规模档位；稳定性 / 成长性 / 风险等标签待 Task 8 按需补充。

import type { CompanySizeTier } from '../storage';

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
