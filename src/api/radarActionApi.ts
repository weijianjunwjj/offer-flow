/**
 * RC-10 雷达动作 API 客户端（收藏 / 忽略 / 标记优先 / 已投待反馈）。
 *
 * 与采集桥、评审 API 一致：所有请求携带自定义头，强制触发 CORS 预检并通过服务端安全网关。
 * 撤销只恢复 Radar 决策状态，绝不触碰正式 Job/Application/FeedbackEvent（服务端保证）。
 */
import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const captureHeaders = { [CAPTURE_CLIENT_HEADER]: 'offerflow-web' };
function withHeaders<T extends { headers?: Record<string, string> } | undefined>(
  options: T,
): T & { headers: Record<string, string> } {
  return { ...(options ?? {} as T), headers: { ...captureHeaders, ...options?.headers } };
}

export type ActionFamily = 'save' | 'ignore' | 'priority' | 'appliedPending';
export type ActionBarActionType =
  | 'saved' | 'unsaved'
  | 'ignored' | 'ignore_reverted'
  | 'marked_priority' | 'priority_reverted'
  | 'marked_applied_pending' | 'applied_pending_reverted';

export interface ActionStateView {
  saved: boolean;
  ignored: boolean;
  priority: boolean;
  appliedPending: boolean;
}

export interface ActionHistoryEntry {
  actionId: string;
  actionType: ActionBarActionType;
  family: ActionFamily;
  isSet: boolean;
  reason: string | null;
  candidateVersionId: string;
  occurredAt: number;
  reverted: boolean;
}

export interface CandidateActionView {
  candidateId: string;
  activeCandidateVersionId: string | null;
  state: ActionStateView;
  history: ActionHistoryEntry[];
}

export interface ActionResultView {
  changed: boolean;
  view: CandidateActionView;
}

export interface ActionApplyInput {
  candidateId: string;
  family: ActionFamily;
  reason?: string | null;
  /** 仅 appliedPending 生效。 */
  channel?: string | null;
  followUpDueAt?: number | null;
}

export interface ActionRevertInput {
  candidateId: string;
  family: ActionFamily;
  reason?: string | null;
}

const base = '/radar/actions';

export const radarActionApi = {
  getView(candidateId: string, options?: ReadOptions): Promise<CandidateActionView> {
    return apiGet(`${base}/candidates/${encodeURIComponent(candidateId)}`, withHeaders(options));
  },
  apply(input: ActionApplyInput, options?: SendOptions): Promise<ActionResultView> {
    return apiSend(`${base}/apply`, 'POST', input, withHeaders(options));
  },
  revert(input: ActionRevertInput, options?: SendOptions): Promise<ActionResultView> {
    return apiSend(`${base}/revert`, 'POST', input, withHeaders(options));
  },
};
