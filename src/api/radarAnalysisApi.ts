import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

/**
 * V8-4 单岗位分析前端 API。严格对应后端 analysisRoutes 的七个接口，只承载安全出参：
 * - 不暴露 inputSnapshot / inputHash / Prompt / JD 全文 / Provider 原文 / Token；
 * - 不在前端复制后端任务状态机（仅按 status 字符串渲染，转换权威在后端）；
 * - 与采集桥/评审一致，所有请求携带 x-offerflow-capture-client 头，过服务端安全网关。
 */
const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const captureHeaders = { [CAPTURE_CLIENT_HEADER]: 'offerflow-web' };
function withHeaders<T extends { headers?: Record<string, string> } | undefined>(
  options: T,
): T & { headers: Record<string, string> } {
  return { ...(options ?? {} as T), headers: { ...captureHeaders, ...options?.headers } };
}

export type AnalysisTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobMatchRecommendation = 'apply_now' | 'stretch' | 'verify' | 'skip';
export type JobMatchConfidence = 'low' | 'medium' | 'high';
export type AnalysisPointKind = 'fact' | 'inference' | 'user_preference' | 'rule_result' | 'unknown';
export type DimensionAssessment = 'strong' | 'moderate' | 'weak' | 'unknown';

/** 对外任务视图：白名单字段，绝不含 inputHash / inputSnapshot。 */
export interface AnalysisTaskView {
  id: string;
  taskType: string;
  entityType: string;
  entityId: string;
  status: AnalysisTaskStatus;
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

export interface AnalysisValidityView {
  status: 'current' | 'stale';
  staleReasons: string[];
}

/** 结论点：与后端 AnalysisPoint 契约同构（前端只读展示，不重复校验）。 */
export interface AnalysisPoint {
  statement: string;
  kind: AnalysisPointKind;
  evidenceKeys: string[];
  explanation: string;
  impact: 'positive' | 'negative' | 'mixed' | 'unknown';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'none';
  confidence: JobMatchConfidence;
}

/** 岗位事实：只含陈述 + kind + 证据引用（无 impact/severity）。 */
export interface JobFact {
  statement: string;
  kind: AnalysisPointKind;
  evidenceKeys: string[];
}

export interface MatchDimension {
  summary: string;
  assessment: DimensionAssessment;
  points: AnalysisPoint[];
}

/** 分析 payload（契约 v1）：四维 + 各证据分区 + 结论。 */
export interface JobMatchAnalysisPayloadV1 {
  contractVersion: number;
  jobFacts: JobFact[];
  dimensions: {
    roleFit: MatchDimension;
    capabilityFit: MatchDimension;
    businessAndCompanyFit: MatchDimension;
    cityAndSalaryFit: MatchDimension;
  };
  transferableEvidence: AnalysisPoint[];
  gaps: AnalysisPoint[];
  risks: AnalysisPoint[];
  counterEvidence: AnalysisPoint[];
  uncertainties: AnalysisPoint[];
  missingEvidence: string[];
  hardConstraints: AnalysisPoint[];
  recommendation: JobMatchRecommendation;
  confidence: JobMatchConfidence;
  summary: string;
  recruiterQuestions: string[];
  communicationAngles: string[];
}

/** 分析记录视图：服务端 Envelope 版本信息 + 结论 + 已校验 payload + 查询期有效性投影。 */
export interface JobMatchAnalysisView {
  id: string;
  candidateId: string;
  candidateVersionId: string;
  resumeVersionId: string;
  jobMatchProfileVersionId: string;
  cityCode: string | null;
  capabilityBaselineVersionId: string | null;
  marketPositionVersionId: string | null;
  strategyVersionId: string | null;
  ruleVersion: string;
  promptVersion: string;
  analysisPolicyVersion: string;
  modelProvider: string;
  modelName: string;
  modelVersion: string | null;
  inputHash: string;
  recommendation: JobMatchRecommendation;
  confidence: JobMatchConfidence;
  payload: JobMatchAnalysisPayloadV1;
  createdAt: number;
  supersedesAnalysisId: string | null;
  validity: AnalysisValidityView;
}

/** 候选分析历史条目（listCandidateAnalyses 每项即一条带 validity 的记录视图）。 */
export type CandidateAnalysisHistoryView = JobMatchAnalysisView;

const base = '/radar';

export const radarAnalysisApi = {
  createTask(candidateVersionId: string, options?: SendOptions): Promise<AnalysisTaskView> {
    return apiSend(`${base}/candidate-versions/${encodeURIComponent(candidateVersionId)}/analysis-tasks`, 'POST', undefined, withHeaders(options));
  },
  getTask(taskId: string, options?: ReadOptions): Promise<AnalysisTaskView> {
    return apiGet(`${base}/analysis-tasks/${encodeURIComponent(taskId)}`, withHeaders(options));
  },
  runTask(taskId: string, options?: SendOptions): Promise<AnalysisTaskView> {
    return apiSend(`${base}/analysis-tasks/${encodeURIComponent(taskId)}/run`, 'POST', undefined, withHeaders(options));
  },
  retryTask(taskId: string, options?: SendOptions): Promise<AnalysisTaskView> {
    return apiSend(`${base}/analysis-tasks/${encodeURIComponent(taskId)}/retry`, 'POST', undefined, withHeaders(options));
  },
  cancelTask(taskId: string, options?: SendOptions): Promise<AnalysisTaskView> {
    return apiSend(`${base}/analysis-tasks/${encodeURIComponent(taskId)}/cancel`, 'POST', undefined, withHeaders(options));
  },
  listCandidateAnalyses(candidateId: string, options?: ReadOptions): Promise<CandidateAnalysisHistoryView[]> {
    return apiGet(`${base}/candidates/${encodeURIComponent(candidateId)}/analyses`, withHeaders(options));
  },
  getAnalysis(analysisId: string, options?: ReadOptions): Promise<JobMatchAnalysisView> {
    return apiGet(`${base}/analyses/${encodeURIComponent(analysisId)}`, withHeaders(options));
  },
};
