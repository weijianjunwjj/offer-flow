import type {
  DecisionGateStatus,
  DecisionGateType,
  EvidenceLevel,
  StrategyActionType,
  StrategyAllocationDimension,
  StrategyWindowType,
} from '../strategy-window';

export const STRATEGY_WINDOW_TYPE_LABELS: Record<StrategyWindowType, string> = {
  evidence_collection: '证据收集窗口',
  controlled_experiment: '受控实验窗口',
  limited_optimization: '有限优化窗口',
};

export const STRATEGY_EVIDENCE_LEVEL_LABELS: Record<EvidenceLevel, string> = {
  insufficient: '证据不足',
  directional: '方向性信号',
  supported: '有证据支持',
};

export const STRATEGY_ACTION_TYPE_LABELS: Record<StrategyActionType, string> = {
  collect_market_evidence: '补充市场证据',
  increase_reliable_applications: '增加可靠投递样本',
  complete_outcome_records: '补齐投递结果记录',
  city_sample_experiment: '城市样本试探',
  role_family_experiment: '岗位族小规模实验',
  resume_ab_test: '简历版本 A/B 实验',
  channel_ab_test: '投递渠道 A/B 实验',
  salary_probe: '薪资区间试探',
  portfolio_evidence_improvement: '完善项目与作品证据',
  interview_story_improvement: '打磨面试表达与叙事',
  follow_up_hygiene: '整理跟进与沟通卫生',
  stale_process_review: '复盘长期无进展流程',
  relocation_feasibility_research: '搬迁可行性调研（仅调研）',
  reduce_exposure: '有限减少低效投入',
  maintain_current_strategy: '维持当前策略',
};

export const STRATEGY_DECISION_GATE_TYPE_LABELS: Record<DecisionGateType, string> = {
  role_positioning: '角色定位',
  city_priority: '城市优先级',
  salary_positioning: '薪资定位',
  resume_effectiveness: '简历有效性',
  channel_effectiveness: '渠道有效性',
  abandon_direction: '放弃当前方向',
  relocation_decision: '搬迁决策',
};

export const STRATEGY_DECISION_GATE_STATUS_LABELS: Record<DecisionGateStatus, string> = {
  blocked: '锁定',
  observe_only: '仅供观察',
  decision_ready: '可供参考',
};

export const STRATEGY_ALLOCATION_DIMENSION_LABELS: Record<StrategyAllocationDimension, string> = {
  city: '城市',
  job_family: '岗位族',
  channel: '投递渠道',
};

export const STRATEGY_CITY_LABELS: Record<string, string> = {
  suzhou: '苏州',
  wuxi: '无锡',
  shanghai: '上海',
  hangzhou: '杭州',
};

export const STRATEGY_JOB_FAMILY_LABELS: Record<string, string> = {
  ai_applications: 'AI 应用工程',
  fullstack_node: '全栈与 Node.js',
  data_platform_frontend: '数据平台与可视化前端',
  frontend: '前端开发',
  uncategorized: '其他 / 待归类',
};
