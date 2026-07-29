/**
 * V8-4 单岗位分析 · stale 有效性投影（设计 §11 / TD §8）。
 *
 * `job_match_analysis_records` 不可变，**不新增字段**：有效性在查询时由记录内冻结版本
 * 与当前 active 版本比较派生（纯函数 deriveAnalysisValidity），落地为 AnalysisValidity。
 *
 * 关键裁决：
 * - model_name 变化**默认不** stale（§11.3）；只有显式 Model Policy 声明旧模型结果不可用于
 *   推荐时才产生 model_policy_invalidated（由调用方以 modelPolicyInvalidated 布尔注入）；
 * - nullable 版本项（能力基线/市场/策略/城市）任一侧存在性或取值变化都记为对应 changed；
 * - 有效性只读派生，前端不得绕过（§11.4）。
 */
import type { JobMatchAnalysisRecord } from '../../../src/domain/radar';
import type { SqliteDatabase } from '../../db';
import { RadarCandidateRepository } from '../candidateRepository';
import { ResumeVersionRepository } from '../../job-memory/resumeVersionRepository';
import { ProfileRepository } from '../../repositories/profileRepository';
import { CapabilityBaselineRepository } from '../../capability-baseline/repository';
import { MarketPositionRepository } from '../../market-position/repository';
import { StrategyRepository } from '../../strategy-window/repository';

/** stale 原因（设计 §11.2 表；model_policy_invalidated 见 §11.3）。 */
export const ANALYSIS_STALE_REASONS = [
  'candidate_version_changed',
  'resume_version_changed',
  'job_match_profile_changed',
  'capability_baseline_changed',
  'market_position_changed',
  'strategy_changed',
  'rule_version_changed',
  'prompt_version_changed',
  'analysis_policy_changed',
  'model_policy_invalidated',
] as const;
export type AnalysisStaleReason = (typeof ANALYSIS_STALE_REASONS)[number];

/** 有效性投影结果（TD §8.2）：current 可进入推荐；stale 仅作旧版参考。 */
export interface AnalysisValidity {
  state: 'current' | 'stale';
  reasons: AnalysisStaleReason[];
}

/**
 * 当前 active 版本描述符：与记录冻结版本逐项比较的对照面。
 * 城市/能力/市场/策略允许为 null（当前无正式版本），比较按"存在性 + 取值"整体判断。
 */
export interface CurrentAnalysisVersions {
  candidateActiveVersionId: string | null;
  activeResumeVersionId: string | null;
  activeJobMatchProfileVersionId: string | null;
  activeCapabilityBaselineVersionId: string | null;
  activeMarketPositionVersionId: string | null;
  activeStrategyVersionId: string | null;
  ruleVersion: string;
  promptVersion: string;
  analysisPolicyVersion: string;
  /** 显式 Model Policy 判定旧模型结果不可用于推荐（§11.3）；默认 false。 */
  modelPolicyInvalidated?: boolean;
}

/**
 * 纯函数：比较记录内冻结版本与当前 active 版本，派生有效性。
 * 任一比较项不一致即 stale 并记录对应 reason（reason 顺序与 §11.2 表一致，稳定可断言）。
 * model_name 变化不参与比较（§11.3）——只有 modelPolicyInvalidated 才产生 model_policy_invalidated。
 */
export function deriveAnalysisValidity(
  record: JobMatchAnalysisRecord,
  current: CurrentAnalysisVersions,
): AnalysisValidity {
  const reasons: AnalysisStaleReason[] = [];
  const differs = (frozen: string | null, active: string | null): boolean => frozen !== active;

  if (differs(record.candidateVersionId, current.candidateActiveVersionId)) {
    reasons.push('candidate_version_changed');
  }
  if (differs(record.resumeVersionId, current.activeResumeVersionId)) {
    reasons.push('resume_version_changed');
  }
  if (differs(record.jobMatchProfileVersionId, current.activeJobMatchProfileVersionId)) {
    reasons.push('job_match_profile_changed');
  }
  if (differs(record.capabilityBaselineVersionId, current.activeCapabilityBaselineVersionId)) {
    reasons.push('capability_baseline_changed');
  }
  if (differs(record.marketPositionVersionId, current.activeMarketPositionVersionId)) {
    reasons.push('market_position_changed');
  }
  if (differs(record.strategyVersionId, current.activeStrategyVersionId)) {
    reasons.push('strategy_changed');
  }
  if (record.ruleVersion !== current.ruleVersion) reasons.push('rule_version_changed');
  if (record.promptVersion !== current.promptVersion) reasons.push('prompt_version_changed');
  if (record.analysisPolicyVersion !== current.analysisPolicyVersion) {
    reasons.push('analysis_policy_changed');
  }
  if (current.modelPolicyInvalidated === true) reasons.push('model_policy_invalidated');

  return { state: reasons.length === 0 ? 'current' : 'stale', reasons };
}

/** 版本策略与 Model Policy 由服务层注入（本层不臆测正式规则/prompt/policy 版本）。 */
export interface CurrentPolicyVersions {
  ruleVersion: string;
  promptVersion: string;
  analysisPolicyVersion: string;
  modelPolicyInvalidated?: boolean;
}

/**
 * 从当前正式数据读取比较对照面（记录版本化领域的 active 版本 ID）。
 * 只读、无副作用；策略版本与 Model Policy 判定由 policy 注入。缺失领域的 active 版本为 null，
 * 由 deriveAnalysisValidity 依存在性差异判定 stale。
 */
export function readCurrentAnalysisVersions(
  db: SqliteDatabase,
  candidateId: string,
  policy: CurrentPolicyVersions,
): CurrentAnalysisVersions {
  const candidate = new RadarCandidateRepository(db).getCandidate(candidateId);
  const profile = new ProfileRepository(db).get();
  return {
    candidateActiveVersionId: candidate?.activeVersionId ?? null,
    activeResumeVersionId: new ResumeVersionRepository(db).getActiveResumeVersionId(),
    activeJobMatchProfileVersionId: profile?.jobMatchProfile?.activeVersionId ?? null,
    activeCapabilityBaselineVersionId: new CapabilityBaselineRepository(db).getState().activeVersionId,
    activeMarketPositionVersionId: new MarketPositionRepository(db).getState().activeVersionId,
    activeStrategyVersionId: new StrategyRepository(db).getState().activeVersionId,
    ruleVersion: policy.ruleVersion,
    promptVersion: policy.promptVersion,
    analysisPolicyVersion: policy.analysisPolicyVersion,
    modelPolicyInvalidated: policy.modelPolicyInvalidated ?? false,
  };
}
