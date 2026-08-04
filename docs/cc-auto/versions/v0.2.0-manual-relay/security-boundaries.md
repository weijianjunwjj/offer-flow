# cc-auto Dual Model Relay v0.2.0 安全与权限边界

> **状态**：v0.2.0 手动接力 MVP 安全设计
> **版本**：v1.2 / 2026-08-04
> **依赖**：[technical-design.md](technical-design.md)

---

## 目录

1. [子进程环境隔离](#1-子进程环境隔离)
2. [日志禁止内容](#2-日志禁止内容)
3. [Run Lease 与 writer 约束](#3-run-lease-与-writer-约束)
4. [角色权限矩阵](#4-角色权限矩阵)
5. [文件范围模型安全](#5-文件范围模型安全)
6. [Evidence Bundle 安全](#6-evidence-bundle-安全)
7. [人工批准事项](#7-人工批准事项)
8. [不可逆操作防护](#8-不可逆操作防护)
9. [密钥与凭证管理](#9-密钥与凭证管理)

---

## 1. 子进程环境隔离

### 1.1 原则

- 父进程（cc-auto CLI）的环境变量不被任何子进程永久修改；
- 每个 Provider 子进程**只**获得 Profile 的 `runtimeEnvAllowlist` + `credentialEnvVars` + `staticEnv`；
- 不使用 `{ ...process.env }` 全量继承；
- 密钥**绝不**落盘。

### 1.2 环境变量构建

基于 ProviderProfile：

```typescript
function buildChildEnv(profile: ProviderProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  // 白名单
  for (const key of profile.runtimeEnvAllowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  // 凭证
  for (const key of profile.credentialEnvVars) {
    const value = process.env[key];
    if (!value) throw new Error(`${key} 未设置（Profile ${profile.id} 需要）`);
    env[key] = value;
  }

  // 静态非敏感变量
  if (profile.staticEnv) Object.assign(env, profile.staticEnv);

  return env;
}
```

### 1.3 Windows 默认白名单

`runtimeEnvAllowlist` 至少包含：

- `PATH`、`SystemRoot`、`ComSpec`、`PATHEXT`
- `TEMP`、`TMP`
- `USERPROFILE`、`APPDATA`、`LOCALAPPDATA`
- `HOME`

### 1.4 第三方渠道环境隔离

第三方 Opus Profile 示例：

```jsonc
{
  "credentialEnvVars": ["ANTHROPIC_AUTH_TOKEN"],
  "runtimeEnvAllowlist": ["PATH", "HOME", "SystemRoot", "TEMP", "TMP"],
  "staticEnv": {
    "ANTHROPIC_BASE_URL": "https://third-party.example.com/v1"
  }
}
```

规则：

- DeepSeek 子进程不得获得 Opus 凭证；
- Opus 子进程不得获得 DeepSeek 凭证；
- `staticEnv` 只能保存非敏感值，被识别为密钥的字段禁止写入；
- 缺失必需变量时 fail closed（抛出错误，不降级）。

### 1.5 互污染检测（v0.2.1+）

- 检测子进程输出中的其他 Provider 密钥模式；
- v0.2.0 通过显式 env 构建已保证基本隔离。

---

## 2. 日志禁止内容

以下内容**不得**出现在任何日志、运行记录、报告、Decision Capsule、Evidence Bundle 或 stdout/stderr 输出中：

| 禁止内容 | 说明 |
|----------|------|
| API Key（`sk-...` 等） | 任何 Provider 的密钥正文 |
| `Authorization` 请求头 | HTTP 认证头完整值 |
| `Cookie` 请求头 | 会话信息 |
| `.env` 文件正文 | 环境变量配置 |
| 完整系统提示词 | 只记录版本哈希 |
| 用户敏感 Prompt | 脱敏后保留摘要 |
| 工具参数中的敏感数据 | `--password`、`--token` 等 |

### 2.1 脱敏机制

沿用 v0.1 的 `redact.ts`，扩展 DeepSeek API Key 模式。

### 2.2 允许记录

| 内容 | 示例 |
|------|------|
| 凭证环境变量**名** | `credentialEnvVars: ["ANTHROPIC_AUTH_TOKEN"]` |
| 模型 ID | `reportedModel: "deepseek-chat"` |
| Provider 标识 | `providerId: "opus-third-party"` |
| Token 用量 | `inputTokens: 1234`（或 `null`） |
| 费用估算 | `costRmbCustom: 0.023`（或 `null`） |
| 提示词版本哈希 | `systemPromptHash: "abc123"` |

---

## 3. Run Lease 与 writer 约束

### 3.1 Run Lease

路径：`.cc-auto/run-lock.json`

- Run Lease 在 INTAKE 获取，DONE/STOPPED 释放，**贯穿全部状态**；
- 同一仓库同一时刻只允许一个 cc-auto run；
- 进程存活检测 + heartbeat；
- stale lease 必须请求用户确认，**不得**仅因 PID 不存在就静默删除；
- 进程退出时通过 `process.on('exit')` 兜底释放。
- `worktreeFingerprintAtStart` 由 `computeWorktreeFingerprint()` 计算（算法见 technical-design §7.3.1）。

### 3.2 writer 管理

- writer 获取：DS_WORK 或 DS_APPLY 开始时（writer=deepseek）；
- writer 释放：验证阶段开始前（writer=none）；
- v0.2.0 中 writer 永远不为 `opus`；
- writer 由 Node.js 代码管理（`fs.writeFileSync`），不依赖模型自觉。

### 3.3 Verifier 的 worktree 变化检测

- VERIFY / FINAL_VERIFY 运行前后比较 `computeWorktreeFingerprint()`；
- 非写阶段（writer=none）出现变化 → `WORKTREE_TAMPERED_DURING_VERIFY`，STOPPED；
- gitignored 缓存产物（`node_modules/.vite/`、`test-results/` 等）不触发误报。

---

## 4. 角色权限矩阵

### 4.1 DeepSeek Builder

| 权限 | 允许 | 说明 |
|------|------|------|
| Read / Grep / Glob | ✅ | 仓库内 |
| Write / Edit | ✅ | 仅 `approvedFiles` 内，执行前由主进程校验 |
| Bash（受限） | ✅ | 仅 TaskContract.verificationCommandAllowlist 中的命令；禁止 shell 模式执行；禁止 `>`、`>>`、`|`、`&&`、`;`；禁止 `sed -i`、`perl -pi`、`git checkout`、`git restore`、`rm`、`mv`、`cp` 覆盖源码 |
| Git 写操作 | ❌ | 不可 commit/push/tag/branch |
| 修改 Run Lease | ❌ | 程序级管理 |
| 修改配置 | ❌ | Provider 配置、预算配置只读 |
| 访问其他 Provider 密钥 | ❌ | 环境隔离 |

### 4.2 DeepSeek Scout（独立使用，v0.2.1+）

| 权限 | 允许 | 说明 |
|------|------|------|
| Read / Grep / Glob | ✅ | 仓库内 |
| Write / Edit / Bash | ❌ | 不允许 |
| Git 操作 | ❌ | 不允许 |

### 4.3 Opus Reviewer

| 权限 | 允许 | 说明 |
|------|------|------|
| Read / Grep / Glob / Write / Edit / Bash | ❌ | v0.2.0 禁用全部原生文件工具（`tools: []`） |
| Evidence Bundle 内容 | ✅ | 由主进程读取后拼入 Prompt（v0.2.0 唯一路径） |
| Git 操作 | ❌ | 禁止 |
| 提交 / 发布 | ❌ | 禁止 |
| 访问真实仓库 | ❌ | 不设 cwd 为仓库 |
| 修改 Run Lease / writer | ❌ | 禁止 |

### 4.4 本地 Verifier

| 权限 | 允许 | 说明 |
|------|------|------|
| 执行 vitest / tsc | ✅ | 定向/全量 |
| 读取测试输出 | ✅ | 生成失败摘要 |
| 修改被跟踪源码 | ❌ | 禁止修改 |
| 写入 gitignored 缓存产物 | ⚠️ 允许 | vitest/tsc 写 `node_modules/.vite/`、`test-results/` 等不会触发误报（WorktreeFingerprint 排除 .gitignore 命中路径） |
| Git 操作 | ❌ | 禁止 |

---

## 5. 文件范围模型安全

### 5.1 FileScope 分层

```
allowedRoots（允许区域）
  ├── proposedFiles（DeepSeek 提案）
  │   └── approvedFiles（机器/用户批准后可写）
  └── protectedPaths（禁止触碰）
```

### 5.2 规则

- 写入前必须提案（proposedFiles），批准后才能写入（approvedFiles）；
- **写入前执行点**：Write / Edit 执行前对目标路径做 `path.resolve` + `path.relative` 校验，拒绝绝对路径、路径穿越和符号链接逃逸，必须精确命中 `approvedFiles`；未批准路径返回工具级 DENIED，不落盘；
- **Bash 约束**：采用 TaskContract 命令白名单；拒绝 `>`、`>>` 重定向和 `sed -i`、`perl -pi`、`git checkout`、`git restore`、`rm`、`mv`、`cp` 覆盖源码等绕过写权限的命令；
- 超出 allowedRoots 或触碰 protectedPaths → 请求用户扩展；
- 施工后 `git diff` 实际文件清单 vs `approvedFiles`（第二层防线）；
- 超出范围 → `FILE_SCOPE_VIOLATION`，STOPPED，保留现场等待人工处理，不自动回滚；
- 简单任务可在 INTAKE 直接生成 `approvedFiles`。

### 5.3 路径穿越防护

- 所有写入操作经过 `path.resolve` + `path.relative` 校验；
- 绝对路径和 `..` 穿越路径一律拒绝；
- 拒绝符号链接逃逸。
- Bundle 复制时解析并拒绝符号链接，只复制常规文件；逐个文件校验真实路径位于 repositoryRoot。

### 5.4 Bash 命令白名单执行模型

DeepSeek 子进程的 Bash 权限通过 `TaskContract.verificationCommandAllowlist` 控制：

- 白名单中每个命令为 `VerificationCommand`，包含 `id`、`executable`、`args[]`、`cwd`；
- `executable` 与 `args` 分离，禁止 shell 模式执行；
- 禁止重定向（`>`、`>>`）、管道（`|`）和命令拼接（`&&`、`;`）；
- `requiredTests` 不是任意 Bash 命令，只能引用白名单中的 `VerificationCommand.id`；
- 不允许模型直接提交任意 shell 字符串。

### 5.5 requiredTests 注入路径

`PlanningVerdict.requiredTests` 和 `ArbitrationVerdict.requiredTests` 的内容是 `VerificationCommand.id` 列表，不是 shell 命令字符串。

处理流程：

```
Opus requiredTests（command id 列表）
→ 主进程逐项匹配 TaskContract.verificationCommandAllowlist
→ 未命中白名单的 id 拒绝并记录
→ 命中的命令加入 VerificationPlan
→ Verifier 按顺序执行
```

禁止：

- 将 Opus 输出直接交给 shell；
- Opus 扩大 Bash 权限；
- 自动接受白名单之外的命令。

---

## 6. Evidence Bundle 安全

### 6.1 Bundle 构建

Bundle 仅在用户于 HUMAN_GATE 明确输入 `o` 且预算与模型配置检查通过后才构建。

```
<fs.mkdtemp 随机目录>/
├── capsule.json
├── task-contract.json
├── git-status.txt
├── diff.patch
├── test-summary.txt
├── failure-fingerprint.json
├── referenced-files/      # 白名单源码
├── evidence-sources/      # Capsule 引用的源码片段
└── manifest.json          # 来源路径、SHA256、脱敏状态
```

### 6.2 规则

- 使用 `fs.mkdtemp` 创建不可预测随机临时目录（不使用 `/tmp/cc-auto-arbiter-<runId>/` 等可预测路径）；
- 权限设置为当前用户可访问；
- 只复制 white-listed 文件（FileScope 内 + Capsule 引用的文件）；
- 复制时拒绝符号链接，只复制常规文件；逐个文件校验真实路径位于 repositoryRoot；
- 限制总文件数、单文件大小和 Bundle 总大小；
- 所有内容先脱敏再写入临时目录；
- **不**复制密钥文件、`.env`、`node_modules`、`data/`、`.cc-auto/`、用户敏感内容；
- `manifest.json` 记录来源路径和 SHA256；
- **Opus 实际不直接访问该目录**——目录只作为主进程组装 Prompt 的中间产物。Opus 调用使用 `tools: []`，内容由主进程拼入 Prompt；
- `try/finally` 无条件删除临时目录；
- 用户拒绝（输入 `x`）时不创建，不存在清理需求；
- Opus 成功、失败、超时、异常均清理；
- 进程启动时清理本工具遗留且能安全确认归属的过期 Bundle；
- 清理失败必须记录脱敏警告日志，但不得泄露 Bundle 路径或内容。

### 6.3 Opus 访问方式（v0.2.0 统一）

v0.2.0 对所有 transport 统一采用 `tools: []` + 主进程 Prompt 拼接。路径受控只读工具推迟到 v0.3。

---

## 7. 人工批准事项

### 7.1 Opus 调用交互（按上下文拆分）

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

规则：
- **无默认选项**，空输入不执行任何动作，重新提示；
- 调用前必须显示：预计费用、剩余预算、Provider Profile、requestedModelId、Opus 已调用次数；
- 用户必须输入明确的 `o` 才能调用 Opus；
- 非交互模式必须提供 `--approve-opus-call` flag，缺少则停止。

### 7.2 必须人工批准的事项

| 事项 | v0.2.0 | 说明 |
|------|--------|------|
| 调用 Opus | ✅ 必须 | `o` 命令 / `--approve-opus-call` |
| 非交互模式 Opus | ✅ 必须显式 flag | 缺少 flag → STOPPED |
| 扩展 FileScope | ✅ 必须 | 超出 allowedRoots |
| 清除 stale Run Lease | ✅ 必须 | 不得静默删除 |
| Opus 写权限 | ❌ 不实现 | v0.3+ |
| 提高预算 | ✅ 必须 | 预算耗尽时 |
| push / tag / release | ✅ 必须 | 安全规则 |
| 不可逆 Git 操作 | ✅ 必须 | 同上 |

---

## 8. 不可逆操作防护

### 8.1 已有防护（继承 v0.1）

`safety.ts` 规则继续生效：禁止 force push、push main、reset --hard、clean -f、branch -D、tag、rm -rf、DROP TABLE/DATABASE、操作 `data/offerflow.sqlite3`、自动创建 PR、读写 `.env`。

### 8.2 v0.2.0 新增

- 禁止 DeepSeek 修改 `run-lock.json`；
- 禁止 DeepSeek 修改 Provider 配置；
- 禁止 DeepSeek 修改其他 run 的记录文件。

---

## 9. 密钥与凭证管理

### 9.1 密钥来源

从父进程环境变量读取 Profile 声明的 `credentialEnvVars`，不落盘。

### 9.2 密钥绝不出现于

- `.cc-auto/runs/*/state.json`
- `.cc-auto/runs/*/phases/*.json`
- `.cc-auto/runs/*/report.md`
- `.cc-auto/runs/*/capsules/*.json`
- Evidence Bundle 任何文件
- `console.log` / `stdout` / `stderr`

### 9.3 密钥刷新

用户通过修改环境变量更新密钥。cc-auto 不提供密钥管理功能，不修改 `.env` 文件，不读取 `.env` 文件。
