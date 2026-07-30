/** 任务分类器：不调用任何模型，纯本地启发式，用于决定探路/构建/仲裁路径。 */
import type { Classification } from './types';

/** 命中即视为高风险（schema、生产数据、鉴权、公共 API 破坏性变更、强推）。 */
const HIGH_RISK_PATTERNS: RegExp[] = [
  /schema|migration|迁移|数据库结构/i,
  /生产(库|数据|环境)|production\s*db|prod\s*database/i,
  /鉴权|authentication|authorization|auth\b/i,
  /public\s*api|破坏性变更|breaking\s*change/i,
  /force\s*push|强推|reset\s*--hard/i,
  /密钥|secret|token\b|api\s*key/i,
];

/** 命中即视为纯文案/文档类任务（不触发 scout/arbiter）。 */
const COPY_ONLY_PATTERNS: RegExp[] = [
  /^(修改|调整|更新|改)?(文案|措辞|文字|拼写|typo|错别字)/i,
  /^(更新|修改)?\s*(readme|注释|comment|文档)/i,
];

/** 命中会提升复杂度（多文件、跨模块、架构相关）。 */
const COMPLEX_HINT_PATTERNS: RegExp[] = [
  /重构|refactor/i,
  /跨(模块|文件|层)/i,
  /架构|architecture/i,
  /新增(功能|模块|页面)/i,
];

/** 声明式的 --estimated-files=N，用户可在 CLI 上明确给出预估文件数覆盖启发式。 */
export function classifyTask(taskDescription: string, estimatedFiles?: number): Classification {
  const reasons: string[] = [];
  let riskScore = 0;

  const highRiskHits = HIGH_RISK_PATTERNS.filter((p) => p.test(taskDescription));
  if (highRiskHits.length > 0) {
    riskScore += Math.min(8, highRiskHits.length * 4);
    reasons.push(`命中高风险关键词 ${highRiskHits.length} 类`);
  }

  const isCopyOnly = COPY_ONLY_PATTERNS.some((p) => p.test(taskDescription.trim()));
  const complexHits = COMPLEX_HINT_PATTERNS.filter((p) => p.test(taskDescription));
  if (complexHits.length > 0) {
    riskScore += Math.min(3, complexHits.length);
    reasons.push(`命中复杂度提示 ${complexHits.length} 类`);
  }

  if (estimatedFiles !== undefined && estimatedFiles > 5) {
    riskScore += 2;
    reasons.push(`预估改动文件数 ${estimatedFiles} > 5`);
  }

  riskScore = Math.max(0, Math.min(10, riskScore));

  let complexity: Classification['complexity'];
  if (isCopyOnly && highRiskHits.length === 0) {
    complexity = 'simple';
    reasons.push('判定为纯文案/文档类任务');
  } else if (riskScore >= 5 || complexHits.length >= 2 || (estimatedFiles ?? 0) > 5) {
    complexity = 'complex';
  } else if (highRiskHits.length > 0 || complexHits.length > 0 || (estimatedFiles ?? 0) > 1) {
    complexity = 'normal';
  } else {
    complexity = 'simple';
  }

  return {
    complexity,
    riskScore,
    reasons,
    touchesHighRisk: highRiskHits.length > 0,
  };
}
