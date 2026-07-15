import type {
  CandidateEvidenceContent,
  CapabilityConstraintKind,
  CapabilityEvidencePolarity,
} from './types';

/**
 * 短期市场信号事件：这些事件本身不能作为降低长期能力结论的强反证，
 * 只能作为弱市场反馈或不确定性提示。
 */
export const WEAK_MARKET_SIGNAL_EVENT_TYPES = [
  'message_viewed',
  'no_response_recorded',
  'recruitment_paused',
  'recruitment_frozen',
  'position_closed',
  'marked_stale',
  'follow_up_sent',
] as const;

/** 能力相关的拒绝原因（可作为真实能力反证）。 */
export const CAPABILITY_REJECTION_REASON_CODES = ['skills', 'experience'] as const;

/**
 * 外部门槛类拒绝原因：属于岗位或市场可达性约束，
 * 不得写成能力反证，必须归入 externalConstraints。
 */
export const EXTERNAL_CONSTRAINT_REASON_CODES: ReadonlyArray<{
  reasonCode: string;
  kind: CapabilityConstraintKind;
}> = [
  { reasonCode: 'education', kind: 'education' },
  { reasonCode: 'degree', kind: 'education' },
  { reasonCode: 'age', kind: 'age' },
  { reasonCode: 'salary', kind: 'salary' },
  { reasonCode: 'budget', kind: 'salary' },
  { reasonCode: 'location', kind: 'city_supply' },
  { reasonCode: 'city', kind: 'city_supply' },
  { reasonCode: 'headcount', kind: 'city_supply' },
  { reasonCode: 'hiring_freeze', kind: 'hiring_preference' },
  { reasonCode: 'preference', kind: 'hiring_preference' },
];

export function isWeakMarketSignalEvent(eventType: string): boolean {
  return (WEAK_MARKET_SIGNAL_EVENT_TYPES as readonly string[]).includes(eventType);
}

export function externalConstraintKindForReason(
  reasonCode: string | null,
): CapabilityConstraintKind | null {
  if (reasonCode === null) return null;
  const match = EXTERNAL_CONSTRAINT_REASON_CODES.find((entry) => entry.reasonCode === reasonCode);
  return match?.kind ?? null;
}

export function isExternalConstraintReason(reasonCode: string | null): boolean {
  return externalConstraintKindForReason(reasonCode) !== null;
}

export type EventCapabilityClassification =
  | { kind: 'capability_signal'; polarity: CapabilityEvidencePolarity; strengthCap: 'strong' | 'medium' | 'weak' }
  | { kind: 'external_constraint'; constraintKind: CapabilityConstraintKind }
  | { kind: 'ignore' };

/**
 * 把一条反馈事件分类为：能力信号 / 外部门槛 / 忽略。
 * 这是核心护栏：
 * - 短期无回复、已读未回、招聘暂停/冻结 → 只能是 neutral 的弱市场信号（strengthCap=weak），不可成为强反证；
 * - 学历、薪资、城市供给、招聘偏好等拒绝原因 → 外部门槛，不写成能力反证；
 * - 因能力/经验被拒 → 真实能力反证 counter。
 */
export function classifyEventForCapability(
  eventType: string,
  reasonCode: string | null,
): EventCapabilityClassification {
  const constraintKind = externalConstraintKindForReason(reasonCode);
  if (eventType === 'rejected' && constraintKind !== null) {
    return { kind: 'external_constraint', constraintKind };
  }
  if (['interview_advanced', 'offer_received', 'offer_accepted'].includes(eventType)) {
    return { kind: 'capability_signal', polarity: 'support', strengthCap: 'strong' };
  }
  if (
    eventType === 'rejected'
    && reasonCode !== null
    && (CAPABILITY_REJECTION_REASON_CODES as readonly string[]).includes(reasonCode)
  ) {
    return { kind: 'capability_signal', polarity: 'counter', strengthCap: 'medium' };
  }
  if (isWeakMarketSignalEvent(eventType)) {
    // 弱市场信号：既不是强反证，也不自动降低能力；标记为 neutral、强度上限 weak。
    return { kind: 'capability_signal', polarity: 'neutral', strengthCap: 'weak' };
  }
  return { kind: 'ignore' };
}

/**
 * 单条证据是否违反护栏。用于校验手工 / AI 生成的候选证据：
 * 短期市场信号不得成为强/中反证。
 */
export function evidenceGuardrailViolations(content: CandidateEvidenceContent): string[] {
  const violations: string[] = [];
  if (
    content.polarity === 'counter'
    && content.strength !== 'weak'
    && content.sourceType === 'feedback_event'
    && content.sourceConfidence !== 'exact'
  ) {
    violations.push('短期或非确证的反馈事件不得作为强反证降低长期能力结论');
  }
  return violations;
}

/** 去重键：同一能力维度 + 来源 + 摘要视为同源证据。 */
export function evidenceDedupeKey(content: CandidateEvidenceContent): string {
  return [
    content.capabilityKey.trim().toLowerCase(),
    content.sourceType,
    (content.sourceId ?? '').trim().toLowerCase(),
    content.polarity,
    content.summary.trim().toLowerCase(),
  ].join('|');
}

/**
 * 同源重复证据去重：保留首条，重复项被视为已存在（返回是否为新证据）。
 * 不会删除已有证据，只用于新增时判定是否重复。
 */
export function isDuplicateEvidence(
  content: CandidateEvidenceContent,
  existing: CandidateEvidenceContent[],
): boolean {
  const key = evidenceDedupeKey(content);
  return existing.some((item) => evidenceDedupeKey(item) === key);
}

/**
 * insufficient / contradicted 结论必须说明还需要补什么证据。
 * 返回缺失项列表，供页面提示与结构校验使用。
 */
export function describeInsufficientGuidance(
  supportingCount: number,
  counterCount: number,
): string[] {
  const guidance: string[] = [];
  if (supportingCount === 0) guidance.push('缺少已接受的支持证据');
  if (counterCount === 0) guidance.push('缺少已核实的反证或边界说明');
  if (supportingCount > 0 && counterCount === 0) {
    guidance.push('仅有支持证据，需补充反证与未验证项以避免单一结论');
  }
  if (guidance.length === 0) guidance.push('需要更多独立来源与时间跨度的证据');
  return guidance;
}
