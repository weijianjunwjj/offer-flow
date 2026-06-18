// Task 6：机会分计算与分数归一（纯函数，无副作用）。
// 规则见 docs/v0.2/requirements.md §6。本文件不接 storage / 页面。

import type { OpportunityRadar } from '../storage';

/**
 * 把任意值归一为 0-100 的整数。
 * - number / 数字字符串（可含 %、空白）→ 钳制到 [0,100] 并四舍五入为整数
 * - 非数字 / 空 / NaN / Infinity → null
 */
export function normalizeScore(value: unknown): number | null {
  let n: number | null = null;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const cleaned = value.replace(/%/g, '').trim();
    if (cleaned === '') {
      return null;
    }
    const parsed = Number(cleaned);
    if (!Number.isNaN(parsed)) {
      n = parsed;
    }
  }
  if (n === null || !Number.isFinite(n)) {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, n)));
}

/**
 * 6 维加权计算机会分（薪资/稳定/成长/匹配各 0.20，通勤/风险可控各 0.10）。
 * 返回 0-100 整数。
 */
export function calculateOpportunityScore(radar: OpportunityRadar): number {
  const score =
    radar.salaryScore * 0.2 +
    radar.stabilityScore * 0.2 +
    radar.growthScore * 0.2 +
    radar.matchScore * 0.2 +
    radar.commuteScore * 0.1 +
    radar.riskControlScore * 0.1;
  return Math.round(Math.min(100, Math.max(0, score)));
}

/** 机会分等级文案（requirements §6） */
export function getOpportunityScoreLevel(score: number): string {
  if (score >= 85) return '高价值机会';
  if (score >= 75) return '优质机会';
  if (score >= 65) return '可观察机会';
  if (score >= 50) return '谨慎机会';
  return '低价值机会';
}
