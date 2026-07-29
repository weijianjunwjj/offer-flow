/**
 * V8-4 单岗位分析 HTTP 边界 · DTO 与安全出参视图。
 *
 * 只承载「路径参数校验」与「安全出参裁剪」两件事：
 * - Task View / Analysis View 均为白名单字段投影，绝不外泄 inputSnapshot / Prompt / JD /
 *   Provider 原文 / Token / Cookie / securityId；
 * - inputHash 是 sha256 指纹（无还原性），可出现在 Analysis Envelope，但**不出现在 Task View**。
 */
import type { AnalysisTask, JobMatchAnalysisRecord } from '../../../src/domain/radar';
import type { AnalysisStaleReason } from './validity';

/** 对外任务视图：严格白名单，剔除 inputHash / inputSnapshot 等内部字段。 */
export interface AnalysisTaskView {
  id: string;
  taskType: string;
  entityType: string;
  entityId: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  cancelledAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultRecordId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 任务领域错误消息为策展安全文案（不含快照/JD/Provider 原文），可原样透出。 */
export function toAnalysisTaskView(task: AnalysisTask): AnalysisTaskView {
  return {
    id: task.id,
    taskType: task.taskType,
    entityType: task.entityType,
    entityId: task.entityId,
    status: task.status,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    cancelledAt: task.cancelledAt,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    resultRecordId: task.resultRecordId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * 对外分析记录视图：服务端 Envelope 版本信息 + 结论 + 已校验安全 payload + 查询期有效性投影。
 * 记录本身不含 Prompt/JD/Provider 原文（payload 已过契约敏感扫描），故 Envelope 可整体透出。
 */
export interface AnalysisRecordView extends JobMatchAnalysisRecord {
  validity: { status: 'current' | 'stale'; staleReasons: AnalysisStaleReason[] };
}

/** 附加有效性投影；不新增/修改任何记录字段。 */
export function toAnalysisRecordView(
  record: JobMatchAnalysisRecord,
  validity: { status: 'current' | 'stale'; staleReasons: AnalysisStaleReason[] },
): AnalysisRecordView {
  return { ...record, validity };
}
