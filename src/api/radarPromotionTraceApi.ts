import { apiGet, type ReadOptions } from './client';

/**
 * RC-11 反向追踪前端 API（只读）。对应后端 promotionTrace 路由：
 * - 正向：从 Promotion 追溯候选版本 / 触发原因 / 推荐批次；
 * - 反向：从 Job/Application/FeedbackEvent 反查引用它们的 Promotion；
 * - 只承载已存储关联，缺失即明确不可追溯状态，前端**如实透传**、不臆测；
 * - 与采集桥/评审/晋升一致，请求带 x-offerflow-capture-client 头过安全网关。
 */
const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const captureHeaders = { [CAPTURE_CLIENT_HEADER]: 'offerflow-web' };
function withHeaders(options?: ReadOptions): ReadOptions {
  return { ...(options ?? {}), headers: { ...captureHeaders, ...options?.headers } };
}

export type FormalObjectKind = 'job' | 'application' | 'feedback_event';

export type CandidateVersionTrace =
  | {
    status: 'resolved';
    candidateId: string; candidateVersionId: string; versionNo: number;
    contentHash: string; originType: string; sourceSnapshotIds: string[]; createdAt: number;
  }
  | { status: 'missing'; candidateVersionId: string };

export type TriggerTrace =
  | { status: 'not_recorded' }
  | {
    status: 'resolved';
    actionId: string; actionType: string; reasonCode: string | null; reasonText: string | null;
    occurredAt: number; reverted: boolean; revertedByActionId: string | null;
  }
  | { status: 'action_missing'; triggerActionId: string };

export interface BatchMembershipRef {
  batchId: string; batchKey: string; status: string; diagnosisStatus: string;
  emptyReason: string | null; generatedAt: number; wasSelected: boolean;
}
export type RecommendationBatchTrace =
  | { status: 'linked_by_scope_membership'; batches: BatchMembershipRef[] }
  | { status: 'no_batch' };

export interface PromotionOriginTrace {
  promotionId: string; promotionType: string; candidateId: string;
  jobId: string; applicationId: string | null; feedbackEventId: string | null; createdAt: number;
  candidateVersion: CandidateVersionTrace;
  trigger: TriggerTrace;
  recommendationBatches: RecommendationBatchTrace;
}

export type FormalObjectTrace =
  | { objectKind: FormalObjectKind; objectId: string; traceable: true; promotions: PromotionOriginTrace[] }
  | { objectKind: FormalObjectKind; objectId: string; traceable: false; reason: 'no_promotion' };

const base = '/radar';
const OBJECT_PATH: Record<FormalObjectKind, string> = {
  job: 'jobs', application: 'applications', feedback_event: 'feedback-events',
};

export const radarPromotionTraceApi = {
  /** 从晋升记录追溯来源；记录不存在时后端 404（apiGet 抛 ApiError）。 */
  traceByPromotion(promotionId: string, options?: ReadOptions): Promise<PromotionOriginTrace> {
    return apiGet(`${base}/promotions/${encodeURIComponent(promotionId)}/trace`, withHeaders(options));
  },

  /** 从正式对象反查来源；无引用晋升时返回 traceable=false（非错误）。 */
  traceByObject(kind: FormalObjectKind, objectId: string, options?: ReadOptions): Promise<FormalObjectTrace> {
    return apiGet(`${base}/${OBJECT_PATH[kind]}/${encodeURIComponent(objectId)}/promotion-trace`, withHeaders(options));
  },
};
