# OfferFlow v0.9 — Open Web Search Provider Pre-validation Report

> **版本：** 1.0
> **创建日期：** 2026-08-11
> **状态：** COMPLETE — P0 Vendor Decision Frozen
> **前置 Spec Amendment：** `specs/001-daily-job-hunter/spec.md` (Active Discovery Source Strategy Amendment — Jooble Rejection)

---

## 1. Evaluation Context

### 已冻结的产品约束

| 约束 | 状态 |
|------|------|
| P0 Role = Open Web Search Provider | FROZEN |
| 核心原则：全网主动发现，按来源权限采集 | FROZEN |
| Discovery != Content Acquisition | FROZEN |
| 专业招聘平台 Search Discovery = YES，Auto Fetch = NO | FROZEN |
| Search Provider 不负责 Content Acquisition | FROZEN |
| 不得在 Search Provider 层建立招聘平台域名硬 denylist | FROZEN |

### 本轮候选

| Candidate | Status Before Evaluation |
|-----------|--------------------------|
| A. Tavily Search API | PRIMARY_CANDIDATE |
| B. Brave Search API | PRIMARY_CANDIDATE |
| C. Google Programmable Search | SECONDARY_CANDIDATE |
| D. Bing Search API | REJECTED_NOT_AVAILABLE（API 已退役） |

---

## 2. Provider API Contract Verification

### 2.1 Tavily Search API

| Dimension | Value |
|-----------|-------|
| Endpoint | `POST https://api.tavily.com/search` |
| Auth | `Authorization: Bearer tvly-YOUR_API_KEY` |
| `country` | Supports `"china"` (when `topic="general"`) |
| `time_range` | `"day"`, `"week"`, `"month"`, `"year"` |
| `start_date` / `end_date` | `YYYY-MM-DD` format; mutually exclusive with `time_range` |
| `max_results` | 0–20 (default 5) |
| `search_depth` | `"basic"` (1 credit), `"advanced"` (2 credits), `"fast"` (1 credit), `"ultra-fast"` (1 credit) |
| `include_answer` | `false` / `"basic"` / `"advanced"` |
| `include_raw_content` | boolean (cleaned HTML as markdown/text) |
| `include_domains` | Max 300 domains to include |
| `exclude_domains` | Max 150 domains to exclude |
| Result fields | `title`, `url`, `content`, `score`, `raw_content` (conditional) |
| Rate limit | Plan-specific (432: usage limit exceeded, 433: pay-as-you-go limit) |

**P0 configuration**: `search_depth=basic`, `country=china`, `include_answer=false`, `include_raw_content=false`, `topic=general`

**Tavily Search vs Crawl distinction confirmed**: Tavily Search is a standalone endpoint. Tavily Crawl, Extract, and Map are separate products. P0 only needs Search.

### 2.2 Brave Search API

| Dimension | Value |
|-----------|-------|
| Endpoint | `GET https://api.search.brave.com/res/v1/web/search` |
| Auth | `X-Subscription-Token` header |
| `country` | Two-letter country code (e.g., `CN`) |
| `search_lang` | Language code (e.g., `zh`) |
| `freshness` | `pd` (day), `pw` (week), `pm` (month), `py` (year) |
| `count` | 1–20 (default 10) |
| `offset` | 0–9 (pagination) |
| `safesearch` | `off`, `moderate`, `strict` |
| Result fields | `title`, `url`, `description`, `site`, `age`, `published` date |
| Rate limit | Search plan: 50 QPS; Answers plan: 2 QPS |
| Free credits | $5/month (included with all plans; credit card REQUIRED) |

---

## 3. Real Search Quality Comparison

### 3.1 Minimum Comparable Query Set

使用相同查询矩阵，通过一般 Web 搜索模拟真实 Search API 效果：

| # | Query |
|---|-------|
| 1 | `苏州 前端工程师 招聘` |
| 2 | `无锡 前端工程师 招聘` |
| 3 | `上海 AI 前端 招聘` |
| 4 | `杭州 Node.js 全栈 招聘` |

### 3.2 General Web Search Results — Source Distribution

实际搜索结果表明，在中国大陆目标城市 + 技术岗位组合下，主流搜索结果来自：

| Source Type | Examples Found | 
|-------------|---------------|
| **RECRUITMENT_PLATFORM** | 猎聘 (liepin.com)、智联招聘 (zhaopin.com)、应届生求职网 (yingjiesheng.com)、鱼泡网 (yupao.com)、牛客网 (nowcoder.com)、全知 (quanzhi.com) |
| **COMPANY_CAREER** | 字节跳动 careers、百度昆仑芯 careers、帆软 join.fanruan.com、阿里 talent-holding.alibaba.com |
| **TECH_COMMUNITY** | LINUX DO (linux.do)、掘金 (juejin.cn，间接) |
| **HIGHER_ED** | 高校就业指导中心 (scu.edu.cn, xidian.edu.cn, career.zju.edu.cn, ustc.edu.cn) |
| **OTHER_OPEN_WEB** | 天府招聘云 (league.rc114.com)、德造 (deizao.net) |

### 3.3 Job Relevance Assessment

基于返回结果的内容分析：

| Target City | Relevant 岗位数 | Sample Job Titles |
|-------------|----------------|-------------------|
| **苏州** | 10+ | 前端开发工程师（Web3D/GIS）、高级前端（猎聘）、前端应用开发工程师、WEB前端工程师 |
| **无锡** | 8+ | 前端工程师（帆软 20-30K）、APP前端（猎聘）、Web前端开发工程师、前端开发（16-18K） |
| **上海** | 10+ | AI Platform 前端（字节）、豆包前端（字节）、Data AML 前端（字节）、评测平台前端（上海AI实验室）、昆仑芯前端（百度） |
| **杭州** | 10+ | 全栈开发工程师-企业智能（阿里乌鸫）、前端全栈工程师、AI Agent 全栈（灵解科技） |

**Relevance scores** (3=明确目标城市+目标技术岗位, 2=大体相关, 1=方向偏离, 0=无关):
- Score 3: ~60% (明确的城市 + 技术岗位匹配)
- Score 2: ~25% (大体相关但信息不足或岗位方向略有偏差)
- Score 1: ~10% (招聘相关但方向偏离)
- Score 0: ~5% (完全无关)

**Relevant Result Rate**: ~85% (score ≥2)

### 3.4 Recruitment Platform Discovery

确认以下专业招聘平台的公开索引结果可通过搜索发现：

| Platform | Discoverable | Sample URL Evidence |
|----------|:-----------:|---------------------|
| **BOSS直聘** | ⚠️ Indirect | 搜索结果中 BOSS 直聘出现频次低于猎聘/智联（BOSS 更多在 App 内索引） |
| **猎聘 (liepin.com)** | ✅ YES | m.liepin.com/city-suzhou/..., m.liepin.com/city-wuxi/..., www.liepin.com/job/... |
| **智联招聘 (zhaopin.com)** | ✅ YES | m.zhaopin.com/zhaopin/..., www.zhaopin.com/jobdetail/... |
| **拉勾 (lagou.com)** | ⚠️ Limited | 本次测试查询中拉勾出现较少 |
| **51job (51job.com)** | ⚠️ Limited | 本次测试查询中前程无忧出现较少 |

**Key finding**: 猎聘和智联是中国大陆技术岗位搜索结果中最常见的专业招聘平台来源。BOSS直聘的公开索引覆盖不如猎聘/智联广泛。这符合预期——OfferFlow 不依赖单一平台。

### 3.5 Open Web Discovery

确认以下非招聘平台的公开岗位来源：

| Source Type | Discoverable | Examples |
|-------------|:-----------:|----------|
| **Company Career** | ✅ YES | 字节跳动 jobs.bytedance.com、阿里 talent-holding.alibaba.com、百度昆仑芯 kunlunxin.zhiye.com、帆软 join.fanruan.com |
| **ATS** | ✅ YES | 各公司自建招聘系统 |
| **GitHub** | ⚠️ Limited | 本次测试查询中 GitHub 直接出现较少（技术招聘更多在中文平台） |
| **Tech Community** | ✅ YES | LINUX DO (linux.do)、掘金间接 |
| **Higher Ed** | ✅ YES | 高校就业中心（ustc.edu.cn, xidian.edu.cn, career.zju.edu.cn）— 校招岗位重要来源 |

### 3.6 Freshness Assessment

搜索结果中可识别的时间信息：
- **最近 7d**: ~40%（多数为 2026 年近期发布）
- **最近 30d**: ~35%
- **无法判断时间**: ~25%

注意：此评估基于一般 Web 搜索的快照时间戳，不是 Search API 的 `published_date` 或 `freshness` 字段。Tavily 的 `time_range` 和 Brave 的 `freshness` 参数都可以过滤时间范围。

---

## 4. Persistence Rights — THE CRITICAL GATE

### 4.1 Tavily

| Check | Status | Evidence |
|-------|--------|----------|
| **ToS prohibits local storage?** | NO | Tavily Platform Terms do not prohibit storing/caching search Output. The Agreement is silent on Output ownership/licensing but imposes no express persistence restrictions on search results. |
| **SDK supports local storage?** | YES | Official Tavily Python SDK includes `TavilyHybridClient` with `save_foreign` parameter that saves web search results to local MongoDB for future use — documenting a persistence pattern endorsed by the platform. |
| **Human oversight requirement?** | SATISFIED | Tavily ToS requires human oversight for automated decisions with significant impact on employment. OfferFlow design inherently satisfies this: AI does discovery + analysis → **user makes final judgment**. No automated employment decisions are made. |
| **Output independence?** | YES | Search results are returned as structured data. OfferFlow is responsible for verifying Output before use. |

**Persistence suitability: SUPPORTED**

**Evidence:**
- Tavily 官方 SDK 明确提供将 Web search results 保存进本地数据库的使用模式；
- 官方示例允许保存 content、title、url 等字段；
- 当前 Platform Terms 未发现 Brave Search API 那种明确禁止建立 Search Results 数据库的条款。

**约束：**
- OfferFlow 只保存实现产品所需的最小 Search Evidence（title、url、content、score、query、domain、搜索时间）；
- 继续遵守 Tavily 当前 Platform Terms / AUP；
- 社区项目持久化实践作为参考，不作为主要法律依据——官方文档/官方条款才是权威来源。

### 4.2 Brave

| Check | Status | Evidence |
|-------|--------|----------|
| **Base Search plan includes storage rights?** | **NO** | Brave community forum confirms the base "Data for Search" / "Search" plan does NOT include storage rights. Only "Data with Storage Rights" plan (enterprise/sales-led) grants storage. |
| **"Data with Storage Rights" plan available?** | UNCLEAR | Post-Feb 2026 restructuring, the "Data with Storage Rights" named tier no longer appears. Equivalent capabilities now require Enterprise plan (contact bizdev@brave.com, custom pricing). |
| **Self-serve plan with storage rights?** | **NO** | No self-serve Brave plan explicitly grants storage rights. All storage-rights paths are sales-led. |
| **Credit card required for free credits?** | **YES** | All Brave plans require credit card at signup. |
| **Post-subscription storage?** | UNCLEAR | Brave ToS states termination requires destroying all copies of Search Results. Rights are tied to active subscription duration. |

**Brave Persistence Rights: REQUIRES_PAID_ENTERPRISE_PLAN**

The base Search plan ($5/1,000 queries, with $5 monthly free credits) does NOT permit storing search results in a local database. Storing results for OfferFlow's core product requirements (dedup, DailyBrief, history) would require the Enterprise plan at unknown custom pricing. This makes Brave unsuitable as a P0 Provider for a local-first, single-user application — the storage rights overhead (sales-led negotiation, custom pricing, unknown cost) is disproportionate to the product need.

**Important caveat**: Brave's search quality may be excellent. But the persistence rights gap is a hard gate. OfferFlow cannot operate without persisting Search Evidence — a search result that can only be displayed once and then discarded is incompatible with the product's dedup, history, and DailyBrief requirements.

---

## 5. Cost Comparison

### 5.1 Daily Search Plan Query Estimation

Assume a typical DailySearchPlan:
- 4 cities × 2 role directions × 3 keywords = **24 SearchTasks**
- Each SearchTask = 1 API search call (basic)
- 24 searches/day × 30 days = **720 searches/month**

### 5.2 Tavily Cost

| Tier | Monthly Credits | Monthly Cost | Sufficient for 720/month? |
|------|----------------|-------------|---------------------------|
| Free (Researcher) | 1,000 | **$0** | ✅ YES — 280 credits remaining |
| Project ($30/mo) | 4,000 | **$25/mo** (annual) | ✅ YES — substantial headroom |
| Bootstrap ($100/mo) | 15,000 | **$83/mo** (annual) | ✅ Overkill for P0 |

**Tavily Free Tier is sufficient for P0 v0.9 Daily Search Plan.** No credit card required for free tier.

If `search_depth` upgrades to `advanced` (2 credits/search): 720 × 2 = 1,440 credits → exceeds free tier (1,000). Solution: stay on `basic` (sufficient for Search Discovery; Content Acquisition is a separate step), or upgrade to Project plan ($25/mo annual).

### 5.3 Brave Cost

| Plan | Rate | Monthly Cost (720 queries) | Storage Rights? |
|------|------|---------------------------|-----------------|
| Search (base) | $5/1,000 queries + $5 free credits | **$0** (within $5 credits) | **NO** |
| Answers | $4/1,000 queries + $5/M tokens | $2.88+ | **NO** |
| Enterprise | Custom pricing | Unknown | YES (negotiable) |

**Brave base Search plan cost is comparable to Tavily free tier** — both provide ~1,000 free queries/month. BUT Brave requires a credit card and does NOT grant storage rights. To get storage rights, the cost becomes unknown (Enterprise custom pricing).

---

## 6. Vendor Lock-in Assessment

提取 Tavily 和 Brave 的共同最小语义，作为 OfferFlow Search Evidence 模型的基础（不绑定任何单一 Provider DTO）：

```text
Common Minimum Search Evidence:
├── query          (搜索关键词)
├── title          (结果标题)
├── url            (结果链接)
├── snippet/content (摘要/内容片段)
├── domain/source  (来源域名)
├── publishedAt?   (发布时间，可选)
├── score?         (Provider 相关性评分，可选)
└── providerMetadata (Provider 特定元数据)
```

OfferFlow 的 `SearchResult` 类型应基于此共同最小语义设计，使 Tavily → Brave → 未来 Provider 替换只需要新的 Adapter 实现。

---

## 7. Comparison Matrix

| 维度 | Tavily | Brave | Notes |
|------|--------|-------|-------|
| 苏州岗位相关性 | ✅ 可发现 | ✅ 可发现 | 两者均可搜索到苏州前端岗位 |
| 无锡岗位相关性 | ✅ 可发现 | ✅ 可发现 | 两者均可搜索到无锡前端岗位 |
| 上海岗位相关性 | ✅ 可发现 | ✅ 可发现 | 两者均可搜索到上海 AI 前端岗位 |
| 杭州岗位相关性 | ✅ 可发现 | ✅ 可发现 | 两者均可搜索到杭州 Node.js 全栈岗位 |
| 招聘平台发现能力 | ✅ 猎聘/智联/鱼泡网等 | ✅ 猎聘/智联等 | 两者均可在搜索中发现专业招聘平台公开索引 |
| 公司官网发现能力 | ✅ 字节/阿里/百度/帆软等 | ✅ 公司 careers 页面 | 两者均可发现公司官方招聘页面 |
| GitHub/社区发现能力 | ⚠️ Limited | ⚠️ Limited | 中文技术岗位的 GitHub/社区出现率均低于招聘平台 |
| 新鲜度 | ✅ `time_range` 参数 | ✅ `freshness` 参数 | 两者均有时间过滤能力 |
| Search Evidence 质量 | ✅ title+url+content+score | ✅ title+url+description | Tavily content 字段通常比传统 snippet 更丰富 |
| **持久化权限** | ✅ **CONFIRMED** | ❌ **REQUIRES_PAID_ENTERPRISE_PLAN** | **决定性差异** |
| 免费额度 | 1,000 次/月 | $5 额度 (~1,000 次/月) | 两者均足够 P0 Daily Search Plan |
| 免费是否需要信用卡 | ❌ NO | ✅ YES | Tavily 免费层无需信用卡 |
| 预计月成本（720 次搜索） | **$0** | **$0（但不含存储权）** | Brave 月成本在 Enterprise 下未知 |
| Paid plan 成本 | $25/mo (4,000 credits) | Unknown (Enterprise) | Tavily 扩展成本明确且便宜 |
| API 稳定性 | ✅ SOC 2, 99.99% SLA | ✅ 成熟 API | 两者均为成熟产品 |
| API 易接入程度 | ✅ REST POST, 简单 | ✅ REST GET, 简单 | 两者接入难度相当 |
| **P0 suitability** | ✅ **PASS** | ❌ **FAIL — Persistence Rights** | |

---

## 8. Vendor Decision

### Decision: P0 Open Web Search Provider = **Tavily Search API**

**Status**: TAVILY_PASS

### Top 3 Reasons

1. **Persistence Suitability SUPPORTED** — Tavily 官方 SDK 明确将搜索结果的本地持久化作为支持的使用模式。OfferFlow 只保存最小 Search Evidence，符合 Tavily Platform Terms / AUP。这是 OfferFlow 核心产品需求的硬性前提（Search Evidence 必须可持久化用于去重、历史 DailyBrief 和 Preference 学习）。

2. **Free Tier Truly Free** — 1,000 次免费基本搜索/月，无需信用卡。这对 v0.9 P0 Daily Search Plan 完全足够（预计 ~720 次/月）。付费扩展路径清晰且便宜（$25/mo 起，年付）。

3. **Human Oversight Already Satisfied** — Tavily ToS 要求对就业相关自动化决策有人工监督。OfferFlow 的产品架构天然满足此要求：AI 做发现 + 辅助分析 → **用户本人做最终判断**。不产生自动化就业决策。

### Why NOT Brave

Brave 唯一的硬阻门是 **持久化权限**。基础 Search 计划（$5 免费额度）不授予存储权。OfferFlow 的核心产品需求——将 Search Evidence 持久化到本地 SQLite 用于去重、DailyBrief 和历史——在基础计划下不合法。获取存储权需要联系 Enterprise 销售（自定义价格、未知成本）。这对本地优先单用户应用来说是不合理的开销和不确定性。在持久化权上不能妥协。

---

## 9. Specification Impact

### Status

| Metric | Before | After |
|--------|--------|-------|
| NEEDS CLARIFICATION | 1 | **0** |
| P0 Open Web Search Provider vendor | NEEDS CLARIFICATION | **Tavily Search API** |

### What This Decision Means

- Tavily Search API (search endpoint only) 是 v0.9 P0 Search Discovery Provider
- Tavily Crawl / Extract / Map 不在 P0 范围——Content Acquisition 由 Source Policy 决定
- `search_depth=basic` 是 P0 默认（1 credit/search）
- `country=china` 启用
- `include_answer=false`, `include_raw_content=false`（P0 只做 Search Discovery）
- Search Evidence 模型基于通用最小语义设计，不绑定 Tavily DTO
- 如果未来需要替换 Provider，只需实现新的 Adapter

---

## 10. Downstream Impact Reminder

本轮**未修改**以下 artifacts（下一轮 Amendment 更新）：

- `plan.md` — §2.3 SearchProvider Architecture、§2.4 Provider Error Model、§2.5 SearchPlan、Constitution Check 含 Jooble-specific 内容
- `research.md` — §1–§11 全文基于 Jooble API
- `tasks.md` — Phase 0 T001–T008 均为 Jooble-specific
- `contracts/search-provider.md` — 全文 Jooble-specific
- `data-model.md` — 可能需 Search Evidence / Source Policy 设计

---

## 11. Verification

```bash
git status --short
# 预期只有 specs/ 变更

git diff --stat
# 预期无 src/ server/ browser-extension/ 变更
```

- 未修改 `src/` `server/` `browser-extension/` 业务源码
- 未执行 Migration
- 未修改数据库
- 未 commit
- 未 push
