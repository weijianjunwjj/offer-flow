/**
 * OfferFlow v0.9 — DailySearchPlan API 客户端（T023）。
 *
 * 只封装后端已存在的正式端点（T022 CRUD + T032 控制），以 server/search-plan 的真实
 * route 与 DTO 为唯一契约（无 /api 前缀，与 /radar/actions 等一致）。前端不做任何
 * schedule 计算 / timezone occurrence / catch-up / skip 语义 / run 并发——全部以后端为真源。
 */
import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

const base = '/daily-search-plans';

export type DailySearchPlanStatus = 'active' | 'paused' | 'deleted';

/** 单个 source provider 配置（source_configs_json 数组元素，P0 = tavily）。 */
export interface SearchSourceConfig {
  providerKey: string;
  [key: string]: unknown;
}

/** 目标城市配置（cities_json 数组元素）。 */
export interface SearchPlanCity {
  name: string;
  priority?: number;
}

/** 逻辑搜索计划 identity。 */
export interface DailySearchPlan {
  id: string;
  name: string;
  status: DailySearchPlanStatus;
  activeVersionId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** 不可变版本快照（schedule 已在服务端 normalize 为 { dailyAt, timezone }，其余 JSON 字段保持开放）。 */
export interface DailySearchPlanVersion {
  id: string;
  searchPlanId: string;
  version: number;
  cities: SearchPlanCity[];
  roleDirections: string[];
  baseKeywords: string[];
  expandedKeywords: string[];
  hardConstraints: Record<string, unknown>[];
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

/** 创建计划 / 创建新版本共用的 config 载荷（新版本无 name）。 */
export interface SearchPlanConfigInput {
  cities: SearchPlanCity[];
  roleDirections: string[];
  baseKeywords: string[];
  expandedKeywords: string[];
  hardConstraints: Record<string, unknown>[];
  sourceConfigs: SearchSourceConfig[];
  schedule: { dailyAt: string; timezone: string };
  scanBudget: Record<string, unknown>;
  analysisBudget: Record<string, unknown>;
  briefPolicy: Record<string, unknown>;
  explorationPolicy: Record<string, unknown>;
  notificationPolicy: Record<string, unknown>;
  latestCatchUpTime: string;
}

export interface CreateSearchPlanInput extends SearchPlanConfigInput {
  name: string;
}

export interface SearchPlanListResponse {
  plans: DailySearchPlan[];
}

export interface SearchPlanDetailResponse {
  plan: DailySearchPlan;
  activeVersion: DailySearchPlanVersion | null;
}

export interface SearchPlanVersionsResponse {
  versions: DailySearchPlanVersion[];
}

export interface SearchPlanCreateResponse {
  plan: DailySearchPlan;
  version: DailySearchPlanVersion;
}

export interface SearchPlanVersionCreateResponse {
  version: DailySearchPlanVersion;
}

export interface SearchPlanStatusResponse {
  plan: DailySearchPlan;
}

export interface SearchPlanSkipTodayResponse {
  skipped: { searchPlanVersionId: string; scheduledDay: string };
}

export interface SearchPlanRunNowResponse {
  sourceRunId: string;
  status: string;
  briefId: string | null;
}

export const dailySearchPlanApi = {
  list(options?: ReadOptions): Promise<SearchPlanListResponse> {
    return apiGet(base, options);
  },
  get(id: string, options?: ReadOptions): Promise<SearchPlanDetailResponse> {
    return apiGet(`${base}/${encodeURIComponent(id)}`, options);
  },
  listVersions(id: string, options?: ReadOptions): Promise<SearchPlanVersionsResponse> {
    return apiGet(`${base}/${encodeURIComponent(id)}/versions`, options);
  },
  create(input: CreateSearchPlanInput, options?: SendOptions): Promise<SearchPlanCreateResponse> {
    return apiSend(base, 'POST', input, options);
  },
  createVersion(id: string, input: SearchPlanConfigInput, options?: SendOptions): Promise<SearchPlanVersionCreateResponse> {
    return apiSend(`${base}/${encodeURIComponent(id)}/versions`, 'POST', input, options);
  },
  pause(id: string, options?: SendOptions): Promise<SearchPlanStatusResponse> {
    return apiSend(`${base}/${encodeURIComponent(id)}/pause`, 'POST', undefined, options);
  },
  resume(id: string, options?: SendOptions): Promise<SearchPlanStatusResponse> {
    return apiSend(`${base}/${encodeURIComponent(id)}/resume`, 'POST', undefined, options);
  },
  skipToday(id: string, options?: SendOptions): Promise<SearchPlanSkipTodayResponse> {
    return apiSend(`${base}/${encodeURIComponent(id)}/skip-today`, 'POST', undefined, options);
  },
  runNow(id: string, options?: SendOptions): Promise<SearchPlanRunNowResponse> {
    return apiSend(`${base}/${encodeURIComponent(id)}/run-now`, 'POST', undefined, options);
  },
};
