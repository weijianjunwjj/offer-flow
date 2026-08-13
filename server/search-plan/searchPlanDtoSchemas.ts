import { z } from 'zod';

/**
 * OfferFlow v0.9 — DailySearchPlan API DTO schemas。
 *
 * Task: T022
 *
 * 只校验 API 边界的输入形状，不做业务编排：
 *   - 数组字段（cities / roleDirections / baseKeywords / expandedKeywords / sourceConfigs）
 *     校验元素形状；
 *   - 开放 JSON 字段（schedule / scanBudget / analysisBudget / briefPolicy /
 *     explorationPolicy / notificationPolicy）保持 Record<string, unknown>，
 *     其精确子结构由 T023 配置 UI 与 T027 Query Expansion 消费时再冻结；
 *   - 缺省字段在 parse 后补齐默认值，使下游总是拿到完整 config。
 */

const trimmedString = z.string().trim().min(1);

/** 目标城市配置（cities_json 数组元素）。 */
export const SearchPlanCitySchema = z.object({
  name: trimmedString,
  priority: z.number().int().optional(),
});

/** 单个 source provider 配置（P0 = tavily；允许 provider 附加字段透传）。 */
export const SearchSourceConfigSchema = z
  .object({ providerKey: trimmedString })
  .catchall(z.unknown());

const searchPlanConfigShape = {
  cities: z.array(SearchPlanCitySchema).default([]),
  roleDirections: z.array(trimmedString).default([]),
  baseKeywords: z.array(trimmedString).default([]),
  expandedKeywords: z.array(trimmedString).default([]),
  hardConstraints: z.array(z.record(z.string(), z.unknown())).default([]),
  sourceConfigs: z.array(SearchSourceConfigSchema).default([]),
  schedule: z.record(z.string(), z.unknown()).default({}),
  scanBudget: z.record(z.string(), z.unknown()).default({}),
  analysisBudget: z.record(z.string(), z.unknown()).default({}),
  briefPolicy: z.record(z.string(), z.unknown()).default({}),
  explorationPolicy: z.record(z.string(), z.unknown()).default({}),
  notificationPolicy: z.record(z.string(), z.unknown()).default({}),
  latestCatchUpTime: trimmedString.default('12:00'),
};

/** 纯 config（无 name），用于创建新版本。 */
export const SearchPlanConfigSchema = z.object(searchPlanConfigShape);

/** 创建计划请求：name + config。 */
export const CreateSearchPlanRequestSchema = z.object({
  name: trimmedString,
  ...searchPlanConfigShape,
});

/** 创建新版本请求：仅 config（新版本继承 name）。 */
export const CreateSearchPlanVersionRequestSchema = z.object(searchPlanConfigShape);

/** 路径参数 id。 */
export const IdParamsSchema = z.strictObject({ id: trimmedString });

export type SearchPlanConfigInput = z.infer<typeof SearchPlanConfigSchema>;
export type CreateSearchPlanRequestInput = z.infer<typeof CreateSearchPlanRequestSchema>;
export type CreateSearchPlanVersionRequestInput = z.infer<typeof CreateSearchPlanVersionRequestSchema>;
