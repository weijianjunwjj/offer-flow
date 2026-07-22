import type { BatchSubmitItem } from './batchPayload';

/** 页面注入脚本 → background 的批量提交消息契约。 */
export const BATCH_SUBMIT_MESSAGE = 'offerflow_batch_submit';

export interface BatchSubmitMessage {
  type: typeof BATCH_SUBMIT_MESSAGE;
  items: BatchSubmitItem[];
}

export interface BatchSubmitResponse {
  ok: boolean;
  sessionId?: string;
  previewUrl?: string;
  submittedCount?: number;
  failedToSubmitCount?: number;
  error?: string;
  code?: 'OFFERFLOW_NOT_RUNNING' | 'NO_ITEMS' | 'SUBMIT_ERROR';
}

export function isBatchSubmitMessage(message: unknown): message is BatchSubmitMessage {
  return message !== null && typeof message === 'object'
    && (message as { type?: unknown }).type === BATCH_SUBMIT_MESSAGE
    && Array.isArray((message as { items?: unknown }).items);
}
