import type {
  CapabilityConclusionStatus,
  CapabilityConstraintKind,
  CapabilityEvidenceGenerator,
  CapabilityEvidencePolarity,
  CapabilityEvidenceStatus,
  CapabilityEvidenceStrength,
  CapabilityEvidenceSourceType,
  CapabilitySourceConfidence,
  CapabilityTimePrecision,
} from '../capability-baseline';

type LabelMap<Code extends string> = Readonly<Record<Code, string>>;

function labelFrom<Code extends string>(labels: LabelMap<Code>, value: unknown, fallback: string): string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(labels, value)
    ? labels[value as Code]
    : fallback;
}

export const CAPABILITY_CONCLUSION_STATUS_LABELS = {
  established: '已确立',
  supported: '有证据支持',
  exploratory: '探索性判断',
  insufficient: '样本不足',
  contradicted: '存在有力反证',
} satisfies LabelMap<CapabilityConclusionStatus>;

export const CAPABILITY_EVIDENCE_POLARITY_LABELS = {
  support: '支持',
  counter: '反证',
  neutral: '中性',
} satisfies LabelMap<CapabilityEvidencePolarity>;

export const CAPABILITY_EVIDENCE_STRENGTH_LABELS = {
  strong: '强',
  medium: '中',
  weak: '弱',
} satisfies LabelMap<CapabilityEvidenceStrength>;

export const CAPABILITY_EVIDENCE_STATUS_LABELS = {
  proposed: '待审核',
  accepted: '已接受',
  modified_and_accepted: '修改后接受',
  rejected: '已拒绝',
  deferred: '稍后处理',
} satisfies LabelMap<CapabilityEvidenceStatus>;

export const CAPABILITY_EVIDENCE_GENERATOR_LABELS = {
  manual: '手工录入',
  ai: 'AI 提案',
  system: '系统推导',
} satisfies LabelMap<CapabilityEvidenceGenerator>;

export const CAPABILITY_EVIDENCE_SOURCE_TYPE_LABELS = {
  profile: '个人档案',
  resume_version: '简历版本',
  job: '岗位',
  application: '求职流程',
  feedback_event: '招聘反馈事实',
  user_input: '用户手工输入',
} satisfies LabelMap<CapabilityEvidenceSourceType>;

export const CAPABILITY_CONSTRAINT_KIND_LABELS = {
  education: '学历门槛',
  age: '年龄门槛',
  city_supply: '城市岗位供给',
  salary: '薪资门槛',
  hiring_preference: '招聘偏好',
  other: '其他外部门槛',
} satisfies LabelMap<CapabilityConstraintKind>;

export const CAPABILITY_TIME_PRECISION_LABELS = {
  exact: '精确时间',
  date: '具体日期',
  approximate: '大致时间',
  unknown: '时间未知',
} satisfies LabelMap<CapabilityTimePrecision>;

export const CAPABILITY_SOURCE_CONFIDENCE_LABELS = {
  exact: '确证',
  approximate: '近似',
  recalled: '回忆',
  inferred: '推断',
} satisfies LabelMap<CapabilitySourceConfidence>;

export const formatCapabilityConclusionStatusLabel = (value: unknown) => labelFrom(
  CAPABILITY_CONCLUSION_STATUS_LABELS, value, '结论状态未知',
);
export const formatCapabilityPolarityLabel = (value: unknown) => labelFrom(
  CAPABILITY_EVIDENCE_POLARITY_LABELS, value, '极性未知',
);
export const formatCapabilityStrengthLabel = (value: unknown) => labelFrom(
  CAPABILITY_EVIDENCE_STRENGTH_LABELS, value, '强度未知',
);
export const formatCapabilityEvidenceStatusLabel = (value: unknown) => labelFrom(
  CAPABILITY_EVIDENCE_STATUS_LABELS, value, '状态未知',
);
