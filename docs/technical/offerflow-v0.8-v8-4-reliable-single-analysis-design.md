# OfferFlow v0.8 · V8-4 可靠单岗位分析技术设计

> **设计文档版本：** 1.0
> **对应 PRD：** v2.1（P0-08 / P0-12，US-05 / US-10）
> **对应 Traceability：** RC-07（可解释单岗位分析）、RC-12（可靠任务，单岗位部分）
> **波次：** V8-4
> **状态：** `DESIGN COMPLETE / IMPLEMENTATION PENDING`
> **基线：** 分支 `feat/v0.8-v8-4`，生产 schema v7，Radar 与 Analysis 正式入口 `DISABLED`

---

## 0. 读取的权威文档与既定事实

本设计前置读取：

- `DESIGN.md`（决策操作系统视觉与信息密度约束）；
- `docs/technical/offerflow-v0.8-technical-design.md`（§3 不变量、§4.8/§4.9 表、§7 输入准备度、§8 stale、§10 任务可靠性、§11 API）；
- `docs/product/offerflow-v0.8-traceability.md`（RC-07 / RC-12 状态与边界）；
- `docs/evaluation/offerflow-v0.8-evaluation-plan.md`（§3 标注、§4 指标、§6 故障演练）；
- 源码：`server/radar/analysisTaskRepository.ts`、`analysisRecordRepository.ts`、`rowMappers.ts`、`server/llm/provider.ts`、`server/job-match-profile/aiProvider.ts`、`server/radar/routes.ts`、`server/index.ts`、`src/domain/radar/{types,schemas}.ts`。

已确认、本设计不再重开的事实：

- schema v7 已含 `analysis_tasks` 与 `job_match_analysis_records`（`server/migrations/radarDomainSchemaV7.ts`）；
- `AnalysisTaskRepository`、`AnalysisRecordRepository` 已存在，提供存取原语，状态机/恢复留给 V8-4 服务层；
- `analysis_tasks.input_hash` **无 UNIQUE**；`job_match_analysis_records.input_hash` **有 UNIQUE**；
- 本轮 **不新增 migration**、不改生产库、不推进 `PRODUCTION_SCHEMA_VERSION`（保持 2）；
- legacy `/api/llm/analyze-job` **不得**作为 V8-4 正式契约；
- 可复用底层 LLM transport（`chatCompletion` + `AbortSignal`）、严格 Zod、一次结构修复模式（参考 `aiProvider.ts`）。

> 本文件不修改 AGENTS.md、PRD 或 Release Contract；不授权任何代码实现。

---

## 1. 输入快照 `JobMatchAnalysisInputSnapshotV1`

### 1.1 设计裁决

单岗位分析的全部输入在任务创建事务内一次性冻结为**严格版本化**的只读快照，序列化后写入 `analysis_tasks.input_snapshot_json`。**retry 复用原始 `input_snapshot_json`，绝不重新读取当前数据库**（TD §10.3）。快照分两层：

- **服务端 Envelope 层**：允许持有数据库 ID、内容 hash、版本号（用于审计与幂等）；
- **模型可见 Payload 层**：由 §2 的证据目录派生，**不含任何内部数据库 ID**。

`analysis_tasks.input_snapshot_json` 存 Envelope 层全量快照；发给 LLM 的内容由 §2 从快照投影得到。

### 1.2 严格结构（TypeScript 契约，落地为 Zod `strictObject`）

```ts
interface JobMatchAnalysisInputSnapshotV1 {
  snapshotVersion: 'job-match-analysis-input:v1'

  // —— 候选岗位事实（不可变版本） ——
  candidate: {
    candidateId: string
    candidateVersionId: string
    versionNo: number
    contentHash: string            // RadarCandidateVersion.contentHash
    normalized: RadarCandidateNormalized
    sourceSnapshotIds: string[]    // 溯源，仅审计
    qualityIssues: RadarCandidateQualityIssue[]
  }

  // —— 简历（active 版本，必需） ——
  resume: {
    resumeVersionId: string
    contentHash: string
    projection: ResumeProjectionV1  // 能力/经历的稳定语义投影
  }

  // —— 正式画像（active JobMatchProfileVersion，必需） ——
  jobMatchProfile: {
    profileVersionId: string
    contentVersion: string         // 画像版本内容标识（进入幂等键）
    projection: JobMatchProfileProjectionV1
  }

  // —— 可选上下文版本（缺失时按 TD §7.2 降级） ——
  capabilityBaseline: { versionId: string; contentVersion: string; projection: unknown } | null
  marketPosition:     { versionId: string; contentVersion: string; projection: unknown } | null
  strategy:           { versionId: string; contentVersion: string; projection: unknown } | null

  // —— 城市 / 全局 fallback（TD §5.2 / 7.2；非苏锡沪杭 cityCode=null） ——
  cityCode: string | null

  // —— 规则摘要投影（来自 RadarRuleAssessment，只投影语义，不含 assessmentId） ——
  ruleAssessmentSummary: RuleAssessmentSummaryV1
  ruleProjectionHash: string       // 规则投影的 canonical 内容 hash

  // —— 用户 override 投影（来自 RadarAction rule_override_*，派生当前有效覆盖） ——
  userOverrides: UserOverrideProjectionV1

  // —— 策略与 Provider 版本（全部进入幂等键） ——
  promptVersion: string            // 例 'job-match-analysis-prompt:v1'
  analysisPolicyVersion: string    // 例 'job-match-analysis-policy:v1'
  providerPolicyVersion: string    // 例 'job-match-analysis-provider-policy:v1'
  provider: string                 // 'deepseek' | 'fake'
  model: string                    // 冻结时的 model name
}
```

### 1.3 投影原则

- `ResumeProjectionV1` / `JobMatchProfileProjectionV1` / `RuleAssessmentSummaryV1` / `UserOverrideProjectionV1` 均为**稳定语义结构**，字段名与顺序固定，用于喂给模型并参与 hash；不得内联可变时间戳、请求 ID 或数据库主键。
- 可选上下文缺失时对应字段为 `null`，并在 §2 目录与 §6 Payload 约束里体现降级（confidence 上限、不形成强结论）。
- `cityCode = null` 时城市证据判定为不足，不生成强城市结论（TD §5.2 / 7.2）。
- 快照一经创建即随任务不可变；任何"当前数据变了"只影响 §11 stale 判定，**不影响已冻结快照**。

---

## 2. LLM Payload 与服务端 Envelope 分离

### 2.1 硬边界（对齐 TD INV-05 / RT-04）

服务端 Envelope（`analysis_tasks` / `job_match_analysis_records` 行、§1 快照）可持有数据库 ID。**发给 LLM 的 Payload 严禁包含**：

- `candidateId`、`candidateVersionId`；
- `resumeVersionId`、`jobMatchProfileVersionId`、任何 profile/context version ID；
- `assessmentId`（RuleAssessment ID）；
- 任何 Snapshot ID、SourceRecord ID、Action ID；
- 任何其他内部数据库 ID、内容 hash 或审计字段。

模型的输入是**证据目录（evidence catalog）** + 岗位/画像语义事实；输出通过**稳定语义键**回指目录，服务端负责把语义键映射回内部对象。

### 2.2 证据目录 `EvidenceCatalogV1`（`evidenceCatalog.ts`）

从 §1 快照确定性生成，键格式：`<namespace>:<kind>:<seq>`，`seq` 为该 namespace+kind 下从 1 开始的稳定序号（按快照数组下标）。允许的命名空间与示例：

```text
candidate:responsibility:1     候选岗位职责第 1 条
candidate:requirement:1        候选岗位要求第 1 条
candidate:skill:1              候选岗位技术栈第 1 项
candidate:fact:1              候选岗位其他标准化事实（薪资/城市/学历/性质…）
resume:capability:1            简历能力投影第 1 条
resume:experience:1           简历经历投影第 1 条
profile:core-capability:1      画像核心能力第 1 条
profile:constraint:1           画像约束第 1 条
profile:role-band:1            画像岗位带第 1 条
rule:hard-constraint:1         规则硬约束命中第 1 条
rule:risk:1                    规则风险命中第 1 条
rule:preference:1              规则偏好命中第 1 条
override:1                     用户覆盖投影第 1 条
```

目录结构：`Array<{ key: string; text: string; namespace; kind }>`，`text` 为脱敏后的稳定语义文本（无 ID）。目录同时保留服务端侧 `key → { assessmentId?, sourcePath? }` 的私有映射，**不发给模型**。

### 2.3 evidenceKey 安全校验

模型返回的每个 `evidenceKey` 必须在目录中存在。校验规则（落地 `validity.ts` / provider 解析层）：

- 未知 key → 视为 `SCHEMA_INVALID`（触发一次 §7 结构修复；修复后仍未知则失败，不写正式结果）；
- key 语法必须匹配 `^[a-z]+(?:-[a-z]+)*:[a-z-]+:[0-9]+$` 或白名单裸键（如 `override:1`）；
- 目录之外的 key 一律拒绝，禁止模型自造键或引用"缺失证据"作为负证据（missing ≠ negative，见 §6）。

---

## 3. 幂等键与确定性任务 ID

### 3.1 inputHash 组成

`inputHash = SHA-256(canonicalJson(idempotencyInput))`，其中 `canonicalJson` 递归按 key 字典序排序、无空白、UTF-8。`idempotencyInput` **至少包含**：

```ts
{
  candidateVersionContentHash: string       // CandidateVersion.contentHash
  resumeContentHash: string
  jobMatchProfileContentVersion: string      // 正式画像版本内容
  capabilityBaselineContentVersion: string | null
  marketPositionContentVersion: string | null
  strategyContentVersion: string | null
  ruleProjectionHash: string
  promptVersion: string
  analysisPolicyVersion: string
  providerPolicyVersion: string
  provider: string
  model: string
}
```

> `cityCode`、`userOverrides` 已被上面各内容 hash / ruleProjectionHash 覆盖（override 投影进入 ruleProjectionHash 或单独 hash 项），不重复列举；实现时若 override 不在 ruleProjectionHash 内，必须单列 `userOverrideHash`。

### 3.2 确定性任务 ID

`analysis_tasks.input_hash` 无 UNIQUE，因此**用主键承载幂等**：

```text
task.id = `analysis-task:v1:${inputHash}`
```

同一输入永远映射到同一 task.id。创建流程：

1. 事务内 `SELECT ... WHERE id = 'analysis-task:v1:<hash>'`；
2. 命中：直接返回既有 task（`succeeded` 返回原 task+result；`queued/running` 返回进行中；`failed/cancelled` 见 §4 是否允许 retry）；
3. 未命中：`INSERT` queued task；
4. **并发插入冲突处理**：`INSERT` 命中主键冲突（`SQLITE_CONSTRAINT_PRIMARYKEY`）时，捕获异常并**重读**同 ID 行，返回已存在的 task（丢弃本次 INSERT）。这样两个并发相同输入的请求最终收敛到同一 task，不产生重复任务。

### 3.3 正式结果第二层保护

`job_match_analysis_records.input_hash UNIQUE` 作为成功结果的第二道幂等锁：即使两个 task（极端并发或历史遗留）走到写入，第二次 `INSERT` record 命中 UNIQUE 冲突时，改为**读取已有 record** 并把当前 task 的 `result_record_id` 指向它（§9），不产生两份成功结果。

> 两层保护：task.id 收敛任务；record.input_hash UNIQUE 收敛正式结果。任一层单独失效都不产生重复正式记录。

---

## 4. 状态机

### 4.1 冻结状态图

```text
queued
  → running
      → succeeded
      → failed
      → cancelled
```

（`queued → cancelled` 也允许，见下）无"恢复中/重试中"等中间态；恢复语义由 `error_code` 表达（TD §10.1）。

### 4.2 转移规则（全部使用 expected-current-status 条件更新）

| 转移 | 前置条件 | 说明 |
|---|---|---|
| `queued → running` | 当前必须 `queued` | 执行器领取任务，写 `started_at` |
| `running → succeeded` | 当前必须 `running` | 原子写 record（§9） |
| `running → failed` | 当前必须 `running` | 写 `error_code` / `finished_at` |
| `queued → cancelled` | 当前必须 `queued` | 尚未执行即取消 |
| `running → cancelled` | 当前必须 `running` | 见 §8 取消与迟到结果 |

**所有状态更新必须带 expected-current-status 条件**：`UPDATE ... SET status=@next WHERE id=@id AND status=@expected`，`changes !== 1` 视为竞态失败并中止本次转移（不覆盖他人已写入的终态）。`AnalysisTaskRepository.updateStatus` 当前无条件更新，V8-4 需新增 `compareAndSetStatus(id, expected, next, patch)` 原语（§16 修改清单）。

### 4.3 取消 / 完成 / retry 规则

- `queued` / `running` **可取消**；`succeeded` **不可取消**（对 `succeeded` 调 cancel → 幂等返回原 task，不改状态）；
- `failed` **可人工 retry**（§5）；`succeeded` 重复创建 → 返回原 task+result（§3.2）；
- **retry**：仅在 `failed` 且 `attempt_count < max_attempts` 时允许；把 task 重置为 `queued`、`attempt_count += 1`、清 `error_code/error_message/finished_at`，**复用原 `input_snapshot_json`**；
- `attempt_count >= max_attempts` 时 retry 被拒绝（返回稳定错误，不再排程）；
- **重复 cancel 幂等**：已 `cancelled` 再 cancel → 返回原 task，不报错、不改字段；
- `cancelled` **不自动恢复**，只能由用户重新创建（相同输入命中 §3 会复用 task.id，故需 §4.4 处理）。

### 4.4 cancelled/failed 终态下的"重新创建"

因为 task.id 由 inputHash 决定，相同输入的"重新分析"会命中已存在的 `cancelled`/`failed` 行。裁决：

- 命中 `failed`：等价于 retry（走 §4.3 retry 路径，若 attempt 未耗尽）；
- 命中 `cancelled`：允许一次"复活"为 `queued`（expected-status = `cancelled`），`attempt_count += 1`，复用原快照；仍受 `max_attempts` 约束。

---

## 5. attempt 语义

**不新增 `AnalysisAttempt` 表**。重试信息由 `analysis_tasks` 既有列承载：

- `attempt_count`：累计尝试次数（创建即 1，每次 retry/复活 +1）；
- `max_attempts`：上限（默认 3，可由 analysisPolicy 版本化配置）；
- `started_at` / `finished_at`：最近一次执行窗口；
- `error_code` / `error_message`：最近一次失败原因（`ANALYSIS_TASK_ERROR_CODES` 已在 `types.ts` 定义）；
- 自动化测试证据（§15）证明多次 attempt 行为符合契约。

**明确限制**：v0.8 **不提供**完整的逐次 attempt 历史页面——`analysis_tasks` 只保留最近一次执行的时间/错误，历史尝试不单独留行。逐次 attempt 审计留到 v0.9 再评估。此限制写入 UI（§14）与文档，避免误导用户以为有完整重试历史。

---

## 6. Structured Output `JobMatchAnalysisPayloadV1`

### 6.1 契约定位

`JobMatchAnalysisPayloadV1Schema` 是发给用户的**唯一正式分析结果契约**，落地为 Zod `strictObject`，存入 `job_match_analysis_records.payload_json`。它 **扩展** TD §4.9 `JobMatchAiPayload`（`schemaVersion:'1.0'`），新增 counterEvidence/missingEvidence/hardConstraints 等字段并给每条结论加**结论类型**。`recommendation` 与 `confidence` 复用 domain 既有枚举（`JOB_MATCH_RECOMMENDATIONS` / `JOB_MATCH_CONFIDENCES`），并冗余抽到 Envelope 列。

### 6.2 结构

```ts
type ConclusionKind = 'fact' | 'inference' | 'user_preference' | 'rule_result' | 'unknown'

interface EvidenceReference { evidenceKey: string; note: string }  // note ≤ 200 字

interface AnalysisPoint {
  statement: string           // ≤ 200 字
  kind: ConclusionKind
  evidence: EvidenceReference[]   // ≤ 8；kind=unknown 时可为空
}

interface MatchDimension {
  assessment: string          // ≤ 300 字
  kind: ConclusionKind
  evidence: EvidenceReference[]   // ≤ 8
}

interface JobMatchAnalysisPayloadV1 {
  schemaVersion: '1.0'
  jobFacts: Array<{ statement: string; kind: ConclusionKind; evidenceKey: string | null }>  // ≤ 20
  roleFit: MatchDimension
  capabilityFit: MatchDimension
  businessAndCompanyFit: MatchDimension
  cityAndSalaryFit: MatchDimension
  transferableEvidence: EvidenceReference[]   // ≤ 10
  gaps: AnalysisPoint[]                        // ≤ 12
  risks: AnalysisPoint[]                       // ≤ 12
  counterEvidence: AnalysisPoint[]             // ≤ 12
  uncertainties: AnalysisPoint[]               // ≤ 12
  missingEvidence: string[]                    // ≤ 12，每条 ≤ 160 字
  hardConstraints: AnalysisPoint[]             // ≤ 12，kind 常为 rule_result
  recommendation: 'apply_now' | 'stretch' | 'verify' | 'skip'
  confidence: 'low' | 'medium' | 'high'
  summary: string                              // ≤ 600 字
  recruiterQuestions: string[]                 // ≤ 8，每条 ≤ 160 字
  communicationAngles: string[]                // ≤ 8，每条 ≤ 160 字
}
```

### 6.3 约束（全部由 Schema / 解析层强制）

- `strictObject`：禁止未知字段（任意层级出现即结构错误）；
- 数组上限如上；字符串长度上限如上；**总 JSON 序列化字节 ≤ 32KB**（超出视为 `SCHEMA_INVALID`）；
- **禁止 HTML**：所有字符串拒绝 `<[a-zA-Z/]` 起始的标签样式片段（正则守卫）；
- **禁止未知 evidenceKey**：所有 `evidenceKey` 必须在 §2 目录内（§2.3）；
- **禁止百分制匹配分**：Schema 无数值分字段；`confidence` 仅三档枚举；
- **missing ≠ negative**：`missingEvidence` 表达"缺证据需核验"，不得被当作反证；`counterEvidence` 必须引用目录内真实反证据；
- **malformed payload 不得写入正式结果**：JSON 解析失败 / Zod 失败 / 超限 / 未知 key / 含 HTML → 走 §7 一次修复，仍失败则 task=`failed`，**绝不写 `job_match_analysis_records`**。

---

## 7. Provider 与一次结构修复

### 7.1 `JobMatchAnalysisProvider` 接口

```ts
interface JobMatchAnalysisProvider {
  isConfigured(): boolean
  providerKey(): string     // 'deepseek' | 'fake'
  modelName(): string
  analyze(
    catalog: EvidenceCatalogV1,
    semanticInput: JobMatchAnalysisModelInputV1,   // 无内部 ID 的语义输入
    signal: AbortSignal,
  ): Promise<{ payload: JobMatchAnalysisPayloadV1; model: string }>
}
```

两个实现：

- **production adapter**（`deepSeekJobMatchAnalysisProvider`）：调用 `chatCompletion`（复用 transport + AbortSignal），严格解析 + 一次修复；
- **deterministic fake**（`fakeJobMatchAnalysisProvider`，供测试/沙箱/E2E）：可编程覆盖以下场景 —— `timeout`、`rate limit`、`network failure`、`malformed`（首答坏结构）、`repair success`（首答坏、修复成功）、`repair failure`（两答都坏）、`delayed cancellable`（等待 AbortSignal 再返回，用于取消/迟到测试）。fake 由构造入参决定行为，全程确定性、无网络。

### 7.2 一次结构修复规则

首答 JSON 解析失败或 Zod/约束校验失败时，**只允许一次结构修复调用**（参考 `aiProvider.ts` 的 first→repair 模式）。修复必须：

- 使用**相同 input snapshot / 相同证据目录**（不读取漂移后的数据库）；
- 只修**结构**（补齐字段、去未知字段、截断超限、去 HTML、纠正枚举），**不新增事实、不改变已有事实含义、不引入目录外 evidenceKey**；
- 修复答仍失败 → 返回 `STRUCTURE_REPAIR_FAILED`（task=`failed`）；
- **不允许第三次模型调用**。

### 7.3 transport retry 与 task retry 的区分

- **transport retry**：`provider.ts` 的 `fetchWithRetry`（网络层指数退避重试），针对连接类错误；
- **task retry**：§5 的 `attempt_count`，针对整个分析任务的人工重试；
- **裁决：V8-4 Provider 调用必须关闭或固定 transport retry**，避免网络层重试被误计为 task attempt，也避免不可取消的隐藏重试拖长取消响应。实现方式：`chatCompletion` 增加显式 `maxRetries` 选项（或 V8-4 分析路径设 `OFFERFLOW_LLM_RETRY_MAX` 等价的调用级 `retryMax:0`），分析 Provider 固定传 0。这是对 `provider.ts` 的**唯一**改动点（§16），且向后兼容（默认仍读原 env）。
- 错误码映射：transport 超时 → `PROVIDER_TIMEOUT`；网络失败 → `PROVIDER_NETWORK_ERROR`；HTTP 429 → `PROVIDER_RATE_LIMIT`；结构/校验/未知 key → 先修复，终失败 `STRUCTURE_REPAIR_FAILED` 或首层 `SCHEMA_INVALID`；配置缺失 → `CONFIGURATION_ERROR`。

---

## 8. Cancel 与迟到结果

### 8.1 进程内取消登记

执行器维护进程内 `Map<taskId, AbortController>`（`executor.ts`）：

- `queued → running` 领取任务时创建 `AbortController` 并登记；
- `running → 终态` 后从 Map 删除；
- 进程重启后 Map 为空——由 §10 恢复扫描处理遗留 `running`。

### 8.2 取消顺序（严格）

1. **先事务性把任务更新为 `cancelled`**（expected-status = `queued` 或 `running`，写 `cancelled_at`、`error_code=CANCELLED_BY_USER`）；
2. 若命中的是 `running`，`abort()` 对应 Provider 的 `AbortController`；
3. Provider 调用返回（无论正常返回、抛 AbortError 还是迟到成功）后，执行器**重新读取任务**；
4. **任务状态非 `running` 时，绝不写 `AnalysisRecord`**，直接丢弃模型输出；
5. `cancelled` 任务永远 `result_record_id = null`，永不产生 resultRecordId。

### 8.3 迟到结果保证

即使 Provider 不支持中断、AbortSignal 到达前已产出完整结果，因第 3–4 步的"返回后重读 + 非 running 不写"，迟到结果也无法写入正式记录（评测 F-05）。取消对 `succeeded` 无效（§4.3）。

---

## 9. 原子成功写入

`running → succeeded` 在**单个数据库事务**内完成（`executor.ts` + 新增 repo 原语）：

1. **再读 task**（`SELECT ... WHERE id=?`）；
2. 确认 `status === 'running'`（否则中止：可能已被取消/失败，丢弃结果）；
3. `INSERT` 不可变 `JobMatchAnalysisRecord`（id、全部 Envelope 版本字段、`input_hash`、`recommendation`、`confidence`、`payload_json`）；
4. **`input_hash` UNIQUE 冲突**（§3.3）：捕获冲突 → `SELECT` 既有 record → 用其 id 作为 `result_record_id`（不插入第二份）；
5. `compareAndSetStatus(taskId, 'running', 'succeeded', { finished_at, result_record_id })`；
6. 写入 `result_record_id`（= 新 record 或步骤 4 的既有 record）；
7. **任一步失败 → 整个事务回滚**：不留半成功状态；task 保持 `running`，由外层捕获置 `failed`（`error_code=RESULT_WRITE_FAILED`），**不得错误标记 succeeded**（评测 F-07）。

> 步骤 2 的"再读并确认 running"与 §8 的"取消后重读"共同保证：取消与成功写入互斥，先到者赢，不会既 cancelled 又写 record。

---

## 10. 进程恢复

**仅在 Analysis capability 显式开启时**执行（§13）；capability 关闭时不扫描、不触碰任何行。启动扫描（`executor.ts` 的 `recoverOnStartup`，通过 `listByStatus`）：

- `queued` 任务：**重新调度**（重新进入执行队列，复用原快照，`attempt_count` 不变——尚未开始执行）；
- `running` 任务：**标记 `failed`**，`error_code = PROCESS_RESTART_INTERRUPTED`，写 `finished_at`（expected-status = `running`）；
- **不继续旧 HTTP / SSE 请求**（进程已重启，旧连接不存在）；
- 用户对 `PROCESS_RESTART_INTERRUPTED` 的 `failed` 任务**人工 retry** 后，从**原 input snapshot 重新执行**（§5），不冒充断点续跑（TD RT-09）。

恢复扫描本身幂等：重复运行只影响仍处于 `queued`/`running` 的行。

---

## 11. stale 判定（有效性投影）

### 11.1 不新增字段

沿用 TD §8：`job_match_analysis_records` 不可变，有效性在**查询时**由记录内冻结版本与当前 active 版本比较派生，落地 `validity.ts`，返回 TD §8.2 的 `AnalysisValidity`。

### 11.2 比较项与 reason 映射

| 比较项 | reason |
|---|---|
| CandidateVersion（记录 `candidate_version_id` vs 候选 active version） | `candidate_version_changed` |
| ResumeVersion | `resume_version_changed` |
| JobMatchProfileVersion | `job_match_profile_changed` |
| CapabilityBaselineVersion | `capability_baseline_changed` |
| MarketPositionVersion | `market_position_changed` |
| StrategyVersion | `strategy_changed` |
| RuleVersion | `rule_version_changed` |
| PromptVersion | `prompt_version_changed` |
| AnalysisPolicyVersion | `analysis_policy_changed` |
| 显式 Model Policy 失效 | `model_policy_invalidated` |

### 11.3 模型名称变化默认不 stale

`model_name` 变化**默认不**产生 stale（TD §8.2）。只有 `providerPolicyVersion` 对应的**显式 Model Policy** 声明旧模型结果不可用于推荐时，才产生 `model_policy_invalidated`。

### 11.4 推荐约束

- 正式推荐只使用 `current`（TD INV-07 / §8.3）；
- `stale` 结果在详情页作为"旧版参考"展示，不进入推荐计算；
- 用户可对 stale 结果重新分析（创建新 task，新记录 `supersedes_analysis_id` 链接旧记录）；
- 前端不得通过参数绕过 stale 约束（有效性由服务端派生，§12 只读投影只输出结果）。

---

## 12. API 契约

### 12.1 接口清单（均在 Radar 安全网关下，`routes.ts` 同一 scope）

```http
POST /radar/candidate-versions/:id/analysis-tasks   创建（幂等）单岗位分析任务
GET  /radar/analysis-tasks/:id                       轮询任务状态
POST /radar/analysis-tasks/:id/retry                 人工重试 failed/cancelled
POST /radar/analysis-tasks/:id/cancel                取消 queued/running
GET  /radar/candidates/:id/analyses                  候选的历史分析（含 stale 投影）
GET  /radar/analyses/:id                             单条分析结果详情
```

> 路径统一挂在 `/radar/*`（与 V8-2/V8-3 采集/评审同网关），不使用 TD §11.6 的顶层 `/api/analysis-tasks/*`——V8-4 分析任务专属 Radar 域，避免与未来 recommendation_batch 任务入口混淆。DTO 全部严格 Zod（`analysisDtoSchemas.ts`）。

### 12.2 关键 DTO

- **CreateAnalysisTaskResponse**：`{ task: AnalysisTaskView }`；`AnalysisTaskView` = 任务状态投影（status、attemptCount、maxAttempts、errorCode、startedAt/finishedAt、resultAnalysisId?），**不含 input_snapshot_json、不含 prompt、不含 provider 原始响应**；
- **AnalysisResultView**（`GET /radar/analyses/:id`）：`{ record: {...Envelope 非敏感元字段}, payload: JobMatchAnalysisPayloadV1, validity: AnalysisValidity, evidenceCatalog: EvidenceCatalogPublicV1 }`——目录只含 `key/text/namespace/kind`，**不含私有 assessmentId 映射**；
- **CandidateAnalysesView**：分析列表 + 每条 validity（current/stale + reasons）+ recommendation/confidence 摘要。

### 12.3 写接口共同要求（TD §11.7）

- 严格 Zod 服务端校验；参数化，绝不信任前端传入的 active 画像/简历版本（服务端重新读取并冻结）；
- **loopback / Host / Origin / custom header 安全网关**：复用 `routes.ts` 既有 `assertCaptureRequestAllowed`（同 scope preHandler）；
- **safe error**：稳定错误码 + requestId/taskId；错误体不回显完整 Prompt、JD、Provider 原始响应或凭据；
- **task polling**：`GET /radar/analysis-tasks/:id` 供前端轮询（无 SSE 绑定，TD "v0.8 不绑定 SSE"）；
- **idempotent replay**：创建接口命中 §3 返回既有 task；
- **stale projection**：读接口带 validity；
- **不返回**完整 Prompt、原始 JD、Provider 原始响应、内部数据库 ID 映射或任何凭据。

---

## 13. 能力门禁

### 13.1 后端 `radar.analysisEnabled`

`RadarCapability` 新增 `analysisEnabled?: boolean`，**默认 false**（`server/index.ts`）。分析路由注册条件（全部满足）：

- `radar.enabled === true`；
- `radar.analysisEnabled === true`；
- `getDatabaseSchemaVersion(db) >= RADAR_DOMAIN_SCHEMA_VERSION`（v7）。

分析任务只用 v7 已有的 `analysis_tasks` / `job_match_analysis_records`，**不需要 v8**。评审路由（V8-3）仍单独要求 `schema >= v8`（`routes.ts` 现有逻辑不变）。生产真实入口（`server/index.ts` 底部 `buildServer({...})`）**不传 `radar.analysisEnabled`**，保持关闭。

### 13.2 前端 `VITE_OFFERFLOW_RADAR_ANALYSIS`

新增前端 flag，**默认 false**（与既有 Radar flag 同模式）。为 false 时不挂载分析入口/面板。**生产构建入口不得开启**；仅沙箱/演练/测试显式开启。

### 13.3 门禁与 stale/DISABLED 现状一致

本设计不改变"生产 schema v7 / Radar 正式入口 DISABLED / Analysis 正式入口 DISABLED"的现状；能力仅在受控环境可用。

---

## 14. UI · `RadarAnalysisPanel.vue`

### 14.1 定位（遵守 DESIGN.md）

**非聊天式页面**。高信息密度、结论先行、证据渐进展开、状态语义色、无 AI 魔法感、无装饰性动画。分析结果是"决策卡片"，不是对话流。

### 14.2 页面状态

`not_started`、`queued`、`running`、`succeeded`、`failed`、`cancelled`、`stale`（`succeeded` 但 validity=stale 的叠加态）。状态用语义色徽标（DESIGN.md）：running=info 青、succeeded=success 绿、failed=danger 红、cancelled=neutral、stale=highlight 蓝紫、queued=warning。

### 14.3 展示内容（结论先行 → 证据展开）

- **当前输入版本**（candidateVersionNo / resume / profile / 可选上下文 / cityCode 或"全局画像"）；
- **recommendation**（四档，语义色）+ **confidence**（三档）——顶部结论区；
- **summary**；
- **匹配点**：roleFit / capabilityFit / businessAndCompanyFit / cityAndSalaryFit（默认收起，展开看 evidence）；
- **hard constraints**（红色优先）、**risks**、**counter evidence**、**gaps**、**uncertainties**、**missing evidence**；
- **evidence references**：点结论展开引用的证据文本（映射自目录 key）；
- **recruiter questions**、**communication angles**（可复制）；
- **retry**（failed/cancelled 可见）、**cancel**（queued/running 可见）；
- **历史分析**：同候选历史记录列表，stale 标注为"旧版参考"，明确文案"不提供逐次重试历史"（§5 限制）。

### 14.4 交互约束

- 轮询 `GET /radar/analysis-tasks/:id` 更新状态，无 SSE；
- stale 结果只读展示 + "重新分析"入口，不允许前端绕过；
- 不显示原始 Prompt / JD / Provider 原始响应 / 数据库 ID。

---

## 15. 测试矩阵

全部使用 deterministic fake Provider（§7.1），确定性、无网络、无 `Date.now`/随机不可控依赖（注入 `now`/`createId`，复用 `serviceDeps` 模式）。

| # | 用例 | 断言要点 | 关联证据 |
|---|---|---|---|
| T-01 | 幂等 | 相同输入两次创建 → 同 task.id、同 record，零重复行 | §3 / F-06 |
| T-02 | 并发创建 | 两个并发相同输入 → 主键冲突重读，收敛单 task | §3.2 |
| T-03 | 状态机 | 非法转移（succeeded→cancelled 等）被 expected-status 拒绝 | §4 |
| T-04 | retry | failed 且 attempt<max → queued、attempt+1、复用快照；attempt 耗尽拒绝 | §5 / §4.3 |
| T-05 | cancel | queued/running 可取消，succeeded 不可取消，重复 cancel 幂等 | §8 / F-05 |
| T-06 | late response | 取消后 Provider 迟到成功 → 不写 record，result_record_id=null | §8.3 / F-05 |
| T-07 | restart recovery | queued 重排、running→failed(PROCESS_RESTART_INTERRUPTED)，retry 从原快照 | §10 / F-04 |
| T-08 | 一次 repair | 首答坏→修复成功写入；两答坏→STRUCTURE_REPAIR_FAILED，无第三次调用 | §7.2 / F-03 |
| T-09 | atomic result write | 写入中途失败全回滚，task 不误判 succeeded，无两份成功记录 | §9 / F-07 |
| T-10 | stale | 逐项切换 10 个版本各命中对应 reason；model_name 变化默认不 stale | §11 / Eval 5.3 |
| T-11 | readiness | 缺 Resume/Profile → INPUT_NOT_READY；缺 Capability → confidence≤medium | §1 / TD §7 / Eval 5.2 |
| T-12 | global city fallback | 非苏锡沪杭 → cityCode=null、全局画像、城市证据不足 | §1 / TD §5.2 |
| T-13 | evidenceKey 安全 | 模型返回目录外 key → SCHEMA_INVALID→修复→仍未知则 failed | §2.3 / §6.3 |
| T-14 | 无内部 ID | 发给 fake 的 Payload/catalog 断言无 candidateId/versionId/assessmentId/snapshotId | §2.1 |
| T-15 | 无敏感信息 | API 响应与错误体断言无 Prompt/JD/原始响应/凭据/DB ID | §12 |
| T-16 | 零正式记忆污染 | 全流程 jobs / applications / feedback_events 新增为 0 | INV-06 |
| T-17 | deterministic fake E2E | 沙箱 v7：创建→轮询→succeeded→读取结果→retry→cancel 全链路 | §13 / Eval 9 |
| T-18 | missing≠negative | missingEvidence 不进入 counterEvidence；缺证据不降级为反证 | §6.3 |
| T-19 | 超限/HTML 拒绝 | 超 32KB / 含 HTML / 数组超限 → 修复→仍违规则 failed | §6.3 |
| T-20 | 幂等键覆盖 | 改任一 hash 项（含 promptVersion/policyVersion）→ 新 task.id | §3.1 |

---

## 16. 实施文件规划

### 16.1 新增文件（`server/radar/analysis/`）

```text
server/radar/analysis/
  contracts.ts        JobMatchAnalysisPayloadV1 类型 + Zod strictObject + 结论类型/长度/数组/HTML/字节约束
  inputSnapshot.ts    JobMatchAnalysisInputSnapshotV1 构建（事务内冻结）+ 投影类型 + Zod
  evidenceCatalog.ts  EvidenceCatalogV1 生成、语义键规则、公有/私有映射拆分、evidenceKey 校验
  provider.ts         JobMatchAnalysisProvider 接口 + deepSeek 适配 + deterministic fake + 一次修复
  taskStateMachine.ts 状态转移表 + expected-current-status 断言 + retry/cancel/复活规则
  executor.ts         队列执行、Map<taskId,AbortController>、原子成功写入、恢复扫描 recoverOnStartup
  validity.ts         AnalysisValidity 派生（stale reasons，model 变化默认不 stale）
  service.ts          RadarAnalysisService：创建/查询/retry/cancel/幂等/准备度门禁
  routes.ts           §12 六个接口 + DTO 复用安全网关（或并入现有 radar/routes.ts 同 scope）
  errors.ts           分析域错误 → ANALYSIS_TASK_ERROR_CODES 映射 + safe error 体
  analysisDtoSchemas.ts  请求/响应 DTO 严格 Zod
```

前端：`src/pages/radar/RadarAnalysisPanel.vue`（+ 只读 API client、`sessionCapability` 同款 flag 读取）。

测试：`server/radar/analysis/*.spec.ts`（覆盖 §15 T-01~T-20）、前端组件 spec、沙箱 E2E。

### 16.2 需修改的既有文件（本轮不改，仅登记）

| 文件 | 改动 | 兼容性 |
|---|---|---|
| `server/radar/analysisTaskRepository.ts` | 新增 `compareAndSetStatus(id,expected,next,patch)`、`getByIdForUpdate`（事务内再读）；保留现有无条件 `updateStatus` 或替换调用点 | 纯新增原语 |
| `server/radar/analysisRecordRepository.ts` | 复用现有 `insert` / `findByInputHash`；可能加事务内 upsert-on-conflict 辅助 | 向后兼容 |
| `server/llm/provider.ts` | `chatCompletion` 增加调用级 `retryMax`（分析路径传 0），关闭 transport retry 计入 task attempt | 默认仍读 env，向后兼容 |
| `server/index.ts` | `RadarCapability` 增 `analysisEnabled?`；满足条件时注册分析路由；生产入口不开启 | 默认 false |
| `server/radar/routes.ts` | 挂载 §12 分析路由（同 scope 安全网关）或委托 analysis/routes.ts | 采集/评审不受影响 |
| `src/domain/radar/{types,schemas}.ts` | `JobMatchAnalysisRecord.payload` 由 `unknown` 收紧为 `JobMatchAnalysisPayloadV1`（或新增分析契约导出） | 收紧型变更，需回归 |
| 前端 radar 页面/路由 | 挂载 `RadarAnalysisPanel.vue`（flag 后） | flag 默认关闭 |

---

## 17. 不采用 / 明确不做

- 不新增 migration、不改生产库、不推进 `PRODUCTION_SCHEMA_VERSION`；
- 不新增 `AnalysisAttempt` 表、不做逐次 attempt 历史页面（§5）；
- 不接新 AI Provider、不做 BYOK、不绑定 SSE、不承诺断点续跑；
- AI Payload 不含内部 ID / 版本 / hash / 模型信息（TD §4.9）；
- 不用 legacy `/api/llm/analyze-job` 作为正式契约；
- 模型升级默认不等同全量 stale；
- 不创建第二套 Application/Feedback 流程；分析全程零正式记忆写入。

---

## 18. 无 migration 确认

**确认本轮设计不需要新增 migration**：`analysis_tasks` 与 `job_match_analysis_records` 已由 schema v7（`server/migrations/radarDomainSchemaV7.ts`）建表，含本设计所需全部列（含 `attempt_count`/`max_attempts`/`error_code`/`result_record_id`/`input_snapshot_json`、record 侧全部 Envelope 版本列与 `input_hash UNIQUE`）。幂等由 **确定性主键 `analysis-task:v1:<inputHash>`** + **record.input_hash UNIQUE** 双层承载，无需为 `analysis_tasks.input_hash` 补 UNIQUE 索引，故无需 schema 变更。

---

## 19. 阻塞与未决

- **无阻塞**：本设计所需存储、transport、修复模式、安全网关均已存在，实施只新增服务层与前端面板 + 少量向后兼容原语。
- 未决（不阻塞设计冻结，实施期确认）：
  - `ResumeProjectionV1` / `JobMatchProfileProjectionV1` 的具体字段需在实施时对齐既有 resume/profile 领域投影（复用现有 active 版本读取）；
  - `analysisPolicyVersion` / `promptVersion` / `providerPolicyVersion` 初始常量值在实施首个 PR 固定；
  - `userOverrides` 是否并入 `ruleProjectionHash` 或单列 `userOverrideHash`（§3.1）在实施时二选一并写死。
- 生产启用仍需独立授权：Radar 正式入口、Analysis 正式入口开启及任何生产库变更均在本设计范围外。

