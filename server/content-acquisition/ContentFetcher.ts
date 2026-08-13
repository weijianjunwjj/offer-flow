/**
 * v0.9 Phase 4C-1 — ContentFetcher 契约接口（薄接口，非编排 god-object）。
 *
 * 职责边界（本接口只负责「transport acquisition」的调用点，其余职责独立）：
 *   A. source policy / fetch eligibility → sourceEligibility.ts
 *   B. transport acquisition                → 本接口（Phase 4C-2 才实现真实 transport）
 *   C. bounded content extraction           → ExtractedContent DTO（见 types.ts）
 *   D. JD 完整性 / 证据验证                  → EvidenceValidationResult DTO（见 types.ts）
 *   E. evidence_upgrade 持久化               → 不在本层（后续显式落库）
 *
 * 本接口绝不：发起真实网络请求、解析 HTML、写 FULL_EVIDENCE、做 DB 持久化、
 * 调用 AnalysisService / RecommendationBatch / Pipeline / fetch queue / worker。
 */

import type { ContentFetchRequest, FetchResult } from './types';

export interface ContentFetcher {
  fetch(request: ContentFetchRequest): Promise<FetchResult>;
}
