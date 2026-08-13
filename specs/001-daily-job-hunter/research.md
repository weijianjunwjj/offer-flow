# OfferFlow v0.9 技术研究报告

> **版本：** 3.0  
> **对应 Plan：** `specs/001-daily-job-hunter/plan.md`  
> **创建日期：** 2026-08-11  
> **最后修订：** 2026-08-11（Plan Amendment：Jooble → Tavily Search API，Active Discovery Source Strategy 重建，新增 Search Evidence / Source Policy / Content Acquisition 研究）

---

## 0. Provider Decision History（不可变记录）

### 0.1 Initial Selection: Jooble REST API

**最初选择：** Jooble REST API 作为 v0.9 P0 ApiSearchProvider。

**选择理由（当时）：**
- REST API，POST 请求体 `{ keywords, location, salary?, page?, ResultOnPage? }`
- 聚合来自多个招聘来源的岗位（BOSS 直聘、拉勾、前程无忧等）
- API Key 认证，无需用户平台登录或浏览器 Session
- 返回 fields：`title`, `company`, `location`, `salary`, `snippet`, `source`, `link`, `updated`, `id`

### 0.2 Pre-validation Outcome: FAIL

**公开市场 Pre-validation 结果：FAIL（Product Suitability Failure，非 Technical Integration Failure）。**

**失败原因：**
- 中国大陆目标岗位（苏州、无锡、上海、杭州；前端/AI应用/Full-stack 等技术岗位）覆盖密度不足
- 苏州/无锡等核心城市有效前端岗位密度不足
- 搜索结果存在明显职位分类噪声
- API 易接入不能弥补数据价值不足

### 0.3 Status: REJECTED_AFTER_PREVALIDATION

Jooble 不被删除（保留完整历史记录），但不再作为 P0 Active SearchProvider，其 Adapter/Secret/Scheduler integration 全部撤销。Jooble 淘汰不推翻 Provider-independent 架构。

### 0.4 Re-evaluation: Open Web Search Provider Strategy

Jooble 淘汰后，重新定义 Active Discovery Source Strategy。候选 Provider：
- **Tavily Search API**: PRIMARY_CANDIDATE → **TAVILY_PASS**（Pre-validation 确认）
- **Brave Search API**: PRIMARY_CANDIDATE → **BRAVE_FAIL**（持久化权在基础计划不授予）
- **Google Programmable Search**: SECONDARY_CANDIDATE（不做 P0）
- **Bing Search API**: REJECTED_NOT_AVAILABLE（API 已退役）

**P0 Vendor 最终决策：Tavily Search API。**

---

## 1. Tavily Search API Contract

### 1.1 基本信息

| 项目 | 内容 |
|------|------|
| API 类型 | REST API（POST） |
| Endpoint | `POST https://api.tavily.com/search` |
| 认证方式 | `Authorization: Bearer tvly-<API_KEY>` |
| Content-Type | `application/json` |
| 响应格式 | JSON |
| 官方文档 | `https://docs.tavily.com/documentation/api-reference/endpoint/search` |

### 1.2 P0 冻结参数

| Parameter | P0 Value | Notes |
|-----------|----------|-------|
| `query` | constructed from SearchTask | 城市 + 岗位方向 + 关键词 |
| `search_depth` | `"basic"` | 1 credit/search；禁止 `auto_parameters` 自动升为 advanced |
| `country` | `"china"` | 与 `topic="general"` 配合 |
| `topic` | `"general"` | |
| `max_results` | 5–10 | 默认 5，可调整 |
| `include_answer` | `false` | P0 只做 Search Discovery |
| `include_raw_content` | `false` | P0 不把网页 HTML/Markdown 塞进 Search Evidence |
| `include_domains` | (not set) | 不在 Search Provider 层建立招聘平台 deny/exclude |
| `exclude_domains` | (not set) | Source Policy 在结果返回后生效，不在搜索前排除 |
| `time_range` | 按需求 | `"day"` / `"week"` / `"month"`；或 `start_date`/`end_date`（互斥） |

### 1.3 响应格式（关键字段）

```json
{
  "query": "苏州 前端工程师 招聘",
  "results": [
    {
      "title": "高级前端开发工程师",
      "url": "https://www.zhipin.com/job_detail/xxx.html",
      "content": "负责Web前端开发，使用React、TypeScript...（搜索摘要）",
      "score": 0.85,
      "raw_content": null
    }
  ],
  "response_time": 0.45,
  "images": []
}
```

| Tavily 字段 | 类型 | 说明 | 映射到 |
|------------|------|------|--------|
| `results[].title` | string | 结果标题 | `SearchEvidence.title` |
| `results[].url` | string | 结果 URL | `SearchEvidence.url` |
| `results[].content` | string | 搜索摘要/内容片段（Provider Output，非完整 JD） | `SearchEvidence.content` |
| `results[].score` | number | 相关性评分 | `SearchEvidence.providerScore` |
| `results[].raw_content` | string \| null | 原始内容（P0 `include_raw_content=false` → null） | 不保存 |
| `query` | string | 回显查询词 | `SearchEvidence.query` |
| `response_time` | number | 响应耗时（秒） | Provider metadata |
| `answer` | string \| null | AI 答案（P0 `include_answer=false` → null） | 不保存 |
| `images` | array | 相关图片 | P0 忽略 |

### 1.4 关键假设与限制

**Tavily Search API 返回的 `content` 字段虽然比传统 snippet 丰富，但仍然是 Search Provider Output，不是完整 JD。**

Plan 明确：
- Tavily Search Result → 保存 Search Evidence → Source Policy → Radar Ingestion
- `content` 字段 ≠ 完整 JD，不自动认定为 FULL_EVIDENCE
- `include_raw_content = false` → 不把网页 HTML 塞进 Search Evidence
- 禁止根据 `content` snippet 编造完整 JD
- 禁止为补全 JD 自动爬招聘平台页面

### 1.5 Tavily Search vs Other Endpoints（边界明确）

| Endpoint | Purpose | P0? | Notes |
|----------|---------|-----|-------|
| `/search` | Web search discovery | **YES** | P0 唯一使用的 Tavily endpoint |
| `/extract` | Extract raw content from URLs | **NO** | 属于 Content Acquisition，不在 P0 |
| `/crawl` | Crawl multiple URLs | **NO** | 属于 Content Acquisition，不在 P0 |
| `/map` | Site map discovery | **NO** | 属于 Content Acquisition，不在 P0 |

**不要因为同一家 vendor 有 Extract/Crawl/Map 就自动把它们加入 P0。** 如果 Content Acquisition 需要 Tavily Extract，必须作为独立技术决策写清理由。

### 1.6 Usage / Credits

| Tier | Monthly Credits | Monthly Cost | Sufficient for P0? |
|------|----------------|-------------|-------------------|
| Free (Researcher) | 1,000 | **$0** | ✅ YES |
| Project | 4,000 | **$25/mo** (annual) | ✅ YES |
| Bootstrap | 15,000 | **$83/mo** (annual) | ✅ Overkill |

**Credit cost per search：**
- `search_depth=basic`：1 credit
- `search_depth=advanced`：2 credits

Tavily response 包含 `usage.credit_used`（如有），优先记录真实 usage。不得自行估造成本。

### 1.7 Persistence Rights —— 更新措辞

**Persistence suitability：SUPPORTED**

**Evidence：**
- Tavily 官方 SDK（Python `TavilyHybridClient`）明确提供将 Web search results 保存进本地数据库的使用模式（`save_foreign` parameter for MongoDB HybridRAG）
- 官方示例允许保存 `content`、`title`、`url` 等字段
- 当前 Platform Terms 未发现 Brave Search API 那种明确禁止建立 Search Results 数据库的条款

**约束：**
- OfferFlow 只保存实现产品所需的最小 Search Evidence
- 继续遵守 Tavily 当前 Platform Terms / AUP
- 社区项目持久化实践作为参考，不作为主要法律依据——官方文档/官方条款才是权威来源

### 1.8 Human Oversight（Employment Domain）

Tavily 当前条款对 `employment` 领域的高影响自动决策要求 Human Oversight。

**OfferFlow 的合规性：**
- Search → AI analysis → Recommendation → **用户本人决定**
- AI 做发现+分析，用户做最终判断
- 禁止：自动替第三方决定招聘/录用、自动投递、自动联系招聘方
- 产品模型天然满足 Human Oversight 要求

---

## 2. Tavily Authentication

### 2.1 API Key 获取

- 注册 `https://app.tavily.com/home`
- Free tier 无需信用卡
- API Key 在 Dashboard 获取
- Format: `tvly-<key>`

### 2.2 Secret 管理

- API Key 不进 Git、不进普通日志、不进前端代码
- 存储方式：通过 SecretStore（Windows DPAPI / 开发环境变量）
- 运行时由 Provider Adapter 读取
- API 响应不返回明文 Key
- DB backup 不含 Key 明文
- Production Secret 仍走 SecretStore；Development 走 `TAVILY_API_KEY` 环境变量注入
- 所有日志脱敏

---

## 3. Tavily Error Model

基于 Tavily 当前 API contract 区分：

```ts
type SearchProviderErrorCode =
  | 'VALID_EMPTY'          // HTTP 200 + 合法 JSON + results=[]
  | 'AUTH_ERROR'           // 401 Unauthorized（API Key 无效/过期）
  | 'RATE_LIMITED'         // 429 Too Many Requests；432 Usage Limit Exceeded；433 Pay-as-you-go Limit
  | 'USAGE_LIMIT'          // 432 Usage Limit Exceeded（月度额度耗尽）
  | 'TIMEOUT'              // 请求超时
  | 'NETWORK_ERROR'        // 网络不可达
  | 'MALFORMED_RESPONSE'   // 200 但 JSON 结构不符合预期 contract
  | 'PROVIDER_UNAVAILABLE' // 5xx
```

**Jooble-specific error assumptions 删除。** 不要凭记忆编 Tavily status codes——以最终实施时 Tavily 官方文档为准。

---

## 4. SearchPlan 与 Query Expansion

### 4.1 SearchPlan 主要输入

| 字段 | 说明 |
|------|------|
| `cities` | 目标城市（苏州、无锡、上海、杭州等） |
| `roleDirections` | 岗位方向（前端开发、全栈开发等） |
| `baseKeywords` | 基础关键词（React、TypeScript 等） |
| `expandedKeywords` | 扩展关键词（来源 PreferenceRule） |
| `schedule` | 每日运行时间 |
| `scanBudget` | 搜索预算 |

`source` 不再是 Jooble/Boss 这种固定 Provider Source——P0 Vendor 已固定 Tavily。

### 4.2 Query Expansion Strategy

**禁止笛卡尔积：不要把每个 city × 每个 role × 每个 keyword 无脑全部展开后每天炸几十上百次 Search。**

设计：
- Query template: `{city} {roleDirection} {keyword} 招聘`
- 例：`苏州 前端工程师 招聘`、`无锡 Vue React 前端 招聘`、`上海 AI 前端 招聘`
- Query dedupe：相同或高度相似 query 合并
- Query budget：限制每次 SourceRun 的 query 总数
- High-value query selection：优先城市 × 方向 × 基础关键词的组合
- Expanded keyword budget：来自 PreferenceRule 的扩展关键词有限配额

### 4.3 T022 重新评估

**旧 T022（Jooble-era）：** `city × roleDirection × keyword × source → SearchTask[]`

**重新判断：** T022 的纯笛卡尔积在 Open Web Search Strategy 下会制造无意义搜索和 credit 浪费。每个 city × role × keyword 组合都是一个 Tavily search request（1 credit），4 cities × 2 roles × 3 keywords = 24 credits/day = 720 credits/month —— this fits within Tavily Free (1,000)。

但如果 expanded keywords 不加控制，可能膨胀到 40+ queries/day × 30 = 1,200+ credits/month，超出 Free tier。

**T022 状态：MODIFY。** 需要 query dedupe + query budget + high-value selection 控制，不是简单的笛卡尔积。

---

## 5. Search Evidence Model

### 5.1 Provider-neutral 最小 Search Evidence

基于 Tavily / Brave 共同最小语义设计（不绑定 Tavily DTO）：

```ts
interface SearchEvidence {
  /** 搜索关键词 */
  query: string;
  /** 结果标题 */
  title: string;
  /** 结果 URL */
  url: string;
  /** 搜索摘要/内容片段（Provider Output） */
  content: string;
  /** 来源域名 */
  domain: string;
  /** Provider 相关性评分 */
  providerScore?: number;
  /** 发布时间（如有） */
  publishedAt?: string;
  /** 搜索时间 */
  searchedAt: number;
  /** 来源策略分类 */
  sourcePolicy: 'SEARCH_ONLY' | 'SEARCH_AND_FETCH' | 'CONDITIONAL_FETCH';
  /** 证据等级 */
  evidenceLevel: 'SEARCH_EVIDENCE' | 'FULL_EVIDENCE' | 'MANUAL_REVIEW_REQUIRED';
  /** Provider 特定元数据（必要最小） */
  providerMetadata?: Record<string, unknown>;
  /** Tavily request ID（如有） */
  providerRequestId?: string;
}
```

**Tavily-specific DTO 必须停留在 Adapter boundary。核心领域不保存 `TavilyResult` 作为领域对象。**

### 5.2 Search Evidence 字段与 Tavily Response 映射

| SearchEvidence | Tavily Response | Notes |
|---------------|----------------|-------|
| `query` | `query` | 回显 |
| `title` | `results[].title` | |
| `url` | `results[].url` | |
| `content` | `results[].content` | Provider Output，非完整 JD |
| `domain` | 从 `url` 解析 | |
| `providerScore` | `results[].score` | |
| `publishedAt` | `results[].published_date`（如有） | Optional |
| `searchedAt` | 系统时间戳 | |
| `sourcePolicy` | 由 Source Policy 判定 | 不在 Tavily response 中 |
| `evidenceLevel` | 初始 = SEARCH_EVIDENCE | 后续可升级 |
| `providerRequestId` | Response header/metadata | 如 Tavily 提供 |

---

## 6. Source Policy

### 6.1 定位

Source Policy 不是通用规则平台。P0 实现为：

```
清晰的 domain/source classification
+
静态/配置化 policy
+
测试
```

不建 Generic Policy DSL、Policy Engine、Rule Language 或 Admin Policy Platform。

### 6.2 招聘平台 Policy

至少覆盖：

| Domain | Search Discovery | Search Evidence Persistence | Auto Fetch | Manual Open | Manual Capture |
|--------|:---:|:---:|:---:|:---:|:---:|
| zhipin.com | YES | YES | **NO** | YES | YES |
| liepin.com | YES | YES | **NO** | YES | YES |
| zhaopin.com | YES | YES | **NO** | YES | YES |
| lagou.com | YES | YES | **NO** | YES | YES |
| 51job.com | YES | YES | **NO** | YES | YES |

**重要：这些域名不作为 Tavily Search `exclude_domains`。Source Policy 发生在搜索结果返回之后，不是搜索之前把招聘平台排除。**

### 6.3 Unknown Domain Policy

来源无法分类（UNKNOWN）：
- Search Evidence 保存：YES
- Auto Fetch：NO（默认保守）
- Manual Review：YES

**不要"不知道是什么站 → 默认抓一下看看"。**

### 6.4 Tavily 内部如何取得 Search Result 不属于 OfferFlow Fetch Policy

Tavily Search API 返回的 `title`/`url`/`content` 属于 Search Provider Output。OfferFlow Source Policy 控制的是 OfferFlow 收到结果后，是否再主动直接访问该 URL。因此 `SEARCH_ONLY` 不等于"禁止 Tavily 返回该 domain 的搜索摘要"。

---

## 7. Content Acquisition

### 7.1 Search Discovery 与 Content Acquisition 正式拆分

```
SearchProvider（Tavily /search）
       ↓
Search Result（title/url/content/score）
       ↓
Source Policy 判定
       ↓
├─ SEARCH_ONLY → 停止自动 acquisition
├─ SEARCH_AND_FETCH → 允许 acquisition
└─ CONDITIONAL_FETCH → 策略评估
```

### 7.2 P0 Content Acquisition 范围

Policy B（SEARCH_AND_FETCH）允许自动 Fetch 的来源：
- 公司官方招聘网站（公开 careers 页面/ATS）
- 公开技术社区（GitHub、掘金等）
- 其他允许公开读取的 Open Web 招聘来源

前提必须满足：公开可访问、网站规则允许、robots/Terms/usage policy 允许、有限频率、有限 Scan Budget、只读、无需绕登录、无需绕 CAPTCHA。

### 7.3 不自动选择 Tavily Extract / Crawl

因为本次只冻结 Tavily Search API（`/search` endpoint）。Tavily Extract / Crawl / Map 不在 P0。

如果 Plan 判断 Content Acquisition 需要 Tavily Extract：必须作为独立技术决策写清理由、成本、安全边界和适用 Source Policy。

### 7.4 Content Acquisition 技术方向

如果 P0 需要从 SEARCH_EVIDENCE 升级到 FULL_EVIDENCE（Policy B 来源），技术候选：
1. **Direct HTTP fetch**（`fetch()` + HTML parsing）—— 最简单
2. **Source-specific API**（如公司 ATS 的公开 API）—— 按需
3. **Tavily Extract**（如决策通过）—— 统一接口

当前不随便选爬虫库。P0 Content Acquisition 是独立技术决策，可以后续冻结。

**禁止新设计：** `GenericCrawlerRuntime`、`CrawlerAgent`、`BrowserAutomationRuntime`、`SiteParserDSL`、`DistributedCrawler`。

---

## 8. Search Evidence 与 Radar Snapshot 的关系

### 8.1 复用 `radar_capture_snapshots`

Search Evidence 直接复用现有 `radar_capture_snapshots` 表：
- `captureSessionId = null`（Active Discovery 无 Session）
- `captureMethod = 'search_discovery'`（新值，需表重建 migration）
- `visibleText = content`（Tavily 的 content 字段）
- `pageTitle = title`
- `sourceUrl = url`
- `sourceDomain = domain`
- `providerKey = 'tavily'`
- `externalRecordId = url`（URL 去重）
- `rawSnapshot = 完整 Search Evidence + Tavily response metadata`

### 8.2 不伪造 Manual Capture 语义

当前 snapshot schema 中：
- `captureSessionId` 已支持 NULL ✅
- `providerKey` 已支持 NULL ✅
- `capture_method` CHECK 需要扩展（表重建 migration）
- 其他字段均可自然承载 Search Evidence

**不需要建 `RawSourceSnapshot` shadow table。**

### 8.3 Evidence Level 在 CandidateVersion

`evidenceLevel` 存在 `radar_candidate_versions` 表（additive TEXT column + CHECK constraint）：

```sql
evidence_level TEXT NOT NULL DEFAULT 'FULL_EVIDENCE' CHECK (
  evidence_level IN ('SEARCH_EVIDENCE', 'FULL_EVIDENCE', 'MANUAL_REVIEW_REQUIRED')
)
```

`MANUAL_REVIEW_REQUIRED` = SEARCH_EVIDENCE 且 Source Policy = SEARCH_ONLY（不得自动 Fetch）。

---

## 9. Evidence Upgrade 与 Material Change 的分离

### 9.1 两种不同 Events

| Event | 含义 | CandidateVersion 表达 |
|-------|------|----------------------|
| **Material Change** | 岗位事实发生变化（薪资、城市、JD 内容）| `originType = 'source_change'` |
| **Evidence Upgrade** | 同一岗位获得更高质量证据（搜索摘要 → 完整 JD）| `originType = 'evidence_upgrade'` |

**"内容更多"不等于"普通岗位 material change"。**

### 9.2 Evidence Upgrade 路径

```
Tavily Search → BOSS 岗位
↓
SEARCH_EVIDENCE + MANUAL_REVIEW_REQUIRED
↓
Candidate A（exists with SEARCH_EVIDENCE version）
↓
用户打开 BOSS
↓
Manual Capture（同一 BOSS 岗位）
↓
Identity Resolution 匹配到 Candidate A
↓
新 CandidateVersion
    evidenceLevel = FULL_EVIDENCE
    originType = 'evidence_upgrade'
    supersedesVersionId = SEARCH_EVIDENCE version
↓
analysisEligible = true → MatchAnalysis → Recommendation
```

### 9.3 Dedupe 保证

Tavily 发现的 BOSS 岗位和用户 Manual Capture 的同一 BOSS 岗位必须是同一个 `RadarCandidate`，不是两个。通过 URL canonicalization + provider-aware identity 实现。

---

## 10. Search Result Dedupe

### 10.1 与 Candidate Identity 分开

Search Evidence dedupe ≠ Candidate Identity。

**Search Evidence dedupe：**
- 同一 URL → 同一 source URL → 去重
- 同一 Tavily result 被多个 query 命中 → 去重

**Candidate Identity：**
- URL canonicalization
- Domain + title/company/location evidence
- Provider-aware identity（现有机制）

**不要把 search result hash 直接当 Candidate identity。**

### 10.2 Cross-Day Dedupe

同一岗位多天被 Tavily 重复命中：
- SourceRecord 更新 `lastSeenAt`
- 如果岗位 content 未变化 → 不创建新 CandidateVersion
- material change → 新 CandidateVersion
- evidence upgrade → 新 CandidateVersion（`originType='evidence_upgrade'`）

---

## 11. Source Provenance

### 11.1 两层 Provenance

| Layer | Value | Source |
|-------|-------|--------|
| Search Provider | `tavily` | Provider Adapter identity |
| Underlying Source | `liepin.com` / `company.com` / `github.com` / ... | Derived from `url` domain |

**不得把所有岗位来源写成 `source = tavily`——用户需要看到岗位实际来自哪里。**

---

## 12. Snapshot Method 更新

### 12.1 新 capture_method 值

```text
'search_discovery'  — Tavily Search 返回的结果（Search Evidence）
'open_web_fetch'    — Content Acquisition 成功获取完整内容（FULL_EVIDENCE）
```

**现有值保持不变：**
```text
'boss_current_page'
'generic_visible_text'
'pasted_text'
'shared_link_and_text'
'json_import'
```

旧值语义不变。新增值通过 SQLite 表重建 migration 添加（与 schema v8 的 `radar_actions` 表重建流程一致）。

### 12.2 旧 `'api_discovery'` 移除

Jooble-era `'api_discovery'` 不再出现在 Plan 中。之前未落地到生产 schema，因此无迁移负担。

---

## 13. SearchPlan 与 Query Budget

### 13.1 Cost Calculation

实际月成本由以下计算：

```
estimatedSearchCredits = SearchPlan.queries × days × (1 + expansionRatio)
actualSearchCredits = sum of Tavily response usage.credits_used
```

不再硬编码 `720 searches/month` 作为产品事实。

### 13.2 Credit Budget Control

| Control | Mechanism |
|---------|-----------|
| Max queries per SourceRun | `scanBudget.maxQueriesPerRun` |
| Max queries per day | `scanBudget.maxQueriesPerDay` |
| Query dedupe | 相同/相似 query 合并 |
| Expanded keyword quota | `scanBudget.maxExpandedKeywords` |

---

## 14. Existing Radar Ingestion Extraction Strategy

### 14.1 保持 V9-1 抽取策略

原有 `RadarCaptureService → RadarIngestionService` 抽取策略保持不变：
- `materializeItem` 核心逻辑提升为独立 `RadarIngestionService`
- Browser Capture 和 SearchProvider 均调用 `RadarIngestionService.ingest()`
- `IngestionInput` 不包含 Browser Capture 特有概念

### 14.2 Evidence-Aware Commit Decision

`decideCommit()` 在 V9-1 需要扩展：
- 识别 `evidenceLevel` 从 IngestionInput 传入
- SEARCH_EVIDENCE input → `analysisEligible = false`
- 但 candidate/version 仍然创建（不阻断 ingestion）

---

## 15. 关键研究结论

1. **Tavily Search API**：REST API，Bearer Token 认证，返回 `title/url/content/score`。P0 只用 `/search` endpoint（`search_depth=basic`），Tavily Extract/Crawl/Map 不在 P0。`content` 字段虽丰富但仍为 Provider Output，不自动认定为完整 JD。
2. **Cost**：Free tier 1,000 credits/month 足够 P0（24 queries/day × 30 = 720）。Basic search = 1 credit。扩展关键词需 query budget 控制。
3. **Persistence**：SUPPORTED。Tavily 官方 SDK 明确提供本地存储模式。OfferFlow 只保存最小 Search Evidence。
4. **Source Policy**：招聘平台 SEARCH_ONLY；Open Web SEARCH_AND_FETCH；Unknown 默认不 Fetch。
5. **Evidence Level**：SEARCH_EVIDENCE / FULL_EVIDENCE / MANUAL_REVIEW_REQUIRED，存在于 CandidateVersion（additive field）。
6. **Evidence Upgrade**：新 `originType = 'evidence_upgrade'`，与 Material Change 分开。
7. **Search Evidence 复用 `radar_capture_snapshots`**：不需要新 shadow table。`captureSessionId=null` 已支持。`capture_method` CHECK 需扩展。
8. **Recommendation Reconciliation**：SEARCH_EVIDENCE 候选不进入 RecommendationBatch；MANUAL_REVIEW_REQUIRED 进入 DailyJobBrief 作为 supplementary discovery items。
9. **Query Expansion**：不是笛卡尔积。需要 query dedupe + budget + high-value selection。
10. **Provider Error Model**：基于 Tavily 当前 contract（AUTH_ERROR/RATE_LIMITED/USAGE_LIMIT/TIMEOUT/NETWORK_ERROR/MALFORMED_RESPONSE/PROVIDER_UNAVAILABLE/VALID_EMPTY）。
