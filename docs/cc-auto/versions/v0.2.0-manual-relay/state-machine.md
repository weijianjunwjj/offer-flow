# cc-auto Dual Model Relay v0.2.0 状态机

> **状态**：v0.2.0 手动接力 MVP 状态机定义
> **版本**：v1.2 / 2026-08-04
> **依赖**：[technical-design.md](technical-design.md)

---

## 目录

1. [设计原则](#1-设计原则)
2. [状态定义](#2-状态定义)
3. [状态转换图](#3-状态转换图)
4. [字段 vs. 状态](#4-字段-vs-状态)
5. [状态转换详述](#5-状态转换详述)
6. [停止条件](#6-停止条件)
7. [与 v0.1 状态机的差异](#7-与-v01-状态机的差异)

---

## 1. 设计原则

v0.1 的状态机有 13 个阶段。v0.2.0 简化状态机，核心原则：

1. **状态只表达"当前在做什么"**，不表达"做了几次"——`repairCycles` 作为字段计数，不单独拆分 `REPAIR_1` / `REPAIR_2`。
2. **可选阶段不作为独立状态**——`STRATEGY_GATE`、`OPUS_REVIEW` 和 `DS_APPLY` 只在被触发时才进入，不成为每个任务的必经路径。
3. **终态只有两个**：`DONE` 和 `STOPPED`。所有异常停止通过 `stopReason` 细分。
4. **普通任务不单独调用 Scout**——DeepSeek Builder 在一次任务中完成必要调查与实施。
5. **Run Lease 贯穿全部状态**——INTAKE 获取，DONE/STOPPED 释放。
6. **writer 管理内部写权限**——DS_WORK 和 DS_APPLY 期间 writer=deepseek，其他时间 writer=none。v0.2.0 不允许 writer=opus。

---

## 2. 状态定义

```typescript
type RunPhase =
  | 'INTAKE'         // 接收任务 + 分类 + TaskContract + FileScope + Run Lease
  | 'STRATEGY_GATE'  // 策略路由（本地/人工阶段，不调用模型）
  | 'DS_WORK'        // DeepSeek 施工（调查 + 实施）
  | 'VERIFY'         // 定向验证
  | 'HUMAN_GATE'     // 人工决策门
  | 'OPUS_REVIEW'    // Opus 只读裁决（tools: []，主进程 Prompt 注入）
  | 'DS_APPLY'       // DeepSeek 按 Opus 裁决实施
  | 'FINAL_VERIFY'   // 最终全量验证
  | 'DONE'           // 正常完成
  | 'STOPPED';       // 异常停止
```

| 状态 | 说明 | 谁在工作 |
|------|------|----------|
| `INTAKE` | 解析任务、分类、创建 TaskContract+FileScope、获取 Run Lease | machine |
| `STRATEGY_GATE` | 策略路由：deepseek-first→DS_WORK，opus-plan-first→人工确认→OPUS_REVIEW | user / machine |
| `DS_WORK` | DeepSeek 读取代码、提出 proposedFiles、实施修改，writer=deepseek | DeepSeek |
| `VERIFY` | 运行定向测试 + flaky 检测 + worktree 变化检测，writer=none | machine |
| `HUMAN_GATE` | 展示失败信息/Opus 调用详情/预算状态/模型身份确认，等待交互输入 | user |
| `OPUS_REVIEW` | Opus 通过主进程注入的 Prompt 输出结构化裁决（tools: []） | Opus（无工具） |
| `DS_APPLY` | DeepSeek 获取 writer，按裁决实施，释放 writer | DeepSeek |
| `FINAL_VERIFY` | 全量 typecheck + 全量测试 + worktree 变化检测，writer=none | machine |
| `DONE` | 任务成功完成，释放 Run Lease | — |
| `STOPPED` | 异常停止（详见 §6），释放 Run Lease | — |

---

## 3. 状态转换图

### 3.1 deepseek-first

```
                                         ┌──────────────────────────────┐
                                         │                              │
                                         ▼                              │
┌────────┐  ┌──────────────┐  ┌──────────┐  ┌────────┐  ┌────────────┐ │
│ INTAKE │─▶│ STRATEGY_GATE│─▶│ DS_WORK  │─▶│ VERIFY │─▶│FINAL_VERIFY│ │
└────────┘  └──────────────┘  └──────────┘  └────────┘  └────────────┘ │
                  │                  │            │            │         │
                  │                  │            │ 失败        │ 通过    │
                  │                  │            ▼            ▼         │
                  │                  │       ┌────────────┐  ┌──────┐   │
                  │                  │       │ HUMAN_GATE │  │ DONE │   │
                  │                  │       └────────────┘  └──────┘   │
                  │                  │            │                     │
                  │                  │     ┌──────┼──────┐              │
                  │                  │     o      d      x              │
                  │                  │     │      │      │              │
                  │                  │     ▼      │      ▼              │
                  │                  │ ┌──────────┐│  STOPPED           │
                  │                  │ │OPUS_REVIEW││                    │
                  │                  │ └──────────┘│                    │
                  │                  │      │      │                    │
                  │                  │      ▼      │                    │
                  │                  │ ┌──────────┐│                    │
                  │                  │ │ DS_APPLY ││                    │
                  │                  │ └──────────┘│                    │
                  │                  │      │      │                    │
                  │                  └──────┴──────┘                    │
                  │                         │                           │
                  │                    修复次数未超标                     │
                  └─────────────────────────────────────────────────────┘
```

### 3.2 opus-plan-first

```
┌────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐
│ INTAKE │─▶│ STRATEGY_GATE│─▶│ HUMAN_GATE │─▶│OPUS_REVIEW│─▶│ DS_WORK  │─▶│ VERIFY │
└────────┘  └──────────────┘  └────────────┘  └──────────┘  └──────────┘  └────────┘
                  │             │        │            │              │           │
                  │ 用户选择 opus-│        │            │              │           │
                  │ plan-first  │ o      d            │              │           │
                  │             │ │      │            │              │           │
                  │             │ ▼      ▼            │              │           │
                  │             │ OPUS_  DS_WORK      │              │           │
                  │             │ REVIEW (降级为       │              │           │
                  │             │        deepseek-    │              │           │
                  │             │        first,       │              │           │
                  │             │        不增加        │              │           │
                  │             │        repairCycles)│              │           │
                  │             │                     │              │           │
                  │             │ x                   │              │           │
                  │             ▼                     │              │           │
                  │          STOPPED                  │              │           │
                  │                                  │              │           │
                  └──────────────────────────────────┴──────────────┘           │
                                                                               │
                               ... → FINAL_VERIFY → DONE                       │
```

### 3.3 转换条件速查

| 从 | 到 | 条件 |
|----|----|------|
| `INTAKE` | `STRATEGY_GATE` | TaskContract + FileScope + Run Lease 创建完成 |
| `INTAKE` | `STOPPED` | 配置校验失败（定价缺失 → `PRICING_NOT_FOUND`） |
| `STRATEGY_GATE` | `DS_WORK` | 策略=deepseek-first；获取 writer=deepseek |
| `STRATEGY_GATE` | `HUMAN_GATE` | 策略=opus-plan-first；在内存中生成调用预览（不构建完整 Bundle） |
| `DS_WORK` | `VERIFY` | DeepSeek 施工完成，writer=none |
| `DS_WORK` | `HUMAN_GATE` | DeepSeek 返回的 reportedModel 为 null，modelIdentityStatus=UNVERIFIED |
| `DS_WORK` | `STOPPED` | 预算耗尽 / 结构化输出缺失 / 轮次超限 / FileScope 违规 |
| `VERIFY` | `FINAL_VERIFY` | 定向测试通过 |

**`DS_WORK → HUMAN_GATE (MODEL_IDENTITY_CONFIRMATION)` 详细说明：**

- 条件：DeepSeek 返回的 `reportedModel` 为 null，`modelIdentityStatus=UNVERIFIED`；
- 保存 `pendingResultId`；
- `resumePhase=VERIFY`；
- 用户输入 `a` 后不重新调用模型，进入 `VERIFY`；
- 用户输入 `x` 后以 `USER_REJECTED_UNVERIFIED_MODEL` 停止。
| `VERIFY` | `HUMAN_GATE` | 定向测试失败，修复次数未超标 |
| `VERIFY` | `STOPPED` | flaky / 修复次数用尽 / worktree 被外部修改 |
| `HUMAN_GATE` (FAILURE_ARBITRATION) | `OPUS_REVIEW` | 用户输入 `o`（或非交互模式 `--approve-opus-call`） |
| `HUMAN_GATE` (FAILURE_ARBITRATION) | `STOPPED` | 用户输入 `x` |
| `HUMAN_GATE` (FAILURE_ARBITRATION) | `DS_WORK` | 用户输入 `d`，repairCycles+1 |
| `HUMAN_GATE` (PRE_IMPLEMENTATION_PLAN) | `OPUS_REVIEW` | 用户输入 `o`（或非交互模式 `--approve-opus-call`） |
| `HUMAN_GATE` (PRE_IMPLEMENTATION_PLAN) | `STOPPED` | 用户输入 `x` |
| `HUMAN_GATE` (PRE_IMPLEMENTATION_PLAN) | `DS_WORK` | 用户输入 `d`，放弃 opus-plan-first，降级为 deepseek-first，**不增加 repairCycles** |
| `OPUS_REVIEW` | `DS_APPLY` | Opus 返回有效裁决（PROCEED/REVISE） |
| `OPUS_REVIEW` | `STOPPED` | Opus 裁决 STOP / 无效裁决 / 预算耗尽 / MODEL_IDENTITY_MISMATCH |
| `OPUS_REVIEW` | `HUMAN_GATE` | UNVERIFIED → MODEL_IDENTITY_CONFIRMATION（二次确认） |
| `OPUS_REVIEW` | `DS_WORK` | opus-plan-first：Opus 裁决后进入施工 |
| `DS_APPLY` | `VERIFY` | DeepSeek 实施完成，writer=none |
| `FINAL_VERIFY` | `DONE` | 全量验证通过 |
| `FINAL_VERIFY` | `HUMAN_GATE` | 全量验证失败，修复次数未超标 |
| `FINAL_VERIFY` | `STOPPED` | flaky / 修复次数用尽 / worktree 变化 |

---

## 4. 字段 vs. 状态

以下信息作为 `RunState` 的**字段**而非独立状态：

| 信息 | 字段名 | 类型 | 说明 |
|------|--------|------|------|
| 启动策略 | `strategy` | `LaunchStrategy` | 用户选择 |
| 修复次数 | `repairCycles` | `number` | 已用修复周期数 |
| 风险等级 | `classification.riskScore` | `number` | 0–10 |
| Opus 调用次数 | 从 `calls[]` 重算 | `number` | 已调用次数（非独立持久化） |
| 当前 writer | RunLease 中的 `writer` | `WriterRole` | 当前谁有写权限 |
| 最后一次失败指纹 | `lastFailureFingerprint` | `string \| null` | 重复失败检测 |
| 预算状态 | `budgetState` | `BudgetState` | 实时预算（从 `calls[]` 重算） |
| 验证状态 | `verificationStatus` | `{ target: string; full: string }` | 最近验证摘要 |
| HUMAN_GATE 目的 | `humanGatePurpose` | `HumanGatePurpose` | 决定交互选项和语义 |

---

## 5. 状态转换详述

### 5.1 INTAKE → STRATEGY_GATE

**前置条件**：
- 任务描述有效、非空；
- 所有 Profile 的模型 ID 都能在 `ProviderProfile.pricing` 中查到定价（配置态校验，失败立即 `PRICING_NOT_FOUND` → STOPPED）；
- SDK / CLI 可执行文件校验通过；
- Run Lease 获取成功。

**转换动作**：
1. 运行分类器（`classifyTask`）；
2. 创建 TaskContract（预算、FileScope、maxOpusCalls 等）；
3. 获取 Run Lease（writer=none），记录 `computeWorktreeFingerprint()`；
4. 状态进入 `STRATEGY_GATE`。

### 5.2 STRATEGY_GATE

**不调用任何模型。** 纯本地/人工路由：

- `strategy=deepseek-first`（默认）：获取 writer=deepseek，→ `DS_WORK`。
- `strategy=opus-plan-first`：**只在内存中生成调用预览**（Capsule 结构 + 预估费用），不构建完整 Bundle，→ `HUMAN_GATE`（前置）。

### 5.3 DS_WORK → VERIFY

**前置条件**：
- DeepSeek 返回有效结构化输出（summary + changedFiles）；
- 实际改动文件全部在 `approvedFiles` 内或可自动批准；
- 预算未耗尽。

**转换动作**：
1. 将 changedFiles 写入 RunState；
2. 释放 writer（writer=none）；
3. 记录 UsageRecord；
4. 状态进入 `VERIFY`。

### 5.4 VERIFY → HUMAN_GATE

**前置条件**：测试失败（非 flaky），修复次数 < maxRepairCycles。

**转换动作**：
1. 计算失败指纹；
2. 如 deepseek-first：调用 DeepSeek 分析（只读），生成 FailureArbitrationCapsule；
3. 如 opus-plan-first：Capsule 已在 OPUS_REVIEW 后 DS_WORK 完成后构建；
4. 如用户尚未批准 Opus：显示 Opus 调用详情 + `[o/d/x]` 交互（`d` 的语义按上下文：失败门 → repairCycles+1；前置门 → 降级不增加 repairCycles）。

### 5.5 HUMAN_GATE → OPUS_REVIEW

**前置条件**：用户输入 `o`（或非交互模式 `--approve-opus-call`）。

**转换动作**：
1. 记录 HandoffRecord（from=user, to=opus, userApproved=true）；
2. 检查 Opus 预算与配置（按 `requestedModelId` 查询 `ProviderProfile.pricing`，缺失则 `PRICING_NOT_FOUND` 停止）；
3. 预算与配置检查通过后，构建完整 Evidence Bundle（使用 `fs.mkdtemp` 创建随机临时目录）；
4. 主进程读取 Bundle 内容拼接进 Opus Prompt；
5. writer 保持 none；
6. 持久化 `pendingCall`（status=PREPARED）；
7. 发起 Opus 调用前更新 `pendingCall` 为 DISPATCHED；
8. 状态进入 `OPUS_REVIEW`。

**空输入**：不执行任何动作，重新提示。

### 5.6 OPUS_REVIEW

Opus 调用**禁用全部原生文件工具**（`tools: []`）。主进程将 Bundle 内容拼入 Prompt——这是 v0.2.0 的唯一路径。

**Opus 模型身份验证**：
- `MISMATCH` → 立即 STOPPED（`MODEL_IDENTITY_MISMATCH`），不重试、不降级、不允许该次 Opus 裁决驱动后续施工。
- `UNVERIFIED` → 进入 HUMAN_GATE（purpose=MODEL_IDENTITY_CONFIRMATION），携带 `identityConfirmationContext`：

```typescript
interface IdentityConfirmationContext {
  sourcePhase: 'DS_WORK' | 'OPUS_REVIEW';
  resumePhase: 'VERIFY' | 'DS_WORK' | 'DS_APPLY';
  pendingResultId: string;
}
```

**恢复目标（按 sourcePhase）**：

| sourcePhase | 用户输入 a 后的行为 |
|---|---|
| `DS_WORK`（DeepSeek 施工返回 UNVERIFIED） | 接受该次 DeepSeek 施工结果，进入 `VERIFY` |
| `OPUS_REVIEW`（前置规划 Opus 返回 UNVERIFIED） | 接受 PlanningVerdict，完成 recommendedFiles 的 FileScope 校验，进入 `DS_WORK` |
| `OPUS_REVIEW`（失败仲裁 Opus 返回 UNVERIFIED） | 接受 ArbitrationVerdict，完成 recommendedFiles 的 FileScope 校验，进入 `DS_APPLY` |

交互规则：
- 显示 requestedModelId + reportedModel=null + Provider Profile + 费用状态；
- `[a]` 接受：不重新调用模型，不产生第二次费用；按上表恢复目标继续；
- `[x]` 停止 → STOPPED；
- 空输入：无动作，重新提示；
- 非交互模式必须使用独立显式 flag `--accept-unverified-model-result`，不得复用 `--approve-opus-call`；
- 报告和 Capsule 标记 `identityUnverified=true`。

**Opus verdict=STOP** → STOPPED（`OPUS_RECOMMENDED_STOP`）。

**Opus verdict=PROCEED/REVISE（deepseek-first）** → DS_APPLY。

**Opus verdict=PROCEED/REVISE（opus-plan-first）** → DS_WORK（DeepSeek 按架构合同施工）。

### 5.7 DS_APPLY → VERIFY

**前置条件**：DeepSeek 按裁决实施完成。

**转换动作**：
1. 释放 writer；
2. 记录 UsageRecord；
3. 修复次数+1（DS_APPLY 计入修复周期）；
4. 进入 `VERIFY`。

### 5.8 FINAL_VERIFY → DONE

**前置条件**：全量 tsc + vitest 通过，非 flaky，非写阶段 worktree 未变化。

**转换动作**：释放 Run Lease → `DONE`。

---

## 5.9 HumanGatePurpose

```typescript
type HumanGatePurpose =
  | 'PRE_IMPLEMENTATION_PLAN'
  | 'FAILURE_ARBITRATION'
  | 'MODEL_IDENTITY_CONFIRMATION';
```

**MODEL_IDENTITY_CONFIRMATION** 转换（按 `identityConfirmationContext`）：

| 从 | 到 | 条件 |
|----|----|------|
| `HUMAN_GATE` (MODEL_IDENTITY_CONFIRMATION, sourcePhase=DS_WORK) | `VERIFY` | 用户输入 `a`；接受 DeepSeek 施工结果，不重新调用模型 |
| `HUMAN_GATE` (MODEL_IDENTITY_CONFIRMATION, sourcePhase=OPUS_REVIEW, 前置规划) | `DS_WORK` | 用户输入 `a`；接受 PlanningVerdict，经 FileScope 校验后进入施工 |
| `HUMAN_GATE` (MODEL_IDENTITY_CONFIRMATION, sourcePhase=OPUS_REVIEW, 失败仲裁) | `DS_APPLY` | 用户输入 `a`；接受 ArbitrationVerdict，经 FileScope 校验后进入实施 |
| `HUMAN_GATE` (MODEL_IDENTITY_CONFIRMATION) | `STOPPED` | 用户输入 `x` |
| `HUMAN_GATE` (MODEL_IDENTITY_CONFIRMATION) | 无动作 | 空输入，重新提示 |

非交互模式：必须提供独立显式 flag `--accept-unverified-model-result`，不得复用 `--approve-opus-call`。

---

## 6. 停止条件

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
  | 'PRICING_NOT_FOUND'             // 配置态缺价——INTAKE 停机

  // v0.2.0 新增
  | 'RUN_LEASE_CONFLICT'             // Run Lease 被其他进程持有
  | 'STALE_LEASE_REQUIRES_CONFIRM'   // stale lease 未获用户确认
  | 'WRITER_CONFLICT'                // writer 管理异常
  | 'WORKTREE_TAMPERED_DURING_VERIFY'// 非写阶段 worktree 被修改
  | 'FILE_SCOPE_VIOLATION'           // 施工超出 approvedFiles
  | 'OPUS_BUDGET_EXCEEDED'
  | 'USER_DECLINED_OPUS'
  | 'OPUS_RECOMMENDED_STOP'
  | 'OPUS_VERDICT_INVALID'
  | 'OPUS_CALLS_EXCEEDED'
  | 'PROVIDER_AUTH_ERROR'
  | 'COST_UNAVAILABLE'               // 运行期费用无法估算——立即停止
  | 'MODEL_IDENTITY_MISMATCH'        // Opus 模型身份 MISMATCH——立即停止

  // v1.2 补全
  | 'REPAIR_CYCLES_EXHAUSTED'        // 修复次数用尽
  | 'USER_REJECTED_UNVERIFIED_MODEL' // 用户在 MODEL_IDENTITY_CONFIRMATION 输入 x
  | 'USER_DECLINED_FILE_SCOPE_EXPANSION'; // 用户拒绝扩展 FileScope
```

---

## 7. 与 v0.1 状态机的差异

| 维度 | v0.1 | v0.2.0 | 原因 |
|------|------|--------|------|
| 阶段数 | 13 | 10 | 新增 STRATEGY_GATE，合并修复周期 |
| 启动策略 | 仅 deepseek-first | 两种策略 | 支持前置 Opus 裁决 |
| Scout | 独立阶段 | 不独立 | 普通任务不需要 |
| 修复 | REPAIR_1/REPAIR_2 | repairCycles 字段 | 避免状态膨胀 |
| 仲裁 | ARBITRATE→APPLY_DECISION | OPUS_REVIEW→DS_APPLY | 结构化裁决 + Evidence Bundle |
| 人工门 | 无（自动升级） | HUMAN_GATE（[o/d/x]） | 人工批准，无默认；d 按上下文拆分语义 |
| 锁 | write-lock（施工期间） | Run Lease（全程）+ writer | 防止并发 + worktree 变化检测 |
| 文件范围 | allowedFiles[] | FileScope | 分层（roots/protected/proposed/approved）+ 写入前执行点 |
| 分类 | CLASSIFY 独立 | INTAKE 内 | 分类逻辑简单 |
| PREFLIGHT | 独立 | 合入 INTAKE | 预检逻辑简单 |
| Opus 访问 | 自由文本 bundle + 无工具 | tools:[] + 主进程 Prompt 注入 | 安全隔离（v0.1 已验证） |
