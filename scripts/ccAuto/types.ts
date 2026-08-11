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
  /** v0.2.0 Slice 1F-RUN H2: 审计元数据——Provider dispatch 的唯一标识，贯穿 PendingCall→UsageRecord→CallUsage→attemptHistory */
  callId: string;
  model: ModelRole;
  modelId: string;
  /** v0.2.0 Slice 1F-RUN P2: routed execution role（FAST_EXECUTOR | STRONG_EXECUTOR | ARBITER），legacy 调用为 null */
  executionRole?: ExecutionModelRole | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
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
  | 'STALE_LEASE_REQUIRES_CONFIRM'
  // v0.2.0 Slice 1B: Provider 执行契约
  | 'MODEL_IDENTITY_MISMATCH'
  | 'COST_UNAVAILABLE'
  | 'TRANSPORT_NOT_IMPLEMENTED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_AUTH_ERROR'
  // v0.2.0 P9: Windows state persistence EPERM
  | 'STATE_PERSISTENCE_FAILED';

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

// ============================================================================
// v0.2.0 Slice 1B: Provider 执行契约类型
// ============================================================================

/** Adapter 执行上下文——隔离的运行环境，不包含 parentEnv 引用 */
export interface ProviderExecutionContext {
  childEnv: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** 当前执行对应的 ProviderProfile——Adapter 不持有 Profile，由 executor 传入 */
  profile: ProviderProfile;
}

/** 标准化调用请求——向后兼容扩展 */
export interface ProviderCallRequest {
  callId: string;
  providerId: string;
  requestedModelId: string;
  role: 'builder' | 'arbiter';
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** v0.2.0 Slice 1E：多轮对话历史。存在时优先使用，systemPrompt/userPrompt 必须为空 */
  messages?: ProviderChatMessage[];
  /** v0.2.0 Slice 1E：工具定义 */
  tools?: ProviderToolDefinition[];
  /** v0.2.0 Slice 1E：工具模式。默认 'disabled'（向后兼容） */
  toolMode?: ProviderToolMode;
}

/** Provider 返回的原始用量——所有字段均可为 null */
export interface RawProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

/** Provider 返回的错误结构 */
export interface ProviderResponseError {
  kind: 'AUTH' | 'RATE_LIMIT' | 'HTTP' | 'UNSUPPORTED';
  httpStatus: number | null;
  code: string | null;
  type: string | null;
  message: string;
}

/** Provider Adapter 返回的标准化响应 */
export interface ProviderCallResponse {
  callId: string;
  providerId: string;
  requestedModelId: string;
  reportedModel: string | null;
  content: string | null;
  usage: RawProviderUsage;
  durationMs: number | null;
  numTurns: number;
  subtype: string;
  isError: boolean;
  /** 结构化错误信息，isError=true 时填充；成功时为 null */
  error: ProviderResponseError | null;
  /** v0.2.0 Slice 1E：Adapter 解析的 tool_calls（tool_mode=enabled 时） */
  toolCalls?: ModelToolCall[];
  /** v0.2.0 Slice 1E-W：DeepSeek reasoning_content（模型思考链） */
  reasoningContent?: string | null;
}

/** Adapter Profile 预校验结果 */
export interface AdapterProfileValidationResult {
  ok: boolean;
  message?: string;
}

/** Provider Adapter 接口——根据 transport 选择实现，不根据 vendor 选择 */
export interface ProviderAdapter {
  readonly transport: ProviderProfile['transport'];

  /**
   * Profile 预校验（可选）——在创建 PendingCall 前执行。
   * 校验失败的 Profile 不创建 PREPARED、不创建 DISPATCHED、不调用 fetch。
   * 未实现此方法的 Adapter 默认视为通过。
   */
  validateProfile?(
    profile: ProviderProfile,
  ): AdapterProfileValidationResult;

  execute(
    request: ProviderCallRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderCallResponse>;
}

/** Mock 场景枚举 */
export type MockProviderScenario =
  | 'VERIFIED_SUCCESS'
  | 'MISMATCH_MODEL'
  | 'UNVERIFIED_MODEL'
  | 'USAGE_MISSING'
  | 'USAGE_PARTIAL'
  | 'UNPRICED_REPORTED_MODEL'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT';

/** 模型身份判定三态 */
export type ModelIdentityStatus =
  | 'VERIFIED'
  | 'MISMATCH'
  | 'UNVERIFIED';

/** Usage 完整性状态 */
export type UsageStatus =
  | 'AVAILABLE'
  | 'MISSING'
  | 'PARTIAL';

/** 费用可算性状态 */
export type CostStatus =
  | 'AVAILABLE'
  | 'UNAVAILABLE';

/** PendingCall 状态 */
export type PendingCallStatus =
  | 'PREPARED'
  | 'DISPATCHED'
  | 'COMPLETED'
  | 'UNKNOWN_AFTER_CRASH';

/** 待处理的模型调用记录（持久化在 RunState 中，不持久化完整请求/响应 body） */
export interface PendingCall {
  callId: string;
  providerId: string;
  requestedModelId: string;
  role: 'builder' | 'arbiter';
  status: PendingCallStatus;
  createdAt: string;
  updatedAt: string;
}

/** 标准化的 UsageRecord */
export interface UsageRecord {
  model: 'builder' | 'arbiter';
  requestedModelId: string;
  reportedModel: string | null;
  providerId: string;

  modelIdentityStatus: ModelIdentityStatus;
  pricingStatus: 'PRICED' | 'UNPRICED';
  usageStatus: UsageStatus;
  costStatus: CostStatus;

  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;

  costRmbCustom: number | null;
  costRmbOfficial: number | null;

  durationMs: number | null;
  numTurns: number;
  subtype: string;
  isError: boolean;

  toolUseCounts: Record<string, number> | null;
  toolErrorCounts: Record<string, number> | null;
  permissionDenialsCount: number;

  /** v0.2.0 Slice 1F-RUN P2: routed execution role，legacy 调用为 null */
  executionRole?: ExecutionModelRole | null;
}

/** Provider 失败诊断——安全结构化摘要，不含密钥/完整请求体/响应体/文件正文/工具结果正文。
 *
 * 仅保存脱敏后的 error class、message、errorKind、httpStatus、网络错误码等可观测字段，
 * 使 stopDetail 不再退化为无诊断价值的 "PROVIDER_ERROR"。 */
export interface ProviderFailureDetail {
  /** 异常类名——用于区分 TimeoutError / TransportError / Error 等 */
  errorClass: string;
  /** 脱敏后的安全消息 */
  safeMessage: string;
  /** 错误类别 */
  errorKind: ProviderResponseError['kind'] | 'TRANSPORT' | 'TIMEOUT' | 'UNKNOWN';
  /** HTTP 状态码（若存在） */
  httpStatus: number | null;
  /** Node/undici 网络错误码（ECONNRESET / ETIMEDOUT / UND_ERR_SOCKET 等） */
  networkErrorCode: string | null;
  /** 底层 error 的 cause name（若存在且安全） */
  causeName: string | null;
  /** 调用时的 timeoutMs 配置 */
  timeoutMs: number;
  /** 请求的 Provider ID */
  providerId: string;
  /** 请求的模型 ID */
  requestedModelId: string;
  /** 关联的 callId */
  callId: string;
}

/** Provider 执行失败原因（非 stopReason 的领域枚举） */
export type ProviderExecutionStopReason =
  | 'PRICING_NOT_FOUND'
  | 'MODEL_IDENTITY_MISMATCH'
  | 'COST_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_AUTH_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'TRANSPORT_NOT_IMPLEMENTED'
  | 'UNKNOWN_AFTER_CRASH';

/** Provider 执行结果——可辨识联合 */
export type ProviderExecutionResult =
  | {
      ok: true;
      usageRecord: UsageRecord;
      content: string | null;
      /** v0.2.0 Slice 1E：assistant 返回的 tool_calls（由 Adapter 解析） */
      toolCalls?: ModelToolCall[];
      /** v0.2.0 Slice 1E-W：DeepSeek reasoning_content 保真传递 */
      reasoningContent?: string | null;
    }
  | {
      ok: false;
      stopReason: ProviderExecutionStopReason | null;
      requiresHumanConfirmation: boolean;
      usageRecord: UsageRecord | null;
      identityConfirmationContext: IdentityConfirmationContext | null;
      message: string;
      /** 1E-W：用于 Tool Loop 瞬时重试决策的 Provider 错误分类 */
      errorKind?: ProviderResponseError['kind'];
      /** 1E-W：原始 HTTP 状态码，用于判断 429/5xx */
      httpStatus?: number | null;
      /** 1E-W：TransportError 标记为瞬时传输失败（ECONNRESET 等） */
      transientTransportError?: boolean;
      /** v0.8.x 诊断修复：安全结构化失败摘要 */
      failureDetail?: ProviderFailureDetail;
    };

// ============================================================================
// v0.2.0 Slice 1E: 工具协议与受控 Tool Loop 类型
// ============================================================================

export type DeepSeekToolName = 'read_file' | 'grep' | 'glob' | 'write_file' | 'edit_file';

/** 模型返回的原始工具调用结构 */
export interface ModelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** read_file 参数 */
export interface ReadFileArguments {
  path: string;
  startLine?: number;
  endLine?: number;
}

/** grep 参数 */
export interface GrepArguments {
  query: string;
  roots?: string[];
  caseSensitive?: boolean;
  maxResults?: number;
}

/** glob 参数 */
export interface GlobArguments {
  pattern: string;
  roots?: string[];
  maxResults?: number;
}

/** write_file 参数——模型可指定 path + content；repositoryRoot/runId/writer/FileScope 由 Dispatcher 注入 */
export interface WriteFileArguments {
  path: string;
  content: string;
}

/** edit_file 参数——复用 Safe Edit API 的 oldText/newText 语义 */
export interface EditFileArguments {
  path: string;
  oldText: string;
  newText: string;
}

/** 解析后的工具调用——可辨识联合（含写入工具） */
export type ParsedToolCall =
  | {
      id: string;
      name: 'read_file';
      arguments: ReadFileArguments;
    }
  | {
      id: string;
      name: 'grep';
      arguments: GrepArguments;
    }
  | {
      id: string;
      name: 'glob';
      arguments: GlobArguments;
    }
  | {
      id: string;
      name: 'write_file';
      arguments: WriteFileArguments;
    }
  | {
      id: string;
      name: 'edit_file';
      arguments: EditFileArguments;
    };

/** 工具协议解析错误原因 */
export type ToolProtocolErrorReason =
  | 'INVALID_TOOL_CALL'
  | 'TOOL_CALL_ID_MISSING'
  | 'DUPLICATE_TOOL_CALL_ID'
  | 'UNKNOWN_TOOL'
  | 'ARGUMENTS_TOO_LARGE'
  | 'ARGUMENTS_INVALID_JSON'
  | 'ARGUMENTS_NOT_OBJECT'
  | 'ARGUMENT_FIELD_UNKNOWN'
  | 'ARGUMENT_FIELD_MISSING'
  | 'ARGUMENT_TYPE_INVALID'
  | 'ARGUMENT_VALUE_INVALID'
  | 'CONTENT_TOO_LARGE'
  | 'OLD_TEXT_TOO_LARGE'
  | 'NEW_TEXT_TOO_LARGE';

/** 工具执行错误原因 */
export type ToolExecutionErrorReason =
  | ToolProtocolErrorReason
  | 'BINARY_FILE'
  | 'DISPATCH_REENTRY'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'FILE_NOT_UTF8'
  | 'FILE_NOT_REGULAR_FILE'
  | 'DIRECTORY_NOT_ALLOWED'
  | 'SYMLINK_DETECTED'
  | 'JUNCTION_DETECTED'
  | 'PATH_OUTSIDE_ROOTS'
  | 'SYSTEM_PROTECTED_PATH'
  | 'PROTECTED_PATH'
  | 'READ_PERMISSION_DENIED'
  | 'READ_BUDGET_EXCEEDED'
  | 'MAX_OUTPUT_EXCEEDED'
  | 'SCAN_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR'
  | 'IO_ERROR'
  | 'UNKNOWN_TOOL'
  | 'WRITE_PERMISSION_DENIED'
  | 'FILE_NOT_APPROVED'
  | 'WRITER_NOT_DEEPSEEK'
  | 'EDIT_TARGET_NOT_FOUND'
  | 'EDIT_TARGET_NOT_UNIQUE'
  | 'OLD_TEXT_EMPTY'
  | 'MAX_CHANGED_FILES_EXCEEDED'
  | 'TARGET_RACE_DETECTED'
  | 'FILE_IDENTITY_UNVERIFIABLE'
  | 'WRITE_STORAGE_ERROR'
  | 'WRITE_IO_ERROR'
  | 'WRITE_FAILED_AFTER_TRUNCATE'
  | 'SCOPE_CONFIG_ERROR';

export type ToolExecutionResult =
  | { kind: 'read_file'; content: string; lineCount: number; byteCount: number; startLine: number; endLine: number }
  | { kind: 'grep'; matches: GrepMatch[]; scannedFiles: number; bytesRead: number }
  | { kind: 'glob'; paths: string[]; scannedEntries: number }
  | { kind: 'write_file'; path: string; action: 'created' | 'updated'; bytesWritten: number }
  | { kind: 'edit_file'; path: string; replacements: 1; bytesBefore: number; bytesAfter: number };

/** 工具执行信封——失败绝不能携带 result，成功绝不能携带 error。 */
export type ToolExecutionEnvelope =
  | {
      ok: true;
      toolCallId: string;
      toolName: DeepSeekToolName;
      result: ToolExecutionResult;
      error: null;
      truncated: boolean;
    }
  | {
      ok: false;
      toolCallId: string;
      toolName: DeepSeekToolName | 'unknown';
      result: null;
      error: { reason: ToolExecutionErrorReason; message: string };
      truncated: false;
    };

/** Provider 工具定义（OpenAI tools 数组项） */
export interface ProviderToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      additionalProperties: false;
      required?: string[];
      properties: Record<string, unknown>;
    };
  };
}

/** Provider 工具模式 */
export type ProviderToolMode = 'disabled' | 'enabled';

/** DeepSeek Tool Loop 执行模式：控制暴露给模型的工具集 */
export type DeepSeekToolMode = 'READ_ONLY' | 'WRITE_CAPABLE';

/** Provider assistant 轮次——Adapter 解析后的结构化结果 */
/** Provider 聊天消息——角色专属字段由判别联合约束。 */
export type ProviderChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ModelToolCall[]; reasoningContent?: string | null }
  | { role: 'tool'; content: string; toolCallId: string };

/** Tool Loop 终止原因——完整枚举（1E-W 冻结版） */
export type ToolLoopTerminationReason =
  | 'FINAL_RESPONSE'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_PROTOCOL_FAILED'
  | 'MAX_TURNS_EXCEEDED'
  | 'MAX_TOOL_CALLS_EXCEEDED'
  | 'HISTORY_LIMIT_EXCEEDED'
  | 'TOOL_RESULT_LIMIT_EXCEEDED'
  | 'TURN_TIMEOUT'
  | 'TOTAL_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_RETRY_EXHAUSTED'
  | 'REPEATED_TOOL_ERROR'
  | 'MODEL_IDENTITY_MISMATCH'
  | 'MODEL_IDENTITY_UNVERIFIED'
  | 'UNKNOWN_AFTER_CRASH'
  | 'CANCELLED';

/** Tool Loop 停止原因（旧式——在 Tool Loop 内部使用） */
export type DeepSeekToolLoopStopReason =
  | 'MAX_TURNS_EXCEEDED'
  | 'MAX_TOOL_CALLS_PER_TURN_EXCEEDED'
  | 'MAX_TOTAL_TOOL_CALLS_EXCEEDED'
  | 'DUPLICATE_TOOL_CALL_ID'
  | 'REPEATED_TOOL_CALL'
  | 'TOOL_PROTOCOL_ERROR'
  | 'TOOL_EXECUTION_FAILED'
  | 'PROVIDER_ERROR'
  | 'MODEL_IDENTITY_MISMATCH'
  | 'MODEL_IDENTITY_UNVERIFIED'
  | 'CONTEXT_LIMIT_EXCEEDED'
  | 'LIMIT_CONFIGURATION_INVALID'
  | 'EMPTY_FINAL_RESPONSE'
  | 'TOTAL_TIMEOUT'
  | 'TURN_TIMEOUT'
  | 'PROVIDER_RETRY_EXHAUSTED'
  | 'UNKNOWN_AFTER_CRASH'
  | 'CANCELLED';

/** Tool Loop 执行选项 */
export interface DeepSeekToolLoopOptions {
  repositoryRoot: string;
  cwd: string;
  runId: string;
  fileScope: FileScope;
  /** Executor 上下文：profile + adapterRegistry + parentEnv + callIdFactory */
  executorContext: DeepSeekToolLoopExecutorContext;
  systemPrompt: string;
  userPrompt: string;
  maxTurns?: number;
  maxToolCallsPerTurn?: number;
  maxTotalToolCalls?: number;
  maxHistoryChars?: number;
  maxToolResultChars?: number;
  maxTotalReadBytes?: number;
  maxWriteContentBytes?: number;
  maxEditContentBytes?: number;
  /** 总超时（ms），默认 300000（5 分钟）；超出后返回 TOTAL_TIMEOUT */
  totalTimeoutMs?: number;
  /** 1E-W：瞬时 Provider 错误最大重试次数，默认 2（最多 3 次真实 attempt） */
  maxTransientRetries?: number;
  /** 1E-W：退避定时器（测试可注入 fake sleeper） */
  sleep?: (ms: number) => Promise<void>;
  /** 1F-RUN：工具定义数组。默认 DEEPSEEK_FILE_TOOL_DEFINITIONS（全部 5 工具）。传入 DEEPSEEK_READ_ONLY_TOOL_DEFINITIONS 实现协议层只读。 */
  toolDefinitions?: ProviderToolDefinition[];
}

export interface ProviderAdapterResolver {
  resolve(transport: string): ProviderAdapter | null;
}

/** Tool Loop 所需的 Executor 上下文——传递给 executeProviderCall */
export interface DeepSeekToolLoopExecutorContext {
  profile: ProviderProfile;
  logicalModelName: string;
  role: 'builder' | 'arbiter';
  maxOutputTokens: number;
  timeoutMs: number;
  adapterRegistry: ProviderAdapterResolver;
  parentEnv: NodeJS.ProcessEnv;
  callIdFactory?: () => string;
  /** v0.2.0 Slice 1F-RUN P2: routed execution role for cost attribution (null = legacy) */
  executionRole?: ExecutionModelRole | null;
}

export type ToolLoopAuditStatus =
  | 'EXECUTED'
  | 'REJECTED_LIMIT'
  | 'REJECTED_PROTOCOL'
  | 'REJECTED_REPEAT'
  | 'SKIPPED_AFTER_FAILURE';

export interface ToolLoopAuditRecord {
  turn: number;
  toolCallId: string;
  toolName: string;
  status: ToolLoopAuditStatus;
  resultOk: boolean | null;
  errorReason: ToolExecutionErrorReason | ToolProtocolErrorReason | null;
}

/** Tool Loop 执行结果 */
export interface DeepSeekToolLoopResult {
  status: 'COMPLETED' | 'STOPPED';
  finalText: string | null;
  turns: number;
  totalToolCalls: number;
  executedTools: ToolExecutionEnvelope[];
  stopReason: DeepSeekToolLoopStopReason | null;
  /** 本轮收集的所有调用 ID（由 Executor 生成，不自己构造） */
  callIds: string[];
  auditTrail: ToolLoopAuditRecord[];
  /** v0.2.0 Slice 1E-W：结构化摘要 */
  summary: DeepSeekToolLoopSummary;
  /** v0.8.x 诊断修复：Provider 失败诊断（若因 Provider 异常终止） */
  failureDetail?: ProviderFailureDetail | null;
}

/** Tool Loop 执行摘要——完成或失败后必然产生 */
export interface DeepSeekToolLoopSummary {
  turns: number;
  toolCallCount: number;

  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;

  durationMs: number;

  terminationReason: ToolLoopTerminationReason;

  provider: string | null;
  profileId: string | null;

  requestedModelId: string | null;
  resolvedModelId: string | null;

  modelIdentity:
    | 'VERIFIED'
    | 'UNVERIFIED'
    | 'MISMATCH'
    | 'UNKNOWN';

  callIds: string[];
  changedFiles: string[];

  verifierResult?: {
    passed: boolean;
    command?: string;
    reason?: string;
  };
}

/** Grep 单条匹配结果 */
export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

/** Glob 操作结果 */
export interface GlobResult {
  paths: string[];
  truncated: boolean;
  scannedEntries: number;
}

// ============================================================================
// v0.2.0 Slice 1F: 三级模型路由、预算估算与成本复盘类型
// ============================================================================

/** 执行模型角色——固定映射，不随配置改变语义 */
export type ExecutionModelRole =
  | 'FAST_EXECUTOR'
  | 'STRONG_EXECUTOR'
  | 'ARBITER';

/** 路由任务类型——确定性分类，不调用 LLM */
export type RoutingTaskType =
  | 'REPOSITORY_READ'
  | 'CODE_IMPLEMENTATION'
  | 'BUG_FIX'
  | 'TEST_REPAIR'
  | 'REFACTOR'
  | 'ARCHITECTURE'
  | 'FINAL_REVIEW'
  | 'DOCUMENTATION';

/** 模型路由上下文——调用方显式提供结构化风险字段 */
export interface ModelRoutingContext {
  taskType: RoutingTaskType;
  affectedFileCount: number;
  specificationClear: boolean;
  touchesArchitecture: boolean;
  touchesSecurityBoundary: boolean;
  touchesProviderLifecycle: boolean;
  touchesPendingCallOrUsage: boolean;
  touchesDatabaseSchema: boolean;
  touchesTransactionOrConcurrency: boolean;
  touchesStateMachine: boolean;
  previousAttemptCount: number;
  previousModelRole?: ExecutionModelRole;
  previousFailure?: ModelAttemptFailure;
  requestedRole?: ExecutionModelRole;
  allowEscalation: boolean;
}

/** 单次模型尝试的失败信息 */
export interface ModelAttemptFailure {
  category: ModelAttemptFailureCategory;
  summary: string;
  contributedToFinalResult: boolean;
}

/** 模型尝试失败类别 */
export type ModelAttemptFailureCategory =
  | 'MODEL_QUALITY_FAILURE'
  | 'MODEL_PROTOCOL_FAILURE'
  | 'MODEL_IDENTITY_FAILURE'
  | 'TRANSPORT_FAILURE'
  | 'CREDENTIAL_FAILURE'
  | 'BALANCE_FAILURE'
  | 'CONTEXT_LIMIT'
  | 'LOCAL_TOOL_FAILURE'
  | 'FILE_SCOPE_FAILURE'
  | 'VERIFIER_FAILURE'
  | 'USER_CANCELLED'
  | 'UNKNOWN';

/** 模型选择来源 */
export type ModelSelectionSource = 'POLICY' | 'USER_OVERRIDE' | 'ESCALATION';

/** 模型路由原因码 */
export type ModelRoutingReasonCode =
  | 'DEFAULT_FLASH'
  | 'MULTI_FILE_CHANGE'
  | 'AMBIGUOUS_SPEC'
  | 'ARCHITECTURE_TASK'
  | 'SECURITY_BOUNDARY'
  | 'PROVIDER_LIFECYCLE'
  | 'PENDING_CALL_OR_USAGE'
  | 'DATABASE_SCHEMA'
  | 'TRANSACTION_OR_CONCURRENCY'
  | 'STATE_MACHINE'
  | 'FINAL_REVIEW'
  | 'USER_OVERRIDE'
  | 'FLASH_QUALITY_FAILURE'
  | 'PRO_QUALITY_FAILURE'
  | 'OPUS_ARBITRATION'
  | 'ESCALATION_DISABLED'
  | 'USER_FAST_OVERRIDE_REJECTED';

/** 模型选择结果——每次调用前生成 */
export interface ModelSelection {
  role: ExecutionModelRole;
  provider: string;
  profileId: string;
  modelLogicalName: string;
  source: ModelSelectionSource;
  reasonCodes: ModelRoutingReasonCode[];
  policyVersion: 'cc-auto-model-routing-v1';
  escalatedFromCallId?: string;
}

/** 上下文预算——限制输入 Token，不依赖模型价格 */
export interface ModelContextBudget {
  maxInputCharacters: number;
  maxHistoryMessages: number;
  maxEvidenceCharacters: number;
}

/** 模型路由配置 */
export interface ModelRoutingConfig {
  enabled: boolean;
  fastModel: {
    provider: string;
    profileId: string;
    modelLogicalName: string;
  };
  strongModel: {
    provider: string;
    profileId: string;
    modelLogicalName: string;
  };
  arbiterModel?: {
    provider: string;
    profileId: string;
    modelLogicalName: string;
  };
  allowStrongEscalation: boolean;
  allowArbiterEscalation: boolean;
}

/** 路由决策记录——独立于 UsageRecord */
export interface RoutingDecisionRecord {
  decisionId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  role: ExecutionModelRole;
  provider: string;
  profileId: string;
  modelLogicalName: string;
  source: ModelSelectionSource;
  reasonCodes: ModelRoutingReasonCode[];
  policyVersion: string;
  escalatedFromCallId?: string;
  createdAt: string;
}

/** 裁决决策——Opus 输出的纠偏计划 */
export interface ArbitrationDecision {
  diagnosis: string;
  selectedPlan: string;
  rejectedPlans: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  nextExecutorRole: 'FAST_EXECUTOR' | 'STRONG_EXECUTOR' | 'HUMAN_REQUIRED';
  reasonCodes: ModelRoutingReasonCode[];
}

/** 裁决胶囊——Opus 的压缩输入，不含完整历史 */
export interface ArbitrationCapsule {
  taskGoal: string;
  hardConstraints: string[];
  attemptedModels: Array<{
    role: ExecutionModelRole;
    modelLogicalName: string;
    outcome: string;
    failureCategory: ModelAttemptFailureCategory;
  }>;
  changedFiles: string[];
  verifierFailures: string[];
  relevantDiff: string;
  unresolvedQuestions: string[];
}

/** 路由执行状态 */
export type RoutedExecutionStatus =
  | 'COMPLETED'
  | 'FAILED'
  | 'OPUS_ARBITRATION_REQUIRED'
  | 'HUMAN_REQUIRED'
  | 'BUDGET_CONFIRMATION_REQUIRED'
  | 'BUDGET_LIMIT_EXCEEDED';

/** 路由执行结果——最终状态汇总 */
export interface RoutedExecutionResult {
  status: RoutedExecutionStatus;
  finalRole: ExecutionModelRole;
  selections: ModelSelection[];
  callIds: string[];
  arbitrationCapsule?: ArbitrationCapsule;
  arbitrationDecision?: ArbitrationDecision;
  failureCategory?: ModelAttemptFailureCategory;
  /** 仅当 cost summary reporter 失败时设置；Provider 调用不重复 */
  reporterError?: 'REPORTER_OUTPUT_FAILED_BEFORE_EXECUTION' | 'REPORTER_OUTPUT_FAILED_AFTER_EXECUTION';
}

// === 预算与成本类型 ===

/** 预算模式 */
export type BudgetMode = 'ECONOMY' | 'BALANCED' | 'QUALITY';

/** 任务预算上限策略 */
export interface TaskBudgetPolicy {
  mode: BudgetMode;
  softLimitRmb?: number;
  hardLimitRmb?: number;
  requireConfirmationAboveSoftLimit: boolean;
  stopBeforeHardLimit: boolean;
}

/** 单模型预估调用 */
export interface EstimatedCall {
  role: ExecutionModelRole;
  provider: string;
  modelLogicalName: string;
  minCalls: number;
  expectedCalls: number;
  maxCalls: number;
  estimatedInputTokens: { min: number; expected: number; max: number };
  estimatedOutputTokens: { min: number; expected: number; max: number };
  estimatedCostRmb: { min: number | null; expected: number | null; max: number | null };
  /** 若任一 cost 字段为 null，记录精确原因（例如 "pricingByModel 缺少 deepseek-v4-pro"） */
  costNullReason?: string | null;
}

/** 任务预算估算——执行前生成 */
export interface TaskBudgetEstimate {
  estimateId: string;
  runId: string;
  taskId: string;
  routingPolicyVersion: string;
  initialSelection: ModelSelection;
  currency: 'CNY';
  estimatedCalls: EstimatedCall[];
  totalEstimatedCostRmb: { min: number | null; expected: number | null; max: number | null };
  /** 若 totalEstimatedCostRmb.max 为 null，记录精确原因（不得留裸 null） */
  maxNullReason?: string | null;
  assumptions: string[];
  createdAt: string;
}

/** 运行中成本快照——每次调用后累计 */
export interface RunningCostSnapshot {
  runId: string;
  taskId: string;
  completedCallCount: number;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  actualCachedTokens: number | null;
  actualCostRmb: number | null;
  expectedBudgetUsedRatio: number | null;
  maximumBudgetUsedRatio: number | null;
  costByRole: Partial<Record<ExecutionModelRole, {
    calls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    costRmb: number | null;
  }>>;
  updatedAt: string;
}

/** 按模型角色的成本明细 */
export interface CostByRoleEntry {
  role: ExecutionModelRole;
  provider: string;
  modelLogicalName: string;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  costRmb: number | null;
  tokenShare: number | null;
  costShare: number | null;
}

/** 预算与实际对比 */
export interface EstimateComparison {
  actualVsExpectedRatio: number | null;
  actualVsMaximumRatio: number | null;
  absoluteVarianceRmb: number | null;
  variancePercent: number | null;
}

/** 路由节省效果 */
export interface RoutingEffect {
  flashCallShare: number | null;
  proCallShare: number | null;
  opusCallShare: number | null;
  flashCostShare: number | null;
  proCostShare: number | null;
  opusCostShare: number | null;
  escalationCount: number;
  escalationCostRmb: number | null;
  hypotheticalAllProCostRmb: number | null;
  savedVsAllProRmb: number | null;
  savedVsAllProPercent: number | null;
}

/** 任务成本总结——执行后生成 */
export interface TaskCostSummary {
  runId: string;
  taskId: string;
  currency: 'CNY';
  estimate: TaskBudgetEstimate;
  actual: {
    totalCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    totalTokens: number | null;
    costRmb: number | null;
  };
  byRole: CostByRoleEntry[];
  estimateComparison: EstimateComparison;
  routingEffect: RoutingEffect;
  completed: boolean;
  generatedAt: string;
}

/** 路由执行报告器——供 CLI/测试注入，控制预算和成本复盘可见性 */
export interface RoutedExecutionReporter {
  onBudgetEstimate(estimate: TaskBudgetEstimate, formatted: string): Promise<void> | void;
  onRunningCost?(snapshot: RunningCostSnapshot, formatted: string): Promise<void> | void;
  onCostSummary(summary: TaskCostSummary, formatted: string): Promise<void> | void;
  /** v0.2.0 P8: Routed Tool Loop observation — called after each routed attempt.
   *  Replaces Claude CLI metadata for routedExecution runs. */
  onToolLoopObservation?(observation: RoutedToolLoopObservation): Promise<void> | void;
}

// ============================================================================
// v0.2.0 P8: Routed Tool Loop Observability
// ============================================================================

/** 单条脱敏工具调用审计记录——从 ToolLoopAuditRecord 派生。
 *  禁止保存：文件正文、完整 prompt、tool result 正文、secret、Authorization。 */
export interface ToolLoopAuditEntry {
  turn: number;
  toolName: string;
  toolCallId: string;
  ok: boolean | null;
  errorCode: string | null;
}

/** 单次 Routed Tool Loop 尝试的结构化观测（脱敏）。
 *  外部可在报告/日志中使用，无需读取 state.json。 */
export interface RoutedToolLoopObservation {
  role: ExecutionModelRole;
  modelLogicalName: string;
  turns: number;
  totalToolCalls: number;
  auditTrail: ToolLoopAuditEntry[];
  terminationReason: ToolLoopTerminationReason | null;
  changedFiles: string[];
  /** 写入工具被调用的次数（write_file + edit_file），0 表示模型从未尝试写 */
  writeToolCalls: number;
  /** 若 stopped + no changedFiles，记录精确原因码 */
  noEffectReason?: string | null;
  /** P10: true 当 changedFiles.length > 0 且 Tool Loop 非正常完成（COMPLETED） */
  partialProgress?: boolean;
  /** P10: Tool Loop 失败原因码（changedFiles > 0 时记录，替代 noEffectReason） */
  failureReason?: ToolLoopNoEffectReason | null;
  /** P10: 建议的下一步动作 */
  nextAction?: 'VERIFY' | 'ESCALATE' | 'STOP';
  /** 诊断字段：DISCOVERY（只读探索）或 WRITER（写入执行）。
   *  只用于 report 展示与诊断，不参与路由/安全/状态机决策。 */
  stage?: 'DISCOVERY' | 'WRITER';
}

/** Routed Tool Loop 在当前 attempt 无效改动的原因码（P8） */
export type ToolLoopNoEffectReason =
  | 'NO_WRITE_TOOL_CALLED'
  | 'TOOL_EXECUTION_FAILED'
  | 'OLD_TEXT_MISMATCH'
  | 'REPEATED_TOOL_CALL'
  | 'TOOL_PROTOCOL_ERROR'
  | 'PROVIDER_STOPPED'
  | 'MAX_TURNS'
  | 'FILE_NOT_APPROVED';
