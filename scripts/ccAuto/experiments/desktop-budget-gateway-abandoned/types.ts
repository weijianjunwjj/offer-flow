/** cc-auto Desktop Budget Gateway v0.2.0 — 共享类型定义。 */

/** 网关记录的单次模型调用（来自上游 provider 的一次完整 HTTP 响应）。 */
export interface GatewayCallRecord {
  turnId: string;
  /** ISO-8601 */
  timestamp: string;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** 按 Token 估算的人民币费用（四舍五入到分），非账单实扣 */
  tokenEstimatedCostRmb: number;
  /** 上游返回的渠道人民币实扣金额（目前上游不提供此字段，始终为 undefined） */
  providerBilledCostRmb?: number;
  /** 各项费用明细 */
  costBreakdown: CostBreakdown;
}

export interface CostBreakdown {
  inputCostRmb: number;
  outputCostRmb: number;
  cacheCreationCostRmb: number;
  cacheReadCostRmb: number;
  totalCostRmb: number;
  inputPercent: number;
  outputPercent: number;
  cacheCreationPercent: number;
  cacheReadPercent: number;
}

/** 预算门闸检查结果 */
export interface BudgetGateResult {
  allowed: boolean;
  reason?: BudgetGateReason;
  detail?: string;
  currentTaskCost: number;
  estimatedNextCallCost: number;
  taskBudget: number;
}

export type BudgetGateReason =
  | 'BUDGET_TASK_EXCEEDED'
  | 'BUDGET_DAILY_EXCEEDED'
  | 'PRICING_NOT_FOUND'
  | 'MISSING_USAGE';

/** 任务复杂度 = 预算等级的映射键。由自然语言覆盖或默认配置决定。 */
export type TaskComplexity = 'simple' | 'normal' | 'complex';

/** Provider（上游渠道）标识。 */
export type ProviderId = string;

/** 模型人民币定价（每 1M tokens）。 */
export interface ModelPricingRmb {
  inputPerMTokens: number;
  outputPerMTokens: number;
  cacheCreationPerMTokens: number;
  cacheReadPerMTokens: number;
}

/** 网关配置 */
export interface GatewayConfig {
  /** 只监听此地址 */
  host: string;
  /** 监听端口 */
  port: number;
  /** CC Switch 上游地址（仅用于 passthrough 模式，Provider 下游模式下不使用） */
  upstreamHost: string;
  upstreamPort: number;
  /** CC Switch Claude Desktop 路径前缀 */
  upstreamPathPrefix: string;
  /** Provider 路由表：urlPrefix → 名称 + 目标 URL */
  routes: Record<string, ProviderRouteConfig>;
  /** 任务复杂度默认预算 */
  budget: {
    simpleTaskRmb: number;
    normalTaskRmb: number;
    complexTaskRmb: number;
    absoluteTaskMaxRmb: number;
    dailyMaxRmb: number;
  };
  /** 冷启动静态估计 */
  coldStartEstimates: {
    simple: { centerRmb: number; p90Rmb: number; maxRmb: number };
    normal: { centerRmb: number; p90Rmb: number; maxRmb: number };
    complex: { centerRmb: number; p90Rmb: number; maxRmb: number };
  };
  /** 模型定价表（按实际模型 ID 索引） */
  modelPricing: Record<string, ModelPricingRmb>;
  /** 数据目录（存储 session 历史、每日费用等） */
  dataDir: string;
}

export interface ProviderRouteConfig {
  name: string;
  upstreamUrl: string;
}

/** 用户从自然语言中解析出的预算覆盖 */
export interface UserBudgetOverride {
  /** 人民币金额 */
  amountRmb: number;
  source: 'inline_parse';
}

/** 费用预测结果 */
export interface CostEstimate {
  /** P50 中心预测（约值） */
  centerRmb: number;
  /** P80/P90 合理上界 */
  upperRmb: number;
  /** 硬预算上限 */
  hardLimitRmb: number;
  /** 实际目标模型 */
  modelId: string;
  /** 置信度 */
  confidence: 'low' | 'medium' | 'high';
  /** 预测使用的复杂度 */
  complexity: TaskComplexity;
}

/** 会话归并：每个 BudgetTurn 对应一个用户任务的完整模型对话周期。 */
export interface BudgetTurn {
  turnId: string;
  /** 任务摘要指纹（脱敏后持久化） */
  taskFingerprint: string;
  /** 用户任务第一条消息片段（脱敏摘要，最多 100 字符） */
  taskSummary: string;
  complexity: TaskComplexity;
  /** 用户是否显式写了预算 */
  userBudgetOverride?: UserBudgetOverride;
  /** 费用预测（仅注入一次） */
  estimate?: CostEstimate;
  /** 本 turn 实际任务预算上限（用户覆盖 or 复杂度默认） */
  taskBudgetRmb: number;
  /** 当日预算上限（启动时从配置读取） */
  dailyBudgetRmb: number;
  calls: GatewayCallRecord[];
  /** 任务是否已结束（最终 stop_reason 不再是 tool_use） */
  ended: boolean;
  /** 最终费用行是否已注入 */
  finalCostInjected: boolean;
  /** 本次响应缺少可靠 usage 或模型无定价（fail closed，不显示 0 元） */
  costUnavailable?: boolean;
  startedAt: string;
  endedAt?: string;
  provider: string;
}
