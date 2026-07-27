import { apiSend, type SendOptions } from './client';

/**
 * V8-6 正式晋升前端 API。对应后端 promotionRoutes：
 * - preview 只读、零写入，用于用户确认前看清"会发生什么"（Human-in-the-loop）；
 * - promote 才落库，且必须由用户显式确认后调用——本模块不提供任何自动晋升封装；
 * - 出参只承载安全视图：不含 idempotencyKey / targetScopeKey 等内部派生值；
 * - 与采集桥/评审/分析/推荐一致，请求带 x-offerflow-capture-client 头过安全网关。
 */
const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const captureHeaders = { [CAPTURE_CLIENT_HEADER]: 'offerflow-web' };
function withHeaders<T extends { headers?: Record<string, string> } | undefined>(
  options: T,
): T & { headers: Record<string, string> } {
  return { ...(options ?? {} as T), headers: { ...captureHeaders, ...options?.headers } };
}

/** 晋升触发原因。no_response 由后端直接拒绝，前端不提供该选项。 */
export type PromotionTrigger =
  | 'hr_replied' | 'contact_exchanged' | 'interview_scheduled' | 'explicit_rejection'
  | 'user_explicit_request' | 'user_priority' | 'no_response';

export type PromotionDepth = 'job_only' | 'application' | 'feedback';
export type PromotionObjectMode = 'link' | 'create' | 'none';

/** 计划安全视图：不含 idempotencyKey / targetScopeKey。 */
export interface PromotionPlanView {
  candidateId: string;
  candidateVersionId: string;
  trigger: string;
  requestedDepth: string;
  effectiveDepth: string;
  jobMode: PromotionObjectMode;
  applicationMode: PromotionObjectMode;
  feedbackMode: PromotionObjectMode;
  feedbackEventType: string | null;
  clampReasons: string[];
  existingPromotionId: string | null;
  linkedJobId: string | null;
  linkedApplicationId: string | null;
}

/** 晋升结果视图：正式对象 id 可安全展示，供用户回溯。 */
export interface PromotionView {
  id: string;
  candidateId: string;
  candidateVersionId: string;
  promotionType: string;
  jobId: string;
  applicationId: string | null;
  feedbackEventId: string | null;
  triggerActionId: string | null;
  createdAt: number;
}

export interface PromoteRequestBody {
  trigger: PromotionTrigger;
  requestedDepth: PromotionDepth;
  jobId?: string | null;
  applicationId?: string | null;
}

export interface PromoteResultView {
  promotion: PromotionView;
  plan: PromotionPlanView;
  created: boolean;
}

const base = '/radar';

export const radarPromotionApi = {
  /** 预览晋升计划：只读、零写入。与执行共用同一推导，所见即所得。 */
  preview(
    candidateVersionId: string, body: PromoteRequestBody, options?: SendOptions,
  ): Promise<{ plan: PromotionPlanView }> {
    return apiSend(
      `${base}/candidate-versions/${encodeURIComponent(candidateVersionId)}/promotions/preview`,
      'POST', body, withHeaders(options),
    );
  },

  /** 执行晋升（写库）。只应在用户显式确认后调用。 */
  promote(
    candidateVersionId: string, body: PromoteRequestBody, options?: SendOptions,
  ): Promise<PromoteResultView> {
    return apiSend(
      `${base}/candidate-versions/${encodeURIComponent(candidateVersionId)}/promotions`,
      'POST', body, withHeaders(options),
    );
  },
};
