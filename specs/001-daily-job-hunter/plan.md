# OfferFlow v0.9 技术计划：每日岗位猎手

> **Plan 版本：** 2.0  
> **对应 Spec：** `specs/001-daily-job-hunter/spec.md`  
> **对应 PRD：** `docs/prd/offerflow-v0.9.md` (v2.3 Final Candidate)  
> **创建日期：** 2026-08-11  
> **最后修订：** 2026-08-11（Plan Amendment：修正 Jooble API snippet 假设、Secret Storage 改为 DPAPI、Autostart 收敛为 HKCU Run、Migration 改为表重建、新增 Provider Validation Gate）  
> **状态：** 完成 —— 等待用户审核  
> **前置 Spec-Kit 阶段：** PRD ✅ → Constitution ✅ → Specification ✅ → Clarify ✅ → **Plan ← 本轮**  

---

## 0. Constitution Check

逐条检查 Constitution 十二项原则。

| # | 原则 | 判定 | 说明 |
|---|---|---|---|
| I | Frozen Facts First | **PASS** | v0.8 Radar 领域模型不做反向修改。所有新增表为 additive migration。不改变现有 Candidate/Version/Snapshot/Analysis/Recommendation 语义。`capture_method` CHECK 扩展为受控表重建 migration（与 schema v8 的 `radar_actions` 表重建流程一致）。 |
| II | One Domain, No Shadow Models | **PASS** | 不创建第二套 Candidate、CandidateVersion、AnalysisTask、MatchAnalysis、RecommendationBatch、RuleAssessment。Preference 评估复用现有 `radar_rule_assessments.category='preference'`。JobJudgment 是新增独立实体，不与 RadarAction 语义重叠。 |
| III | Immutable Evidence | **PASS** | PlanVersion 不可变。SourceRun 失败不覆盖历史，RETRY 创建新 Run。JobJudgment 修改走 supersedes 模式（保留旧版本）。PreferenceSignal 失效标记 invalidated_at，不物理删除。Snapshot 不变。 |
| IV | Human Authority | **PASS** | 高影响 PreferenceRule 必须 EXPLICIT_CONFIRM。JobJudgment 四档由用户选择，AI 只提取 Signal/生成追问。SearchPlan 由用户定义。AI 不自动修改画像、战略、薪资底线或城市。 |
| V | Reliability Before Automation | **PASS** | Outbox 持久化 + Worker + 有限退避。SourceRun 显式 FAILED / INTERRUPTED / WAITING_FOR_USER。RETRY 创建新 Run。Ingestion/Analysis/Recommendation/Notification 全部幂等。Provider 错误明确区分 VALID_EMPTY / AUTH_ERROR / RATE_LIMITED 等。 |
| VI | Local First | **PASS** | 复用现有 SQLite + Fastify。Scheduler 运行在同一进程。不引入 Redis/PostgreSQL/BullMQ/Kubernetes。不暴露公网。 |
| VII | Product Need Before Infrastructure | **PASS** | 不建设通用 Agent Runtime。SourceRun 不变成通用 Checkpoint Engine。Pipeline 是简单、显式的步骤序列。Notification 只做到 QQ SMTP + 可替换 Channel。 |
| VIII | Spec Before Code | **PASS** | 本轮为 Plan 阶段，不写业务代码。Spec 已冻结，Clarify 已清零 NEEDS CLARIFICATION。 |
| IX | Tests Follow Risk | **PASS** | Plan 明确测试层级：Ingestion 回归、Provider 错误矩阵、Scheduler 状态机、Notification 幂等、Judgment 版本化、Migration 演练。 |
| X | Git Bash Only | **PASS** | 所有开发命令使用 Bash。Windows Autostart 使用 OS 原生能力（注册表/启动文件夹），不引入 PowerShell 作为开发 Shell。 |
| XI | Cost Is a Product Constraint | **PASS** | SourceRun 和 DailyJobBrief 包含 costSummary。复用现有 usage/cost 追踪能力。Jooble API 若无可靠货币成本，标记 "Cost unavailable"——不伪造。 |
| XII | Third-Party Replaceability | **PASS** | SearchProvider 通过 Adapter 接口隔离。Jooble 具体实现不侵入 Candidate/Analysis/Recommendation 核心。SMTP Channel 通过 NotificationChannel 抽象，未来可替换。 |

**Constitution Check 结论：全部十二项 PASS。无 NEEDS JUSTIFICATION 项。**

---

## 1. 架构概览

### 1.1 新增组件

```
┌─────────────────────────────────────────────────┐
│                  v0.9 新增                        │
│                                                  │
│  DailySearchPlan / PlanVersion                   │
│       ↓                                          │
│  Scheduler (Fastify 进程内)                       │
│       ↓                                          │
│  SearchProviderAdapter (Jooble REST API)          │
│       ↓                                          │
│  SourceRun (执行追踪)                             │
│       ↓                                          │
│  RadarIngestionService (从 RadarCaptureService    │
│  抽取的共享核心)                                  │
│       ↓                                          │
│  ┌─────── 复用 v0.8 Radar ───────┐              │
│  │ Snapshot → Candidate →        │              │
│  │ Version → Rule → Analysis →   │              │
│  │ RecommendationBatch           │              │
│  └──────────────────────────────┘              │
│       ↓                                          │
│  DailyJobBrief (日报容器)                        │
│       ↓                                          │
│  NotificationOutbox → QQ SMTP                    │
│       ↓                                          │
│  JobJudgment → PreferenceSignal → PreferenceRule │
│       ↓                                          │
│  反馈到下一轮 Search/Sort/Suppress               │
└─────────────────────────────────────────────────┘
```

### 1.2 复用组件

| 组件 | 复用方式 |
|------|----------|
| `RadarCaptureSnapshot` | 直接复用。Active Discovery 写 `captureSessionId=null`, `captureMethod='api_discovery'`（需受控表重建 migration） |
| `RadarSourceRecord` | 直接复用。Provider identity 使用 `providerKey='jooble'` |
| `RadarCandidate` / `RadarCandidateVersion` | 直接复用。通过共享 Ingestion Core 生成 |
| `RadarCandidateRelation` | 直接复用 |
| `RadarRuleAssessment` | 直接复用。PreferenceRule 评估写入 `category='preference'` |
| `AnalysisTask` / `JobMatchAnalysisRecord` | 直接复用。`entityType='radar_candidate_version'` |
| `AnalysisService` | 直接复用。主动 Discovery 触发分析走同一 `createTask` |
| `RadarRecommendationBatch` | 直接复用。DailyJobBrief 通过 `recommendationBatchId` 引用 |
| `RecommendationBatchService` | 直接复用。扩展 Preference 评分输入 |
| `RadarAction` | 直接复用。不与 JobJudgment 混淆 |
| `RadarPromotion` | 直接复用 |
| SQLite / better-sqlite3 | 直接复用 |
| Fastify 本地服务 | 直接复用。Scheduler + Outbox Worker 在同一进程 |
| Migration 基础设施 | 直接复用。`runMigrations` + `LATEST_SCHEMA_VERSION` |
| Host Snapshot V3 | 直接复用。新表纳入 snapshot |
| NovaWing Host Adapter | 直接复用 |

### 1.3 需要抽取的共享组件

**从 `RadarCaptureService` 抽取 `RadarIngestionService`**：

当前 `RadarCaptureService.materializeItem()` 包含完整 ingestion 链：
1. `buildSnapshot` → `insertSnapshot`
2. `normalizeCandidateFields`
3. `resolveIdentity`（provider-aware）
4. `decideCommit`（fingerprint + material change）
5. `insertNewVersion` / 原子切换 `activeVersionId`
6. SourceRecord / Candidate / SourceLink 管理

抽取策略：
- 将 `materializeItem` 的核心逻辑（步骤 1-6）提升为独立 `RadarIngestionService`
- `RadarCaptureService` 改为调用 `RadarIngestionService.ingest(IngestionInput)` 
- `SearchProviderAdapter` 也调用 `RadarIngestionService.ingest(IngestionInput)`
- `IngestionInput` 是标准化输入契约（不含 `RadarPreviewItem` / `captureSessionId` 等 Browser Capture 特有概念）
- Browser Capture 的 `captureSessionId` 继续写 Snapshot，但不进入 Ingestion 核心逻辑

---

## 2. 核心技术设计

### 2.1 共享 Radar Ingestion Core

**输入契约 `RadarIngestionInput`**：

```ts
interface RadarIngestionInput {
  // 来源身份
  providerKey: string | null;
  providerVersion: string | null;
  externalRecordId: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  
  // 内容
  visibleText: string;
  pageTitle: string | null;
  
  // 结构化字段（可选）
  recognizedFields: Partial<RadarCandidateNormalized> | null;
  
  // 元数据
  extractionMetadata: unknown;
  capturedAt: number;
  
  // 会话关联（可选）
  captureSessionId: string | null;
  captureMethod: RadarCaptureMethod;
}
```

**输出 `RadarIngestionOutcome`**：

```ts
interface RadarIngestionOutcome {
  snapshotId: string;
  sourceRecordId: string | null;
  candidateId: string | null;
  candidateVersionId: string | null;
  decisionType: CommitDecisionType;
  analysisEligible: boolean;
  decision: CommitDecisionSummary;
}
```

**调用关系**：

```
Browser Capture (RadarCaptureService)
  → 构造 RadarIngestionInput（含 captureSessionId）
  → RadarIngestionService.ingest(input)
  
SearchProviderAdapter
  → 构造 RadarIngestionInput（captureSessionId=null, captureMethod='api_discovery'）
  → RadarIngestionService.ingest(input)
```

**关键不变性保证**：
- Browser Capture 行为完全兼容（Snapshot/session/commit 语义不变）
- Candidate identity 规则不变（providerKey+externalRecordId → normalizedSourceUrl → content hash）
- CandidateVersion material change 语义不变（fingerprint v1 比较）
- 不伪造 captureSession

### 2.2 Snapshot 与 Data Quality Gate

**`capture_method` CHECK 扩展——表重建 Migration**：

真实当前 schema（`server/migrations/radarDomainSchemaV7.ts`）：
```sql
capture_method TEXT NOT NULL CHECK (
  capture_method IN (
    'boss_current_page', 'generic_visible_text',
    'pasted_text', 'shared_link_and_text', 'json_import'
  )
)
```

扩展为：
```sql
capture_method TEXT NOT NULL CHECK (
  capture_method IN (
    'boss_current_page', 'generic_visible_text',
    'pasted_text', 'shared_link_and_text', 'json_import',
    'api_discovery'
  )
)
```

**迁移方式**：这不是普通 `ADD COLUMN`——修改 CHECK 约束在 SQLite 中需要 **表重建 migration**（与 schema v8 的 `radar_actions` 表重建流程一致）：

```
backup
↓
transaction
↓
CREATE TABLE radar_capture_snapshots_v9_new (...)
↓
INSERT INTO ... SELECT ... (copy 所有既有行)
↓
preserve FK / indexes / constraints
↓
DROP TABLE radar_capture_snapshots
↓
ALTER TABLE ... RENAME TO radar_capture_snapshots
↓
PRAGMA foreign_key_check
↓
integrity verification
↓
v0.8 Radar regression
```

**绝对禁止**：`PRAGMA writable_schema` 直接手改生产 schema 文本。

**设计选择**：评估了两种方案——
- **方案 A（采用）**：扩展现有 `capture_method` CHECK，新增 `'api_discovery'`。需要表重建 migration，但与既有 `radar_actions` 重建（v8）流程完全一致，已验可可靠执行。
- **方案 B（放弃）**：新增独立列 `discovery_method TEXT` 避免改 CHECK。问题：分裂语义（同一张表两个方法列）、查询复杂、未来 Provider 类型增加时仍然要改。

选择方案 A。禁止把 `api_discovery` 假装成 `json_import` 或其他错误旧语义。

Active Discovery 的 Snapshot：
- `captureSessionId = null`
- `captureMethod = 'api_discovery'`
- `providerKey = 'jooble'`
- `visibleText` = 从 Jooble snippet + title + company + location 拼合
- `rawSnapshot` 包含完整 API 原始 payload + provenance（`source`/`link`/`updated`/`id`）

**Data Quality Gate**（新增——Jooble 只提供 snippet，不保证完整 JD）：

```
Jooble Result
↓
保存完整 API 原始 payload / provenance
↓
Radar Ingestion
↓
数据质量评估
↓
只有事实充分的 CandidateVersion 才进入正式 MatchAnalysis
```

信息不足时：
```
保留 Candidate
+
Data Quality / insufficient evidence
```

**禁止**：
- 根据 snippet 编造完整 JD
- 为补全 JD 自动去抓专业招聘平台页面（BOSS/拉勾/猎聘/智联/前程无忧）

如果 Jooble 的 `link`/`source` 指向允许主动读取的 Company Career / Open Web 来源，未来可由对应 Provider 独立处理。P0 Jooble Provider 本身不承担万能网页爬虫职责。

### 2.3 SearchProvider Architecture

#### 核心接口

```ts
interface SearchProviderAdapter {
  readonly providerKey: string;
  readonly providerVersion: string;
  
  search(
    plan: DailySearchPlanVersion, 
    tasks: SearchTask[],
    signal: AbortSignal
  ): Promise<SearchProviderResult>;
}

interface SearchTask {
  city: string;
  roleDirection: string;
  keyword: string;
  salary?: { min?: number; max?: number } | null;
  page?: number;
}

interface SearchProviderResult {
  items: SearchResultItem[];
  coverage: {
    tasksCompleted: number;
    tasksFailed: number;
    failedScopes: FailedScope[];
  };
  providerMeta: {
    requestsMade: number;
    rateLimitRemaining?: number;
    cost?: ProviderCost;
  };
}

interface SearchResultItem {
  providerKey: string;
  providerVersion: string;
  sourceUrl: string;
  externalRecordId: string;
  title: string;
  company: string;
  location: string;
  salary?: string;
  snippet: string;
  source: string;        // Jooble: 原始来源站名
  link: string;          // Jooble: 原始岗位 URL
  updated: string;       // Jooble: 更新时间
  capturedAt: number;
  rawResponse: unknown;  // 完整 API 响应（写 Snapshot）
}
```

#### P0: Jooble Provider

**API Contract**（基于 Jooble 官方文档 `POST /api/{api_Key}`）：
- Endpoint: `https://jooble.org/api/<API_KEY>`
- Method: POST
- Body: `{ keywords, location, radius?, salary?, page?, ResultOnPage?, SearchMode?, companysearch? }`
- Response: `{ jobs: [...], totalCount: number }`
  - jobs[]: `title`, `location`, `snippet`, `salary`, `source`, `type`, `link`, `company`, `updated`, `id`
- Auth: API Key in URL path（不进 Git、不进日志、Secret 管理）

**关键假设**：Jooble 官方 API 提供的是 **`snippet`（岗位摘要）**，不是完整 JD。Plan 不假定 Jooble 一定返回完整 JD。

**搜索输入映射**：

| SearchPlan 字段 | Jooble 参数 |
|----------------|-------------|
| roleDirection + keyword | `keywords` |
| city | `location` |
| salary.min | `salary`（具体语义验证后确认）|
| page | `page` |

**搜索输出消费**：

| Jooble 字段 | 映射到 |
|------------|--------|
| `id` | `externalRecordId` |
| `title` | `SearchResultItem.title` / `recognizedFields.role` |
| `company` | `SearchResultItem.company` / `recognizedFields.company` |
| `location` | `SearchResultItem.location` / `recognizedFields.city` |
| `salary` | `SearchResultItem.salary` / 解析到 `recognizedFields.salaryMinK/salaryMaxK` |
| `snippet` | `SearchResultItem.snippet` / `visibleText`（作为主要文本来源，不假定完整 JD） |
| `source` | `SearchProviderResultItem.source`（provenance） |
| `link` | `SearchResultItem.link` / `sourceUrl` |
| `updated` | `SearchResultItem.updated` |
| `type` | Snapshot metadata |

**分页、Rate Limit 与 Scan Budget**：
- 通过 `page` 参数控制分页
- `ResultOnPage` 控制每页返回数量
- **Provider quota / rate limit**：当前具体额度未冻结，取得真实 API Key 后验证。无论官方额度如何，OfferFlow 自身仍实施有限请求、Scan Budget 和退避策略。
- 默认每城市×方向×关键词组合最多 1 页（受 `scanBudget.maxPagesPerTask` 控制）
- 达到 Scan Budget 立即停止后续 page 请求

### 2.4 Provider Error Model

```ts
type SearchProviderErrorCode =
  | 'VALID_EMPTY'           // 搜索正常，结果为空
  | 'AUTH_ERROR'            // API Key 无效/过期
  | 'RATE_LIMITED'          // 频率限制
  | 'TIMEOUT'               // 请求超时
  | 'NETWORK_ERROR'         // 网络不可达
  | 'MALFORMED_RESPONSE'    // 响应结构异常
  | 'PROVIDER_UNAVAILABLE'  // Provider 服务不可用（5xx）
  | 'ACTION_REQUIRED';      // 需用户介入（如 API Key 配置）

interface FailedScope {
  taskKey: string;   // e.g. "苏州×AI前端"
  errorCode: SearchProviderErrorCode;
  message: string;
}
```

**核心原则**：`VALID_EMPTY`（API 请求成功 + 响应有效 + jobs=[]）与 `AUTH_ERROR`/`TIMEOUT`/`NETWORK_ERROR` 严格区分。禁止 `catch(...) { return [] }` 吞异常。

### 2.5 DailySearchPlan 与 PlanVersion

**DailySearchPlan** — 用户的可变配置聚合根：

```ts
interface DailySearchPlan {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'deleted';
  activeVersionId: string | null;
  createdAt: number;
  updatedAt: number;
}
```

**DailySearchPlanVersion** — 不可变配置快照：

```ts
interface DailySearchPlanVersion {
  id: string;
  searchPlanId: string;
  version: number;
  
  cities: CityConfig[];
  roleDirections: string[];
  baseKeywords: string[];
  expandedKeywords: ExpandedKeyword[];
  
  hardConstraints: HardConstraint[];
  sourceConfigs: SourceConfig[];
  
  schedule: ScheduleConfig;
  scanBudget: ScanBudget;
  analysisBudget: AnalysisBudget;
  
  briefPolicy: BriefPolicy;
  explorationPolicy: ExplorationPolicy;
  notificationPolicy: NotificationPolicy;
  
  // 补偿
  latestCatchUpTime: string;  // "12:00"
  
  createdAt: number;
  activatedAt: number | null;
  supersedesVersionId: string | null;
}
```

**关键设计决策**：
- Plan 修改创建新 Version（不可变）
- 旧 SourceRun 永远指向旧 Version
- `expandedKeywords` 记录来源 PreferenceRule、规则版本、为何扩展
- `sourceConfigs` 至少包含一个 `{ providerKey: 'jooble', ... }`
- Schedule 使用本地时间（"09:00"），由 Scheduler 解析

**与 JobMatchProfile 的关系**：
- SearchPlan 表达"今天怎么找"（搜索策略）
- JobMatchProfile 表达"用户总体在找什么/匹配标准"（画像）
- 两者不混合：SearchPlan 的 hardConstraints 引用 Profile 约束但独立存储

### 2.6 Scheduler

**运行于现有 Fastify 进程内**：

```
Fastify 启动
  → initSchema
  → 检查错过 Schedule
  → 启动 Scheduler（setInterval / setTimeout 链）
  → 恢复未完成 Outbox
  → 注册路由
  → listen
```

**Scheduler 核心逻辑**：

```ts
class DailyScheduler {
  private timer: NodeJS.Timeout | null = null;
  
  start(): void {
    this.checkMissedSchedules();
    this.scheduleNext();
  }
  
  private scheduleNext(): void {
    const nextRun = this.calculateNextRun();
    const delay = nextRun - Date.now();
    this.timer = setTimeout(() => this.fire(), delay);
  }
  
  private async fire(): Promise<void> {
    // 1. 冻结 PlanVersion
    // 2. 展开 SearchTask
    // 3. 创建 SourceRun（triggerType=SCHEDULED）
    // 4. 执行 Pipeline
    // 5. 完成后 scheduleNext()
  }
  
  private checkMissedSchedules(): void {
    // 服务恢复时检查
    // 符合条件的创建 CATCH_UP SourceRun
    // 同一 PlanVersion 同一自然日最多一次
  }
}
```

**关键约束**：
- 同一计划最多一个活跃 SourceRun（pending/running）
- 调度使用 `setTimeout` 精确到分钟级
- 服务关闭时通过 Fastify `onClose` 清理 timer
- SCHEDULED / CATCH_UP / MANUAL / RETRY 四种触发类型

### 2.7 Autostart

**Windows 原生开机启动方案**：

P0 只选一个 canonical mechanism：

> **`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`**

原因：
- 当前单用户 local-first，不需要管理员权限
- 可以明确 enable / disable
- 可以由 UI 显示安装状态
- Windows 登录后启动即可
- 即使系统延迟启动，Scheduler Catch-up 已负责补偿错过的任务
- 不引入额外依赖（Win32 API 或 PowerShell）

Fallback：仅当真实兼容性问题出现后才评估启动文件夹（`Start Menu\Programs\Startup`）方案。不预先维护两套正式 Autostart 机制。

启动命令：
- 通过注册表 Run 键配置 Windows 原生快捷方式
- 实际命令指向：`bash -c "cd /d/VSCode/offer-flow && pnpm run dev"`（使用 Git Bash）
- 开发命令继续 Bash-only
- Autostart 管理通过 `POST /api/local-service/autostart/enable|disable` API
- UI 展示当前 Autostart 状态
- 不在 UI 提供"启动服务"按钮（已停止进程无法 HTTP 自举）

**开发 Shell 与 Runtime 的区分**：
- 开发 Shell = Git Bash only（禁止 PowerShell/CMD）
- Runtime 调用 Windows OS 原生能力（注册表读写）≠ PowerShell 作为开发 Shell

### 2.8 SourceRun

```ts
interface SourceRun {
  id: string;
  searchPlanVersionId: string;
  
  sourceKey: string;          // e.g. 'jooble'
  sourceVersion: string;      // e.g. '1.0.0'
  
  triggerType: 'SCHEDULED' | 'CATCH_UP' | 'MANUAL' | 'RETRY';
  retryOfRunId: string | null;
  
  status: 'PENDING' | 'RUNNING' | 'WAITING_FOR_USER' 
        | 'PARTIALLY_SUCCEEDED' | 'SUCCEEDED' | 'FAILED' 
        | 'CANCELLED' | 'INTERRUPTED';
  phase: 'PREPARING' | 'DISCOVERING' | 'INGESTING' 
        | 'ANALYZING' | 'RECOMMENDING' | 'BUILDING_BRIEF';
  
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  
  // 计数
  plannedTaskCount: number;
  completedTaskCount: number;
  scannedCount: number;
  ingestedCount: number;
  newCount: number;
  changedCount: number;
  duplicateCount: number;
  conflictCount: number;
  blockedCount: number;
  analysisRequestedCount: number;
  analysisSucceededCount: number;
  selectedCount: number;
  alertedCount: number;
  failedCount: number;
  
  // JSON
  coverageJson: CoverageReport;
  progressJson: ProviderProgress;  // NOT generic checkpoint
  costSummaryJson: CostSummary;
  
  errorCode: string | null;
  errorMessage: string | null;
  
  createdAt: number;
  updatedAt: number;
}
```

**`progressJson` 不是 Generic Checkpoint**：它只表达 provider-local progress（当前 page、已完成 task 列表），不表达 Agent session/step/resume token。

**Retry**：失败 Run 保留原状态 → 创建新的 `RETRY` Run（`retryOfRunId = 旧Run.id`）。不覆盖历史。

### 2.9 Analysis 复用

主动 Discovery 不新增分析任务类型。利用现有：
- `AnalysisService.createTask(candidateVersionId)` — 创建/复用分析任务
- `analysis_tasks` 表的 `input_hash UNIQUE` 保证幂等
- 现有 retry 机制
- 现有 stale 检测

Pipeline 中的分析步骤：
1. 对每个 `analysisEligible=true` 的新/变化 CandidateVersion
2. 调用 `AnalysisService.createTask(candidateVersionId)`
3. 等待完成（或异步 + SourceRun 记录 analysisRequestedCount）
4. 成功后 JobMatchAnalysisRecord 自动创建

### 2.10 Recommendation 复用

复用现有 `RecommendationBatchService.generateBatch()`：
- 输入：scope candidate version IDs（去重排序）
- 输出：0-8 条 selected + blocked 列表

**v0.9 扩展**：
- PreferenceRule 评估结果作为额外输入
- 影响排序（boost/penalty）、抑制（suppression）、解释
- 探索位 0-1 条（标记 `exploration=true`）

### 2.11 DailyJobBrief

```ts
interface DailyJobBrief {
  id: string;
  briefDate: string;  // "2026-08-11"
  
  searchPlanVersionId: string;
  sourceRunIds: string[];
  
  recommendationBatchId: string;  // FK reference
  
  status: 'GENERATING' | 'READY' | 'IN_REVIEW' | 'COMPLETED' | 'FAILED';
  
  coverageJson: CoverageReport;
  costSummaryJson: CostSummary;
  emptyReason: string | null;
  
  generatedAt: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
```

**关键约束**：
- 不复制 `selectedCandidateVersionIds`（RecommendationBatch 是唯一权威）
- 审批进度派生：`Batch.selectedCandidateVersionIds - 已有有效 JobJudgment 的条目`
- 不存 `currentIndex`

### 2.12 JobJudgment

```ts
interface JobJudgment {
  id: string;
  dailyBriefId: string;
  radarCandidateId: string;
  candidateVersionId: string;
  matchAnalysisId: string | null;
  
  judgment: 'VERY_SUITABLE' | 'SOMEWHAT_SUITABLE' | 'NOT_VERY_SUITABLE' | 'VERY_UNSUITABLE';
  
  systemRecommendation: 'apply_now' | 'stretch' | 'verify' | 'skip';
  systemConfidence: 'low' | 'medium' | 'high';
  
  judgedAt: number;
  
  supersedesJudgmentId: string | null;
  revertedAt: number | null;
  
  createdAt: number;
  updatedAt: number;
}
```

**与 RadarAction 严格区分**：
- RadarAction: `saved | ignored | marked_priority | marked_applied_pending`（用户决策动作）
- JobJudgment: `VERY_SUITABLE | SOMEWHAT_SUITABLE | NOT_VERY_SUITABLE | VERY_UNSUITABLE`（用户评价判断）
- 两者不互转、不混用、不互相依赖

**修改与撤销**：
- 修改 = `supersedesJudgmentId` 指向旧判断 + 新判断成为有效版本
- 不物理删除旧行
- 旧 PreferenceSignal 失效（`invalidated_at`）
- 派生 PreferenceRule 重算

### 2.13 JudgmentReason

```ts
interface JudgmentReason {
  id: string;
  judgmentId: string;
  
  reasonCode: string | null;
  reasonText: string | null;
  
  polarity: 'positive' | 'negative' | 'neutral';
  
  relatedJdEvidenceJson: unknown;
  
  source: 'USER_SELECTED' | 'USER_TEXT' | 'AI_EXTRACTED';
  
  createdAt: number;
}
```

**关键约束**：
- `USER_SELECTED` / `USER_TEXT` = 用户原话（权威输入）
- `AI_EXTRACTED` = AI 派生（derived）
- 两者不混淆，前端明确区分展示

### 2.14 Preference 三层模型

**PreferenceSignal** — 单次局部偏好证据：

```ts
interface PreferenceSignal {
  id: string;
  judgmentId: string;
  
  featureKey: string;
  featureValueJson: unknown;
  
  direction: 'positive' | 'negative';
  strength: 'strong' | 'medium' | 'weak';
  
  scopeJson: unknown;
  confidence: number;  // 0-1
  
  createdAt: number;
  invalidatedAt: number | null;
}
```

**PreferenceRule** — 稳定偏好规则：

```ts
interface PreferenceRule {
  id: string;
  
  ruleType: 'RANK_BOOST' | 'RANK_PENALTY' | 'SUPPRESS' | 'SEARCH_EXPAND';
  featureKey: string;
  
  conditionJson: unknown;
  effectJson: unknown;
  
  status: 'PROPOSED' | 'ACTIVE' | 'DISABLED' | 'DELETED';
  explanation: string;
  
  activationMode: 'EXPLICIT_CONFIRM' | 'THRESHOLD_AUTO' | 'PROPOSED';
  
  createdAt: number;
  updatedAt: number;
  disabledAt: number | null;
}
```

**激活规则**：
- 强信号 ×2 独立岗位 或 中信号 ×3 独立岗位 → 生成 Proposal
- HIGH_IMPACT 规则（城市屏蔽、行业屏蔽、薪资底线、主方向改变、技术栈硬排除、公司类型屏蔽）→ 必须 EXPLICIT_CONFIRM
- 否则 THRESHOLD_AUTO（达到阈值自动激活）

**集成到现有 RadarRuleAssessment**：
- PreferenceRule 对 CandidateVersion 评估
- 写入 `radar_rule_assessments`，`category='preference'`
- Recommendation Pipeline 消费这些评估

### 2.15 NotificationOutbox 与 SMTP

**Outbox 模式**：

```
业务事件（高优先级提醒/日报/失败/需操作）
  → INSERT notification_outbox（status=PENDING）
  → Worker Claim（status=SCHEDULED/SENDING）
  → SMTP 发送
  → SENT / FAILED_RETRYABLE / FAILED_FINAL / ACTION_REQUIRED
```

**SMTP 配置**：
- P0: QQ SMTP（`smtp.qq.com:465` TLS）
- Secret: QQ 邮箱授权码，加密存储
- Secret 不进 Git、不进普通日志、API 不返回明文、不进普通 DB backup

**Secret Storage**：
- 使用 `SecretStore` 抽象
- **Production / Windows**：优先 OS-bound Secret Protection——Windows DPAPI 或等价 Windows Credential 机制
- **Development / Test**：允许环境变量注入
- P0 目标：Secret 加密结果可存储在本地配置/数据库，但解密能力绑定当前 Windows 用户/机器
- 任务阶段研究最小可靠 Node ↔ Windows DPAPI 实现方式（不需要现在绑定特定第三方 Node package）
- 备份数据库不包含明文 Secret
- 跨机器 restore 后 Secret 可能需要重新配置
- 用户 Windows 凭据异常导致 Secret 无法解密时 → `ACTION_REQUIRED`
- 不引入 Vault / KMS / 外部密钥管理服务

### 2.16 Cost Visibility

复用现有模型 usage/cost 追踪：
- `SourceRun.costSummaryJson`：scannedCount, analysisCount, modelUsage, tokenCount（可用时）, actualCost（可用时）
- `DailyJobBrief.costSummaryJson`：当日汇总
- 无可靠成本数据时标记 "Cost unavailable"

---

## 3. 数据模型

详见 [data-model.md](data-model.md)。

**新增表**：
- `daily_search_plans`
- `daily_search_plan_versions`
- `source_runs`
- `daily_job_briefs`
- `job_judgments`
- `judgment_reasons`
- `preference_signals`
- `preference_rules`
- `notification_channels`
- `notification_outbox`
- `notification_links`

**现有表 additive 变更**：
- `radar_capture_snapshots`：扩展 `capture_method` CHECK 约束（新增 `'api_discovery'`）——**这不是普通 ADD COLUMN，是需要 SQLite 表重建的受控兼容性 Migration**（与 schema v8 的表重建流程一致）

**不新增的 Shadow Models**：
- 无 `Opportunity`
- 无第二套 Candidate/CandidateVersion
- 无 `RawSourceSnapshot`
- 无 `DiscoveryAnalysisTask`
- 无 `PreferenceCandidateAssessment`

---

## 4. Migration Plan

### 4.1 Schema 版本

- 当前 `LATEST_SCHEMA_VERSION = 8`
- v0.9 新 migration: **schema v9**
- `PRODUCTION_SCHEMA_VERSION` 保持 2（生产底座下限）
- 生产库升级需要显式授权（`db:upgrade-real -- --confirm`）

### 4.2 Migration 内容

- 新建 12 张 v0.9 表（含 `preference_rule_sources`）
- **表重建 Migration**：`radar_capture_snapshots`——扩展 `capture_method` CHECK 约束以新增 `'api_discovery'`（与 schema v8 的 `radar_actions` 表重建流程一致）
- 所有新表外键、UNIQUE 约束、索引
- Migration 前自动备份（复用现有 `backupDatabase()`）

### 4.3 兼容性保证

- v0.8 Radar 在 v0.9 migration 后继续可用
- 新表为空开始，不伪造历史 Judgment/Preference
- 不反向改写 v0.8 Snapshot / CandidateVersion / AnalysisRecord
- 关闭 v0.9 功能后旧 Radar 仍可工作
- 新表/字段纳入 Host Snapshot V3

---

## 5. API 设计

沿用现有 Fastify + loopback + Origin 保护 + `/api/radar/*` 风格。

详见 [contracts/](contracts/) 目录。

**核心新路由**：
- `GET/POST /api/daily-search-plans`
- `GET /api/daily-search-plans/:id`
- `POST /api/daily-search-plans/:id/versions`
- `POST /api/daily-search-plans/:id/activate|pause|resume|run-now|skip-today`
- `GET /api/source-runs`
- `GET /api/source-runs/:id`
- `POST /api/source-runs/:id/retry|cancel`
- `GET /api/daily-job-briefs`
- `GET /api/daily-job-briefs/today`
- `GET /api/daily-job-briefs/:id`
- `POST /api/daily-job-briefs/:briefId/items/:candidateId/judgment`
- `PATCH /api/job-judgments/:id`
- `DELETE /api/job-judgments/:id`
- `POST /api/job-judgments/:id/reason`
- `GET /api/preference-rules`
- `PATCH /api/preference-rules/:id`
- `DELETE /api/preference-rules/:id`
- `GET/POST /api/notification-channels`
- `PATCH/DELETE /api/notification-channels/:id`
- `POST /api/notification-channels/:id/test`
- `GET /api/notifications`
- `POST /api/notifications/:id/retry`
- `GET /api/local-service/status`
- `GET /api/scheduler/status`
- `POST /api/local-service/autostart/enable|disable`

---

## 6. UI Plan

复用现有 Radar UI，新增页面：

| 路由 | 功能 | 组件 |
|------|------|------|
| `/radar/daily-brief` | 今日汇报 + 四档审批 | 新建 `DailyBriefPage.vue` |
| `/radar/search-plan` | 找岗计划配置 | 新建 `SearchPlanPage.vue` |
| `/radar/source-runs` | 来源运行历史 | 新建 `SourceRunsPage.vue` |
| `/radar/preferences` | 偏好记忆管理 | 新建 `PreferencesPage.vue` |
| `/notifications` | 通知中心 | 新建 `NotificationsPage.vue` |
| `/settings/notifications/email` | QQ 邮箱配置 | 新建 `EmailSettingsPage.vue` |
| `/settings/local-service` | 本地服务状态 | 新建 `LocalServicePage.vue` |

**不重做整个 Radar App**。现有 `/radar/*` 页面保持不变。

---

## 7. 安全

| 安全领域 | 措施 |
|----------|------|
| 外部 JD 不可信输入 | 统一走现有 Snapshot → normalize → Zod 校验链 |
| API 响应不可信输入 | Provider Adapter 内 sanitize，字段长度限制 |
| Prompt 注入 | 复用现有 Prompt 隔离：JD 作为 data block，不执行指令 |
| 恶意 HTML/文本 | 复用现有清洗：Unicode 正规化、控制字符清除、长度限制 |
| 不安全链接 | 仅允许 http/https URL，校验协议白名单 |
| Secret 不泄露 | SMTP 授权码 + Jooble API Key 加密存储，不进 Git/日志/API响应 |
| SMTP 不泄露 | 邮件不含简历全文/Token/API Key/调试日志/原始HTML |
| 专业招聘平台 Crawler 禁止 | Jooble 为 REST API（非爬虫）。BOSS/拉勾/猎聘等仅通过 Browser Manual Capture |

---

## 8. 测试策略

### 8.1 Radar Ingestion
- Browser Capture 旧行为回归（现有测试全部保留）
- Provider ingestion: 同 source 同 externalId → 同一 Candidate
- 同一 candidate 多 source hit → 不重复创建
- Material change → 新 CandidateVersion
- Unchanged → 不创建新版本
- Snapshot `captureSessionId=null` + `captureMethod='api_discovery'`

### 8.2 Scheduler
- SCHEDULED 正常触发
- CATCH_UP 补偿触发
- Skip Today 不触发
- 同一 PlanVersion 同一自然日最多一次 CATCH_UP
- Dedupe: 并发触发拒绝
- 服务重启: missed schedule 检测
- Pause/Resume

### 8.3 Provider
- 成功返回
- VALID_EMPTY
- AUTH_ERROR
- RATE_LIMITED
- TIMEOUT
- MALFORMED_RESPONSE
- PROVIDER_UNAVAILABLE

### 8.4 Analysis
- 复用已有 AnalysisTask/Service 测试
- 主动 Discovery 触发分析：`createTask(candidateVersionId)` 正常
- Idempotency: 相同 input 不重复分析

### 8.5 Recommendation
- 0-8 条输出
- Preference boost
- Negative suppression
- Exploration 位
- 不凑数

### 8.6 Notification
- Outbox 写入
- Idempotency key: 重复通知拒绝
- Retry 有限退避
- Auth failure → ACTION_REQUIRED
- 邮件失败不污染业务状态

### 8.7 Judgment
- 创建四档判断
- 修改 → supersedes
- 撤销 → 旧 Signal 失效
- Source 区分 USER_SELECTED / AI_EXTRACTED
- 审批进度派生（不用 currentIndex）

### 8.8 Migration
- Fresh DB 初始化（schema v9）
- v8 → v9 升级
- 备份恢复
- 旧 Radar 回归（v0.8 功能不受影响）

---

## 9. 实现波次

| 波次 | 内容 | 依赖 |
|------|------|------|
| **V9-0** | **Jooble Provider Validation Gate（新增——在投入完整 Discovery 基建前）** | V8.x 基线 |
| | 1. API Key 能真实取得 | |
| | 2. 中国地区搜索可调用 | |
| | 3. 苏州 / 无锡等至少一个目标城市能获得真实结果 | |
| | 4. 返回字段和官方 contract 一致 | |
| | 5. 真实结果的数据完整度足以进入 Radar | |
| | 6. 至少部分结果具备正式 MatchAnalysis 所需的最低事实 | |
| | 7. `source`/`link` 行为真实可追踪 | |
| | 如果验证失败 → 记录 **Provider Validation Failed**，不偷改 Radar 规则、不爬专业招聘平台，重新决策 Provider | |
| **V9-1** | Shared Radar Ingestion Core | V9-0 |
| | - 从 RadarCaptureService 抽取 RadarIngestionService | |
| | - `capture_method` CHECK 扩展 + 表重建 migration `'api_discovery'` | |
| | - Browser Capture 行为兼容 | |
| | - Snapshot/SourceRecord/Candidate/Version 语义不变 | |
| **V9-2** | SearchPlan + Scheduler + Jooble Discovery | V9-1 |
| | - DailySearchPlan / PlanVersion 模型与 API | |
| | - SearchProviderAdapter 接口 | |
| | - Jooble REST API Provider | |
| | - SearchTask 展开 | |
| | - Scheduler（进程内 setInterval/setTimeout） | |
| | - SourceRun 模型与追踪 | |
| | - SCHEDULED / CATCH_UP / MANUAL / RETRY | |
| | - Skip Today / Pause / Resume | |
| | - Provider Error Model（8 种错误码） | |
| | - Coverage 报告 | |
| | - Windows Autostart | |
| **V9-3** | Discovery → Radar → DailyJobBrief | V9-2 |
| | - Pipeline: discover → ingest → assess → analyze → recommend → buildBrief | |
| | - Analysis 复用（createTask 触发） | |
| | - RecommendationBatch 复用（generateBatch） | |
| | - Preference 扩展推荐排序 | |
| | - DailyJobBrief 模型与 API | |
| | - Cost Summary | |
| | - Empty Brief | |
| | - Partial Coverage | |
| **V9-4** | QQ SMTP + NotificationOutbox | V9-3 |
| | - NotificationChannel 模型 | |
| | - Secret Storage（加密） | |
| | - NotificationOutbox 模型与 Worker | |
| | - QQ SMTP Sender | |
| | - HIGH_PRIORITY_ALERT / DAILY_BRIEF / RUN_FAILED / ACTION_REQUIRED | |
| | - Test Email | |
| | - 幂等 + Retry + Quiet Hours | |
| | - 通知中心 UI | |
| **V9-5** | JobJudgment（四档审批） | V9-3 |
| | - JobJudgment 模型 | |
| | - 四档审批 UI（Daily Brief 卡片） | |
| | - 修改/撤销 | |
| | - 审批进度派生 | |
| | - Completion Summary | |
| | - JudgmentReason（来源区分） | |
| | - 与 RadarAction 严格分离 | |
| **V9-6** | Preference Learning | V9-5 |
| | - PreferenceSignal 提取 | |
| | - PreferenceRule Proposal / 激活 / 停用 / 删除 | |
| | - 高影响规则确认 | |
| | - Preference → RadarRuleAssessment (category='preference') | |
| | - 智能追问（≤1 / 岗位） | |
| | - SearchExpand | |
| | - Repeated Mistake Protection | |
| **V9-7** | Production Validation | V9-1..V9-6 |
| | - Migration 演练（v8→v9） | |
| | - Backup / Restore | |
| | - Host Snapshot 更新 | |
| | - Scheduler Crash 恢复 | |
| | - Source Failure 矩阵 | |
| | - SMTP Failure 矩阵 | |
| | - Outbox Idempotency | |
| | - 连续 3 自然日真实运行 | |
| | - Cost Visibility 验证 | |
| | - README / Changelog | |

---

## 10. P0 验收

保留 Spec 已冻结验收标准：

> **连续至少 3 个自然日真实运行**：Scheduler 自动触发、Jooble API 返回真实岗位、搜索结果进入统一 Radar Ingestion、重复岗位不重复创建 Candidate、岗位变化进入 CandidateVersion 事实链、Provider 失败不伪装 0 岗位、Coverage 完整可追踪、无无限 retry、至少形成一次真实 MatchAnalysis、一次真实 RecommendationBatch、一次真实 DailyJobBrief。

---

## 11. 关键研究结论

详见 [research.md](research.md)。核心结论：

1. **Jooble API**：REST API，API Key 认证，POST 请求体 `keywords/location/radius?/salary?/page?/ResultOnPage?/SearchMode?/companysearch?`，响应 `jobs[]` 含 `title/location/snippet/salary/source/type/link/company/updated/id`。关键约束：**只提供 snippet 而非完整 JD**。Plan 不假定完整 JD，Data Quality Gate 只让事实充分的 CandidateVersion 进入分析。
2. **RadarCaptureService 抽取**：`materializeItem` 的 Snapshot → normalize → identity → fingerprint → decision → write 链可以安全抽取，无需改变语义
3. **捕获方法扩展**：`capture_method` 真实当前 CHECK 为 `'boss_current_page', 'generic_visible_text', 'pasted_text', 'shared_link_and_text', 'json_import'`。新增 `'api_discovery'` 需要 SQLite 表重建 migration（与 schema v8 的 `radar_actions` 表重建流程一致）
4. **Windows Autostart**：P0 仅 `HKCU\...\Run` 注册表单一机制。Fallback 仅在真实兼容性问题出现后评估。
5. **Node SMTP**：使用 `nodemailer`（新增依赖），QQ SMTP `smtp.qq.com:465` TLS
6. **Secret Storage**：`SecretStore` 抽象，Production 优先 Windows DPAPI，Development 允许环境变量
7. **Scheduler**：`setTimeout` 链 + 服务恢复检查，不需要独立进程
8. **Provider Validation Gate**（新增）：在 V9-1 实施前先验证 Jooble API 真实覆盖与数据完整度

---

## 12. 遗留风险

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| Jooble 中国岗位覆盖不足 | 高 | **V9-0 Provider Validation Gate 提前验证**；预留 CompanyCareerProvider 后续接入 |
| Jooble snippet 数据不足以进入 MatchAnalysis | 中 | Data Quality Gate 机制；信息不足 → 保留 Candidate + insufficient evidence，不编造 JD |
| Jooble API Key / quota 限制 | 中 | **Quota 未冻结**，取得真实 Key 后验证；Error Model 显式区分 AUTH_ERROR/RATE_LIMITED |
| Provider 稳定性（Jooble 服务中断） | 中 | PROVIDER_UNAVAILABLE 错误码；SourceRun FAILED；不丢数据 |
| Windows Autostart 可靠性 | 中 | HKCU Run 单一机制；UI 显示状态；用户可手工启动 |
| QQ SMTP 授权码过期 | 低 | ACTION_REQUIRED 显式通知；不无限 retry |
| Windows DPAPI 凭据异常导致 Secret 不可读 | 低 | ACTION_REQUIRED；Secret 重新配置即可；不影响业务数据 |
| Preference 过拟合 | 低 | Exploration 位保留；阈值激活；高影响规则需确认 |

---

## 13. Git 约束确认

- ✅ 未修改 `src/` `server/` `browser-extension/` 业务源码
- ✅ 未执行真实 Migration
- ✅ 未修改生产数据库
- ✅ 未 commit / push / tag / release
- ✅ 仅修改 `specs/001-daily-job-hunter/` 下 Plan 产物

---

## 14. 停止确认

**本轮已完成 `/speckit.plan`。**

未执行 `/speckit.tasks`。  
未执行 `/speckit.analyze`。  
未执行 `/speckit.implement`。

未修改业务源码。  
未执行真实 Migration。  
未修改生产数据库。  
未 commit。  
未 push。

**等待用户审核 Plan 后进入 `/speckit.tasks`。**
