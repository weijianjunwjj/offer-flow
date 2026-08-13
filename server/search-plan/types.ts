/**
 * OfferFlow v0.9 — DailySearchPlan 与 DailySearchPlanVersion 领域类型。
 *
 * Task: T021
 * 设计依据：specs/001-daily-job-hunter/data-model.md §1.1 / §1.2
 *
 * 语义：
 *   - DailySearchPlan = 逻辑搜索计划 identity（不改写历史，只维护当前激活版本指针）；
 *   - DailySearchPlanVersion = 不可变版本快照（每次配置实质变化产生新版本，不 UPDATE 旧版本）。
 *
 * 本文件只定义类型，不包含 DB 映射或持久化逻辑（见 searchPlanRepository.ts）。
 */

/** 计划生命周期状态。 */
export type DailySearchPlanStatus = 'active' | 'paused' | 'deleted';

export const DAILY_SEARCH_PLAN_STATUSES: readonly DailySearchPlanStatus[] = [
  'active',
  'paused',
  'deleted',
];

/** 单个 source provider 配置（source_configs_json 数组元素，P0 = tavily）。 */
export interface SearchSourceConfig {
  providerKey: string;
  searchDepth?: string;
  country?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** 目标城市配置（cities_json 数组元素）。 */
export interface SearchPlanCity {
  name: string;
  priority?: number;
}

/** 硬约束（hard_constraints_json 数组元素）——P0 为开放 JSON，具体结构由配置 UI 冻结。 */
export type SearchPlanHardConstraint = Record<string, unknown>;

/** 逻辑搜索计划 identity。 */
export interface DailySearchPlan {
  id: string;
  name: string;
  status: DailySearchPlanStatus;
  /** 当前激活版本指针，未激活时为 null。 */
  activeVersionId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/**
 * 不可变版本快照。JSON 字段在 DB 层以 TEXT 存储，读取时反序列化为本类型。
 *
 * schedule / scanBudget / analysisBudget / briefPolicy / explorationPolicy /
 * notificationPolicy 保持 Record<string, unknown>：其精确子结构由 T023 配置 UI
 * 与 T027 Query Expansion 消费时再冻结，本层只保证可持久化与可追溯。
 */
export interface DailySearchPlanVersion {
  id: string;
  searchPlanId: string;
  version: number;
  cities: SearchPlanCity[];
  roleDirections: string[];
  baseKeywords: string[];
  expandedKeywords: string[];
  hardConstraints: SearchPlanHardConstraint[];
  sourceConfigs: SearchSourceConfig[];
  schedule: Record<string, unknown>;
  scanBudget: Record<string, unknown>;
  analysisBudget: Record<string, unknown>;
  briefPolicy: Record<string, unknown>;
  explorationPolicy: Record<string, unknown>;
  notificationPolicy: Record<string, unknown>;
  latestCatchUpTime: string;
  createdAt: number;
  activatedAt: number | null;
  supersedesVersionId: string | null;
}
