# cc-auto Dual Model Relay v0.2.0 技术设计

> **状态**：v0.2.0 手动接力 MVP 技术设计
> **版本**：v1.2 / 2026-08-04
> **依赖**：[总体架构书](../../architecture/dual-model-relay-architecture.md)
> **受众**：DeepSeek（施工依据）、Claude Opus（审计）

---

## 目录

1. [版本范围](#1-版本范围)
2. [总体架构](#2-总体架构)
3. [启动策略](#3-启动策略)
4. [Provider Adapter](#4-provider-adapter)
5. [子进程环境隔离](#5-子进程环境隔离)
6. [模型身份与 Token 记录](#6-模型身份与-token-记录)
7. [Run Lease 与 writer](#7-run-lease-与-writer)
8. [文件范围模型](#8-文件范围模型)
9. [Evidence Bundle 与 Decision Capsule](#9-evidence-bundle-与-decision-capsule)
10. [手动接力流程](#10-手动接力流程)
11. [本地 Verifier](#11-本地-verifier)
12. [任务硬预算](#12-任务硬预算)
13. [运行记录与恢复](#13-运行记录与恢复)
14. [与 v0.1 的关系](#14-与-v01-的关系)
15. [明确不实现](#15-明确不实现)

---

## 1. 版本范围

v0.2.0 是 Dual Model Relay 的**最小可行版本**。核心目标：**让 DeepSeek 和 Opus 能在一次任务中接力，但 Opus 必须由人工明确批准后才被调用。**

### 1.1 本版实现

| # | 能力 | 概要 |
|---|------|------|
| 1 | 两种启动策略 | deepseek-first（默认）/ opus-plan-first（用户选择） |
| 2 | Provider Adapter | vendor 与 transport 分离；Adapter 按 transport 选 SDK |
| 3 | 子进程环境隔离 | credentialEnvVars + runtimeEnvAllowlist + staticEnv；支持 Windows |
| 4 | 模型身份与 Token 记录 | acceptedReportedModelIds 匹配；统一 null 语义 |
| 5 | 仓库级 Run Lease + writer | Run Lease 贯穿全部状态；writer 管理内部写权限 |
| 6 | 文件范围模型 | FileScope（allowedRoots / protectedPaths / proposed / approved） |
| 7 | Evidence Bundle + Decision Capsule | 机器构建 Bundle → DeepSeek 分析 → 用户补充 |
| 8 | 手动接力 | 系统提示 `[o/d/x]` → 人工批准 → Opus 裁决 → DeepSeek 实施 |
| 9 | 本地 Verifier | 测试 + 类型检查，flaky 检测，非写阶段 worktree 变化检测 |
| 10 | 任务硬预算 | 每任务设置人民币预算上限，耗尽即停止 |
| 11 | 运行记录与基础恢复 | 持久化运行状态，进程重启后可定位中断点 |

### 1.2 本版不实现（明确推迟）

| 能力 | 推迟到 |
|------|--------|
| 自动检测模型漂移 | v0.2.1+ |
| 自动调用 Opus（无人工批准） | v0.3+ |
| 自动矛盾分类器 | v0.2.1+ |
| 自动范围膨胀决策 | v0.2.1+ |
| 人民币费用比例硬门禁 | 已废弃 |
| GUI / 仪表盘 | v0.3+ |
| 自动路由 | v0.3+ |
| 模型自由对话 | 永不 |
| 两个模型同时写 | 永不 |
| 自动 commit / push / PR / tag / release | 永不 |
| Gateway / SSE / Claude Desktop Profile 改写 | 永不（已终止） |
| Opus 写权限 | v0.3+ |
| Opus 路径受控只读工具 | v0.3+ |
| 独立 read-lock 文件 | 永不（由 Evidence Bundle 替代） |
| 多币种与汇率换算 | v0.3+ |

---

## 2. 总体架构

### 2.1 进程模型

```
┌──────────────────────────────────────────────┐
│              cc-auto CLI                      │
│  (Node.js 主进程，不调用任何模型)               │
│                                               │
│  ┌──────────┐  ┌──────────┐  ┌────────┐      │
│  │ DeepSeek │  │  Opus    │  │ 本地    │      │
│  │ 子进程    │  │ 子进程   │  │ Verifier│      │
│  │          │  │          │  │         │      │
│  │ env:     │  │ tools:[] │  │ vitest  │      │
│  │ Profile  │  │ Prompt   │  │ tsc     │      │
│  │ 白名单    │  │ 由主进程  │  │         │      │
│  └──────────┘  │ 注入     │  └────────┘      │
│                └──────────┘                   │
│                                               │
│  ┌────────────────────────────────────┐       │
│  │  Run Lease (.cc-auto/run-lock.json)│       │
│  │  + writer 字段                      │       │
│  └────────────────────────────────────┘       │
│                                               │
│  ┌────────────────────────────────────┐       │
│  │  运行记录 .cc-auto/runs/<run-id>/   │       │
│  └────────────────────────────────────┘       │
└──────────────────────────────────────────────┘
```

- 主进程（Node.js）不调用任何模型，只负责：编排、Run Lease、writer、预算、Evidence Bundle 构建、Decision Capsule 组装、运行记录。
- DeepSeek 子进程：通过 Provider Adapter 拉起，获得 Profile 对应的白名单环境变量。
- Opus 子进程：tools: []（禁用全部原生文件工具）；Bundle 内容由主进程拼入 Prompt；Opus 不直接访问 Bundle 目录或真实仓库；临时目录只是主进程中间产物。
- 本地 Verifier：主进程直接 spawn `vitest` / `tsc`。

### 2.2 数据流

**deepseek-first（默认）：**

```
用户输入任务
  → 选择策略（deepseek-first）
  → INTAKE（分类 + TaskContract + FileScope + Run Lease）
  → DS_WORK（DeepSeek 施工，writer=deepseek）
  → writer=none
  → VERIFY
  → 通过？→ FINAL_VERIFY → DONE
  → 失败？→ HUMAN_GATE
    → [o] → 构建 Evidence Bundle → OPUS_REVIEW → DS_APPLY → VERIFY → FINAL_VERIFY → DONE
    → [d] → DS_WORK（修复次数+1）
    → [x] → STOPPED
```

**opus-plan-first（用户选择）：**

```
用户输入任务
  → 选择策略（opus-plan-first）
  → INTAKE（分类 + TaskContract + FileScope + Run Lease）
  → STRATEGY_GATE（只在内存生成调用预览，不构建完整 Bundle）
  → HUMAN_GATE（前置）
    → [o] → 预算与配置检查 → 构建 Evidence Bundle → OPUS_REVIEW（reviewPurpose=PRE_IMPLEMENTATION_PLAN）
           → DS_WORK（DeepSeek 按 Opus 架构合同施工，writer=deepseek）
           → VERIFY → FINAL_VERIFY → DONE
    → [d] → DS_WORK（降级为 deepseek-first，不增加 repairCycles）
    → [x] → STOPPED
```

opus-plan-first **必须在用户明确批准 Opus 调用且预算配置检查通过后，才构建完整 Evidence Bundle**。批准前只在内存中生成调用预览。

---

## 3. 启动策略

### 3.1 策略定义

```typescript
type LaunchStrategy =
  | 'deepseek-first'    // 默认：DeepSeek 先施工
  | 'opus-plan-first';  // 用户选择：Opus 先出架构合同
```

### 3.2 CLI 接口

```
cc-auto run "任务描述" --strategy deepseek-first
cc-auto run "任务描述" --strategy opus-plan-first
```

`--strategy` 不指定时默认 `deepseek-first`。

### 3.3 opus-plan-first 流程

1. INTAKE 阶段创建 TaskContract + FileScope + Run Lease，不构建 Bundle、不复制源码；
2. STRATEGY_GATE 只在内存中生成调用预览（Capsule 结构 + 预估费用）；
3. 进入 HUMAN_GATE，列出 Opus 预计费用和剩余预算，用户必须输入 `o` 确认；
4. 用户输入 `o` 且预算与配置检查通过后，构建完整 Evidence Bundle；
5. OPUS_REVIEW 阶段：Opus 输出架构合同（不变量、recommendedFiles、requiredTests、stopConditions）；
6. DS_WORK 阶段：DeepSeek 获取 writer，按架构合同实施；
7. 后续流程与 deepseek-first 验证失败后类似。

**opus-plan-first 仍然不自动调用 Opus**——用户必须在 HUMAN_GATE 明确输入 `o`。

---

## 4. Provider Adapter

### 4.1 ProviderProfile

```typescript
interface ProviderProfile {
  id: string;
  displayName: string;

  vendor: 'deepseek' | 'anthropic' | 'third-party';
  transport: 'openai-chat' | 'anthropic-messages' | 'claude-cli';

  apiBaseUrl?: string;

  /** 凭证环境变量名列表（不存值） */
  credentialEnvVars: string[];
  /** 运行时环境变量白名单 */
  runtimeEnvAllowlist: string[];
  /** 静态非敏感环境变量 */
  staticEnv?: Record<string, string>;

  /** 默认请求模型 ID */
  defaultModelId: string;
  models: ModelIdentity[];
  pricing: Record<string, ModelPricing>;
}
```

`ModelPricing` 支持两种 Provider-neutral 契约：

```typescript
type ModelPricing = FlatModelPricing | ContextTieredModelPricing;

interface ContextTieredModelPricing {
  pricingType: 'context-tiered';
  thresholdBasis: 'REQUEST_CONTEXT_TOKENS';
  tiers: Array<{
    id: string;
    fromInclusive: number;
    upToInclusive: number | null;
    rates: {
      inputPerMTokens: number;
      outputPerMTokens: number;
      cacheCreationPerMTokens: number;
      cacheReadPerMTokens: number;
    };
  }>;
  currency: 'CNY';
  source: string;
  updatedAt: string;
}
```

现有无 `pricingType` 的四维费率继续解释为 flat pricing。Context tiers 必须从 0 连续覆盖到最终
catch-all，不允许 gap、overlap、重复 ID、负数/非有限费率或未知 threshold basis。每档保存完整实际
费率，不使用 multiplier 作为核心持久化语义。

### 4.2 ModelIdentity

```typescript
interface ModelIdentity {
  logicalName: string;
  requestedModelId: string;
  /** Provider 可能返回的可接受模型 ID 列表 */
  acceptedReportedModelIds: string[];
  displayName: string;
}
```

定价不在 ModelIdentity 中。唯一真相来源是 `ProviderProfile.pricing: Record<string, ModelPricing>`。

### 4.3 示例配置

**DeepSeek Profile（OpenAI 兼容渠道）：**

```jsonc
{
  "id": "deepseek-v4-pro",
  "displayName": "DeepSeek V4 Pro",
  "vendor": "deepseek",
  "transport": "openai-chat",
  "apiBaseUrl": "https://api.deepseek.com/v1",
  "credentialEnvVars": ["DEEPSEEK_API_KEY"],
  "runtimeEnvAllowlist": ["PATH", "HOME", "SystemRoot", "TEMP", "TMP"],
  "defaultModelId": "deepseek-chat",
  "models": [
    {
      "logicalName": "deepseek",
      "requestedModelId": "deepseek-chat",
      "acceptedReportedModelIds": ["deepseek-chat", "deepseek-v3"],
      "displayName": "DeepSeek Chat"
    }
  ],
  "pricing": { "deepseek-chat": { "inputPerMTokens": 1.0, "outputPerMTokens": 2.0, "cacheCreationPerMTokens": 1.25, "cacheReadPerMTokens": 0.1, "currency": "CNY", "source": "third-party-2026-08", "updatedAt": "2026-08-04" } }
}
```

**Opus Profile（第三方 Anthropic 兼容渠道）：**

```jsonc
{
  "id": "opus-third-party",
  "displayName": "Claude Opus（第三方渠道）",
  "vendor": "third-party",
  "transport": "anthropic-messages",
  "apiBaseUrl": "https://third-party.example.com/v1",
  "credentialEnvVars": ["ANTHROPIC_AUTH_TOKEN"],
  "runtimeEnvAllowlist": ["PATH", "HOME", "SystemRoot", "TEMP", "TMP"],
  "staticEnv": { "ANTHROPIC_BASE_URL": "https://third-party.example.com/v1" },
  "defaultModelId": "claude-opus-4-8",
  "models": [
    {
      "logicalName": "opus",
      "requestedModelId": "claude-opus-4-8",
      "acceptedReportedModelIds": ["claude-opus-4-8", "claude-opus-5"],
      "displayName": "Claude Opus"
    }
  ],
  "pricing": { "claude-opus-4-8": { "inputPerMTokens": 3.50, "outputPerMTokens": 17.50, "cacheCreationPerMTokens": 4.38, "cacheReadPerMTokens": 0.35, "currency": "CNY", "source": "third-party-2026-08", "updatedAt": "2026-08-04" } }
}
```

定价只在 `ProviderProfile.pricing` 中出现一次。ModelIdentity 不包含 pricing 字段。

### 4.4 Adapter 选择逻辑

```typescript
function selectAdapter(profile: ProviderProfile): ProviderAdapter {
  switch (profile.transport) {
    case 'openai-chat':
      return new OpenAIChatAdapter(profile);
    case 'anthropic-messages':
      return new AnthropicMessagesAdapter(profile);
    case 'claude-cli':
      return new ClaudeCliAdapter(profile);
  }
}
```

- 不根据 `vendor` 选择协议。
- DeepSeek 可以使用 `openai-chat` 或 `anthropic-messages`（如第三方兼容接口）。
- Opus 可以使用 `anthropic-messages`（官方/第三方 API）或 `claude-cli`（本地 CLI）。

### 4.5 Opus Adapter

Opus 子进程：
- 通过 `anthropic-messages` 或 `claude-cli` transport 调用；
- **禁用全部原生文件工具（`tools: []`）**；
- Evidence Bundle 内容由主进程读取并拼接进 Prompt——这是 v0.2.0 的唯一路径；
- 调用参数：`model: profile.defaultModelId`、`max_turns: 1`；
- 返回：`OpusVerdict`（结构化 JSON）。

路径受控的自定义只读工具推迟到 v0.3。

---

## 5. 子进程环境隔离

### 5.1 原则

- 父进程环境不被永久修改；
- 每个 Provider 子进程**只**获得 Profile 声明的环境变量白名单 + 凭证 + 静态非敏感变量；
- 密钥**绝不**落盘。

### 5.2 环境变量构建

```typescript
function buildChildEnv(profile: ProviderProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  // 白名单变量
  for (const key of profile.runtimeEnvAllowlist) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // 凭证变量（从父进程读取，不落盘）
  for (const key of profile.credentialEnvVars) {
    const value = process.env[key];
    if (!value) {
      throw new Error(`${key} 未设置（Profile ${profile.id} 需要此凭证）`);
    }
    env[key] = value;
  }

  // 静态非敏感变量
  if (profile.staticEnv) {
    Object.assign(env, profile.staticEnv);
  }

  return env;
}
```

- **不**使用 `{ ...process.env }` 全量继承；
- DeepSeek 子进程不得获得 Opus 凭证；
- Opus 子进程不得获得 DeepSeek 凭证；
- `staticEnv` 只能保存非敏感值（如 `ANTHROPIC_BASE_URL`），被识别为密钥的字段禁止写入。

### 5.3 Windows 默认白名单

建议 `runtimeEnvAllowlist` 至少包含：

- `PATH`、`SystemRoot`、`ComSpec`、`PATHEXT`
- `TEMP`、`TMP`
- `USERPROFILE`、`APPDATA`、`LOCALAPPDATA`
- `HOME`

---

## 6. 模型身份与 Token 记录

### 6.1 UsageRecord

```typescript
interface UsageRecord {
  // 逻辑角色
  model: 'builder' | 'arbiter';

  // 模型身份
  requestedModelId: string;          // 请求时发送的模型 ID
  reportedModel: string | null;      // Provider 返回的实际模型 ID，null=未返回
  providerId: string;
  modelIdentityStatus: 'VERIFIED' | 'MISMATCH' | 'UNVERIFIED';

  // Token（null = Provider 未返回该字段）
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;

  // 费用（null = 无法估算）
  costRmbCustom: number | null;
  costRmbOfficial: number | null;

  // 状态
  pricingStatus: 'PRICED' | 'UNPRICED';
  usageStatus: 'AVAILABLE' | 'MISSING' | 'PARTIAL';
  costStatus: 'AVAILABLE' | 'UNAVAILABLE';

  // 元数据
  durationMs: number | null;
  numTurns: number;
  subtype: string;
  isError: boolean;
  toolUseCounts: Record<string, number> | null;
  toolErrorCounts: Record<string, number> | null;
  permissionDenialsCount: number;
}
```

### 6.2 身份验证逻辑与门禁

```
1. 发送请求时使用 requestedModelId；
2. 从 Provider 返回中提取实际模型 ID → reportedModel；
3. 比对：
   - reportedModel 为 null → modelIdentityStatus = UNVERIFIED；
   - reportedModel 在 acceptedReportedModelIds 中 → VERIFIED；
   - 否则 → MISMATCH；
4. MISMATCH：立即 STOPPED（MODEL_IDENTITY_MISMATCH），不重试、不静默降级、不允许该次 Opus 裁决驱动后续施工；
5. UNVERIFIED：进入 HUMAN_GATE，不得自动继续；必须显示 requestedModelId、reportedModel=null、Provider Profile、模型身份未确认、预计费用状态；用户必须再次确认是否接受身份未验证的结果；非交互模式缺少显式 flag 时停止；报告、Capsule 和裁决记录必须标记 identityUnverified=true。
```

### 6.3 统一 null 规则

- Token 数确实为 0 → 记录 0；
- Provider 未返回该字段 → 记录 null；
- 价格未知 → 费用为 null；
- usage 缺失 → 全部 Token 为 null，费用为 null（`costStatus = 'UNAVAILABLE'`）；
- usage 部分缺失 → 可用字段记录值，缺失字段记录 null（`usageStatus = 'PARTIAL'`）；
- 报告不得把 null 显示为 `¥0.00`；
- 存在 null 费用调用且任务已停止时，报告可标注"已知下限"，但不得作为继续运行的依据。**运行期出现 costStatus='UNAVAILABLE' 必须立即 COST_UNAVAILABLE 停止。**

Context-tiered 定价在 usage normalization 之后执行。`REQUEST_CONTEXT_TOKENS` 使用
`inputTokens + cacheReadInputTokens`，不包含 output；选中一个 tier 后，其 input、output、cache read、
cache creation 完整 rates 统一应用于本次 invocation。无法确定 request context 时返回
`PRICING_CONTEXT_TOKENS_UNAVAILABLE`，不得默认低档。

---

## 7. Run Lease 与 writer

### 7.1 Run Lease

路径：`.cc-auto/run-lock.json`

```typescript
type WriterRole = 'none' | 'deepseek';

interface RunLease {
  runId: string;
  pid: number;
  repositoryRoot: string;
  acquiredAt: string;
  heartbeatAt: string;
  worktreeFingerprintAtStart: string;
  /** 当前 run 内部谁有写权限 */
  writer: WriterRole;
}
```

### 7.2 获取 Run Lease

```typescript
function acquireRunLease(runId: string): RunLease {
  const existing = readRunLease();
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      throw new Error(`仓库已被 runId=${existing.runId} 占用（pid=${existing.pid}）`);
    }
    // PID 不存在——stale lease
    throw new Error(
      `发现残留 Run Lease（runId=${existing.runId}，pid=${existing.pid} 已不存在）。` +
      `请手动确认后重试：删除 .cc-auto/run-lock.json 或使用 --force-clean-lease`
    );
  }
  const lease: RunLease = {
    runId,
    pid: process.pid,
    repositoryRoot: process.cwd(),
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    worktreeFingerprintAtStart: computeWorktreeFingerprint(),
    writer: 'none',
  };
  writeRunLease(lease);
  return lease;
}
```

- **不得**仅因 PID 不存在就静默删除 stale lock；
- stale lease 必须请求用户确认（`--force-clean-lease` 或在交互式提示中确认）；
- 获取 Run Lease 后启动 heartbeat 定时器。

### 7.3 writer 管理

```typescript
function setWriter(writer: WriterRole): void {
  const lease = readRunLease();
  if (!lease || lease.runId !== currentRunId) throw new Error('Run Lease 不存在');
  lease.writer = writer;
  writeRunLease(lease);
}

function releaseWriter(): void {
  setWriter('none');
}
```

- `writer` 获取：DS_WORK 或 DS_APPLY 开始时；
- `writer` 释放：验证阶段开始前；
- v0.2.0 中 writer 永远不为 `opus`。

### 7.3.1 WorktreeFingerprint 算法

替代原未定义的 `computeWorktreeHash`，明确为 `computeWorktreeFingerprint()`：

1. `git status --porcelain=v1 --untracked-files=all` 的规范化输出（排序后）；
2. 已跟踪文件的 `git diff` 内容 SHA256；
3. staged diff（`git diff --staged`）的内容 SHA256；
4. 未跟踪但未被 `.gitignore` 忽略的文件：相对路径 + 文件内容 SHA256；
5. 排除：`.cc-auto/`、`.git/`、gitignored 缓存和构建产物。

指纹目标：
- 检测被 Git 感知的源码和配置变化；
- 不承诺检测所有被 `.gitignore` 忽略的文件；
- Verifier 不修改被跟踪源码，但允许工具在 gitignored 目录产生缓存或构建产物（如 `node_modules/.vite/`、`test-results/`）；
- `VERIFY` 前后指纹不一致且 `writer=none` 时 → `WORKTREE_TAMPERED_DURING_VERIFY`，STOPPED。

### 7.4 Verifier 的 worktree 变化检测

Verifier 运行时（writer=none）检测 worktree 是否被外部修改：
- 运行前记录 `computeWorktreeFingerprint()`；
- 运行后比较——变化则 STOPPED（`WORKTREE_TAMPERED_DURING_VERIFY`）。

---

## 8. 文件范围模型

### 8.1 FileScope

```typescript
interface FileScope {
  allowedRoots: string[];
  protectedPaths: string[];
  proposedFiles: string[];
  approvedFiles: string[];
  maxChangedFiles: number;
}
```

### 8.2 流程

1. **机器初始化**：根据任务描述 + 分类器生成初始 `allowedRoots` / `protectedPaths`。
   - 简单任务：可直接生成 `approvedFiles`（跳过 proposed）。
2. **DeepSeek 提案**：施工前 DeepSeek 提出 `proposedFiles`。
3. **机器批准**：
   - `proposedFiles` 在 `allowedRoots` 内 + 不触碰 `protectedPaths` + 数量 ≤ `maxChangedFiles` → 自动批准（加入 `approvedFiles`）；
   - 超出范围 → 请求用户扩展。
4. **写入前执行点（v0.2.0 主进程实现）**：
   - **Write / Edit**：执行前对目标路径执行 `path.resolve` → 计算相对 `repositoryRoot` 的 `path.relative` → 拒绝绝对路径、路径穿越（`..`）和符号链接逃逸 → 必须精确命中 `approvedFiles` → 未批准路径返回工具级 DENIED，不落盘。
   - **Bash**：采用 TaskContract 中的命令白名单，只允许明确的验证命令（如 `vitest run`、`tsc --noEmit`）；拒绝输出重定向（`>`、`>>`）；拒绝能原地修改文件的命令（`sed -i`、`perl -pi`、`git checkout`、`git restore`、`rm`、`mv`、`cp` 覆盖源码）；不得把 Bash 当作绕过 Write/Edit 的写入通道。
5. **事后核对（第二层防线）**：`git diff` 实际文件清单 vs `approvedFiles`。
6. **超出范围** → STOPPED（`FILE_SCOPE_VIOLATION`），保留现场等待人工处理，不自动回滚。

### 8.3 用户扩展

超出范围时提示：

```
DeepSeek 请求修改以下文件，超出当前允许范围：
  src/bar.ts（不在 allowedRoots 内）

允许范围：
  allowedRoots: src/foo/
  protectedPaths: src/foo/secrets/

[o] 批准扩展  [x] 拒绝并停止
```

### 8.4 TaskContract 命令白名单

DeepSeek 子进程的 Bash 权限通过 TaskContract 中的命令白名单控制，不允许模型直接提交任意 shell 字符串。

```typescript
interface VerificationCommand {
  /** 命令唯一标识，供 requiredTests 等引用 */
  id: string;
  /** 可执行文件名（如 "vitest"、"tsc"），不做 PATH 查找——必须是绝对路径或相对于 cwd */
  executable: string;
  /** 参数数组，executable 与 args 分离，禁止 shell 模式执行 */
  args: string[];
  /** 工作目录 */
  cwd: string;
}

interface TaskContract {
  // 其他已有字段
  /** 允许执行的验证命令白名单 */
  verificationCommandAllowlist: VerificationCommand[];
}
```

规则：

- Bash 只能执行 `verificationCommandAllowlist` 中的命令；
- 不允许模型直接提交任意 shell 字符串；
- `executable` 与 `args` 分离，禁止 shell 模式执行；
- 禁止重定向（`>`、`>>`）、管道（`|`）和命令拼接（`&&`、`;`）；
- `requiredTests` 不是任意 Bash 命令，只能引用白名单中的 `VerificationCommand.id`。

---

## 9. Evidence Bundle 与 Decision Capsule

### 9.1 构建时机（v0.2.0 统一）

**唯一构建时机：用户在 HUMAN_GATE 明确输入 `o`，且预算与模型配置检查通过后，才构建完整 Evidence Bundle 并调用 Opus。**

- deepseek-first：VERIFY 失败 → HUMAN_GATE → 用户输入 `o` → 预算检查通过 → 构建 Bundle → OPUS_REVIEW。
- opus-plan-first：INTAKE → STRATEGY_GATE → HUMAN_GATE（前置）→ 用户输入 `o` → 预算检查通过 → 构建 Bundle → OPUS_REVIEW。

**批准前**：只在内存中生成调用预览（Capsule 结构 + 预估费用），不复制源码到临时目录，不生成完整 Bundle。

### 9.2 Bundle 构建与清理

**构建**：
```
1. 使用 fs.mkdtemp 创建不可预测随机临时目录（不使用 /tmp/cc-auto-arbiter-<runId>/ 等可预测路径）；
2. 权限设置为当前用户可访问；
3. 复制时拒绝符号链接，只复制常规文件；
4. 逐个文件校验真实路径位于 repositoryRoot；
5. 限制总文件数、单文件大小和 Bundle 总大小；
6. 所有内容先脱敏再写入临时目录；
7. 写入：
   - capsule.json（Decision Capsule）
   - task-contract.json
   - git-status.txt
   - diff.patch
   - test-summary.txt（opus-plan-first 时不存在）
   - failure-fingerprint.json（opus-plan-first 时不存在）
   - referenced-files/（白名单源码，按原相对路径）
   - manifest.json（来源路径、SHA256、脱敏状态）
```
Opus 实际不直接访问该目录——目录只作为主进程组装 Prompt 的中间产物。

**清理**：
- `try/finally` 无条件删除临时目录；
- 用户拒绝（输入 `x`）时不创建；
- Opus 成功、失败、超时、异常均清理；
- 进程启动时清理本工具遗留且能安全确认归属的过期 Bundle；
- 清理失败必须记录脱敏警告日志，但不得泄露 Bundle 路径或内容。

### 9.3 Capsule 中的 OPUS_REVIEW 目的

```typescript
type ReviewPurpose =
  | 'PRE_IMPLEMENTATION_PLAN'  // opus-plan-first
  | 'FAILURE_ARBITRATION';     // deepseek-first 验证失败
// 'FINAL_BLOCKER_REVIEW' 不属于 v0.2.0，保留为未来扩展，不写当前实现契约
```

### 9.4 Opus prompt 组装（v0.2.0 唯一路径）

主进程读取 Bundle 中必要文件内容，拼接为 Prompt 文本注入 Opus 调用。

Opus 子进程**无任何原生文件工具**（`tools: []`）。路径受控的自定义只读工具推迟到 v0.3。

### 9.5 按 reviewPurpose 拆分的 Capsule 与 Verdict 契约

v0.2.0 的两种 `reviewPurpose` 拥有不同的 Capsule 和 Verdict 结构，不强制共用字段语义。

#### 9.5.1 Capsule 可辨识联合

```typescript
type DecisionCapsule =
  | PreImplementationCapsule
  | FailureArbitrationCapsule;

interface CapsuleBase {
  capsuleId: string;
  runId: string;
  reviewPurpose: ReviewPurpose;
  createdAt: string;
  machineContext: MachineContext;
  userSupplement: UserSupplement | null;
}

interface PreImplementationCapsule extends CapsuleBase {
  reviewPurpose: 'PRE_IMPLEMENTATION_PLAN';
  // 无失败指纹、无测试失败、无 rootCause
  deepseekAnalysis: null;  // 无施工结果可分析
  // 重点字段在 machineContext 中：gitState、fileScope、budgetStatus
}

interface FailureArbitrationCapsule extends CapsuleBase {
  reviewPurpose: 'FAILURE_ARBITRATION';
  // 必须含测试失败、失败指纹和 DeepSeek 分析
  failureFingerprint: string;
  testFailures: string[];
  deepseekAnalysis: DeepSeekAnalysis;
}
```

#### 9.5.2 OpusVerdict 可辨识联合

```typescript
type OpusVerdict =
  | PlanningVerdict
  | ArbitrationVerdict;

interface VerdictBase {
  verdict: 'PROCEED' | 'REVISE' | 'STOP';
  confidence: number;
}

interface PlanningVerdict extends VerdictBase {
  reviewPurpose: 'PRE_IMPLEMENTATION_PLAN';
  // 前置规划重点
  architectureDecision: string;
  invariants: string[];
  recommendedFiles: string[];
  requiredTests: string[];
  risks: string[];
  stopConditions: string[];
  // 无 rootCauseStatus / rootCause / evidence / contradictions（前置规划不存在失败）
}

interface ArbitrationVerdict extends VerdictBase {
  reviewPurpose: 'FAILURE_ARBITRATION';
  // 失败仲裁重点
  rootCauseStatus: 'CONFIRMED' | 'PROBABLE' | 'UNKNOWN';
  rootCause: string | null;
  evidence: EvidenceItem[];
  contradictions: ContradictionItem[];
  decision: string;
  recommendedFiles: string[];
  requiredTests: string[];
  stopConditions: string[];
}
```

关键约束：
- **不能为了结构复用强迫前置规划伪造 UNKNOWN rootCause**；
- `recommendedFiles` 只是 Opus 的建议，不是写权限授予，必须经 FileScope 校验后才能进入 `approvedFiles`；
- **两种 Verdict 的 JSON Schema 必须设置 `additionalProperties: false`**——PlanningVerdict 出现 rootCause、rootCauseStatus、contradictions 等仲裁字段时 Schema 验证必须失败；ArbitrationVerdict 出现 architectureDecision、risks、invariants 等规划专属字段时 Schema 验证必须失败；不再允许"Schema 通过但下游忽略错误字段"；
- `FINAL_BLOCKER_REVIEW` 不属于 v0.2.0，不写当前实现契约。

### 9.6 requiredTests 注入路径

`PlanningVerdict.requiredTests` 和 `ArbitrationVerdict.requiredTests` 的数组内容是 `VerificationCommand.id`，不是任意 shell 命令。

处理流程：

```
Opus requiredTests（command id 列表）
→ 主进程逐项匹配 TaskContract.verificationCommandAllowlist
→ 未命中白名单的 id 拒绝并记录
→ 命中的命令加入 VerificationPlan
→ Verifier 按顺序执行
```

```typescript
interface VerificationPlan {
  /** VerificationCommand.id 列表 */
  commandIds: string[];
  /** 来源 */
  source: 'task-contract' | 'opus-verdict' | 'machine-default';
}
```

禁止：

- 将 Opus 输出直接交给 shell；
- Opus 扩大 Bash 权限；
- 自动接受白名单之外的命令。

---

## 10. 手动接力流程

### 10.1 交互命令（按 HumanGatePurpose 拆分）

**PRE_IMPLEMENTATION_PLAN（前置门）**：

```
[o] 交给 Opus 裁决
[d] 放弃 opus-plan-first，降级为 deepseek-first（不增加 repairCycles）
[x] 停止任务
```

**FAILURE_ARBITRATION（失败门）**：

```
[o] 交给 Opus 裁决
[d] 让 DeepSeek 再修一次（repairCycles +1）
[x] 停止任务
```

**MODEL_IDENTITY_CONFIRMATION（模型身份确认门）**：

```
[a] 接受本次身份未确认的模型结果
[x] 停止任务
```

规则：
- 空输入不执行，重新提示；
- a 不重新调用模型，不产生第二次费用；
- 对 Opus 结果，确认后才允许使用该 Verdict；
- 对 DeepSeek 结果，确认后才允许进入后续验证或施工流程；
- 非交互模式必须使用独立显式 flag `--accept-unverified-model-result`，不得复用 `--approve-opus-call`。

### 10.2 Opus 调用前的信息展示

```
═══════════════════════════════════════════
  建议升级 Opus

  失败指纹：abc123
  已花费：¥2.35 / ¥10.00（任务预算）
  当日累计：¥8.50 / ¥50.00（当日上限）

  Opus 调用详情：
    Provider：opus-third-party（第三方渠道）
    请求模型：claude-opus-4-8
    预计费用：约 ¥3.00
    本次任务已调用 Opus：0 / 1 次

  ⚠ 费用为估算值，不等于最终账单。
═══════════════════════════════════════════

[o] 交给 Opus 裁决  [d] DeepSeek 再试  [x] 停止
```

### 10.3 非交互模式

```
cc-auto run "任务" --approve-opus-call
```

缺少 `--approve-opus-call` 时，在 HUMAN_GATE 停止并提示需要显式 flag。

### 10.4 Opus 调用约束

- 每次任务最多调用 Opus `maxOpusCalls` 次（默认 1，高风险任务最多 2）；
- 每次 Opus 调用前检查剩余预算；
- Opus 必须人工批准；
- Opus 完成裁决后立即退出，DeepSeek 获取裁决结果后继续施工。

---

## 11. 本地 Verifier

### 11.1 验证步骤

1. **定向测试**：与修改文件相关的测试（同名 spec → 同模块 spec → 全量测试兜底）；
2. **全量验证**（FINAL_VERIFY）：至少一次全量 `tsc --noEmit` + 一次全量 `vitest run`。

### 11.2 Flaky 检测

- 第一次失败 → 重跑一次；
- 第一次通过 → 采信；
- 两次不一致 → `FLAKY_TESTS`，STOPPED；
- 两次均失败 → 确认失败。

### 11.3 worktree 变化检测

- VERIFY / FINAL_VERIFY 运行前后比较 `computeWorktreeFingerprint()`；
- 非写阶段（writer=none）出现变化 → `WORKTREE_TAMPERED_DURING_VERIFY`，STOPPED。

### 11.4 输出

```typescript
interface VerificationResult {
  passed: boolean;
  flaky: boolean;
  output: string;
  fingerprint: string | null;
  command: string;
  durationMs: number;
  worktreeChanged: boolean;
}
```

---

## 12. 任务硬预算

### 12.1 预算模型

```typescript
interface TaskBudget {
  taskLimitRmb: number;
  absoluteLimitRmb: number;
  dailyLimitRmb: number;
}
```

### 12.2 预算检查

**配置态（INTAKE）**：
- 所有 Profile 的模型 ID 必须能在 `ProviderProfile.pricing` 中查到定价；
- 缺失 → `PRICING_NOT_FOUND`，停止，不发起任何模型请求。

**调用前**：
- 按 `requestedModelId` 查询 `ProviderProfile.pricing` → 预估费用 + 累计 → 超限则停止。

**调用后**：
- 优先按 `reportedModel` 查询价格；
- `reportedModel` 为 null 时不能伪造实际模型定价；
- 实际模型无对应定价、usage 缺失、或 usage 不足以安全计算费用：
  - `costStatus = UNAVAILABLE`；
  - **该 run 立即 `COST_UNAVAILABLE` 停止**；
  - 后续不得继续调用任何模型；
  - "已知费用下限"只用于已停止任务的报告口径，不作为继续运行的依据。

### 12.3 Opus 预算

- Opus 预算不足时**不**自动降级；
- 提示"Opus 预算不足，建议降低任务复杂度或手动修复后重试"。

---

## 13. 运行记录与恢复

### 13.1 持久化

```
.cc-auto/runs/<run-id>/
├── state.json
├── phases/
│   ├── STRATEGY_GATE.json
│   ├── DS_WORK.json
│   ├── VERIFY.json
│   ├── HUMAN_GATE.json
│   ├── OPUS_REVIEW.json
│   └── ...
├── capsules/
│   └── <capsule-id>.json
├── evidence-bundles/
│   └── <bundle-id>.json  # manifest 引用
└── report.md
```

### 13.2 RunState 扩展

```typescript
interface RunStateV2 {
  runId: string;
  taskDescription: string;
  contract: TaskContract;
  strategy: LaunchStrategy;
  currentPhase: RunPhase;
  classification: Classification;
  calls: UsageRecord[];
  pendingCall: PendingCall | null;
  failures: FailureRecord[];
  repairCycles: number;
  changedFiles: string[];
  budgetState: BudgetState;
  fileScope: FileScope;
  writerHistory: WriterRecord[];
  capsuleIds: string[];
  handoffHistory: HandoffRecord[];
  stopReason: StopReason | null;
  stopDetail: string | null;
  done: boolean;
  resumed: boolean;
  createdAt: string;
  updatedAt: string;

  // v1.2 持久化 HUMAN_GATE 上下文
  humanGatePurpose: HumanGatePurpose | null;
  identityConfirmationContext: IdentityConfirmationContext | null;
  lastFailureFingerprint: string | null;
  verificationStatus: {
    target: 'NOT_RUN' | 'PASSED' | 'FAILED' | 'FLAKY';
    full: 'NOT_RUN' | 'PASSED' | 'FAILED' | 'FLAKY';
  };
}
```

`opusCalls` 与 `spentRmb` 不独立持久化——**一律从 `calls[]` 重算**，不作为独立权威字段。

**RunState 持久化字段规则**：

- 进入 HUMAN_GATE 前持久化 `humanGatePurpose` 和 `identityConfirmationContext`；
- 离开 HUMAN_GATE 后清理这两个字段；
- 恢复任务时依赖这些字段恢复正确交互；
- `lastFailureFingerprint` 持久化，用于重复失败检测；
- `verificationStatus` 持久化，用于恢复时判断验证进度；
- 不允许只存在于内存中——所有字段写入 `state.json`。

### 13.2.2 StopReason

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

对应：

- `REPAIR_CYCLES_EXHAUSTED`：修复次数用尽；
- `USER_REJECTED_UNVERIFIED_MODEL`：用户在 MODEL_IDENTITY_CONFIRMATION 输入 x；
- `USER_DECLINED_FILE_SCOPE_EXPANSION`：用户拒绝扩展 FileScope。

不得使用模糊的 `UNKNOWN` 或 `OTHER` 替代。

### 13.2.1 PendingCall

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

### 13.3 恢复与 PendingCall 保护

**调用顺序规则**：

1. 调用**前**持久化 `pendingCall`（status=PREPARED）；
2. 真正发出请求**前**更新为 DISPATCHED；
3. 收到并完成记录后：
   - 原子写入 `calls[]`；
   - 清除 `pendingCall`（设为 null）；
4. `opusCalls`、`spentRmb` 等派生值从 `calls[]` 重算，不作为独立权威来源。

**恢复规则**：

- `resumeTask(runId)` 读取 `state.json`，首先检查 `pendingCall`；
- `pendingCall.status === 'PREPARED'`：可安全取消或重新审批（未发出请求）；
- `pendingCall.status === 'DISPATCHED'` 且 `calls[]` 中无对应完成记录：
  - 标记为 `UNKNOWN_AFTER_CRASH`；
  - **进入 HUMAN_GATE**，不自动重发；
  - 告知用户可能已产生真实费用，显示 pendingCall 的全部信息；
  - 只有用户明确批准后才允许重新调用；
- **不允许恢复时静默突破 maxOpusCalls 或预算**；
- 从 `currentPhase` 继续，不重复已完成的阶段；
- 恢复时**不**保留子进程上下文；
- 必须重新获取 Run Lease（检查 stale）；
- `resumed: true`。

---

## 14. 与 v0.1 的关系

| 维度 | v0.1 | v0.2.0 |
|------|------|--------|
| 模型 | Claude Sonnet/Haiku/Opus | DeepSeek（施工）+ Opus（仲裁） |
| Provider | 单一 Claude CLI | 多 Provider（vendor+transport 分离） |
| 锁 | write-lock（仅施工期间） | Run Lease（全程）+ writer |
| 文件范围 | allowedFiles 简单列表 | FileScope（allowedRoots/protected/approved） |
| Opus 调用 | 自动（风险阈值） | 人工批准 [o/d/x] |
| 裁决输入 | 自由文本 bundle | Evidence Bundle + 结构化 Capsule |
| 裁决输出 | 自由文本 | 结构化 OpusVerdict |
| 启动策略 | 只有 deepseek-first | 两种策略 |
| 模型身份 | 仅 modelId | acceptedReportedModelIds + 统一 null |

v0.1 延续使用的模块：`classify.ts`、`budget.ts`、`fingerprint.ts`、`store.ts`（扩展）、`report.ts`（扩展）、`safety.ts`、`redact.ts`、`git.ts`。

---

## 15. 明确不实现

1. **自动检测模型漂移**；
2. **自动调用 Opus**——必须经过 HUMAN_GATE + 明确输入 `o`；
3. **自动矛盾分类器**；
4. **自动范围膨胀**——超出 FileScope 必须人工扩展；
5. **人民币费用比例硬门禁**；
6. **GUI**；
7. **自动路由**；
8. **模型自由对话**；
9. **两个模型同时写**——writer 永远只有一个是 `deepseek`；
10. **自动 commit / push / PR / tag / release**；
11. **Gateway / SSE / Claude Desktop Profile 改写**；
12. **Opus 写权限**——v0.2.0 writer 永远不为 `opus`；
13. **独立 read-lock 文件**——由 Evidence Bundle 替代。
