import type {
  DecisionGateStatus,
  DecisionGateType,
  EvidenceLevel,
  MarketPositionCityCode,
} from '../market-position';

type LabelMap<Code extends string> = Readonly<Record<Code, string>>;

export const MARKET_POSITION_CITY_LABELS = {
  suzhou: '苏州',
  wuxi: '无锡',
  shanghai: '上海',
  hangzhou: '杭州',
} satisfies LabelMap<MarketPositionCityCode>;

export const MARKET_POSITION_EVIDENCE_LEVEL_LABELS = {
  insufficient: '证据不足',
  directional: '方向性信号',
  supported: '有证据支持',
} satisfies LabelMap<EvidenceLevel>;

export const DECISION_GATE_TYPE_LABELS = {
  role_positioning: '角色定位',
  city_priority: '城市优先级',
  salary_positioning: '薪资定位',
  resume_effectiveness: '简历有效性',
  channel_effectiveness: '渠道有效性',
  abandon_direction: '放弃当前方向',
  relocation_decision: '搬迁决策',
} satisfies LabelMap<DecisionGateType>;

export const DECISION_GATE_STATUS_LABELS = {
  blocked: '锁定',
  observe_only: '仅供观察',
  decision_ready: '可供参考',
} satisfies LabelMap<DecisionGateStatus>;
