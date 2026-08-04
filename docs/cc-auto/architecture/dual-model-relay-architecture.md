# cc-auto Dual Model Relay 总体技术架构书

> **状态**：总纲（长期有效）
> **版本**：v1.2 / 2026-08-04
> **受众**：Claude Opus（架构审计）、DeepSeek V4 Pro（施工依据）、维护者
>
> **冻结状态**：v0.2.0 实现基线
> **冻结日期**：2026-08-04
> **审计结论**：Claude Opus 最终封闭复核 PROCEED
>
> 后续实现过程中发现非阻断细节，进入实施记录；不再修改总体职责、权限边界、预算 fail-closed 原则和状态机主路径；架构级变化必须重新人工批准。

---

## 目录

1. [背景与问题定义](#1-背景与问题定义)
2. [产品定位](#2-产品定位)
3. [核心设计原则](#3-核心设计原则)
4. [角色与职责](#4-角色与职责)
5. [仓库级 Run Lease 与写权限](#5-仓库级-run-lease-与写权限)
6. [Provider 与密钥隔离](#6-provider-与密钥隔离)
7. [Evidence Bundle 与 Opus 访问方式](#7-evidence-bundle-与-opus-访问方式)
8. [Decision Capsule](#8-decision-capsule)
9. [预算与费用原则](#9-预算与费用原则)
10. [模型身份验证](#10-模型身份验证)
11. [文件范围模型](#11-文件范围模型)
12. [人工确认边界](#12-人工确认边界)
13. [版本路线图](#13-版本路线图)
14. [非目标范围](#14-非目标范围)
15. [已废弃 Gateway 路线](#15-已废弃-gateway-路线)
16. [长期完成标准](#16-长期完成标准)

---

## 1. 背景与问题定义

cc-auto 是 OfferFlow 项目内部的自动化工程工具链。v0.1 已实现：任务分类 → 单模型（Claude Sonnet/Haiku/Opus）子进程编排 → 验证 → 修复 → 仲裁 → 运行记录与预算闭环。

v0.1 暴露的核心问题：

1. **单点瓶颈**：所有施工都在单一 Claude 模型链上完成——低风险文案修复和高风险逻辑改动占用同一条流水线，无法按任务复杂度分流成本。
2. **成本不可控**：Claude Opus 作为唯一仲裁者，在 v0.1 中通过硬编码的 `opusShareMax`（人民币费用占比 ≤15%）约束。但 Opus 单价远高于 DeepSeek，即使 Opus 调用次数极少，费用占比也可能很大。人民币占比是错误指标。
3. **无跨 Provider 接力**：v0.1 的 scout / builder / arbiter 三个角色都由 Claude CLI 子进程执行，无法利用 DeepSeek 的低成本优势做日常施工。
4. **Gateway 路线已死**：Desktop Budget Gateway 实验（SSE 代理 + content block 注入）因稳定性与维护成本终止，费用可见性和预算控制需要新方案。
5. **缺乏结构化裁决**：v0.1 的仲裁阶段输出为自由文本（rootCause + decision），无法做机器可读的裁决分类、置信度评估与证据追溯。

Dual Model Relay 的核心命题：

> **如何在两个不同 Provider 的大模型之间，以人工确认为边界、以机器采集的事实为上下文、以单写者为约束，完成一次安全、可审计、费用可控的任务接力？**

---

## 2. 产品定位

cc-auto Dual Model Relay 不是通用多模型编排框架。它只解决一个特定场景：

- 用户在本地仓库向 cc-auto 提交一个工程任务；
- 默认由 **DeepSeek**（低成本、高吞吐）执行施工；
- 在特定条件下，由 **Claude Opus**（高可靠性、关键决策）进行只读审计或裁决；
- 施工结果由**本地机器验证**（测试、类型检查）作为事实裁判；
- 用户保留最终授权——启动、批准 Opus 调用、审批不可逆操作。

一句话：

> **DeepSeek 是默认双手，Opus 是关键保险，机器验证是裁判，用户是最终授权者。**

---

## 3. 核心设计原则

### 3.1 不对称分工

- DeepSeek 承担 ≥85% 的模型工作 Token（目标值，可在试运行后校准）。
- Opus 只在人工批准后才被调用——默认调用次数为 0。
- 简单任务 Opus 调用率为 0；常规任务默认 0 次，用户手动升级后最多 1 次；高风险任务原则上最多 2 次。
- **不追求两个模型的"均衡分工"**——DeepSeek 和 Opus 不是平等的协作者，Opus 是异常路径。

### 3.2 仓库级 Run Lease + 内部写权限

- 整个仓库同一时刻只允许一个 cc-auto run（Run Lease）。
- Run 内部通过 writer 字段（`none` / `deepseek`）管理写权限。
- v0.2.0 中 Opus 不获取写权限，writer 永远不会是 `opus`。
- 详见 [§5 仓库级 Run Lease 与写权限](#5-仓库级-run-lease-与写权限)。

### 3.3 两种启动策略

v0.2.0 支持两种启动策略，均不自动调用 Opus：

1. **deepseek-first**（默认）：DeepSeek 先施工，验证失败后再由用户决定是否交给 Opus。
2. **opus-plan-first**：用户明确选择 —— 机器先在内存中生成调用预览，用户批准 Opus 且预算检查通过后才构建完整 Evidence Bundle，Opus 输出架构合同、不变量、推荐文件和验收条件，再交给 DeepSeek 实施。

两种策略均须人工明确授权 Opus 调用。

### 3.4 不自动、不静默

- 不自动调用 Opus（v0.2.0 只提示并等待人工批准）。
- 不自动 commit / push / tag / release。
- 不静默改变预算、Provider、工作区范围。
- 不静默跳过验证。

### 3.5 证据链闭口

所有裁决必须能追溯到：
- 机器采集的原始事实（Git 状态、diff、测试输出、失败指纹）；
- DeepSeek 的分析（已确认事实 vs. 推测的明确分界）；
- 用户的补充约束。

---

## 4. 角色与职责

### 4.1 DeepSeek —— 默认施工模型

| 维度 | 说明 |
|------|------|
| 职责 | 读取任务 → 理解上下文 → 实施代码修改 → 响应验证失败 |
| 权限 | Read / Grep / Glob / Write / Edit / 受限 Bash（只允许任务合同中的验证命令白名单；禁止 `>`, `>>`, `sed -i`, `perl -pi`, `git checkout`, `git restore`, `rm`, `mv`, `cp` 覆盖源码） |
| 调用频率 | 每次任务至少一次；可多次修复 |
| 费用承担 | 承担 ≥85% 的模型工作 Token（目标值） |
| 限制 | 不能调用 Opus；不能修改 Run Lease 或 writer；不能扩大文件范围 |

DeepSeek 在一次任务中完成**必要调查与实施**，不单独拆分 Scout 角色（只有复杂或高风险任务且用户明确要求时才允许独立的 DS Scout 阶段）。

### 4.2 Claude Opus —— 关键决策保险

| 维度 | 说明 |
|------|------|
| 职责 | 只读审计 Evidence Bundle → 结构化裁决（PROCEED / REVISE / STOP） |
| 默认权限 | **禁用全部原生文件工具（`tools: []`）**；不允许 Write / Edit / Bash / Read / Grep / Glob |
| 调用条件 | 用户手动批准后（v0.2.0）；v0.3+ 可探索自动门闸 |
| 调用次数 | 常规任务最多 1 次；高风险任务原则上最多 2 次 |
| 输入 | Evidence Bundle 内容由主进程读取并拼入 Opus Prompt（v0.2.0 唯一路径） |
| 输出 | 结构化 OpusVerdict（见 [§8 Decision Capsule](#8-decision-capsule) 配套裁决格式） |

Opus 在 v0.2.0 **不获得任何文件工具**。路径受控的自定义只读工具推迟到 v0.3。Bundle 目录只作为主进程组装 Prompt 的中间产物，Opus 实际不直接访问该目录。

### 4.3 本地机器验证 —— 事实裁判

| 维度 | 说明 |
|------|------|
| 职责 | 运行测试、类型检查、验证施工结果 |
| 权限 | 只读执行（不能修改源码） |
| 输出 | 通过 / 失败 + 失败指纹 + 原始输出摘要 |

- 验证失败不静默跳过。
- flaky 检测：第一次失败时重跑一次，结果不一致则标记为不稳定（FLAKY_TESTS），停止等待人工确认。

### 4.4 用户 —— 最终授权者

用户保留以下事项的最终决定权：

- 启动任务并选择策略（deepseek-first / opus-plan-first）；
- 批准 Opus 调用；
- 批准 Opus 写权限（v0.3+）；
- 提高预算；
- push / tag / release；
- 生产迁移；
- 不可逆 Git 操作；
- 修改真实 Provider 配置；
- 扩展文件范围。

---

## 5. 仓库级 Run Lease 与写权限

### 5.1 Run Lease

路径：`.cc-auto/run-lock.json`

职责：同一仓库同一时刻只允许一个 cc-auto run。

```jsonc
{
  "runId": "run-...",
  "pid": 12345,
  "repositoryRoot": "/abs/path/to/repo",
  "acquiredAt": "2026-08-04T10:00:00.000Z",
  "heartbeatAt": "2026-08-04T10:00:30.000Z",
  "worktreeFingerprintAtStart": "abc123",
  "writer": "deepseek"
}
```

- `writer` 字段表示当前 run 内部谁有写权限：`none` 或 `deepseek`（v0.2.0 不允许 `opus`）。
- Run Lease 在 INTAKE 获取，DONE / STOPPED 时释放，**贯穿全部状态**。
- 防止两个 cc-auto 任务交叉修改或验证错误 worktree。
- 验证、Opus 审计和 DeepSeek 施工期间均保持 Run Lease。
- 进程存活检测 + heartbeat。
- stale lease 恢复**必须请求用户确认**，不得仅因 PID 不存在就静默删除锁。
- Verifier 发现工作区在非写阶段（writer=none）发生文件变化时立即 STOPPED。

### 5.1.1 WorktreeFingerprint 算法

替代原未定义的 `computeWorktreeHash`，明确为 `computeWorktreeFingerprint()`：

1. `git status --porcelain=v1 --untracked-files=all` 的规范化输出（排序后）；
2. 已跟踪文件的 `git diff` 内容 SHA256；
3. staged diff（`git diff --staged`）的内容 SHA256；
4. 未跟踪但未被 `.gitignore` 忽略的文件：相对路径 + 文件内容 SHA256；
5. 排除：`.cc-auto/`、`.git/`、gitignored 缓存和构建产物。

指纹目标：
- 检测被 Git 感知的源码和配置变化；
- 不承诺检测所有被 `.gitignore` 忽略的文件；
- Verifier 不修改被跟踪源码，但允许工具在 gitignored 目录产生缓存或构建产物；
- `VERIFY` 前后指纹不一致且 `writer=none` 时 STOPPED。

### 5.2 writer 生命周期

```
none → deepseek → none → deepseek → none
```

- DeepSeek 获取 writer（`deepseek`）后才能修改文件。
- DeepSeek 施工完成后必须释放 writer（`none`），再进入验证。
- Opus 不获取 writer——v0.2.0 中 writer 永远不是 `opus`。
- 如果进程崩溃（未正常释放 writer），recovery 必须在用户确认后重置 writer。

### 5.3 不再有独立 read-lock

删除了原设计中的独立 `read-lock.json`。Opus 不直接读取临时目录或真实仓库。Evidence Bundle 仅作为主进程生成脱敏 Prompt 的中间产物；Opus 使用 `tools: []`，只能看到主进程明确注入的文本内容。

---

## 6. Provider 与密钥隔离

### 6.1 原则

- DeepSeek 子进程只获得 DeepSeek 所需环境变量；
- Opus 子进程只获得 Opus 所需环境变量；
- 密钥名称可记录，密钥正文绝不落盘、不进入日志、不进入运行记录；
- Provider 切换不得依赖 Claude Desktop 重启；
- 不修改 CC Switch 数据库；
- 不依赖 Gateway / SSE 注入。

### 6.2 ProviderProfile 抽象

```typescript
interface ProviderProfile {
  /** 本地唯一标识，用户自定义（如 "deepseek-v4-pro" / "opus-third-party"） */
  id: string;
  /** 显示名称 */
  displayName: string;

  /** 厂商 */
  vendor: 'deepseek' | 'anthropic' | 'third-party';

  /** 传输协议——Adapter 据此选择 SDK */
  transport: 'openai-chat' | 'anthropic-messages' | 'claude-cli';

  /** API endpoint（claude-cli 可省略） */
  apiBaseUrl?: string;

  /** 凭证环境变量名列表（不存值） */
  credentialEnvVars: string[];
  /** 运行时环境变量白名单 */
  runtimeEnvAllowlist: string[];
  /** 静态非敏感环境变量 */
  staticEnv?: Record<string, string>;

  /** 默认请求模型 ID */
  defaultModelId: string;
  /** 支持的模型列表 */
  models: ModelIdentity[];
  /** 按模型 ID 的定价表 */
  pricing: Record<string, ModelPricing>;
}
```

关键规则：

- Adapter 根据 `transport` 选择协议，不根据 `vendor` 决定协议。
- DeepSeek 可以通过 `openai-chat` 或 `anthropic-messages` 协议访问。
- Claude Opus 可以通过 `anthropic-messages`（官方 API）、`openai-chat`（第三方兼容 API）或 `claude-cli`（本地 CLI）访问。
- 不硬编码具体第三方渠道名称。
- `credentialEnvVars` 声明凭证变量名，`staticEnv` 只能保存非敏感值。
- 被识别为密钥的字段禁止写入 `staticEnv`。

### 6.3 模型身份

```typescript
interface ModelIdentity {
  /** 本地逻辑名称 */
  logicalName: string;
  /** 实际请求时发送的模型 ID */
  requestedModelId: string;
  /** Provider 可能返回的可接受模型 ID 列表 */
  acceptedReportedModelIds: string[];
  /** 显示名称 */
  displayName: string;
}
```

- `logicalName` = 本地 Profile 内部引用名（如 `"opus"` / `"deepseek"`）。
- `requestedModelId` = 实际发送给 Provider 的字符串。
- `acceptedReportedModelIds` = Provider 可能返回的模型 ID 白名单。
- 模型身份比对不再直接拿 Profile ID 与 `reportedModel` 比较，而是检查 `reportedModel` 是否在 `acceptedReportedModelIds` 中。
- **定价不在此结构中**——唯一真相来源是 `ProviderProfile.pricing: Record<string, ModelPricing>`（见 §6.2）。

---

## 7. Evidence Bundle 与 Opus 访问方式

### 7.1 统一方案

Opus **不直接访问真实仓库，也不直接访问 Evidence Bundle 临时目录**。v0.2.0 采用 v0.1 已验证的安全路径：

- Opus 调用**禁用全部原生文件工具**（`tools: []`）；
- Evidence Bundle 中经过脱敏和限额的内容，由 cc-auto 主进程读取并拼接进 Opus Prompt；
- Opus 只能看到主进程明确发送的内容；
- 路径受控的自定义只读工具推迟到 v0.3。

Bundle 目录仅作为主进程组装 Prompt 的中间产物，不向 Opus 子进程暴露为 cwd。

Bundle 内容（中间产物）：

```
<mkdtemp 随机目录>/
├── capsule.json             # Decision Capsule
├── task-contract.json       # TaskContract 摘要
├── git-status.txt           # Git 状态
├── diff.patch               # diff 输出
├── test-summary.txt         # 测试输出摘要
├── failure-fingerprint.json # 失败指纹
├── referenced-files/        # 白名单源码文件（按原相对路径结构）
│   └── src/
│       ├── foo.ts
│       └── foo.spec.ts
├── evidence-sources/         # Capsule 中引用的源码片段
└── manifest.json            # 来源路径、内容哈希、脱敏状态
```

### 7.2 规则

- Opus 子进程**无任何文件工具**（`tools: []`），不设 cwd 为 Bundle 目录。
- 主进程读取 Bundle 中必要文件内容，拼接为 Prompt 文本注入 Opus 调用——这是 v0.2.0 的唯一路径。
- 不复制密钥、`.env`、用户敏感 Prompt 或未授权文件。
- `manifest.json` 记录每个文件的来源路径、SHA256 哈希和脱敏状态。
- Capsule 中的证据引用必须能追溯到 Bundle 中的具体文件。

### 7.3 未来方向（v0.3+）

路径受控的自定义只读工具（允许 Opus 在受约束的 Bundle 目录内读取）推迟到 v0.3 探索。v0.2.0 不做任何 Opus 文件工具。

---

## 8. Decision Capsule

Decision Capsule 是 Opus 裁决的入口上下文。它不等同于"DeepSeek 对自己工作的总结"——它由**三部分**组成，其中第一部分（机器采集）不由任何模型编写。

### 8.1 结构

#### 第一部分：机器自动采集

- 任务合同（TaskContract）；
- 当前 Git 状态（branch、HEAD hash、dirty files）；
- worktree / commit 标识；
- 修改文件列表（相对路径）；
- diff 摘要（每个修改文件的增删行数）；
- 测试命令与原始结果摘要；
- 失败指纹；
- 文件范围（FileScope，含 allowedRoots / protectedPaths / approvedFiles）；
- 已花费用与剩余预算（按 Provider 返回的 Token 与配置单价计算的估算费用，不等于最终账单）。

#### 第二部分：DeepSeek 分析

- 已确认事实（如"测试 X 因断言 Y 失败"）；
- 尚未确认的推测（如"可能是 Z 模块的副作用"，明确标记为推测）；
- 当前判断（为什么认为需要 Opus 介入）；
- 可选方案及代价（至少 2 个方案）；
- 需要 Opus 回答的**唯一问题**（不超过 3 个）。

#### 第三部分：用户补充

- 人工约束（如"不能改 database schema"）；
- 现实背景（如"这个改动需要在 prod 前兼容旧数据"）；
- 对不可逆操作的授权状态。

### 8.2 Capsule 与 Evidence Bundle 的关系

- Capsule 是 Opus 的"目录"——引用了哪些文件、哪些测试输出、哪些 diff。
- Evidence Bundle 是 Opus 的"书架"——Capsule 引用的所有内容都在 Bundle 中。
- Opus 通过 Capsule 理解上下文，通过 Bundle 核对原始证据。

### 8.3 配套裁决格式

```jsonc
{
  "verdict": "PROCEED | REVISE | STOP",
  "rootCauseStatus": "CONFIRMED | PROBABLE | UNKNOWN",
  "rootCause": "string | null",
  "evidence": [
    {
      "source": "referenced-files/src/foo.ts:42 | diff.patch | test-summary.txt | capsule.json",
      "claim": "证据支持的主张",
      "strength": "STRONG | WEAK"
    }
  ],
  "contradictions": [
    {
      "description": "与已有证据矛盾的发现",
      "sources": ["来源1", "来源2"]
    }
  ],
  "decision": "裁决理由的完整叙述",
  "invariants": ["不可违反的约束1"],
  "recommendedFiles": ["Opus 建议修改的文件路径（非授权——必须经 FileScope 校验后才能成为 approvedFiles）"],
  "requiredTests": ["必须运行的测试命令"],
  "stopConditions": ["触发立即停止的条件"],
  "confidence": 0.85
}
```

关键约束：

- `UNKNOWN` 是合法的 `rootCauseStatus`——根因未确认时不得包装成确定事实；
- `evidence` 每项必须能追溯到 Bundle 中的具体文件；
- **`recommendedFiles` 只是 Opus 的建议**，不能直接授予 DeepSeek 写权限；主进程必须将 recommendedFiles 送入 FileScope 校验（位于 allowedRoots 内、不命中 protectedPaths、不超过 maxChangedFiles），经规则或用户批准后才能进入 approvedFiles；
- Opus 默认无写权限，裁决完成后退出，由 DeepSeek 实施；
- 即使 `verdict` 为 `PROCEED`，也不意味着 Opus 认可代码正确——只表示"没有发现需要阻止的理由"。

---

## 9. 预算与费用原则

### 9.1 核心修正

v0.1 使用人民币费用占比（`opusShareMax`）作为 Opus 调用次数的硬约束。这是**错误指标**，原因：

- DeepSeek 单价远低于 Opus；
- DeepSeek 即使承担绝大多数 Token，少量 Opus 调用仍可能在人民币费用上占大头；
- 人民币占比无法反映"Opus 是否被合理使用"。

**v0.2.0 修正为**：

| 指标 | 类型 | 说明 |
|------|------|------|
| DeepSeek 承担 ≥85% 模型工作 Token | 目标值 | 可在试运行后校准，非硬门禁 |
| 简单任务 Opus 调用率 = 0 | 硬约束 | 代码实现保证（不路由到 Opus） |
| 常规任务默认 0 次 Opus | 默认值 | 用户手动升级后最多 1 次 |
| 高风险任务最多 2 次 Opus | 硬约束 | 程序限制（`maxOpusCalls`） |
| 每任务不超过用户硬预算 | 硬约束 | 程序门闸（预算耗尽即停止） |
| 人民币费用占比 | 仅记录 | 不作为 v0.2.0 硬 KPI |

重点衡量指标：

1. 总费用（按 Provider 返回的 Token 与配置单价计算的估算费用，不等于最终账单）；
2. 返工次数（repairCycles）；
3. 任务成功率（DONE / 总任务数）；
4. Opus 调用必要性（裁决后问题是否解决）。

### 9.2 费用显示规则与未知费用处理

- 所有费用必须表述为"按 Provider 返回的 Token 与配置单价计算的估算费用，不等于最终账单"；
- 无法估算时显示 `UNAVAILABLE`，**不得**显示为 `¥0.00`；
- **不得**伪造精确费用。

**配置态缺价**：
- INTAKE 阶段所有 Profile 模型 ID 必须能查到定价（`ProviderProfile.pricing`）；
- 缺失则 `PRICING_NOT_FOUND`，立即停止，不发起任何模型请求。

**运行时费用未知**：
- 调用后出现 `reportedModel` 无对应定价、usage 缺失、或 usage 不足以安全计算费用 → `costStatus = UNAVAILABLE`；
- 该 run 立即 `COST_UNAVAILABLE` 停止；
- 后续不得继续调用任何模型；
- "已知费用下限"只用于已停止任务的报告口径，不作为继续运行的依据。

---

## 10. 模型身份验证

### 10.1 目标

确保"声称使用的模型"与"实际调用的模型"一致，防止 Provider 静默降级或路由错误。

**门禁规则**：

| 状态 | 行为 |
|------|------|
| `VERIFIED` | 正常继续 |
| `MISMATCH` | **立即 STOPPED**（`MODEL_IDENTITY_MISMATCH`），不重试、不静默降级、不允许该次 Opus 裁决驱动后续施工 |
| `UNVERIFIED` | **进入 HUMAN_GATE**，不得自动继续；必须显示 requestedModelId、reportedModel=null、Provider Profile、模型身份未确认、预计费用状态；用户必须再次确认是否接受身份未验证的结果；非交互模式缺少显式 flag 时停止；报告、Capsule 和裁决记录必须标记 `identityUnverified=true` |

### 10.2 统一状态枚举

模型身份状态：

| 状态 | 含义 |
|------|------|
| `VERIFIED` | `reportedModel` 在 `acceptedReportedModelIds` 中 |
| `MISMATCH` | `reportedModel` 不在 `acceptedReportedModelIds` 中 |
| `UNVERIFIED` | Provider 未返回可靠模型 ID（`reportedModel` 为 null） |

用量状态（UsageStatus）：

| 状态 | 含义 |
|------|------|
| `AVAILABLE` | usage 数据完整 |
| `MISSING` | Provider 未返回任何 usage 信息 |
| `PARTIAL` | usage 部分字段缺失 |

定价状态（PricingStatus）：

| 状态 | 含义 |
|------|------|
| `PRICED` | 实际模型 ID 命中价格表 |
| `UNPRICED` | 实际模型 ID 不在价格表中 |

费用状态（CostStatus）：

| 状态 | 含义 |
|------|------|
| `AVAILABLE` | 费用可估算 |
| `UNAVAILABLE` | 费用无法估算（缺失 usage 或未定价） |

### 10.3 null 语义统一

所有"未知"字段必须使用 `null`，不能用 `0` 表示未知：

- `reportedModel: string | null`
- `inputTokens: number | null`
- `outputTokens: number | null`
- `cacheCreationInputTokens: number | null`
- `cacheReadInputTokens: number | null`
- `costRmbCustom: number | null`
- `costRmbOfficial: number | null`
- `durationMs: number | null`

规则：

- Token 数确实为 0 时可以记录 0；
- Provider 未返回该字段时必须记录 `null`；
- usage 缺失时不得把 Token 记录为 0；
- 价格未知时费用为 `null`；
- usage 缺失或不完整时费用为 `null`；
- 报告不得把 `null` 显示为 `¥0.00`；
- 已知费用合计存在 `null` 调用时，已停止任务的报告可标注"已知下限"，但不得作为继续运行的依据。

---

## 11. 文件范围模型

### 11.1 FileScope

替代原来的简单 `allowedFiles: string[]` 设计：

```typescript
interface FileScope {
  /** 允许修改的目录或文件前缀 */
  allowedRoots: string[];
  /** 明确禁止触碰的路径 */
  protectedPaths: string[];
  /** DeepSeek 提出的候选文件 */
  proposedFiles: string[];
  /** 已批准可写入的文件 */
  approvedFiles: string[];
  /** 最大修改文件数 */
  maxChangedFiles: number;
}
```

### 11.2 流程

1. 机器根据任务生成初始 `allowedRoots` / `protectedPaths`；
2. DeepSeek 在写入前提出 `proposedFiles`；
3. 如果 `proposedFiles` 位于 `allowedRoots` 内且不触碰 `protectedPaths`，程序可按任务合同规则批准（加入 `approvedFiles`）；
4. 超出 `allowedRoots`、触碰 `protectedPaths` 或超过 `maxChangedFiles`，必须请求用户扩展范围；
5. **写入前执行点**：Write / Edit 执行前对目标路径执行 `path.resolve` + `path.relative` 校验，拒绝绝对路径、路径穿越和符号链接逃逸，必须精确命中 `approvedFiles`；未批准路径返回工具级 DENIED，不落盘；
6. **Bash 约束**：采用 TaskContract 中的命令白名单，只允许明确的验证命令；拒绝输出重定向（`>`、`>>`）和能原地修改文件的命令（`sed -i`、`perl -pi`、`git checkout`、`git restore`、`rm`、`mv`、`cp` 覆盖源码），不得把 Bash 当作绕过 Write/Edit 的写入通道；
7. 施工结束后的 `git diff` 校验是第二层防线，不是主要授权机制；
8. 越权写入在工具执行前拒绝；若仍发现实际越权改动，则 STOPPED 并保留现场等待人工处理，不自动回滚。

简单且明确的任务可以在 INTAKE 直接生成 `approvedFiles`，跳过 proposed 阶段。

---

## 12. 人工确认边界

### 12.1 无需确认（自动执行）

- 任务分类；
- 策略选择（deepseek-first / opus-plan-first 由用户一次性选定）；
- DeepSeek 施工（在 FileScope 与预算范围内）；
- 本地机器验证；
- 调用预览生成（内存中，不落盘临时文件）；
- Decision Capsule 生成；
- 运行记录保存。

**Evidence Bundle 构建**不属于自动执行：只在用户于 HUMAN_GATE 明确输入 `o` 且预算与模型配置检查通过后，才构建完整 Bundle 并调用 Opus。

### 12.2 必须人工确认

| 事项 | v0.2.0 | 说明 |
|------|--------|------|
| 调用 Opus | ✅ 必须 | 必须输入明确的 `o` 命令 |
| 非交互模式 Opus | ✅ 必须显式 flag | `--approve-opus-call` |
| 扩展文件范围 | ✅ 必须 | 超出 allowedRoots / 触碰 protectedPaths |
| Opus 写权限 | ❌ 不实现 | 推迟到 v0.3+ |
| 提高任务预算 | ✅ 必须 | 预算耗尽时提示 |
| push / tag / release | ✅ 必须 | 安全规则生效 |
| 生产迁移 | ✅ 必须 | 同上 |
| 不可逆 Git 操作 | ✅ 必须 | 同上 |
| stale lease 清理 | ✅ 必须 | 不得静默删除 |

### 12.3 Opus 调用人工确认交互

统一交互命令：

```
[o] 交给 Opus 裁决
[d] 不调用 Opus，改用备选路径
[x] 停止任务
```

规则：

- **无默认选项**，空输入不执行任何动作，重新提示；
- 任何 Opus 调用前必须再次显示：预计费用、剩余预算、Provider Profile、requestedModelId、Opus 已调用次数；
- 用户必须输入明确的 `o` 才能调用 Opus；
- 非交互模式必须提供显式 flag `--approve-opus-call`；
- 缺少 flag 时停止，不能自动批准。

**`d` 的语义按上下文拆分**：

| HUMAN_GATE 上下文 | `d` 的含义 | repairCycles |
|---|---|---|
| `PRE_IMPLEMENTATION_PLAN`（前置门） | 放弃 opus-plan-first，策略降级为 deepseek-first，进入 DS_WORK | **不增加** |
| `FAILURE_ARBITRATION`（失败门） | 让 DeepSeek 再修一次 | **+1** |

两种上下文的 `d` 在交互提示中必须显示不同的说明文案。

### 12.4 CLI 策略选择

```
--strategy deepseek-first    (默认)
--strategy opus-plan-first
```

或等价的交互选择。opus-plan-first 必须先由用户明确批准 Opus 调用，批准且预算与配置检查通过后才构建完整 Evidence Bundle。

---

## 13. 版本路线图

### v0.2.0 —— 手动双模型接力 MVP

- 两种启动策略（deepseek-first / opus-plan-first）；
- Provider Adapter（vendor 与 transport 分离）；
- 子进程环境隔离（支持 Windows 与第三方渠道）；
- 模型身份与 Token 记录（统一 null 语义）；
- 仓库级 Run Lease + 内部 writer；
- Evidence Bundle + Decision Capsule；
- 手动接力（系统提示 → 人工批准 `o` → Opus 裁决 → DeepSeek 实施）；
- 本地 Verifier；
- 文件范围模型；
- 任务硬预算；
- 运行记录和基础恢复。

详见 [versions/v0.2.0-manual-relay/technical-design.md](../versions/v0.2.0-manual-relay/technical-design.md)。

### v0.2.1 —— 信号增强（计划，不提前设计）

在 10–20 个真实任务数据基础上增加：
- 失败指纹建议；
- 矛盾提示；
- 范围膨胀提示；
- 建议升级 Opus 的提示质量改进。

**仍需用户确认，不自动调用 Opus。**

### v0.3 —— 条件自动化（计划，不提前设计）

数据证明阈值可靠后探索：
- 自动门闸；
- 轻量 GUI；
- 阈值校准；
- 自动但可中断的接力。

**v0.3 不做设计细节，不提前实现。**

---

## 14. 非目标范围

以下内容明确**不在** Dual Model Relay 任何版本的计划内：

- 两个模型同时写工作区；
- 模型自由对话（无结构化裁决）；
- 自动 commit / push / PR / tag / release；
- Gateway / SSE 透明代理；
- Claude Desktop Profile 改写；
- CC Switch 数据库耦合；
- 自动投递、自动搜索、自动翻页（BOSS 自动化边界）；
- 绕过 Human-in-the-loop；
- 模型"投票"机制；
- 通用多模型编排框架。

---

## 15. 已废弃 Gateway 路线

Claude Desktop Budget Gateway 实验已于 2026-08-04 正式终止。详细归档见 [research/desktop-budget-gateway-abandoned.md](../research/desktop-budget-gateway-abandoned.md)。

**终止原因**：维护成本、协议不确定性和收益不匹配。

**明确禁止重新启用**：
- SSE content block 注入；
- Gateway 下游透明代理；
- Claude Desktop Profile 改写；
- CC Switch 数据库耦合。

**可复用部分**（已在 v0.1 中吸收）：
- Token 用量统计与费用计算（`budget.ts`）；
- 预算门禁逻辑（`budget.ts`）；
- 模型费用报告（`report.ts`）；
- 运行记录持久化（`store.ts`）。

---

## 16. 长期完成标准

Dual Model Relay 达到"完成"状态时，必须同时满足：

1. **费用可控**：用户可以为每个任务设置硬预算，预算耗尽自动停止，费用不会静默超支。
2. **模型可审计**：每次 Opus 调用都有完整的 Evidence Bundle + OpusVerdict 记录，事后可回溯。
3. **身份可确认**：每次模型调用的 `reportedModel` 都被记录并与 `acceptedReportedModelIds` 比对；`MISMATCH` 立即 STOPPED（`MODEL_IDENTITY_MISMATCH`），不重试、不降级；`UNVERIFIED` 进入 HUMAN_GATE 要求用户二次确认，报告标记 `identityUnverified=true`。
4. **单写者无冲突**：Run Lease 保证同一仓库同一时刻只有一个 run；writer 字段保证 run 内部只有一个模型可写。
5. **无 Gateway 依赖**：Dual Relay 独立运行，不依赖 Claude Desktop 重启、SSE 注入、CC Switch 数据库。
6. **人工在回路中**：Opus 调用、不可逆操作始终需要人工确认。
7. **可恢复**：进程重启后，运行记录可以定位到中断点；任务可以从固定输入重新执行（不冒充断点续跑）。
