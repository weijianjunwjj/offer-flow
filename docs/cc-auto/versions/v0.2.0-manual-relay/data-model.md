# cc-auto Dual Model Relay v0.2.0 数据模型

> **状态**：v0.2.0 手动接力 MVP 数据模型定义
> **版本**：v1.2 / 2026-08-04
> **依赖**：[technical-design.md](technical-design.md)
> **注意**：本文档定义数据结构的**职责和字段**，不是生产代码。施工时按本文档创建具体类型文件。

---

## 目录

1. [设计原则](#1-设计原则)
2. [Provider 与模型身份](#2-provider-与模型身份)
3. [用量与费用](#3-用量与费用)
4. [文件范围模型](#4-文件范围模型)
5. [Run Lease 与 writer](#5-run-lease-与-writer)
6. [任务与运行](#6-任务与运行)
7. [Evidence Bundle 与 Decision Capsule](#7-evidence-bundle-与-decision-capsule)
8. [Opus 裁决](#8-opus-裁决)
9. [验证结果](#9-验证结果)
10. [失败指纹](#10-失败指纹)
11. [预算状态](#11-预算状态)
12. [接力记录](#12-接力记录)

---

## 1. 设计原则

- 每个结构只负责一个明确的领域概念，不混合职责。
- 字段必须标注"谁写入"：`machine`（Node.js 代码）、`deepseek`、`opus`、`user`。
- 所有"未知"字段使用 `null`，不能用 `0` 表示未知。
- Token 数确实为 0 时记录 0；Provider 未返回该字段时记录 `null`。
- 枚举使用字符串联合类型，不使用数字。
- 所有时间字段使用 ISO 8601 字符串。
- 路径字段使用 POSIX 风格（`/`），相对于仓库根目录。

---

## 2. Provider 与模型身份

### 2.1 ProviderProfile

Provider 的静态配置，来自 `.cc-auto/config.json`。

| 字段 | 类型 | 说明 | 写入者 |
|------|------|------|--------|
| `id` | `string` | 本地唯一标识，如 `"deepseek-v4-pro"` / `"opus-third-party"` | config |
| `displayName` | `string` | 显示名称 | config |
| `vendor` | `'deepseek' \| 'anthropic' \| 'third-party'` | 厂商 | config |
| `transport` | `'openai-chat' \| 'anthropic-messages' \| 'claude-cli'` | 传输协议——Adapter 据此选 SDK | config |
| `apiBaseUrl` | `string \| undefined` | API endpoint（claude-cli 可省略） | config |
| `credentialEnvVars` | `string[]` | 凭证环境变量**名**（不存值） | config |
| `runtimeEnvAllowlist` | `string[]` | 运行时环境变量白名单 | config |
| `staticEnv` | `Record<string, string> \| undefined` | 静态非敏感环境变量 | config |
| `defaultModelId` | `string` | 默认请求模型 ID | config |
| `models` | `ModelIdentity[]` | 支持的模型列表 | config |
| `pricing` | `Record<string, ModelPricing>` | 按模型 ID 的定价表 | config |

### 2.2 ModelIdentity

| 字段 | 类型 | 说明 | 写入者 |
|------|------|------|--------|
| `logicalName` | `string` | 本地逻辑名称，如 `"deepseek"` / `"opus"` | config |
| `requestedModelId` | `string` | 实际发送给 Provider 的模型 ID | config |
| `acceptedReportedModelIds` | `string[]` | Provider 可能返回的可接受模型 ID 白名单 | config |
| `displayName` | `string` | 显示名称 | config |

定价不在 ModelIdentity 中。唯一真相来源是 `ProviderProfile.pricing: Record<string, ModelPricing>`。

### 2.3 ModelPricing

| 字段 | 类型 | 说明 |
|------|------|------|
| `inputPerMTokens` | `number` | 输入价格（元/百万 Token） |
| `outputPerMTokens` | `number` | 输出价格（元/百万 Token） |
| `cacheCreationPerMTokens` | `number` | 缓存写入价格（元/百万 Token） |
| `cacheReadPerMTokens` | `number` | 缓存读取价格（元/百万 Token） |
| `currency` | `'CNY'` | 计价货币（v0.2.0 仅允许 CNY——所有配置价格由用户预先换算为人民币/百万 Token；多币种与汇率换算推迟到未来版本） |
| `source` | `string` | 价格来源 |
| `updatedAt` | `string` | 价格更新日期（ISO 8601） |

---

## 3. 用量与费用

### 3.1 统一状态枚举

**ModelIdentityStatus**：

| 值 | 含义 |
|----|------|
| `VERIFIED` | `reportedModel` 在 `acceptedReportedModelIds` 中 |
| `MISMATCH` | `reportedModel` 不在 `acceptedReportedModelIds` 中 |
| `UNVERIFIED` | Provider 未返回可靠模型 ID（`reportedModel` 为 null） |

**UsageStatus**：

| 值 | 含义 |
|----|------|
| `AVAILABLE` | usage 数据完整 |
| `MISSING` | Provider 未返回任何 usage 信息 |
| `PARTIAL` | usage 部分字段缺失 |

**PricingStatus**：

| 值 | 含义 |
|----|------|
| `PRICED` | 实际模型 ID 命中价格表 |
| `UNPRICED` | 实际模型 ID 不在价格表中 |

**CostStatus**：

| 值 | 含义 |
|----|------|
| `AVAILABLE` | 费用可估算 |
| `UNAVAILABLE` | 费用无法估算（缺失 usage 或未定价） |

### 3.2 UsageRecord

| 字段 | 类型 | 说明 | 写入者 |
|------|------|------|--------|
| `model` | `'builder' \| 'arbiter'` | 逻辑角色 | machine |
| `requestedModelId` | `string` | 请求时发送的模型 ID | machine |
| `reportedModel` | `string \| null` | Provider 返回的实际模型 ID，null=未返回 | machine |
| `providerId` | `string` | 使用的 ProviderProfile.id | machine |
| `modelIdentityStatus` | `ModelIdentityStatus` | 模型身份验证状态 | machine |
| `pricingStatus` | `PricingStatus` | 定价可用性 | machine |
| `usageStatus` | `UsageStatus` | 用量数据可用性 | machine |
| `costStatus` | `CostStatus` | 费用可用性 | machine |
| `inputTokens` | `number \| null` | 输入 Token 数，null=未返回 | machine |
| `outputTokens` | `number \| null` | 输出 Token 数，null=未返回 | machine |
| `cacheCreationInputTokens` | `number \| null` | 缓存创建 Token 数 | machine |
| `cacheReadInputTokens` | `number \| null` | 缓存读取 Token 数 | machine |
| `costRmbCustom` | `number \| null` | 渠道估算费用（元），null=无法估算 | machine |
| `costRmbOfficial` | `number \| null` | 官方参考费用（元），null=无法估算 | machine |
| `durationMs` | `number \| null` | 调用耗时（毫秒），null=未返回 | machine |
| `numTurns` | `number` | 对话轮次 | machine |
| `subtype` | `string` | 调用子类型 | machine |
| `isError` | `boolean` | 是否为错误 | machine |
| `toolUseCounts` | `Record<string, number> \| null` | 工具调用计数 | machine |
| `toolErrorCounts` | `Record<string, number> \| null` | 工具错误计数 | machine |
| `permissionDenialsCount` | `number` | 权限拒绝次数 | machine |

### 3.3 统一 null 规则

- Token 数确实为 0 → 记录 `0`；
- Provider 未返回该字段 → 记录 `null`；
- 价格未知 → 费用为 `null`；
- usage 完全缺失 → 全部 Token 为 `null`，`costStatus='UNAVAILABLE'`；
- usage 部分缺失 → 可用字段记录值，缺失字段为 `null`，`usageStatus='PARTIAL'`；
- 报告不得把 `null` 显示为 `¥0.00`，必须显示 `UNAVAILABLE` 或等效文本；
- 存在 null 费用调用且任务已停止时，报告可标注"已知下限"；**运行期出现 costStatus='UNAVAILABLE' 必须立即 COST_UNAVAILABLE 停止，不得继续运行。**

---

## 4. 文件范围模型

### 4.1 FileScope

| 字段 | 类型 | 说明 | 写入者 |
|------|------|------|--------|
| `allowedRoots` | `string[]` | 允许修改的目录或文件前缀 | machine |
| `protectedPaths` | `string[]` | 明确禁止触碰的路径 | machine |
| `proposedFiles` | `string[]` | DeepSeek 提出的候选文件 | deepseek |
| `approvedFiles` | `string[]` | 已批准可写入的文件 | machine / user |
| `maxChangedFiles` | `number` | 最大修改文件数 | config |

---

## 5. Run Lease 与 writer

### 5.1 RunLease

路径：`.cc-auto/run-lock.json`

| 字段 | 类型 | 说明 |
|------|------|------|
| `runId` | `string` | 关联的 runId |
| `pid` | `number` | 持有 Run Lease 的进程 PID |
| `repositoryRoot` | `string` | 仓库绝对路径 |
| `acquiredAt` | `string` | 获取时间（ISO 8601） |
| `heartbeatAt` | `string` | 最后心跳时间 |
| `worktreeFingerprintAtStart` | `string` | 获取时的 worktree 指纹（`computeWorktreeFingerprint()`） |
| `writer` | `WriterRole` | 当前 run 内部谁有写权限（v0.2.0 不允许 `opus`）

### 5.2 WriterRole

```typescript
type WriterRole = 'none' | 'deepseek';
```

统一用于 `RunLease.writer`、`setWriter`、`releaseWriter`、`WriterRecord`。

### 5.3 WriterRecord

| 字段 | 类型 | 说明 |
|------|------|------|
| `writer` | `WriterRole` | 持有者 |
| `acquiredAt` | `string` | 获取时间 |
| `releasedAt` | `string` | 释放时间 |
| `runId` | `string` | 关联 runId |

---

## 6. 任务与运行

### 6.1 LaunchStrategy

```typescript
type LaunchStrategy = 'deepseek-first' | 'opus-plan-first';
```

### 6.2 TaskContract

| 字段 | 类型 | 说明 | 写入者 |
|------|------|------|--------|
| `taskDescription` | `string` | 原始任务描述 | user |
| `strategy` | `LaunchStrategy` | 启动策略 | user / config |
| `complexity` | `'simple' \| 'normal' \| 'complex'` | 分类结果 | machine |
| `riskScore` | `number` | 风险分（0–10） | machine |
| `touchesHighRisk` | `boolean` | 是否涉及高风险面 | machine |
| `fileScope` | `FileScope` | 文件范围 | machine |
| `maxOpusCalls` | `number` | 最大 Opus 调用次数 | config |
| `maxRepairCycles` | `number` | 最大修复次数 | config |
| `budget` | `TaskBudget` | 预算设置 | machine |
| `providers` | `{ deepseek: string; opus: string }` | 使用的 ProviderProfile.id | config |
| `verificationCommandAllowlist` | `VerificationCommand[]` | 允许执行的验证命令白名单 | config |
| `createdAt` | `string` | 创建时间 | machine |

### 6.2.1 VerificationCommand

| 字段 | 类型 | 说明 | 写入者 |
|------|------|------|--------|
| `id` | `string` | 命令唯一标识，供 `requiredTests` 等引用 | config |
| `executable` | `string` | 可执行文件名（绝对路径或相对于 cwd） | config |
| `args` | `string[]` | 参数数组，与 executable 分离，禁止 shell 模式 | config |
| `cwd` | `string` | 工作目录 | config |

### 6.3 RunPhase

```typescript
type RunPhase =
  | 'INTAKE'         // 接收任务 + 分类 + TaskContract + FileScope + Run Lease
  | 'STRATEGY_GATE'  // 策略路由（本地/人工阶段，不调用模型）
  | 'DS_WORK'        // DeepSeek 施工
  | 'VERIFY'         // 定向验证
  | 'HUMAN_GATE'     // 人工决策门
  | 'OPUS_REVIEW'    // Opus 只读裁决
  | 'DS_APPLY'       // DeepSeek 按裁决实施
  | 'FINAL_VERIFY'   // 最终全量验证
  | 'DONE'           // 正常完成
  | 'STOPPED';       // 异常停止
```

### 6.4 RunState

| 字段 | 类型 | 说明 | 写入者 |
|------|------|------|--------|
| `runId` | `string` | 运行 ID | machine |
| `taskDescription` | `string` | 任务描述 | user |
| `strategy` | `LaunchStrategy` | 启动策略 | user / config |
| `contract` | `TaskContract` | 任务合同 | machine |
| `currentPhase` | `RunPhase` | 当前阶段 | machine |
| `classification` | `Classification` | 分类结果 | machine |
| `calls` | `UsageRecord[]` | 全部模型调用记录 | machine |
| `pendingCall` | `PendingCall \| null` | 当前进行中或中断的调用 | machine |
| `failures` | `FailureRecord[]` | 失败记录 | machine |
| `repairCycles` | `number` | 已用修复次数 | machine |
| `changedFiles` | `string[]` | 已修改文件列表 | machine |
| `fileScope` | `FileScope` | 文件范围 | machine |
| `budgetState` | `BudgetState` | 预算状态 | machine |
| `writerHistory` | `WriterRecord[]` | writer 获取/释放历史 | machine |
| `capsuleIds` | `string[]` | Capsule ID 列表 | machine |
| `handoffHistory` | `HandoffRecord[]` | 接力记录 | machine |
| `stopReason` | `StopReason \| null` | 停止原因 | machine |
| `stopDetail` | `string \| null` | 停止详情 | machine |
| `humanGatePurpose` | `HumanGatePurpose \| null` | 当前 HUMAN_GATE 目的（进入时持久化，离开后清理） | machine |
| `identityConfirmationContext` | `IdentityConfirmationContext \| null` | 模型身份确认上下文（进入 HUMAN_GATE 前持久化，离开后清理） | machine |
| `lastFailureFingerprint` | `string \| null` | 最后一次失败指纹（持久化，用于重复失败检测） | machine |
| `verificationStatus` | `{ target: VerificationOutcome; full: VerificationOutcome }` | 验证状态（持久化，用于恢复时判断验证进度） | machine |
| `done` | `boolean` | 运行是否结束 | machine |
| `resumed` | `boolean` | 是否恢复执行 | machine |
| `createdAt` | `string` | 创建时间 | machine |
| `updatedAt` | `string` | 更新时间 | machine |

其中 `VerificationOutcome`：

```typescript
type VerificationOutcome = 'NOT_RUN' | 'PASSED' | 'FAILED' | 'FLAKY';
```

### 6.5 PendingCall

防止恢复后重复调用和重复收费的保护机制。

```typescript
type PendingCallStatus = 'PREPARED' | 'DISPATCHED' | 'COMPLETED' | 'UNKNOWN_AFTER_CRASH';

interface PendingCall {
  callId: string;
  phase: RunPhase;
  role: 'builder' | 'arbiter';
  providerId: string;
  requestedModelId: string;
  startedAt: string;
  approvalRecordId: string;
  estimatedCostRmb: number | null;
  status: PendingCallStatus;
}
```

调用顺序：
1. 调用前持久化 `pendingCall`（status=PREPARED）；
2. 真正发出请求前更新为 DISPATCHED；
3. 收到并完成记录后：原子写入 `calls[]`，清除 `pendingCall`（设为 null）。

恢复规则：
- `PREPARED`：可安全取消或重新审批（未发出请求）；
- `DISPATCHED` 且 `calls[]` 中无对应完成记录 → 标记 `UNKNOWN_AFTER_CRASH`，进入 HUMAN_GATE，不自动重发；
- 只有用户明确批准后才允许重新调用。

`opusCalls` 与 `spentRmb` 一律从 `calls[]` 重算，不作为独立持久化字段。

### 6.6 StopReason

```typescript
type StopReason =
  // 继承 v0.1
  | 'BUDGET_TASK_EXCEEDED'
  | 'BUDGET_DAILY_EXCEEDED'
  | 'MAX_CHANGED_FILES_EXCEEDED'
  | 'REPEATED_FAILURE_FINGERPRINT'
  | 'HIGH_RISK_OPERATION_DETECTED'
  | 'FLAKY_TESTS'
  | 'MAX_TURNS_EXCEEDED'
  | 'STRUCTURED_OUTPUT_MISSING'
  | 'PROVIDER_ERROR'
  | 'PRICING_NOT_FOUND'

  // v0.2.0 新增
  | 'RUN_LEASE_CONFLICT'
  | 'STALE_LEASE_REQUIRES_CONFIRM'
  | 'WRITER_CONFLICT'
  | 'WORKTREE_TAMPERED_DURING_VERIFY'
  | 'FILE_SCOPE_VIOLATION'
  | 'OPUS_BUDGET_EXCEEDED'
  | 'USER_DECLINED_OPUS'
  | 'OPUS_RECOMMENDED_STOP'
  | 'OPUS_VERDICT_INVALID'
  | 'OPUS_CALLS_EXCEEDED'
  | 'PROVIDER_AUTH_ERROR'
  | 'COST_UNAVAILABLE'
  | 'MODEL_IDENTITY_MISMATCH'

  // v1.2 补全
  | 'REPAIR_CYCLES_EXHAUSTED'
  | 'USER_REJECTED_UNVERIFIED_MODEL'
  | 'USER_DECLINED_FILE_SCOPE_EXPANSION';
```

对应含义：
- `REPAIR_CYCLES_EXHAUSTED`：修复次数用尽；
- `USER_REJECTED_UNVERIFIED_MODEL`：用户在 MODEL_IDENTITY_CONFIRMATION 输入 x；
- `USER_DECLINED_FILE_SCOPE_EXPANSION`：用户拒绝扩展 FileScope。

不得使用模糊的 `UNKNOWN` 或 `OTHER` 替代。

### 6.7 VerificationPlan

```typescript
interface VerificationPlan {
  /** VerificationCommand.id 列表 */
  commandIds: string[];
  /** 来源 */
  source: 'task-contract' | 'opus-verdict' | 'machine-default';
}
```

处理流程：

```
Opus requiredTests（command id 列表）
→ 主进程逐项匹配 TaskContract.verificationCommandAllowlist
→ 未命中白名单的 id 拒绝并记录
→ 命中的命令加入 VerificationPlan
→ Verifier 按顺序执行
```

---

## 7. Evidence Bundle 与 Decision Capsule

### 7.1 EvidenceManifest

Bundle 的文件清单。

| 字段 | 类型 | 说明 |
|------|------|------|
| `bundleId` | `string` | Bundle 唯一 ID |
| `runId` | `string` | 关联 runId |
| `createdAt` | `string` | 创建时间 |
| `files` | `EvidenceFileEntry[]` | 文件清单 |

### 7.2 EvidenceFileEntry

| 字段 | 类型 | 说明 |
|------|------|------|
| `relativePath` | `string` | Bundle 内的相对路径 |
| `sourcePath` | `string` | 原始仓库路径 |
| `sha256` | `string` | 内容 SHA256 |
| `redacted` | `boolean` | 是否经过脱敏 |

### 7.3 DecisionCapsule（可辨识联合）

```typescript
type DecisionCapsule =
  | PreImplementationCapsule
  | FailureArbitrationCapsule;
```

**PreImplementationCapsule**：

| 字段 | 类型 | 说明 | 写入者 |
|------|------|------|--------|
| `capsuleId` | `string` | Capsule 唯一 ID | machine |
| `runId` | `string` | 关联 runId | machine |
| `reviewPurpose` | `'PRE_IMPLEMENTATION_PLAN'` | Opus 裁决目的 | machine |
| `createdAt` | `string` | 创建时间 | machine |
| `machineContext` | `MachineContext` | 机器采集的事实 | machine |
| `deepseekAnalysis` | `null` | 无施工结果可分析（前置规划） | — |
| `userSupplement` | `UserSupplement \| null` | 用户补充 | user |

**FailureArbitrationCapsule**：

| 字段 | 类型 | 说明 | 写入者 |
|------|------|------|--------|
| `capsuleId` | `string` | Capsule 唯一 ID | machine |
| `runId` | `string` | 关联 runId | machine |
| `reviewPurpose` | `'FAILURE_ARBITRATION'` | Opus 裁决目的 | machine |
| `createdAt` | `string` | 创建时间 | machine |
| `machineContext` | `MachineContext` | 机器采集的事实 | machine |
| `failureFingerprint` | `string` | 失败指纹 | machine |
| `testFailures` | `string[]` | 测试失败信息 | machine |
| `deepseekAnalysis` | `DeepSeekAnalysis` | DeepSeek 分析（必须） | deepseek |
| `userSupplement` | `UserSupplement \| null` | 用户补充 | user |

### 7.4 ReviewPurpose

```typescript
type ReviewPurpose =
  | 'PRE_IMPLEMENTATION_PLAN'   // opus-plan-first
  | 'FAILURE_ARBITRATION';      // deepseek-first 验证失败
// 'FINAL_BLOCKER_REVIEW' 不属于 v0.2.0，保留为未来扩展，不写当前实现契约
```

### 7.5 MachineContext

| 字段 | 类型 | 说明 |
|------|------|------|
| `taskContract` | `TaskContractSummary` | 任务合同摘要 |
| `gitState` | `GitStateSnapshot` | Git 状态快照 |
| `changedFiles` | `string[]` | 修改文件列表（opus-plan-first 时为空） |
| `diffSummary` | `DiffSummary[]` | diff 摘要 |
| `testCommand` | `string \| null` | 测试命令（opus-plan-first 时为空） |
| `testOutputSummary` | `string \| null` | 测试输出摘要 |
| `failureFingerprint` | `string \| null` | 失败指纹（opus-plan-first 时为空） |
| `fileScope` | `FileScope` | 当前文件范围 |
| `budgetStatus` | `BudgetStatus` | 预算摘要 |

### 7.6 DeepSeekAnalysis

| 字段 | 类型 | 说明 |
|------|------|------|
| `confirmedFacts` | `string[]` | 已确认事实 |
| `unconfirmedSpeculations` | `string[]` | 未确认推测 |
| `currentJudgment` | `string` | 当前判断 |
| `alternatives` | `Array<{ description: string; cost: string }>` | 可选方案及代价（≥2 个） |
| `questionsForOpus` | `string[]` | 需要 Opus 回答的问题（≤3 个） |

### 7.7 UserSupplement

| 字段 | 类型 | 说明 |
|------|------|------|
| `approved` | `boolean` | 是否批准 Opus 调用 |
| `constraints` | `string[]` | 额外人工约束 |
| `context` | `string` | 补充背景信息 |

---

## 8. Opus 裁决（可辨识联合）

v0.2.0 的两种 `reviewPurpose` 拥有不同的 Verdict 结构，不强制共用字段语义。**两种 Verdict 的 JSON Schema 必须设置 `additionalProperties: false`**——额外字段导致 Schema 验证失败，不允许"通过但忽略"。

```typescript
type OpusVerdict =
  | PlanningVerdict
  | ArbitrationVerdict;
```

### 8.1 PlanningVerdict（前置规划）

JSON Schema 约束：`additionalProperties: false`。出现 rootCauseStatus、rootCause、evidence、contradictions、decision 等仲裁专属字段时 Schema 验证必须失败。

| 字段 | 类型 | 说明 |
|------|------|------|
| `reviewPurpose` | `'PRE_IMPLEMENTATION_PLAN'` | 裁决目的 |
| `verdict` | `'PROCEED' \| 'REVISE' \| 'STOP'` | 裁决结论 |
| `confidence` | `number` | 置信度（0.0–1.0） |
| `architectureDecision` | `string` | 架构决策完整叙述 |
| `invariants` | `string[]` | 不可违反的约束 |
| `recommendedFiles` | `string[]` | Opus 建议修改的文件（非授权——必须经 FileScope 校验） |
| `requiredTests` | `string[]` | 必须运行的测试命令 |
| `risks` | `string[]` | 识别的风险 |
| `stopConditions` | `string[]` | 触发立即停止的条件 |

无 `rootCauseStatus` / `rootCause` / `evidence` / `contradictions`——前置规划不存在失败。

### 8.2 ArbitrationVerdict（失败仲裁）

JSON Schema 约束：`additionalProperties: false`。出现 architectureDecision、risks、invariants 等规划专属字段时 Schema 验证必须失败。

| 字段 | 类型 | 说明 |
|------|------|------|
| `reviewPurpose` | `'FAILURE_ARBITRATION'` | 裁决目的 |
| `verdict` | `'PROCEED' \| 'REVISE' \| 'STOP'` | 裁决结论 |
| `rootCauseStatus` | `'CONFIRMED' \| 'PROBABLE' \| 'UNKNOWN'` | 根因确认状态 |
| `rootCause` | `string \| null` | 根因描述，UNKNOWN 时为 null |
| `evidence` | `EvidenceItem[]` | 证据列表（来源引用 Bundle 文件路径） |
| `contradictions` | `ContradictionItem[]` | 矛盾发现 |
| `decision` | `string` | 裁决理由完整叙述 |
| `recommendedFiles` | `string[]` | Opus 建议修改的文件（非授权——必须经 FileScope 校验） |
| `requiredTests` | `string[]` | 必须运行的测试命令 |
| `stopConditions` | `string[]` | 触发立即停止的条件 |
| `confidence` | `number` | 置信度（0.0–1.0） |

### 8.3 EvidenceItem

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | `string` | Bundle 内路径（如 `referenced-files/src/foo.ts:42` / `diff.patch` / `test-summary.txt`） |
| `claim` | `string` | 证据支持的主张 |
| `strength` | `'STRONG' \| 'WEAK'` | 证据强度 |

### 8.4 ContradictionItem

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | `string` | 矛盾描述 |
| `sources` | `string[]` | 矛盾的来源引用 |

---

## 9. 验证结果

### 9.1 VerificationResult

| 字段 | 类型 | 说明 |
|------|------|------|
| `passed` | `boolean` | 是否通过 |
| `flaky` | `boolean` | 是否检测到不稳定 |
| `output` | `string` | 测试输出（截断后） |
| `command` | `string` | 运行的命令 |
| `durationMs` | `number` | 耗时 |
| `fingerprint` | `string \| null` | 失败指纹（仅失败时） |
| `worktreeChanged` | `boolean` | 非写阶段 worktree 是否被外部修改 |

---

## 10. 失败指纹

沿用 v0.1 实现：

| 字段 | 类型 | 说明 |
|------|------|------|
| `phase` | `RunPhase` | 失败发生的阶段 |
| `fingerprint` | `string` | SHA256 前 16 位 |
| `summary` | `string` | 失败简述 |
| `truncatedLog` | `string` | 截断后的日志 |
| `createdAt` | `string` | 失败时间 |

---

## 11. 预算状态

### 11.1 BudgetStatus

| 字段 | 类型 | 说明 |
|------|------|------|
| `taskLimitRmb` | `number` | 任务预算上限 |
| `spentRmb` | `number` | 已花费（从 calls[] 重算，仅 PRICED） |
| `remainingRmb` | `number` | 剩余 |
| `hasUnpriced` | `boolean` | calls[] 中是否有 costStatus='UNAVAILABLE' 的调用 |
| `hasNullCost` | `boolean` | 是否有 null 费用调用 |
| `isExhausted` | `boolean` | 是否已耗尽 |
| `isLowerBound` | `boolean` | 合计是否为已知下限（仅用于已停止任务的报告，不作为继续运行依据） |

注意：`spentRmb`、`remainingRmb` 从 `calls[]` 重算，不是独立持久化的权威字段。

---

## 12. 接力记录

### 12.1 HandoffRecord

| 字段 | 类型 | 说明 |
|------|------|------|
| `from` | `'deepseek' \| 'opus' \| 'user' \| 'machine'` | 发起方 |
| `to` | `'deepseek' \| 'opus' \| 'user' \| 'machine'` | 接收方 |
| `reason` | `string` | 接力原因 |
| `capsuleId` | `string \| null` | 关联 Capsule ID |
| `strategy` | `LaunchStrategy \| null` | 关联策略 |
| `timestamp` | `string` | 时间（ISO 8601） |
| `userApproved` | `boolean` | 是否经人工批准 |
