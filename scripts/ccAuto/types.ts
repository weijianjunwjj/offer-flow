/** cc-auto v0.1 共享类型定义。 */
// === v0.2.0 扩展：本文件同时为 v0.1 和 v0.2.0 提供共享类型。v0.2.0 新增字段不会破坏 v0.1 调用方。 ===

export type Phase =
  | 'INTAKE'
  | 'PREFLIGHT'
  | 'CLASSIFY'
  | 'SCOUT'
  | 'IMPLEMENT'
  | 'VERIFY'
  | 'REPAIR_1'
  | 'REPAIR_2'
  | 'ARBITRATE'
  | 'APPLY_DECISION'
  | 'FINAL_VERIFY'
  | 'DONE'
  | 'STOPPED';

export type TaskComplexity = 'simple' | 'normal' | 'complex';

export type ModelRole = 'scout' | 'builder' | 'arbiter';

export interface Classification {
  complexity: TaskComplexity;
  riskScore: number; // 0-10
  reasons: string[];
  touchesHighRisk: boolean;
}

/**
 * 单次模型调用的定价状态。
 * PRICED：实际模型 ID 命中第三方渠道价格表，costRmbCustom / costRmb 为具体金额。
 * UNPRICED：调用已经真实发生，但实际模型 ID 不在价格表中，无法定价——
 *   此时 costRmbCustom / costRmb 必须为 null（绝不写成 0），只保留 token、官方参考费用等可观测事实。
 */
export type PricingStatus = 'PRICED' | 'UNPRICED';

/**
 * 单次模型调用的用量与费用（RMB 为估算值，非账单）。
 * costRmb 恒等于 costRmbCustom（第三方渠道估算）：预算止损与历史累计只依据渠道费用，与 pricingMode 无关；
 * costRmbOfficial 是 CLI 返回的官方参考费用，只用于报告中并列展示、互相对照，不参与止损判断。
 * pricingStatus=UNPRICED 时 costRmbCustom / costRmb 为 null：该调用仍计入调用数、Token 与官方费用，
 * 但不计入已知渠道人民币合计（已知合计因此只是费用下限）。
 */
export interface CallUsage {
  model: ModelRole;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  costRmbOfficial: number;
  costRmbCustom: number | null;
  costRmb: number | null;
  durationMs: number;
  numTurns: number;
  pricingStatus: PricingStatus;
  /** CLI 返回的 subtype（success / error_max_turns / ...），原样保留 */
  subtype: string;
  /** CLI 返回的 is_error */
  isError: boolean;
  /** 工具调用次数统计（工具名 -> 次数），不存密钥/请求头/环境变量 */
  toolUseCounts?: Record<string, number>;
  /** 工具错误次数统计（工具名 -> 次数） */
  toolErrorCounts?: Record<string, number>;
  /** permission_denials 数量 */
  permissionDenialsCount: number;
  /** MCP server 名称列表（若有） */
  mcpServers?: string[];
  /** 最后一次 assistant 文本的受限摘要（最多 300 字符） */
  lastAssistantTextSummary?: string;
}

export interface FailureRecord {
  phase: Phase;
  fingerprint: string;
  summary: string;
  truncatedLog: string;
  createdAt: string;
}

export type StopReason =
  | 'BUDGET_TASK_EXCEEDED'
  | 'BUDGET_DAILY_EXCEEDED'
  | 'ARBITRATION_FAILED'
  | 'MAX_CHANGED_FILES_EXCEEDED'
  | 'REPEATED_FAILURE_FINGERPRINT'
  | 'ACCEPTANCE_CONFLICT'
  | 'HIGH_RISK_OPERATION_DETECTED'
  | 'FLAKY_TESTS'
  | 'MAX_TURNS_EXCEEDED'
  | 'STRUCTURED_OUTPUT_MISSING'
  | 'PROVIDER_ERROR'
  | 'PRICING_NOT_FOUND'
  | 'CLAUDE_BINARY_NOT_FOUND'
  | 'DIRECT_EDIT_PREPARE_FAILED'
  | 'DIRECT_EDIT_APPLY_FAILED'
  // v0.2.0 / v1.2 补全
  | 'REPAIR_CYCLES_EXHAUSTED'
  | 'USER_REJECTED_UNVERIFIED_MODEL'
  | 'USER_DECLINED_FILE_SCOPE_EXPANSION'
  // v0.2.0 Run Lease
  | 'RUN_LEASE_CONFLICT'
  | 'STALE_LEASE_REQUIRES_CONFIRM';

// ============================================================================
// v0.2.0 Dual Model Relay 新增类型（与 v0.1 共存）
// ============================================================================

/** v0.2.0 状态机阶段（区别于 v0.1 Phase） */
export type RunPhase =
  | 'INTAKE'
  | 'STRATEGY_GATE'
  | 'DS_WORK'
  | 'VERIFY'
  | 'HUMAN_GATE'
  | 'OPUS_REVIEW'
  | 'DS_APPLY'
  | 'FINAL_VERIFY'
  | 'DONE'
  | 'STOPPED';

export type LaunchStrategy = 'deepseek-first' | 'opus-plan-first';

export type WriterRole = 'none' | 'deepseek';

// === Provider 与模型身份 ===

export interface ModelIdentity {
  logicalName: string;
  requestedModelId: string;
  acceptedReportedModelIds: string[];
  displayName: string;
}

export interface ModelPricing {
  inputPerMTokens: number;
  outputPerMTokens: number;
  cacheCreationPerMTokens: number;
  cacheReadPerMTokens: number;
  currency: 'CNY';
  source: string;
  updatedAt: string;
}

export interface ProviderProfile {
  id: string;
  displayName: string;
  vendor: 'deepseek' | 'anthropic' | 'third-party';
  transport: 'openai-chat' | 'anthropic-messages' | 'claude-cli';
  apiBaseUrl?: string;
  credentialEnvVars: string[];
  runtimeEnvAllowlist: string[];
  staticEnv?: Record<string, string>;
  defaultModelId: string;
  models: ModelIdentity[];
  pricing: Record<string, ModelPricing>;
}

// === 命令白名单 ===

export interface VerificationCommand {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
}

export interface VerificationPlan {
  commandIds: string[];
  source: 'task-contract' | 'opus-verdict' | 'machine-default';
}

// === 文件范围 ===

export interface FileScope {
  allowedRoots: string[];
  protectedPaths: string[];
  proposedFiles: string[];
  approvedFiles: string[];
  maxChangedFiles: number;
}

// === Run Lease ===

export interface RunLease {
  runId: string;
  pid: number;
  repositoryRoot: string;
  acquiredAt: string;
  heartbeatAt: string;
  worktreeFingerprintAtStart: string;
  writer: WriterRole;
}

// === HUMAN_GATE ===

export type HumanGatePurpose =
  | 'PRE_IMPLEMENTATION_PLAN'
  | 'FAILURE_ARBITRATION'
  | 'MODEL_IDENTITY_CONFIRMATION';

export interface IdentityConfirmationContext {
  sourcePhase: 'DS_WORK' | 'OPUS_REVIEW';
  resumePhase: 'VERIFY' | 'DS_WORK' | 'DS_APPLY';
  pendingResultId: string;
}

export type VerificationOutcome = 'NOT_RUN' | 'PASSED' | 'FAILED' | 'FLAKY';

// === 预检 ===

export interface PreflightOk {
  ok: true;
  runId: string;
  phase: 'STRATEGY_GATE';
  runStatePath: string;
  worktreeFingerprint: string;
}

export interface PreflightFail {
  ok: false;
  stopReason: StopReason;
  message: string;
}

export type PreflightResult = PreflightOk | PreflightFail;

// === 配置加载结果 ===

export interface ProviderConfigLoadResult {
  ok: boolean;
  profiles?: Record<string, ProviderProfile>;
  error?: string;
  /** ok=false 时区分错误类别 */
  reason?: 'FILE_NOT_FOUND' | 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'PRICING_NOT_FOUND';
}
