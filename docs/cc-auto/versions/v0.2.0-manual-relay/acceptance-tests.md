# cc-auto Dual Model Relay v0.2.0 验收测试设计

> **状态**：v0.2.0 验收测试矩阵（只定义测试，不实现）
> **版本**：v2.3 / 2026-08-04
> **依赖**：[technical-design.md](technical-design.md)、[state-machine.md](state-machine.md)
> **注意**：本文档定义验收测试矩阵。v0.2.0 施工完成后按此矩阵编写和运行测试。

---

## 目录

1. [测试分类](#1-测试分类)
2. [基本路径测试](#2-基本路径测试)
3. [前置 Opus 策略测试](#3-前置-opus-策略测试)
4. [Opus 接力测试](#4-opus-接力测试)
5. [安全与隔离测试](#5-安全与隔离测试)
6. [模型身份与费用测试](#6-模型身份与费用测试)
7. [预算测试](#7-预算测试)
8. [Run Lease 与 writer 测试](#8-run-lease-与-writer-测试)
9. [文件范围测试](#9-文件范围测试)
10. [Evidence Bundle 测试](#10-evidence-bundle-测试)
11. [边界与异常测试](#11-边界与异常测试)
12. [恢复测试](#12-恢复测试)
13. [回归测试（禁止项）](#13-回归测试禁止项)

---

## 1. 测试分类

| 分类 | 说明 | 实现优先级 |
|------|------|-----------|
| 基本路径 | 不使用 Opus 的正常流程 | 施工时同步实现 |
| 前置 Opus 策略 | opus-plan-first 路径 | 施工时同步实现 |
| Opus 接力 | 跨 Provider 流程 | 施工时同步实现 |
| 安全与隔离 | 环境隔离、Run Lease、脱敏、Bundle、Opus 无文件工具 | 施工时同步实现 |
| 模型身份与费用 | 模型 ID 验证、MISMATCH/UNVERIFIED 门禁、MODEL_IDENTITY_CONFIRMATION | 施工时同步实现 |
| 预算 | 三级门闸 + COST_UNAVAILABLE + PRICING_NOT_FOUND | 施工时同步实现 |
| Run Lease 与 writer | 锁获取/释放、stale 确认、WorktreeFingerprint | 施工时同步实现 |
| 文件范围 | FileScope 分层批准 + 写入前执行点 | 施工时同步实现 |
| Evidence Bundle | Bundle 构建时机、mkdtemp、清理、拒绝 symlink、按 reviewPurpose 区分 | 施工时同步实现 |
| 边界与异常 | 极端输入、错误处理、Verdict Schema 严格校验 | 施工后补充 |
| 恢复 | 进程中断后恢复 + PendingCall 保护 | 施工后补充 |
| 回归（禁止项） | 确保不该发生的没有发生 | 施工后补充 |

---

## 2. 基本路径测试

### AT-01：简单任务 deepseek-first，只调用 DeepSeek

**前置**：任务复杂度=simple，风险分=0，策略=deepseek-first。

**流程**：INTAKE → STRATEGY_GATE → DS_WORK → VERIFY → FINAL_VERIFY → DONE。

**验证**：所有调用 providerId 为 DeepSeek；从 calls[] 重算的 opusCalls===0；无 HUMAN_GATE/OPUS_REVIEW；无 Capsule。

### AT-02：普通任务一次通过，不调用 Opus

**前置**：复杂度=normal，DeepSeek 施工后测试通过。

**流程**：INTAKE → STRATEGY_GATE → DS_WORK → VERIFY → FINAL_VERIFY → DONE。

**验证**：currentPhase='DONE'；calls[] 中无 model='arbiter' 记录；capsuleIds 为空。

### AT-03：复杂任务验证通过不自动触发 Opus

**前置**：复杂度=complex，riskScore=8，测试通过。

**验证**：v0.1 中高风险自动触发仲裁，v0.2.0 中不自动触发；仅在 VERIFY 失败后进入 HUMAN_GATE。

---

## 3. 前置 Opus 策略测试

### AT-04：opus-plan-first——用户批准 Opus 后施工

**前置**：用户选择 --strategy opus-plan-first。

**流程**：INTAKE → STRATEGY_GATE → HUMAN_GATE（前置）→ 用户输入 o → 预算与配置检查 → 构建完整 Evidence Bundle → OPUS_REVIEW（reviewPurpose=PRE_IMPLEMENTATION_PLAN）→ DS_WORK → VERIFY → FINAL_VERIFY → DONE。

**验证**：
- STRATEGY_GATE 阶段只在内存中生成调用预览（不构建完整 Bundle）；
- HUMAN_GATE 正确展示 Opus 调用详情和 `[o/d/x]`（d 文案标注"放弃 opus-plan-first，降级为 deepseek-first，不增加 repairCycles"）；
- 用户输入 o 且预算与配置检查通过后才构建完整 Evidence Bundle（使用 mkdtemp）；
- OPUS_REVIEW 阶段 Opus 使用 `tools: []`，获得主进程拼接的 Prompt；
- Opus 返回 PlanningVerdict（不含 rootCauseStatus/rootCause 等仲裁字段）；
- PlanningVerdict 的 invariants/recommendedFiles/requiredTests 被注入 DS_WORK prompt；
- **recommendedFiles 不被直接当作写权限**——必须经 FileScope 校验后才成为 approvedFiles；
- DeepSeek 在 Opus 裁决后才开始写（writer 在 DS_WORK 才获取）。

### AT-05：opus-plan-first——用户拒绝前置 Opus（x）

**前置**：opus-plan-first，HUMAN_GATE。

**验证**：用户输入 x → STOPPED（USER_DECLINED_OPUS）；不进入 OPUS_REVIEW；不进入 DS_WORK；不创建 Bundle 临时目录。

### AT-06：opus-plan-first——用户选择降级为 deepseek-first（d）

**前置**：opus-plan-first，HUMAN_GATE。

**验证**：用户输入 d → 降级为 deepseek-first，进入 DS_WORK；repairCycles **不增加**；不进入 OPUS_REVIEW；不创建 Bundle。

### AT-07：opus-plan-first——空输入不触发

**前置**：HUMAN_GATE。

**验证**：用户直接回车 → 不执行任何动作，重新提示。

---

## 4. Opus 接力测试

### AT-08：deepseek-first 验证失败，用户批准 Opus

**前置**：DS_WORK 后 VERIFY 失败。

**流程**：…→VERIFY（失败）→HUMAN_GATE→用户输入 o→预算检查→构建 Bundle→OPUS_REVIEW→DS_APPLY→VERIFY→FINAL_VERIFY→DONE。

**验证**：
- HUMAN_GATE 批准后才构建完整 Bundle（mkdtemp）；
- Opus 获得主进程拼接的 Prompt（tools: []）；
- Opus 返回 ArbitrationVerdict（含 rootCauseStatus/rootCause/evidence/contradictions）；
- 从 calls[] 重算的 opusCalls===1；
- handoffHistory 包含 user→opus 和 opus→deepseek。

### AT-09：用户拒绝 Opus，停止任务

**前置**：HUMAN_GATE（FAILURE_ARBITRATION）。

**验证**：用户输入 x → STOPPED（USER_DECLINED_OPUS）；从 calls[] 重算的 opusCalls===0。

### AT-10：失败门用户选择 DeepSeek 再试一次（d）

**前置**：HUMAN_GATE（FAILURE_ARBITRATION）。

**验证**：
- 用户输入 d → 回到 DS_WORK；
- **repairCycles+1**（与前置门的 d 语义不同）；
- DeepSeek 获得失败上下文；
- 交互文案明确标注"再修一次，repairCycles+1"。

### AT-11：Opus 裁决 STOP

**验证**：verdict=STOP → STOPPED（OPUS_RECOMMENDED_STOP）；不进入 DS_APPLY。

### AT-12：Opus 裁决 PROCEED，DeepSeek 按裁决实施

**验证**：DS_APPLY prompt 包含完整裁决；DeepSeek 只能修改经 FileScope 校验后的 approvedFiles（recommendedFiles 不直接授予写权限）；实施后运行 requiredTests。

### AT-13：Opus 裁决 REVISE，根因 UNKNOWN（失败仲裁）

**前置**：reviewPurpose=FAILURE_ARBITRATION，rootCauseStatus=UNKNOWN，rootCause=null。

**验证**：裁决被正确接受（UNKNOWN 合法）；DS_APPLY prompt 注明"根因未确认"；报告不为 null rootCause 伪造确定性。

### AT-14：Opus 无任何原生文件工具

**验证**：OPUS_REVIEW 期间 Opus 子进程 tools 参数为空数组；Opus 不能执行 Read / Grep / Glob / Write / Edit / Bash；Bundle 内容必须由主进程拼接进 Prompt。

### AT-15：Opus 子进程不设 cwd 为 Bundle 目录

**验证**：OPUS_REVIEW 期间 Opus cwd 不是仓库根目录也不是 Bundle 临时目录；Opus 无法通过相对路径访问任何文件；临时目录只是主进程中间产物。

### AT-16：非交互模式缺少 --approve-opus-call 则停止

**前置**：非交互模式运行，进入 HUMAN_GATE。

**验证**：缺少 `--approve-opus-call` flag → STOPPED；不发起 Opus 调用。

### AT-17：非交互模式 --approve-opus-call 允许 Opus

**前置**：非交互模式，`--approve-opus-call`。

**验证**：HUMAN_GATE 自动通过（用户已预授权）；进入 OPUS_REVIEW。

---

## 5. 安全与隔离测试

### AT-18：两个 Provider 环境不互相污染

**验证**：DeepSeek 子进程 env 不含 Opus 凭证变量名及值；Opus 子进程 env 不含 DeepSeek 凭证。

### AT-19：第三方 Opus 渠道环境变量注入

**前置**：Opus Profile 使用第三方渠道（credentialEnvVars=["ANTHROPIC_AUTH_TOKEN"]，staticEnv={"ANTHROPIC_BASE_URL":"https://..."}）。

**验证**：Opus 子进程 env 包含 ANTHROPIC_AUTH_TOKEN（值来自父进程）和 ANTHROPIC_BASE_URL（值来自 staticEnv）。

### AT-20：Windows 运行时环境白名单

**前置**：Windows 平台。

**验证**：子进程 env 包含 SystemRoot、ComSpec、PATHEXT、TEMP、TMP、USERPROFILE、APPDATA、LOCALAPPDATA（如存在于父进程）。

### AT-21：密钥不落盘

**验证**：.cc-auto/runs/ 下所有文件中搜索不到密钥模式（sk-/deepseek-/Bearer token 等）。

### AT-22：脱敏函数覆盖 Provider Key 模式

**验证**：redactSecretLiterals 和 redactEnvLikeText 覆盖 DeepSeek API Key 和第三方渠道 token 模式。

---

## 6. 模型身份与费用测试

### AT-23：acceptedReportedModelIds 匹配 → VERIFIED

**前置**：requestedModelId="deepseek-chat"，reportedModel="deepseek-chat"，acceptedReportedModelIds=["deepseek-chat","deepseek-v3"]。

**验证**：modelIdentityStatus='VERIFIED'；正常继续。

### AT-24：reportedModel 不在白名单 → MISMATCH，立即 STOPPED

**前置**：requestedModelId="deepseek-chat"，reportedModel="deepseek-v4-unknown"。

**验证**：
- modelIdentityStatus='MISMATCH'；
- 立即 STOPPED（MODEL_IDENTITY_MISMATCH）；
- 不重试、不静默降级；
- 不允许该次裁决驱动后续施工。

### AT-25：reportedModel 为 null → UNVERIFIED，进入 MODEL_IDENTITY_CONFIRMATION

**前置**：Provider 响应中 model 字段缺失。

**验证**：
- modelIdentityStatus='UNVERIFIED'；
- reportedModel=null；
- 进入 HUMAN_GATE（purpose=MODEL_IDENTITY_CONFIRMATION）；
- 交互为 `[a]` 接受 / `[x]` 停止，无 `[o]` 和 `[d]`；
- 显示 requestedModelId + reportedModel=null + Provider Profile + 费用状态；
- 报告不得声称"已确认使用某模型"；
- 报告和 Capsule 标记 identityUnverified=true；
- 非交互模式缺少 `--accept-unverified-model-result` flag 时停止。

### AT-26：MODEL_IDENTITY_CONFIRMATION——DeepSeek 施工返回 UNVERIFIED，用户接受

**前置**：DS_WORK 中 DeepSeek 返回 UNVERIFIED，进入 HUMAN_GATE（purpose=MODEL_IDENTITY_CONFIRMATION），identityConfirmationContext.sourcePhase='DS_WORK'，resumePhase='VERIFY'。

**验证**：
- 用户输入 a → 接受该次 DeepSeek 施工结果；
- a 不重新调用模型，不产生第二次费用；
- 进入 `VERIFY`；
- 裁决记录标记 identityUnverified=true。

### AT-27：MODEL_IDENTITY_CONFIRMATION——前置规划 Opus 返回 UNVERIFIED，用户接受

**前置**：OPUS_REVIEW（reviewPurpose=PRE_IMPLEMENTATION_PLAN）中 Opus 返回 UNVERIFIED，进入 HUMAN_GATE（purpose=MODEL_IDENTITY_CONFIRMATION），identityConfirmationContext.sourcePhase='OPUS_REVIEW'，resumePhase='DS_WORK'。

**验证**：
- 用户输入 a → 接受 PlanningVerdict；
- a 不重新调用模型，不产生第二次费用；
- 主进程完成 recommendedFiles 的 FileScope 校验（allowedRoots + protectedPaths + maxChangedFiles）；
- 进入 `DS_WORK`；
- 裁决记录标记 identityUnverified=true。

### AT-28：MODEL_IDENTITY_CONFIRMATION——失败仲裁 Opus 返回 UNVERIFIED，用户接受

**前置**：OPUS_REVIEW（reviewPurpose=FAILURE_ARBITRATION）中 Opus 返回 UNVERIFIED，进入 HUMAN_GATE（purpose=MODEL_IDENTITY_CONFIRMATION），identityConfirmationContext.sourcePhase='OPUS_REVIEW'，resumePhase='DS_APPLY'。

**验证**：
- 用户输入 a → 接受 ArbitrationVerdict；
- a 不重新调用模型，不产生第二次费用；
- 主进程完成 recommendedFiles 的 FileScope 校验（allowedRoots + protectedPaths + maxChangedFiles）；
- 进入 `DS_APPLY`；
- 裁决记录标记 identityUnverified=true。

### AT-29：MODEL_IDENTITY_CONFIRMATION——用户拒绝

**前置**：UNVERIFIED 状态，交互模式，用户输入 x。

**验证**：→ STOPPED；裁决不被使用。

### AT-30：MODEL_IDENTITY_CONFIRMATION——空输入不触发

**验证**：空输入不执行任何动作，重新提示。

### AT-31：MODEL_IDENTITY_CONFIRMATION——非交互模式缺少 flag 停止

**前置**：非交互模式，UNVERIFIED。

**验证**：缺少 `--accept-unverified-model-result` → STOPPED；`--approve-opus-call` 不足以通过此门。

### AT-32：usage 完全缺失 → MISSING，全部 Token 为 null

**前置**：Provider 不返回 usage。

**验证**：usageStatus='MISSING'；inputTokens/outputTokens/cacheTokens 全部为 null；costStatus='UNAVAILABLE'。

### AT-33：usage 部分缺失 → PARTIAL

**前置**：Provider 返回 input/output tokens 但缺少 cache tokens。

**验证**：usageStatus='PARTIAL'；可用字段记录值，缺失字段为 null。

### AT-34：Token 数确实为 0 → 记录 0

**前置**：Provider 返回 usage 中某字段为 0。

**验证**：该字段记录为 0（不是 null）。

### AT-35：费用绝不显示为假 ¥0.00

**验证**：所有 null 费用在报告中显示为 UNAVAILABLE 或"未定价"，不显示 ¥0.00。

---

## 7. 预算测试

### AT-36：任务预算不足 → 停止

**验证**：budgetGate 返回 blocked；stopReason='BUDGET_TASK_EXCEEDED'。

### AT-37：Opus 预算不足 → 停止

**验证**：HUMAN_GATE 提示 Opus 预算不足；用户仍批准后被 budgetGate 拦截。

### AT-38：当日预算不足 → 停止

**验证**：stopReason='BUDGET_DAILY_EXCEEDED'。

### AT-39：绝对上限覆盖任务预算

**验证**：超过绝对上限时停止。

### AT-40：配置态缺价 → PRICING_NOT_FOUND 调用前停止

**前置**：ProviderProfile.pricing 中缺少 requestedModelId 对应的定价。

**验证**：INTAKE 阶段停止（PRICING_NOT_FOUND）；不发起任何模型请求。

### AT-41：运行期 costStatus=UNAVAILABLE → COST_UNAVAILABLE 立即停止

**前置**：调用后 reportedModel 无对应定价，或 usage 缺失。

**验证**：
- costStatus='UNAVAILABLE'；
- 该 run 立即 COST_UNAVAILABLE 停止；
- 后续不得继续调用任何模型；
- "已知下限"仅出现在已停止任务的报告中。

### AT-42：仅 CNY 定价——非 CNY 配置不被接受

**前置**：配置中 currency 不是 'CNY'。

**验证**：INTAKE 校验失败；不进入下一步。

### AT-43：定价只有一个真相来源

**前置**：ModelIdentity 不包含 pricing 字段；所有定价从 ProviderProfile.pricing 查询。

**验证**：
- 按 requestedModelId 查询 ProviderProfile.pricing；
- 调用后按 reportedModel 查询价格；
- 不与 ModelIdentity 中任何字段比较。

---

## 8. Run Lease 与 writer 测试

### AT-44：Run Lease 阻止并发任务

**前置**：进程 A 持有 Run Lease。

**验证**：进程 B 获取失败，错误信息包含 runId 和 pid。

### AT-45：stale lease 必须人工确认

**前置**：Run Lease 文件中 pid 不存在。

**验证**：新进程获取时提示"残留 Run Lease，请手动确认"；不静默删除；等用户确认后才覆盖。

### AT-46：验证阶段 worktree 被外部修改时停止

**前置**：VERIFY 运行期间（writer=none），外部进程修改了被跟踪的源码文件。

**验证**：VERIFY 前后 computeWorktreeFingerprint() 变化 → STOPPED（WORKTREE_TAMPERED_DURING_VERIFY）。

### AT-47：gitignored 缓存不触发 WorktreeFingerprint 误报

**前置**：VERIFY 运行期间 vitest 写入了 `node_modules/.vite/` 或 `test-results/`。

**验证**：这些目录已被 .gitignore 覆盖，computeWorktreeFingerprint() 前后一致；不触发 WORKTREE_TAMPERED_DURING_VERIFY。

### AT-48：writer 释放后 DeepSeek 写操作被拒绝

**前置**：writer=none。

**验证**：DeepSeek Write/Edit 调用时主进程在工具执行前校验 → 返回 DENIED，不落盘。

---

## 9. 文件范围测试

### AT-49：proposedFiles 在 allowedRoots 内自动批准

**前置**：allowedRoots=["src/foo/"]，proposedFiles=["src/foo/a.ts","src/foo/b.ts"]。

**验证**：自动批准，加入 approvedFiles。

### AT-50：proposedFiles 超出 allowedRoots 请求人工扩展

**前置**：proposedFiles 包含 "src/bar/c.ts"，不在 allowedRoots 内。

**验证**：提示用户扩展文件范围；用户批准后加入 approvedFiles；用户拒绝 → STOPPED。

### AT-51：proposedFiles 触碰 protectedPaths 请求人工扩展

**验证**：提示用户；用户批准后加入；用户拒绝 → STOPPED。

### AT-52：Write/Edit 写入前校验——未批准路径返回 DENIED

**前置**：DeepSeek 尝试写入不在 approvedFiles 中的文件。

**验证**：主进程在工具执行前通过 path.resolve + path.relative 校验；返回工具级 DENIED；文件不落盘。

### AT-53：Bash 不能绕过写权限（拒绝重定向）

**前置**：DeepSeek 尝试执行 `echo "x" > src/foo/secrets.ts`。

**验证**：Bash 白名单拒绝 `>` 重定向；命令不被执行或返回 DENIED。

### AT-54：Bash 不能绕过写权限（拒绝 sed -i）

**前置**：DeepSeek 尝试执行 `sed -i 's/foo/bar/' src/foo.ts`。

**验证**：Bash 白名单拒绝 `sed -i`；命令不被执行或返回 DENIED。

### AT-55：施工后 diff 超出 approvedFiles → STOPPED（第二层防线）

**前置**：DeepSeek 实际修改了未在 approvedFiles 中的文件（绕过写入前检查的极端情况）。

**验证**：git diff 核对发现超范围 → FILE_SCOPE_VIOLATION；STOPPED；保留现场等待人工处理，不自动回滚。

### AT-56：路径穿越在写入前被拒绝

**前置**：DeepSeek 尝试 Write `../../.env`。

**验证**：path.resolve + path.relative 校验拒绝 `..` 穿越；返回 DENIED，不落盘。

---

## 10. Evidence Bundle 测试

### AT-57：Bundle 仅在用户批准 o 之后构建

**前置**：进入 HUMAN_GATE。

**验证**：用户输入 o 之前，不创建任何 Bundle 临时目录；源码副本不落盘；仅在用户输入 o 且预算与配置检查通过后才创建。

### AT-58：PRE_IMPLEMENTATION_PLAN Bundle 包含必要文件

**前置**：opus-plan-first，用户输入 o。

**验证**：Bundle 临时目录包含：
- capsule.json
- task-contract.json
- git-status.txt
- referenced-files/
- manifest.json

可以包含 diff.patch（如仓库有未提交变更），但**不得强制要求存在** test-summary.txt、failure-fingerprint.json（前置规划不存在测试失败）。

### AT-59：FAILURE_ARBITRATION Bundle 包含完整失败证据

**前置**：deepseek-first，VERIFY 失败，用户输入 o。

**验证**：Bundle 临时目录包含 capsule.json、task-contract.json、git-status.txt、**diff.patch**、**test-summary.txt**、**failure-fingerprint.json**、referenced-files/、manifest.json。

### AT-60：Bundle 不包含未授权文件

**验证**：referenced-files/ 只包含 FileScope 内 + Capsule 引用的文件；不包含 .env、node_modules、data/、.cc-auto/、密钥文件。

### AT-61：manifest.json 记录完整

**验证**：每个 Bundle 内文件在 manifest.json 中有条目（sourcePath、sha256、redacted）。

### AT-62：用户拒绝 o 时不创建 Bundle

**前置**：HUMAN_GATE，用户输入 x。

**验证**：不创建任何 Bundle 临时目录；源码副本不落盘。

### AT-63：Bundle 使用 mkdtemp 随机目录

**前置**：用户输入 o。

**验证**：Bundle 目录路径不是 `/tmp/cc-auto-arbiter-<runId>/` 等可预测路径；使用 `fs.mkdtemp` 生成随机后缀。

### AT-64：Bundle 复制时拒绝符号链接

**前置**：源码树中存在指向仓库外部的符号链接。

**验证**：复制时解析并拒绝符号链接；只复制常规文件；不跟随 symlink。

### AT-65：Bundle 逐个文件校验真实路径在 repositoryRoot

**验证**：每个复制文件的真实路径（realpath）位于 repositoryRoot 内；否则拒绝复制。

### AT-66：try/finally 清理临时目录

**前置**：OPUS_REVIEW 完成。

**验证**：Opus 子进程退出后 Bundle 临时目录被删除（无论 Opus 成功、失败、超时还是异常）。

### AT-67：进程启动时清理遗留过期 Bundle

**前置**：上一进程异常崩溃，遗留了能安全确认归属的 Bundle 临时目录。

**验证**：cc-auto 启动时检测并清理遗留 Bundle；清理失败记录脱敏警告日志。

---

## 11. 边界与异常测试

### AT-68：Provider 认证失败

**验证**：stopReason='PROVIDER_AUTH_ERROR'；不降级到其他 Provider。

### AT-69：Opus 未返回结构化裁决 → OPUS_VERDICT_INVALID

**前置**：Opus 返回的 JSON 不符合任何 Verdict Schema。

**验证**：Schema 验证失败 → stopReason='OPUS_VERDICT_INVALID'；不进入 DS_APPLY。

### AT-70：PlanningVerdict Schema 拒绝额外仲裁字段（additionalProperties: false）

**前置**：reviewPurpose=PRE_IMPLEMENTATION_PLAN，但 Opus 返回的 JSON 包含 rootCauseStatus、rootCause 或 contradictions。

**验证**：PlanningVerdict JSON Schema 设置了 `additionalProperties: false`；包含仲裁专属字段时 **Schema 验证必须失败**（非"通过但忽略"）；stopReason='OPUS_VERDICT_INVALID'。

### AT-71：ArbitrationVerdict Schema 拒绝额外规划字段（additionalProperties: false）

**前置**：reviewPurpose=FAILURE_ARBITRATION，但 Opus 返回的 JSON 包含 architectureDecision、risks 或 invariants。

**验证**：ArbitrationVerdict JSON Schema 设置了 `additionalProperties: false`；包含规划专属字段时 **Schema 验证必须失败**（非"通过但忽略"）；stopReason='OPUS_VERDICT_INVALID'。

### AT-72：Opus 调用次数达到上限

**验证**：从 calls[] 重算的 opusCalls>=maxOpusCalls → 不发起子进程 → OPUS_CALLS_EXCEEDED。

### AT-73：Vendor 与 Transport 独立

**前置**：Profile vendor='deepseek'，transport='anthropic-messages'。

**验证**：Adapter 按 transport 选择 AnthropicMessagesAdapter，不因 vendor 选择 OpenAIChatAdapter。

### AT-74：Profile ID 与 reportedModel 不直接比较

**验证**：身份比对使用 acceptedReportedModelIds 白名单，不直接拿 Profile.id 与 reportedModel 比较。

---

## 12. 恢复测试

### AT-75：运行中断后恢复

**前置**：DS_WORK 阶段进程崩溃（无 pendingCall）。

**验证**：resumeTask 读取 state.json；从 currentPhase 继续；不重复已完成阶段；resumed=true。

### AT-76：恢复时不保留子进程上下文

**验证**：恢复时重新构造 prompt；不尝试复用中断前的子进程；不声称"断点续跑"。

### AT-77：pendingCall=PREPARED 恢复时可安全取消

**前置**：进程在持久化 pendingCall（PREPARED）后、发起请求前崩溃。

**验证**：恢复时识别 pendingCall=PREPARED；可安全取消或重新审批；不自动重发。

### AT-78：pendingCall=DISPATCHED 恢复时进入 HUMAN_GATE

**前置**：进程在发起请求后、写入 calls[] 前崩溃，pendingCall=DISPATCHED。

**验证**：
- 恢复时标记 UNKNOWN_AFTER_CRASH；
- 进入 HUMAN_GATE，告知用户可能已产生真实费用；
- 不自动重发；
- 只有用户明确批准后才允许重新调用。

### AT-79：恢复时不静默突破 maxOpusCalls

**前置**：pendingCall=DISPATCHED（UNKNOWN_AFTER_CRASH），用户批准重新调用。

**验证**：重新调用前再次检查从 calls[] 重算的 opusCalls + 本次 < maxOpusCalls；超限则停止。

### AT-80：opusCalls 和 spentRmb 从 calls[] 重算

**验证**：RunState 中不独立持久化 opusCalls、spentRmb；这些值从 calls[] 每次计算；恢复后值与 calls[] 一致。

---

## 13. 回归测试（禁止项）

### AT-81：不发生自动 commit / push

**验证**：git log 不变；无新增 tag；无 push。

### AT-82：不依赖 Gateway 或 Claude Desktop

**验证**：Claude Desktop 未运行时 cc-auto 正常工作；不读取 CC Switch 数据库；不修改 Claude Desktop profile；不启动 HTTP 代理。

### AT-83：不在验证通过时调用 Opus

**验证**：VERIFY/FINAL_VERIFY 通过后不进入 HUMAN_GATE；验证通过条件下 calls[] 中无 model='arbiter' 记录。

### AT-84：不存在两个模型同时写的窗口

**验证**：writer 任意时刻最多一个为 deepseek；两个不同 Provider 子进程不会同时持有文件句柄。

### AT-85：环境变量名称可记录，密钥正文不记录

**验证**：运行记录中可看到 credentialEnvVars 名称；搜索不到任何密钥正文值。

### AT-86：Gateway 历史归档不声称未证实根因

**验证**：research/desktop-budget-gateway-abandoned.md 区分了"已确认"和"未完全确认"；不把未证实结论写成确定根因。

### AT-87：文档中不含具体模型 ID 硬编码

**验证**：架构书、技术设计等文档中不含 `claude-opus-5` 等硬编码模型 ID；所有模型 ID 作为示例配置出现并带有说明。

### AT-88：HUMAN_GATE 三种 purpose 无默认选项

**验证**：空输入不执行任何动作，重新提示；PRE_IMPLEMENTATION_PLAN 的 `[o/d/x]`、FAILURE_ARBITRATION 的 `[o/d/x]`、MODEL_IDENTITY_CONFIRMATION 的 `[a/x]` 各有明确语义。

### AT-89：跨文档一致性——不允许 Opus 原生文件工具

**验证**：全部 7 份文档中搜索不到"Opus"+"Read/Grep/Glob"权限或"cwd 为 Bundle 临时目录"等描述（除明确标记为 v0.3+ 或已废弃的章节）。

### AT-90：跨文档一致性——不允许批准前构建完整 Bundle

**验证**：全部文档中的构建时机统一为 HUMAN_GATE 用户输入 o 且预算配置检查通过之后。

### AT-91：跨文档一致性——不允许 cwd 视为沙箱

**验证**：全部文档中不出现"cwd 指向 Bundle 即无法访问真实仓库"或等效表述。

### AT-92：跨文档一致性——approvedFiles 不是仅事后检查

**验证**：全部文档中不出现"只有 approvedFiles 中的文件可以写入"而无写入前执行点校验的描述。

---

## 14. v1.2 补全测试

### AT-93：verificationCommandAllowlist 中命令可执行

**前置**：TaskContract.verificationCommandAllowlist 配置了 `[{id: "vitest-run", executable: "vitest", args: ["run"], cwd: "."}]`。

**验证**：DeepSeek 子进程可通过 Bash 执行 `vitest run`；命令按 VerificationCommand 定义执行（executable 与 args 分离，非 shell 模式）。

### AT-94：verificationCommandAllowlist 拒绝白名单外命令

**前置**：DeepSeek 尝试执行不在 verificationCommandAllowlist 中的命令（如 `rm -rf src/`）。

**验证**：Bash 调用被拒绝；命令不被执行；记录拒绝日志。

### AT-95：Bash 拒绝 shell 模式执行（管道拼接）

**前置**：DeepSeek 尝试执行含 `|` 或 `&&` 或 `;` 的 Bash 命令。

**验证**：命令被拒绝；不执行任何部分。

### AT-96：requiredTests 仅接受 VerificationCommand.id

**前置**：Opus 返回的 ArbitrationVerdict.requiredTests 包含 `["vitest-run"]`（已在白名单中）。

**验证**：主进程逐项匹配 verificationCommandAllowlist；命中后加入 VerificationPlan；Verifier 按顺序执行。

### AT-97：requiredTests 中未命中白名单的 id 被拒绝

**前置**：Opus 返回的 requiredTests 包含 `["rm -rf /tmp"]`（不在白名单中，且不是合法 id）。

**验证**：该 id 被拒绝；记录警告日志；不影响白名单中其他命令的执行。

### AT-98：RunState 持久化字段——进入 HUMAN_GATE 前写入

**前置**：DS_WORK 中 modelIdentityStatus=UNVERIFIED，进入 HUMAN_GATE(purpose=MODEL_IDENTITY_CONFIRMATION)。

**验证**：state.json 中 humanGatePurpose='MODEL_IDENTITY_CONFIRMATION'；identityConfirmationContext 包含 sourcePhase='DS_WORK'、resumePhase='VERIFY'、pendingResultId。

### AT-99：RunState 持久化字段——离开 HUMAN_GATE 后清理

**前置**：用户输入 a，离开 MODEL_IDENTITY_CONFIRMATION。

**验证**：state.json 中 humanGatePurpose=null；identityConfirmationContext=null。

### AT-100：verificationStatus 持久化——恢复时可见

**前置**：定向测试通过（target=PASSED），全量测试未运行（full=NOT_RUN），进程崩溃后恢复。

**验证**：恢复后 verificationStatus={target: 'PASSED', full: 'NOT_RUN'}；恢复从 FINAL_VERIFY 继续。

### AT-101：lastFailureFingerprint 持久化——重复失败检测

**前置**：VERIFY 失败生成失败指纹 abc123，持久化到 state.json。

**验证**：恢复后可读取 lastFailureFingerprint；与当前失败指纹比较用于重复失败检测。

### AT-102：StopReason REPAIR_CYCLES_EXHAUSTED

**前置**：repairCycles 达到 maxRepairCycles，VERIFY 再次失败。

**验证**：stopReason='REPAIR_CYCLES_EXHAUSTED'；不进入 HUMAN_GATE；直接 STOPPED。

### AT-103：StopReason USER_REJECTED_UNVERIFIED_MODEL

**前置**：HUMAN_GATE(purpose=MODEL_IDENTITY_CONFIRMATION)，用户输入 x。

**验证**：stopReason='USER_REJECTED_UNVERIFIED_MODEL'；任务停止。

### AT-104：StopReason USER_DECLINED_FILE_SCOPE_EXPANSION

**前置**：DeepSeek 请求扩展 FileScope（超出 allowedRoots），用户输入 x 拒绝。

**验证**：stopReason='USER_DECLINED_FILE_SCOPE_EXPANSION'；任务停止；不使用 UNKNOWN 或 OTHER。

### AT-105：DS_WORK→HUMAN_GATE (MODEL_IDENTITY_CONFIRMATION) 转换正确

**前置**：DS_WORK 中 DeepSeek 返回 reportedModel=null。

**验证**：
- 进入 HUMAN_GATE(purpose=MODEL_IDENTITY_CONFIRMATION)；
- pendingResultId 被保存；
- resumePhase='VERIFY'；
- 用户输入 a 后不重新调用模型，直接进入 VERIFY；
- 用户输入 x 后以 USER_REJECTED_UNVERIFIED_MODEL 停止。

### AT-106：VerificationPlan.source 区分三种来源

**前置**：任务配置了 task-contract 默认命令，Opus 裁决包含额外 requiredTests，machine 也有默认兜底命令。

**验证**：
- task-contract 来源的 commandIds 标记 source='task-contract'；
- Opus verdict 来源的 commandIds 标记 source='opus-verdict'；
- machine 兜底的 commandIds 标记 source='machine-default'；
- 三种来源合并去重后按顺序执行。

### AT-107：Opus 输出不能直接交给 shell——requiredTests 必须走白名单

**前置**：ArbitrationVerdict 的 requiredTests 为 string[]。

**验证**：不将 requiredTests 直接作为 shell 命令执行；不走 eval 或等效路径；每个 id 经过 verificationCommandAllowlist 匹配后才执行对应 VerificationCommand。
