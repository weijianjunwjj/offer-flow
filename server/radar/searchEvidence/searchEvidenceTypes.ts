/**
 * v0.9 Phase 2 — Provider-neutral Search Evidence Item DTO.
 *
 * 设计依据：specs/001-daily-job-hunter/contracts/search-provider.md §SearchEvidenceItem
 *
 * 这是 Provider-neutral 的领域类型——不绑定 Tavily / Brave 等任何具体 Provider DTO。
 * Provider-specific mapping 在 Adapter boundary 完成，业务层只消费此类型。
 *
 * content 字段是 Provider Output（搜索摘要），不假定为完整 JD。
 * evidenceLevel 初始值 = SEARCH_EVIDENCE；Content Acquisition 成功或 Manual Capture 后才升级。
 */

import type { RadarEvidenceLevel } from '../../../src/domain/radar';

export interface SearchEvidenceItem {
  /** Search Provider 标识（如 'tavily'） */
  provider: string;
  /** 搜索查询词 */
  query: string;
  /** Provider request/trace ID（如有） */
  providerRequestId?: string;

  /** 结果标题 */
  title: string;
  /** 结果 URL */
  url: string;
  /** 搜索摘要/内容片段（Provider Output，非完整 JD） */
  content: string;
  /** 来源域名（从 url 解析） */
  domain: string;

  /** Provider 相关性评分（如有） */
  providerScore?: number;
  /** 发布时间（如有） */
  publishedAt?: string;

  /** 搜索时间戳 */
  searchedAt: number;

  /** Provider 特定元数据（必要最小） */
  providerMetadata?: Record<string, unknown>;
}

export interface SearchEvidenceIngestionInput {
  /** Search Evidence 条目 */
  item: SearchEvidenceItem;
  /** 目标证据等级（初始 SEARCH_EVIDENCE——Content Acquisition 前置） */
  evidenceLevel: RadarEvidenceLevel;
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}
