# OfferFlow v0.9 技术计划：每日岗位猎手

> **Plan 版本：** 3.0  
> **对应 Spec：** `specs/001-daily-job-hunter/spec.md`  
> **对应 PRD：** `docs/prd/offerflow-v0.9.md` (v2.3 Final Candidate)  
> **创建日期：** 2026-08-11  
> **最后修订：** 2026-08-11（Plan Amendment v3：Jooble → Tavily Search API，Active Discovery Source Strategy 重建，Search Evidence / Source Policy / Content Acquisition / Evidence Upgrade 架构设计）  
> **状态：** Plan Amendment 完成 —— 等待用户审核  
> **前置 Spec-Kit 阶段：** PRD ✅ → Constitution ✅ → Specification ✅ → Clarify ✅ → Plan ✅ → Plan Amendment ← 本轮

---

## 0. Provider Decision History

### Initial Selection → Evaluation → Rejection → New Decision

```text
Jooble REST API
  → evaluated（2026-08-11，基于 China market Pre-validation）
  → pre-validation FAILED（Product Suitability Failure：中国大陆技术岗位覆盖密度不足）
  → REJECTED_AFTER_PREVALIDATION（保留完整历史，不考虑重新激活）

Tavily Search API
  → evaluated（2026-08-11，Pre-validation: TAVILY_PASS）
  → P0 SELECTED

Brave Search API
  → evaluated（2026-08-11）
  → BRAVE_FAIL（持久化权在基础计划不授予，Enterprise 需自定义定价）
```

Jooble 历史保留在 `research.md §0` 和 `search-provider-prevalidation.md`。

---

## 0.1 Constitution Check（重新跑——全部 12 条）

| # | 原则 | 判定 | 说明 |
|---|---|---|---|
| I | Frozen Facts First | **PASS** | v0.8 Radar 领域模型不做反向修改。`capture_method` CHECK 扩展为受控表重建 migration。新增 `evidence_level` / `source_policy` 为 additive 字段。`originType` 新增 `'evidence_upgrade'`（受控 migration）。 |
| II | One Domain, No Shadow Models | **PASS** | Search Evidence 进入现有 `radar_capture_snapshots` + `radar_candidate_versions`。不创建 `DiscoveryCandidate`、`SearchOpportunity`、`SearchRecommendationBatch`、`SearchDailyBriefItem`。MANUAL_REVIEW_REQUIRED 候选通过 DailyJobBrief 的 `discoveryItems` 字段引用（不是第二套推荐）。 |
| III | Immutable Evidence | **PASS** | PlanVersion 不可变。SourceRun 失败不覆盖历史。Search Evidence 作为 Snapshot 不可变。Evidence Upgrade 创建新 CandidateVersion（`originType='evidence_upgrade'`）。旧 Search Evidence 版本不变。 |
| IV | Human Authority | **PASS** | 高影响 PreferenceRule 必须 EXPLICIT_CONFIRM。MANUAL_REVIEW_REQUIRED 候选由用户决定。AI 只做 Search → Discovery → Analysis → Recommendation。不自动替第三方决定录用。 |
| V | Reliability Before Automation | **PASS** | Outbox 持久化 + Worker + 有限退避。SourceRun 显式 FAILED / INTERRUPTED / WAITING_FOR_USER。Provider 错误明确区分（含 USAGE_LIMIT）。Search Evidence 幂等去重。 |
| VI | Local First | **PASS** | 复用现有 SQLite + Fastify。不引入 Redis/PostgreSQL/BullMQ/Kubernetes。 |
| VII | Product Need Before Infrastructure | **PASS** | Source Policy P0 为 code/config policy（不建 DSL/Engine/Platform）。Content Acquisition 最小实现，不做 GenericCrawlerRuntime。 |
| VIII | Spec Before Code | **PASS** | Spec 已冻结。Clarify 已清零。Plan 在 Amendment 后重新校准。 |
| IX | Tests Follow Risk | **PASS** | Ingestion 回归、Provider 错误矩阵、Evidence Upgrade、Source Policy 判定、手动核实路径覆盖。 |
| X | Git Bash Only | **PASS** | 所有开发命令 Bash。 |
| XI | Cost Is a Product Constraint | **PASS** | Tavily credits 优先记录真实 `usage.credits_used`。`estimatedSearchCredits` / `actualSearchCredits` 双轨。Query budget + dedupe 防止笛卡尔积浪费。不自行估造成本。 |
| XII | Third-Party Replaceability | **PASS** | Search Evidence 模型基于 Tavily/Brave 共同最小语义设计。Tavily DTO 停留在 Adapter boundary。Content Acquisition 独立于 SearchProvider。 |

**Constitution Check 结论：全部十二项 PASS。无 NEEDS JUSTIFICATION 项。**

---

## 1. 架构概览

### 1.1 完整 Active Discovery 产品链

```
DailySearchPlan / PlanVersion
       ↓
Scheduler（Fastify 进程内，现有）
       ↓
SearchProviderAdapter（Tavily Search API — /search ONLY）
       ↓
Search Result — Search Evidence（title/url/content/score）
       ↓
Source Policy 判定
  ├─ SEARCH_ONLY → 保存 Search Evidence
  ├─ SEARCH_AND_FETCH → fetchEligible
  └─ CONDITIONAL_FETCH → 策略评估（默认不 Fetch）
       ↓
Initial Discovery Ingestion（RadarIngestionService）
  → 产生 CandidateVersion（evidenceLevel = SEARCH_EVIDENCE 或 MANUAL_REVIEW_REQUIRED）
       ↓
（仅 fetchEligible）Content Acquisition → Evidence Validation
       ↓
（validation PASS）Evidence Upgrade
  → 新 CandidateVersion（evidenceLevel = FULL_EVIDENCE, originType = evidence_upgrade）
       ↓
┌─────── 复用 v0.8 Radar ───────┐
│ RadarCaptureSnapshot           │
│ RadarSourceRecord              │
│ RadarCandidate                 │
│ RadarCandidateVersion          │
│   evidenceLevel                │ ← 新增 additive
│   originType (含 evidence_upgrade) │ ← 新增
│ RadarRuleAssessment            │
│ AnalysisTask / MatchAnalysis   │
│ RadarRecommendationBatch       │
│   (仅 FULL_EVIDENCE + current MatchAnalysis) │
└────────────────────────────────┘
       ↓
STOP T037（Pipeline 停在 Recommendation）

DailyJobBrief → T040
  ├─ recommendationBatchId（FULL_EVIDENCE 正式推荐，0-8）
  └─ discoveryItems（SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 发现条目）
       ↓
NotificationOutbox → QQ SMTP
       ↓
JobJudgment → PreferenceSignal → PreferenceRule
       ↓
反馈到下一轮：SearchExpansion / Suppression / Ranking
```

### 1.2 关键设计决策：SEARCH_EVIDENCE 如何进入系统

**核心架构答案（经真实现有代码验证）：**

```text
Tavily Search Result
↓
Immutable Search Snapshot（radar_capture_snapshots，captureMethod='search_discovery'）
↓
现有 Radar identity 机制
↓
RadarCandidate（与 Manual Capture 共享同一 Candidate 空间）
↓
RadarCandidateVersion（evidenceLevel = SEARCH_EVIDENCE）
↓
analysisEligible = false（由 commitDecision 基于 evidenceLevel 判定）
↓
不创建 MatchAnalysis
↓
不进入 RecommendationBatch（RecommendationBatchService 的 blockReasonFor 返回 no_current_analysis）
↓
进入 DailyJobBrief.discoveryItems（作为 supplementary discovery flag，不是第二套推荐）
↓
用户看到「信息不足但值得人工确认」→ 打开原 URL → Manual Capture → Evidence Upgrade → FULL_EVIDENCE → MatchAnalysis → Recommendation
```

**合规性验证（针对现有 v0.8 Code）：**

| 检查项 | 结果 | 说明 |
|--------|------|------|
| `RadarCaptureSnapshot.captureSessionId` 已支持 `null` | ✅ | `RadarCaptureSnapshot` 类型已定义 `captureSessionId: string \| null` |
| `analysisEligible` 已是 `CommitDecisionSummary` 字段 | ✅ | `decideCommit()` 已返回 `analysisEligible: boolean` |
| `RecommendationBatchService` 的 `blockReasonFor` 返回 `no_current_analysis` 当 analysisRecordId === null | ✅ | SEARCH_EVIDENCE 候选必然被门禁排除（无 MatchAnalysis） |
| `RecommendationKind` = `apply_now \| stretch \| verify` | ✅ | `verify` 语义接近"需要确认"但仍需 analysis——不可用于 SEARCH_EVIDENCE |
| `RadarCandidateVersion.originType` = `captured \| manual_correction \| source_change \| merge_resolution` | ✅ | 可 additive 扩展 `'evidence_upgrade'` |
| `RadarCandidateVersion.qualityIssues` 已存在 | ✅ | 可携带 evidence 不足信号 |
| `DailyJobBrief` 不保存 `selectedCandidateVersionIds` | ✅ | `recommendationBatchId` 是唯一权威推荐引用 |

---

## 2. 核心技术设计

### 2.1 Sharing Radar Ingestion Core（V9-1，保持）

原有 V9-1 设计（从 `RadarCaptureService` 抽取 `RadarIngestionService`）保持有效。额外要求：

- `IngestionInput` 新增 `evidenceLevel: 'SEARCH_EVIDENCE' | 'FULL_EVIDENCE' | 'MANUAL_REVIEW_REQUIRED'`
- `IngestionInput` 新增 `sourcePolicy: 'SEARCH_ONLY' | 'SEARCH_AND_FETCH' | 'CONDITIONAL_FETCH'`
- `decideCommit()` 接收 evidenceLevel 输入：
  - `evidenceLevel = 'SEARCH_EVIDENCE'` → `analysisEligible = false`（不论 identity/material-change 判定）
  - `evidenceLevel = 'FULL_EVIDENCE'` → 正常判定 `analysisEligible`
  - `evidenceLevel = 'MANUAL_REVIEW_REQUIRED'` → `analysisEligible = false`（需用户先确认）
- SEARCH_EVIDENCE candidate/version 仍然正常创建（去重、追踪），只是不进入分析

### 2.2 Snapshot 与 Evidence

**`capture_method` CHECK 扩展——表重建 Migration：**

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
    'search_discovery',
    'open_web_fetch'
  )
)
```

**迁移方式**：SQLite 表重建 migration（与 schema v8 的 `radar_actions` 表重建流程一致）。

**绝对禁止**：`PRAGMA writable_schema` 直接手改生产 schema 文本。

**Semantics of new values：**
- `search_discovery`：Tavily Search 返回的结果（SEARCH_EVIDENCE 来源）
- `open_web_fetch`：Content Acquisition 成功后 Fetch 的内容（经完整性验证 + `evidence_upgrade` 后作为 FULL_EVIDENCE 来源）

**Jooble-era `api_discovery` 移除。** 该值从未落地到生产 schema，无迁移负担。

**Search Evidence 的 Snapshot：**
- `captureSessionId = null`
- `captureMethod = 'search_discovery'`
- `providerKey = 'tavily'`
- `visibleText = content`（Tavily 的 content 字段——Provider Output，不假定为完整 JD）
- `pageTitle = title`
- `sourceUrl = url`
- `sourceDomain = domain`
- `rawSnapshot` 包含完整 Search Evidence + Tavily response metadata（`query`、`providerScore`、`providerRequestId` 等）

### 2.3 SearchProvider Architecture

#### 核心接口

```ts
interface SearchProviderAdapter {
  readonly providerKey: string;       // 'tavily'
  readonly providerVersion: string;   // '1.0.0'

  search(
    plan: DailySearchPlanVersion, 
    queries: SearchQuery[],
    signal: AbortSignal
  ): Promise<SearchProviderResult>;
}

interface SearchQuery {
  query: string;            // 组合后的搜索词（如 "苏州 前端工程师 招聘"）
  queryKey: string;         // 唯一键（如 "苏州×前端开发×React"）
  city: string;
  roleDirection: string;
  keyword: string;
  keywordSource: 'base' | 'expanded';
}

interface SearchProviderResult {
  items: SearchEvidenceItem[];
  coverage: SearchCoverage;
  providerMeta: SearchProviderMeta;
}

interface SearchEvidenceItem {
  // Provider-neutral Search Evidence（不绑定 Tavily DTO）
  provider: string;             // 'tavily'
  query: string;
  title: string;
  url: string;
  content: string;             // search snippet（Provider Output）
  domain: string;
  providerScore?: number;
  publishedAt?: string;
  searchedAt: number;
  sourcePolicy: 'SEARCH_ONLY' | 'SEARCH_AND_FETCH' | 'CONDITIONAL_FETCH';
  evidenceLevel: 'SEARCH_EVIDENCE' | 'FULL_EVIDENCE' | 'MANUAL_REVIEW_REQUIRED';
  providerMetadata?: Record<string, unknown>;
  providerRequestId?: string;
}
```

**Tavily-specific DTO 只存在于 Adapter mapping。`SearchEvidenceItem` 是 Provider-neutral domain type。**

#### P0: Tavily Search Provider

**契约（基于 Tavily 官方文档 `POST /search`）：**
- Endpoint: `https://api.tavily.com/search`
- Method: POST
- Auth: `Authorization: Bearer tvly-<API_KEY>`
- Body: `{ query, search_depth, country, topic, max_results, include_answer, include_raw_content, time_range? }`
- Response: `{ results: [{ title, url, content, score }], response_time, images }`

**搜索输入映射：**

| SearchTask 字段 | Tavily 参数 |
|----------------|-------------|
| query（组合后） | `query` |
| (固定) | `search_depth = "basic"` |
| (固定) | `country = "china"` |
| (固定) | `topic = "general"` |
| (固定) | `include_answer = false` |
| (固定) | `include_raw_content = false` |
| (按 ScanBudget) | `max_results` |
| (按需求) | `time_range` / `start_date` |

**搜索输出映射：**

| Tavily 字段 | 映射到 SearchEvidenceItem |
|------------|--------------------------|
| `results[].title` | `title` |
| `results[].url` | `url` |
| `results[].content` | `content` |
| `results[].score` | `providerScore` |
| `results[].published_date` | `publishedAt`（如有） |
| `query` | `query`（回显） |
| domain from `url` | `domain` |
| (判定) | `sourcePolicy` |
| (初始) | `evidenceLevel` |

**Tavily Search ONLY — 不自动接入 Extract/Crawl/Map：**
- P0 只用 Tavily `/search` endpoint
- Tavily Extract/Crawl/Map 不在 P0 范围
- 不要因为同一 vendor 有这些能力就自动加入
- 如果 Content Acquisition 需要 Tavily Extract：做独立技术决策

**`auto_parameters` 禁用**：P0 不使用 `auto_parameters`（会 basic→advanced 自动升级，成本不可预测）。

### 2.4 Provider Error Model（Tavily-specific）

```ts
type SearchProviderErrorCode =
  | 'VALID_EMPTY'           // HTTP 200 + 合法 JSON + results=[]
  | 'AUTH_ERROR'            // API Key 无效/过期（401）
  | 'RATE_LIMITED'          // 频率限制（429）
  | 'USAGE_LIMIT'           // 月度额度耗尽（432）
  | 'TIMEOUT'               // 请求超时
  | 'NETWORK_ERROR'         // 网络不可达
  | 'MALFORMED_RESPONSE'    // 200 但 JSON 结构不符 contract
  | 'PROVIDER_UNAVAILABLE'  // 5xx
```

删除 Jooble-specific error assumptions。具体 HTTP status codes 以 Tavily 官方文档为准，不凭记忆编。

### 2.5 DailySearchPlan 与 PlanVersion（保持，更新 source 语义）

原有 Plan 设计基本保持。更新：

- `sourceConfigs` 不再包含 `{ providerKey: 'jooble' }`。P0 改为 `{ providerKey: 'tavily', searchDepth: 'basic', country: 'china' }`
- SearchPlan 主要输入仍然是：`cities`、`roleDirections`、`baseKeywords`、`expandedKeywords`、`hardConstraints`、`schedule`、`scanBudget`
- **不要求用户提前维护目标公司/目标 domain 名单**（Company Career 是 Follow-up，不是 v0.9 P0 前置条件）

### 2.6 Scheduler（保持）

原有 Scheduler 设计（Fastify 进程内，`setTimeout` 链）保持有效。只更新 SourceRun 中 provider 相关的 `source_key` / `source_version`。

### 2.7 Autostart（保持）

原有 Windows Autostart 设计（`HKCU\...\Run` 单一机制）保持有效。

### 2.8 SourceRun 更新

SourceRun 不再记录 Jooble-specific fields。更新为 Provider-neutral Search Run：

```ts
interface SourceRun {
  // ...existing fields...
  sourceKey: string;           // 'tavily'
  sourceVersion: string;       // Provider version

  // 删除：Jooble pages / totalCount

  // 新增 Provider-neutral 计数器
  queriesAttempted: number;
  queriesSucceeded: number;
  queriesFailed: number;
  resultsDiscovered: number;
  relevantResults: number;
  duplicates: number;
  searchEvidencePersisted: number;
  manualReviewRequired: number;
  fullEvidenceCount: number;
  coverage: SearchCoverage;    // 替换旧的 Jooble-specific coverage
  creditsUsed?: number;        // Tavily response usage.credits_used
}
```

`progressJson` 继续表达 provider-local progress（当前 query index、已完成 query 列表），不改 Generic Checkpoint。

### 2.9 Source Policy 最小实现

**P0 不建 Generic Policy DSL / Policy Engine / Rule Language / Admin Policy Platform。**

P0 实现为：

```
清晰的 domain/source classification
+
静态/配置化 policy
+
测试
```

**Domain Classification（code/config）：**

| Domain Pattern | Policy | Evidence Level |
|---------------|--------|----------------|
| `zhipin.com` | SEARCH_ONLY | MANUAL_REVIEW_REQUIRED |
| `liepin.com` | SEARCH_ONLY | MANUAL_REVIEW_REQUIRED |
| `zhaopin.com` | SEARCH_ONLY | MANUAL_REVIEW_REQUIRED |
| `lagou.com` | SEARCH_ONLY | MANUAL_REVIEW_REQUIRED |
| `51job.com` | SEARCH_ONLY | MANUAL_REVIEW_REQUIRED |
| `*.zhiye.com`（ATS） | SEARCH_AND_FETCH | FULL_EVIDENCE（Fetch + 完整性验证成功 → evidence_upgrade 后） |
| `github.com` | SEARCH_AND_FETCH | FULL_EVIDENCE（Fetch + 完整性验证成功 → evidence_upgrade 后） |
| `juejin.cn` | CONDITIONAL_FETCH | SEARCH_EVIDENCE（默认） |
| (其他) UNKNOWN public | SEARCH_AND_FETCH | SEARCH_EVIDENCE（受控 fetch；仍须 validation + evidence_upgrade 才 FULL_EVIDENCE） |
| (空/无效 domain) | SEARCH_ONLY | MANUAL_REVIEW_REQUIRED |

**这些域名不作为 Tavily Search `exclude_domains`。** Source Policy 在搜索结果返回之后生效，不在搜索前排除。

**Source Policy 的数据模型：** P0 为 code/config policy，不需要 `source_policies` 表（除非有真实用户需要动态维护 policy）。

### 2.10 Content Acquisition

**Search Provider 与 Content Acquisition 正式拆开。**

Search Provider（Tavily `/search`）只负责搜索、发现 URL、返回 Search Evidence。Content Acquisition 是后续独立能力，由 Source Policy 触发。

**P0 最小设计：**

```
Search Evidence → Source Policy 判定

if SEARCH_ONLY:
    停止自动 acquisition
    → 保存 Search Evidence
    → MANUAL_REVIEW_REQUIRED

if SEARCH_AND_FETCH:
    允许 acquisition
    → direct HTTP fetch（简单 fetch()）
    → bounded extraction（title/plainText 等最小字段，不做通用 Crawler）
    → JD completeness / evidence validation
    → if validation PASS → explicit evidence_upgrade → FULL_EVIDENCE
    → Radar Ingestion → analysis eligible

if CONDITIONAL_FETCH:
    策略评估（当前默认：不自动 Fetch）
    → 保留 Search Evidence
    → MANUAL_REVIEW_REQUIRED
```

**fetch success != FULL_EVIDENCE** —— HTTP 200 / 文本提取成功本身都不产生 FULL_EVIDENCE。FULL_EVIDENCE 只能来自“Content Acquisition 成功 + JD 完整性验证通过 + 显式 evidence_upgrade”，或 Manual Capture。

**Per-run fetch budget（P0）**：单次 Daily Run 最多尝试自动 Content Acquisition 50 条（`DEFAULT_FETCH_BUDGET`，可经 `DailyPipelineRunOptions.fetchBudget` 覆盖）。超过预算的 item 保留 discovery / manual-review，不算 failure，不因单条 fetch 失败终止整个 SourceRun。

**Cross-source enrichment（P0，identity-safe）**：已知招聘平台（SEARCH_ONLY）详情页禁止自动 Fetch，但允许对招聘平台搜索结果做有界 cross-source enrichment，通过 Open Web Search 寻找「同一公司同一岗位」的公开替代源。硬约束：缺结构化 company identity → 不做 enrichment（fail closed，保持 MANUAL_REVIEW_REQUIRED）；禁止 role-only 查询；public alternative 必须非招聘平台、非原 URL、company 一致、role/title 合理匹配；enrichment 预算默认每 run 最多 20 个原始招聘平台 item，禁止递归。当前 Tavily 不提供结构化 company，故 enrichment 在缺少 company 时 fail closed。

**P0 Content Acquisition 技术候选（实施时研究决定）：**
1. Direct `fetch()` + 简单 HTML parsing（最简单）
2. Source-specific adapter（如 ATS 公开 API）
3. Tavily Extract（如独立决策通过——需写清理由）

**禁止：** GenericCrawlerRuntime、CrawlerAgent、BrowserAutomationRuntime、SiteParserDSL、DistributedCrawler。

**不自动选择 Tavily Extract/Crawl/Map** —— 这些是独立技术决策。

### 2.11 Query Expansion & Budget

**禁止笛卡尔积：** 不要每个 city × 每个 role × 每个 keyword 无脑全部展开后每天炸几十上百次 Search。

**Query Expansion 设计：**

```text
baseKeyword × roleDirection → expanded queries
expandedKeyword × roleDirection → limited expanded queries（有配额控制）
最终去重 merge
```

**Query Budget：**

| Control | Default | Purpose |
|---------|---------|---------|
| `scanBudget.maxQueriesPerRun` | 30 | 单次 SourceRun 最大 query 数 |
| `scanBudget.maxExpandedKeywords` | 5 | 来自 PreferenceRule 的扩展关键词配额 |
| Query dedupe | 相同 query 合并 | 防止重复浪费 credit |
| High-value query selection | 优先城市×方向×基础关键词 | 确保核心覆盖 |

**T022 判定：MODIFY。** 旧 T022（Jooble-era 笛卡尔积）在 Tavily Open Web Search 下需要 query dedupe + budget 控制，不是简单笛卡尔积。

### 2.12 Evidence Model

#### three Evidence Levels

```ts
type EvidenceLevel =
  | 'SEARCH_EVIDENCE'        // 只有搜索结果 title/content/url（Tavily content）
  | 'FULL_EVIDENCE'          // 完整岗位事实（完整 JD）
  | 'MANUAL_REVIEW_REQUIRED'; // SEARCH_EVIDENCE + 值得看但来源禁止自动 Fetch
```

**存储位置：** `radar_candidate_versions.evidence_level`（additive TEXT column migration）

#### Evidence Upgrade（与 Material Change 分开）

| Event | originType | 说明 |
|-------|-----------|------|
| Material Change | `source_change` | 岗位事实发生变化 |
| Evidence Upgrade | `evidence_upgrade` | 同一岗位获得更高质量证据 |
| First Capture | `captured` | 首次采集 |
| Manual Correction | `manual_correction` | 用户纠错 |
| Merge Resolution | `merge_resolution` | 重复合并 |

**Evidence Upgrade 是版本事件，不是字段覆写**：禁止原地 `UPDATE evidence_level`（SEARCH_EVIDENCE → FULL_EVIDENCE）。升级必须创建新的不可变 `RadarCandidateVersion`（`originType='evidence_upgrade'`、`evidenceLevel='FULL_EVIDENCE'`），原 SEARCH_EVIDENCE 版本继续保留。

**Evidence Upgrade 路径示例：**
```
Tavily Search → BOSS 岗位 URL
↓
RadarCandidate A（evidenceLevel = SEARCH_EVIDENCE, originType = 'captured'）
↓
用户打开 BOSS → Manual Capture
↓
Identity Resolution 匹配到 Candidate A
↓
新 CandidateVersion V2
    evidenceLevel = FULL_EVIDENCE
    originType = 'evidence_upgrade'
    supersedesVersionId = V1
↓
analysisEligible = true → MatchAnalysis → Recommendation
```

### 2.13 Data Quality Gate（更新）

Data Quality Gate 是**逻辑阶段**，不要求对应单一 `DataQualityGate.ts`。其实现由两层 gate 共同完成：

1. **Evidence Eligibility Gate**（`server/radar/commitDecision.ts` 的 `canEnterAnalysis(evidenceLevel)`）——判定该 evidenceLevel 是否允许进入 Analysis：
   - Discovery eligible ≠ Analysis eligible
   - `SEARCH_EVIDENCE` → blocked → `analysisEligible = false`
   - `MANUAL_REVIEW_REQUIRED` → blocked → `analysisEligible = false`，提示用户打开原站确认
   - `FULL_EVIDENCE` → eligible → `analysisEligible = true`
2. **Analysis Input Readiness Gate**（`server/radar/analysis/inputSnapshot.ts` 的 `hasCoreFacts` → `INPUT_NOT_READY`）——即使 evidenceLevel 已允许进入，仍需在组装固定输入时校验岗位事实是否足以支撑分析；不足则返回 `INPUT_NOT_READY`。

`analysisEligible` 只表达 Evidence Eligibility 维度，不承载 facts completeness。

### 2.14 Analysis 复用（保持，补充证据门）

主动 Discovery 不新增分析任务类型。复用现有：
- `AnalysisService.createTask(candidateVersionId)`
- 现有 `input_hash UNIQUE` 保证幂等
- 现有 retry + stale 检测

**证据门：** SEARCH_EVIDENCE 候选 → `analysisEligible = false` → `AnalysisService.createTask()` 不被调用。

**输入就绪门：** FULL_EVIDENCE 候选在 `createTask()` 内仍经 `buildJobMatchAnalysisInputSnapshot` 的 core-facts 校验；事实不足 → `INPUT_NOT_READY`（不执行 MatchAnalysis，不改 evidenceLevel）。

### 2.15 Recommendation 复用——关键一致性

**RecommendationBatch 仍是唯一正式推荐集合：YES。**

**SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 如何进入 DailyJobBrief：**

现有 `RecommendationBatchService.createBatch()` 只接受有 current MatchAnalysis 的 CandidateVersion（`blockReasonFor()` 返回 `no_current_analysis` 当无分析）。因此 SEARCH_EVIDENCE 候选自然不进入 RecommendationBatch。

**DailyJobBrief 新增 `discoveryItems`：**
- 不是第二套推荐集合
- 不替代 `recommendationBatchId`
- 只是当天发现的 SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 候选的引用列表
- 用户可浏览、跳转原 URL、决定是否 Manual Capture

```ts
interface DailyJobBrief {
  // ...existing fields...
  recommendationBatchId: string;        // 正式推荐（0-8，FULL_EVIDENCE）
  discoveryItemIds?: string[];          // 发现条目（SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED，supplementary）
}
```

**不创建 `SearchRecommendationBatch`、`DiscoveryRecommendation`、`DailyJobBrief.selectedSearchResults[]`** 作为第二套推荐真相。

**RecommendationKind `verify`** 用于 `analysisEligible=true` 但存在疑虑的 FULL_EVIDENCE 候选——不用于 SEARCH_EVIDENCE 候选（SEARCH_EVIDENCE 连 MatchAnalysis 都没有）。

### 2.16 DailyJobBrief（更新）

> **边界标注：** DailyJobBrief 归属 T040（downstream）。T037 / Discovery Pipeline 停在 Recommendation result / RecommendationBatch，不实现 BUILDING_BRIEF / DailyJobBrief 持久化。

```ts
interface DailyJobBrief {
  id: string;
  briefDate: string;

  searchPlanVersionId: string;
  sourceRunIds: string[];

  recommendationBatchId: string;        // 正式推荐引用（FULL_EVIDENCE 候选，0-8）
  discoveryItemIds?: string[];          // 发现条目引用（SEARCH_EVIDENCE/MANUAL_REVIEW_REQUIRED）

  status: 'GENERATING' | 'READY' | 'IN_REVIEW' | 'COMPLETED' | 'FAILED';

  coverageJson: CoverageReport;
  costSummaryJson: CostSummary;
  emptyReason: string | null;           // recommendationBatchId 无推荐 + discoveryItemIds 无发现时填写

  generatedAt: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
```

**`discoveryItemIds` 不是第二权威推荐集合。** 它只引用 CandidateVersion IDs 中有 SEARCH_EVIDENCE 或 MANUAL_REVIEW_REQUIRED 的发现条目。用户仍查阅它们，但系统不声称正式分析过。

### 2.17 Manual Review 转换

```text
MANUAL_REVIEW_REQUIRED Candidate
↓
用户点击原 URL（zhipin.com/liepin.com/...）
↓
浏览器打开 → Manual Capture
↓
RadarCaptureService.commitSession()
↓
RadarIngestionService → Identity Resolution → 匹配已有 Candidate
↓
新 CandidateVersion（evidenceLevel = FULL_EVIDENCE, originType = 'evidence_upgrade'）
↓
Data Quality Gate → analysisEligible = true
↓
AnalysisService.createTask() → MatchAnalysis
↓
RecommendationBatchService.createBatch() → 可能进入下一批推荐
↓
旧 MANUAL_REVIEW_REQUIRED status → 不再为当前判断（旧版本保留）
```

**关键：旧 SEARCH_EVIDENCE 版本保留（不可变），但不再为当前 active version。当前 active version 已升级为 FULL_EVIDENCE。**

### 2.18 Search Result Dedupe

| Dedupe Layer | Mechanism |
|-------------|-----------|
| **Intra-run** | URL canonicalization + domain matching |
| **Cross-day** | SourceRecord find-by-normalized-url |
| **Cross-source** | 同一 BOSS URL：Tavily discovery + Manual Capture → identity resolution → same Candidate |

**Search result hash 不直接当 Candidate identity。** 使用现有 URL canonicalization + provider-aware identity。

### 2.19 Source Provenance（两层）

| Layer | Value | 存储 |
|-------|-------|------|
| Search Provider | `'tavily'` | Snapshot.providerKey |
| Underlying Source | 从 url 解析的 domain | Snapshot.sourceDomain |

**不把所有岗位写成 `source = tavily`。**

### 2.20 Search Query Evidence

同一 Search Evidence 可追踪：
- 来自哪个 `DailySearchPlanVersion`
- 哪个 `SourceRun`
- 哪条 `query`（Search Task key）
- Tavily request ID（如有）
- 搜索时间

通过 Snapshot 的 `rawSnapshot` + SourceRecord 关系链追踪。不为此建设通用 Observability Platform。

### 2.21 Cost Visibility（更新）

```ts
interface CostSummary {
  estimatedSearchCredits?: number;   // Plan 估算
  actualSearchCredits?: number;      // Tavily response usage.credits_used（优先）
  analysisCount: number;
  modelUsage?: string;
  tokenCount?: number;
  actualCost?: number;               // 有可靠数据时
  // 无成本数据时整个 CostSummary 标记 "Cost unavailable"
}
```

**不要硬编码 `720 searches/month` 作为产品事实。** 实际月成本由 `SearchPlan × query expansion × schedule × scan budget × retry` 计算。

### 2.22 Notification / Judgment / Preference（保持）

原有 V9-4/V9-5/V9-6 设计基本保持。这些模块基本不受 Provider 更换影响。

**Preference 对 SEARCH_EVIDENCE 的边界：**
- 用户对 SEARCH_EVIDENCE 做四档判断时：不应因为"信息不足"点击不适合 → 系统误学成永久负偏好
- `evidenceLevel` 进入 Preference learning context
- MANUAL_REVIEW_REQUIRED 候选不应因为用户尚未确认就自动形成强负规则

### 2.23 Search Coverage（更新）

覆盖现在包括：

```text
queries planned
queries executed
queries succeeded
queries failed
results returned
results relevant
recruitment-platform results
company-career results
open-web results
search-only results
fetch-eligible results
manual-review results
analysis-eligible results
credits used
```

避免只记录"扫描了多少页"（Jooble-era page model）。

---

## 3. 数据模型（更新）

详见 [data-model.md](data-model.md)。核心变化：

**新增表（与旧 Plan 相同，11 张）：**
- `daily_search_plans`
- `daily_search_plan_versions`
- `source_runs`（结构更新为 Provider-neutral）
- `daily_job_briefs`（新增 `discovery_item_ids_json`）
- `job_judgments`
- `judgment_reasons`
- `preference_signals`
- `preference_rules`
- `notification_channels`
- `notification_outbox`
- `notification_links`

**移除的表（Jooble-specific）：** 无（Jooble 相关未落地为表）

**现有表 additive 变更：**
- `radar_capture_snapshots`：扩展 `capture_method` CHECK（新增 `'search_discovery'`、`'open_web_fetch'`）——表重建 migration
- `radar_candidate_versions`：新增 `evidence_level TEXT NOT NULL DEFAULT 'FULL_EVIDENCE'` + CHECK
- `radar_candidate_versions.origin_type`：CHECK 扩展新增 `'evidence_upgrade'`
- `source_runs`：结构更新（删除 Jooble-specific 字段，新增 Provider-neutral 字段）

**不新增的 Shadow Models：** 同旧 Plan + 额外确保：
- 无 `DiscoveryCandidate` / `SearchCandidate`
- 无 `WebOpportunity`
- 无 `SearchRecommendationBatch` / `DiscoveryRecommendation`
- 无 `SearchDailyBriefItem`
- 无 `RawSourceSnapshot`
- 无 `source_policies` 表（P0 为 code/config policy）
- 无 `search_evidence` 表（复用 `radar_capture_snapshots`）

---

## 4. Migration Plan

### 4.1 Schema 版本

- 当前 `LATEST_SCHEMA_VERSION = 8`
- v0.9 新 migration: **schema v9**
- `PRODUCTION_SCHEMA_VERSION` 保持 2

### 4.2 Migration 内容

- 新建 11 张 v0.9 表
- **表重建 Migration**：`radar_capture_snapshots`——扩展 `capture_method` CHECK 约束（新增 `'search_discovery'`、`'open_web_fetch'`）
- **Additive column Migration**：`radar_candidate_versions`——新增 `evidence_level TEXT NOT NULL DEFAULT 'FULL_EVIDENCE'`
- **CHECK 扩展 Migration**：`radar_candidate_versions.origin_type`——扩展 CHECK 新增 `'evidence_upgrade'`
- 所有新表外键、UNIQUE 约束、索引
- Migration 前自动备份

### 4.3 兼容性保证

- v0.8 Radar 在 v0.9 migration 后继续可用
- 新表为空开始，不伪造历史 Judgment/Preference
- `evidence_level` 默认值 `'FULL_EVIDENCE'` 对已有行兼容（v0.8 所有 CandidateVersion 视为 FULL_EVIDENCE）
- `origin_type` 旧值不变，新值 `'evidence_upgrade'` 仅新行使用
- 不反向改写 v0.8 Snapshot / CandidateVersion / AnalysisRecord
- 关闭 v0.9 功能后旧 Radar 仍可工作

---

## 5. API 设计

详见 [contracts/](contracts/) 目录。原有 API 设计基本保持。关键更新：

- SearchPlan API 的 `sourceConfigs`：`{ providerKey: 'tavily' }`
- SourceRun response：不再包含 Jooble-specific 字段（`totalCount`、pages 等），改为 Tavily/Provider-neutral 字段
- DailyJobBrief response：新增 `discoveryItems`（supplementary）
- NotificationChannels：Secret 引用 `TAVILY_API_KEY`（替换 `OFFERFLOW_JOOLE_API_KEY`）

---

## 6. UI Plan（保持）

原有 UI 页面设计保持有效。更新：
- SearchPlan 配置页：source selector 改为 Tavily（不再有 Jooble）
- SourceRunsPage：展示 Tavily/Provider-neutral coverage（queries、results、credits 等）

---

## 7. 安全（更新）

| 安全领域 | 措施 |
|----------|------|
| Tavily API Key | 通过 SecretStore 保护，不进 Git/日志/API 响应/DB backup |
| 外部 JD 不可信输入 | 统一走现有 Snapshot → normalize → Zod 校验链 |
| API 响应不可信输入 | Provider Adapter 内 sanitize |
| Search Evidence 不可信输入 | Tavily `content` 视为 Provider Output（非完整 JD） |
| Professional Platform Crawler 禁止 | Tavily 为 Search API（非 Crawler）。BOSS/拉勾/猎聘等仅通过 Browser Manual Capture |
| Source Policy 安全 | SEARCH_ONLY 来源绝不自动 Fetch |
| Secret 不泄露 | `TAVILY_API_KEY` 加密存储 |
| 邮件安全 | 保持现有约束 |

---

## 8. 测试策略（更新）

保持原有测试策略，新增/调整：

### 8.1 Evidence Model
- SEARCH_EVIDENCE CandidateVersion 创建（`evidenceLevel = 'SEARCH_EVIDENCE'`）
- SEARCH_EVIDENCE → `analysisEligible = false`（commitDecision 扩展）
- FULL_EVIDENCE → `analysisEligible` 正常判定
- Evidence Upgrade → 新 CandidateVersion（`originType = 'evidence_upgrade'`）
- 同一岗位 Search Evidence + Manual Capture → same Candidate

### 8.2 Provider（Tavily-specific）
- Tavily 成功返回 → SearchEvidenceItem[] 映射正确
- VALID_EMPTY（HTTP 200 + results=[]）
- AUTH_ERROR（401）
- RATE_LIMITED（429）
- USAGE_LIMIT（432）
- TIMEOUT / NETWORK_ERROR / MALFORMED_RESPONSE / PROVIDER_UNAVAILABLE

### 8.3 Source Policy
- SEARCH_ONLY 域名（zhipin.com 等）→ MANUAL_REVIEW_REQUIRED，不触发 auto fetch
- SEARCH_AND_FETCH 域名 → FULL_EVIDENCE（Fetch + 完整性验证成功 → evidence_upgrade 后）
- CONDITIONAL_FETCH 域名 → 默认不 Fetch
- UNKNOWN domain → 默认保守

### 8.4 Tavily Integration Smoke Gate（新增，替换 Jooble Provider Validation Gate）
- 真实 API Key 可达性
- 中国地区搜索（country=china）真实调用
- Contract 验证（response 字段与文档一致）
- Credit 消耗验证（basic = 1 credit）
- Secret 脱敏验证

---

## 9. 实现波次

| 波次 | 内容 | 依赖 |
|------|------|------|
| **V9-0** | **Tavily Integration Smoke + Evidence Model Validation** | V8.x 基线 |
| | 1. Tavily API Key 可达性验证 | |
| | 2. 中国地区搜索真实调用 | |
| | 3. Response contract 验证 | |
| | 4. Credit 消耗验证 | |
| | 5. `evidence_level` additive migration | |
| | 6. `capture_method` CHECK 扩展 + 表重建 migration | |
| | 7. `originType` CHECK 扩展（`evidence_upgrade`） | |
| | 8. `decideCommit` 扩展（evidenceLevel → analysisEligible） | |
| **V9-1** | Shared Radar Ingestion + Search Evidence | V9-0 |
| | - 从 RadarCaptureService 抽取 RadarIngestionService | |
| | - IngestionInput 扩展（evidenceLevel, sourcePolicy） | |
| | - Browser Capture 兼容 | |
| | - Search Evidence CandidateVersion 创建 | |
| | - Evidence Upgrade 路径 | |
| **V9-2** | SearchPlan + Scheduler + Tavily Search Discovery | V9-1 |
| | - DailySearchPlan / PlanVersion 模型与 API | |
| | - SearchProviderAdapter 接口 | |
| | - Tavily Search API Provider | |
| | - Query Expansion（含 dedupe + budget） | |
| | - Scheduler | |
| | - SourceRun（Provider-neutral 结构） | |
| | - Coverage 报告 | |
| | - Windows Autostart | |
| **V9-3** | Source Policy + Content Acquisition + Pipeline（Phase 5A Evidence Upgrade Persistence + Phase 5B Core Orchestration）+ Analysis / Recommendation + DailyJobBrief（T040） | V9-2 |
| | - Source Policy（code/config） | |
| | - Content Acquisition（最小实现） | |
| | - Phase 5A: Evidence Upgrade Persistence（evidence_upgrade → 新 FULL_EVIDENCE CandidateVersion，含幂等） | |
| | - Phase 5B: Pipeline Core Orchestration（discover → source policy → initial ingest → optional content acquisition → optional evidence upgrade → quality gate → analyze → recommend） | |
| | - Analysis 复用（evidence gate） | |
| | - RecommendationBatch 复用（FULL_EVIDENCE + current MatchAnalysis） | |
| | - DailyJobBrief（含 discoveryItems，T040） | |
| | - Cost Summary | |
| **V9-4** | QQ SMTP + NotificationOutbox | V9-3 |
| | （保持原有设计） | |
| **V9-5** | JobJudgment（四档审批） | V9-3 |
| | （保持原有设计，新增 evidenceLevel-aware 追问抑制） | |
| **V9-6** | Preference Learning | V9-5 |
| | （保持原有设计，新增 evidenceLevel-aware signal 生成） | |
| **V9-7** | Production Validation | V9-1..V9-6 |
| | （保持原有设计） | |

---

## 10. P0 验收（更新）

> **连续至少 3 个自然日真实运行**：Scheduler 自动触发、Tavily Search API 返回真实岗位、搜索结果根据 Source Policy 进入 Search Evidence 或 Content Acquisition、SEARCH_EVIDENCE 岗位保存为 RadartCandidate（evidenceLevel=SEARCH_EVIDENCE）、FULL_EVIDENCE 岗位进入正式 CandidateVersion 事实链、同一岗位 Search Discovery + Manual Capture 正确合并为同一 Candidate、重复岗位不重复创建、岗位变化进入 CandidateVersion 事实链、Provider 失败不伪装 0 岗位、Coverage 完整可追踪、无无限 retry、至少形成一次真实 MatchAnalysis（来自 FULL_EVIDENCE 岗位）、一次真实 RecommendationBatch、一次真实 DailyJobBrief（含混合 Evidence Level）。

---

## 11. 遗留风险

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| Tavily 中国技术岗位覆盖不足（某些城市/方向） | 中 | Pre-validation 已验证基本覆盖；VALID_EMPTY 显式区分；不为凑数降低标准 |
| Tavily content 字段不足以进入 FULL_EVIDENCE | 中 | Data Quality Gate；MANUAL_REVIEW_REQUIRED 机制；不编造 JD |
| Content Acquisition 自动化需要额外技术决策 | 中 | P0 先做 MANUAL_REVIEW_REQUIRED + Manual Capture 路径；Content Acquisition 后续独立决策 |
| Query 笛卡尔积导致 credit 浪费 | 中 | Query dedupe + budget + high-value selection（T022 MODIFY） |
| Tavily Free tier 1,000 credits 长期不够（query expansion 膨胀） | 低 | 扩展路径明确（Project $25/mo）；实际 usage 追踪 |
| 一台 Windows 凭据异常导致 Secret 不可读 | 低 | ACTION_REQUIRED；Secret 重新配置即可 |

---

## 12. Git 约束确认

- ✅ 未修改 `src/` `server/` `browser-extension/` 业务源码
- ✅ 未执行真实 Migration
- ✅ 未修改生产数据库
- ✅ 未 commit / push / tag / release
- ✅ 仅修改 `specs/001-daily-job-hunter/` 下 Plan 产物

---

## 13. 停止确认

**本轮已完成 Plan Amendment（`/speckit.plan`）。**

未执行 `/speckit.tasks`。
未执行 `/speckit.analyze`。
未执行 `/speckit.implement`。

未启动 cc-auto。
未修改业务源码。
未执行 Migration。
未修改数据库。
未 commit。
未 push。

**等待用户审核后进入 Tasks Amendment。**
