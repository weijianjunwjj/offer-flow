import type {
  JobMatchCityCode,
  JobMatchConfidence,
  JobMatchProposalStatus,
} from '../job-match-profile';

type LabelMap<Code extends string> = Readonly<Record<Code, string>>;

function labelFrom<Code extends string>(labels: LabelMap<Code>, value: unknown, fallback: string): string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(labels, value)
    ? labels[value as Code]
    : fallback;
}

export const JOB_MATCH_CITY_LABELS = {
  suzhou: '苏州',
  wuxi: '无锡',
  shanghai: '上海',
  hangzhou: '杭州',
} satisfies LabelMap<JobMatchCityCode>;

export const JOB_MATCH_CONFIDENCE_LABELS = {
  insufficient: '样本不足',
  exploratory: '探索性判断',
  actionable: '可行动判断',
} satisfies LabelMap<JobMatchConfidence>;

export const JOB_MATCH_PROPOSAL_STATUS_LABELS = {
  proposed: '待审核',
  accepted: '已接受',
  modified_and_accepted: '修改后接受',
  rejected: '已拒绝',
  deferred: '稍后处理',
} satisfies LabelMap<JobMatchProposalStatus>;

export const JOB_MATCH_VERSION_STATUS_LABELS = {
  active: '当前正式版本',
  archived: '历史版本',
} as const;

export const JOB_MATCH_GENERATED_BY_LABELS = {
  ai: 'AI 提案',
  manual: '手工提案',
} as const;

export const JOB_MATCH_CAPABILITY_LEVEL_LABELS = {
  core: '核心优势',
  supporting: '支撑能力',
  to_validate: '待验证能力',
} as const;

export const formatJobMatchCityLabel = (value: unknown) => labelFrom(JOB_MATCH_CITY_LABELS, value, '未知城市');
export const formatJobMatchConfidenceLabel = (value: unknown) => labelFrom(
  JOB_MATCH_CONFIDENCE_LABELS, value, '置信状态未知',
);
export const formatJobMatchProposalStatusLabel = (value: unknown) => labelFrom(
  JOB_MATCH_PROPOSAL_STATUS_LABELS, value, '处理状态未知',
);
