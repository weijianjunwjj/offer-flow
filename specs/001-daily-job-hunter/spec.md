# 功能规格说明书：OfferFlow v0.9 — 每日岗位猎手

**Feature Branch**: `feat/v0.9`

**Created**: 2026-08-11

**Status**: Frozen — v0.9 Final Scope

**Final Scope Amendment**: 2026-08-19

**Input**: 用户描述："OfferFlow v0.9 — 每日岗位猎手：系统在电脑端每天主动替用户寻找可能合适的真实岗位，复用 v0.8 Radar 完成可信分析与有限推荐，把主动发现的机会汇总到每日简报，用户在电脑端查看推荐结果并做出决策。"

## Clarifications

### Session 2026-08-11

- Q: P0 Active SearchProvider 的来源安全边界：专业招聘平台是否允许作为网页爬虫 Active SearchProvider？ → A: 专业招聘平台（BOSS直聘、拉勾、猎聘、智联招聘、前程无忧等）禁止作为网页爬虫或浏览器自动化 Active SearchProvider。主动 Crawler 仅用于公开公司招聘官网、公开技术社区及允许公开读取的 Open Web 来源。Provider 分为 ApiSearchProvider（官方授权 API）、CompanyCareerProvider（公司官网/公开 ATS）、OpenWebJobProvider（GitHub/掘金/技术社区/公开招聘内容）。专业招聘平台仅通过 Browser Manual Capture 进入 Radar。
- Q: v0.9 P0 Active SearchProvider 的具体实现方向？ → A: P0 = Jooble REST API（ApiSearchProvider）。认证方式为 API Key（不进 Git、不进日志、Secret 管理）。无需用户招聘平台登录、无需浏览器 Session、无需爬虫。搜索输入映射：keywords、location、salary（来源支持时）、page。搜索输出消费：title、company、location、salary、snippet、source、link、updated、id。缺失字段进入现有 Radar 数据质量机制。分页与预算原则冻结（有限分页、有限 Scan Budget、Provider-specific rate limit），具体实现参数留到 Plan。仅 API 请求成功 + 响应结构有效 + jobs=[] 才属于 valid empty result；API Key 无效/HTTP error/rate limit/timeout/malformed response/provider unavailable 均进入 Coverage Gap/FAILED/ACTION_REQUIRED。P0 验收：连续至少 3 个自然日真实运行，验证 Scheduler 自动触发、Jooble API 返回真实岗位、搜索结果进入统一 Radar Ingestion、重复岗位不重复创建 Candidate、岗位变化进入 CandidateVersion 事实链、Provider 失败不伪装 0 岗位、Coverage 完整可追踪、无无限 retry、无招聘平台网页自动化、至少形成一次真实 MatchAnalysis、一次真实 RecommendationBatch、一次真实 DailyJobBrief。后续 Provider 优先级：Company Career Provider（Next）→ GitHub/掘金/技术社区（Later）。

### Session 2026-08-11 — Amendment: Active Discovery Source Strategy

本 Amendment 是 Jooble 公开市场 Pre-validation 失败后的正式 Specification 变更，撤销 Jooble P0 决策并重新定义 Active Discovery Source Strategy。

- **Jooble Pre-validation: FAIL** — 最初选择 Jooble REST API 作为 P0 Active SearchProvider，但在公开市场 Pre-validation 中，Jooble 对中国大陆目标岗位（苏州、无锡、上海、杭州；前端/AI应用/Full-stack 等技术岗位）覆盖密度不足，分类存在明显噪声，实际岗位价值不足以支撑 v0.9 Daily Job Hunter 的产品目标。这是 **Product Suitability Failure**，不是 Technical Integration Failure。不要因为有 API 就继续保留其 P0 身份。

- **Jooble 当前状态：REJECTED_AFTER_PREVALIDATION** — Jooble 不被删除（保留完整历史记录，包括"为什么当初选、为什么后来撤"），但不再作为 P0 Active SearchProvider，其 Adapter/Secret/Scheduler integration 全部撤销。Jooble 淘汰不推翻 Provider-independent 架构（Shared Radar Ingestion Core、DailySearchPlan、SourceRun、Scheduler 等通用设计保持不变）。

- **撤销 Jooble ≠ 撤销 Active Discovery** — v0.9 的核心能力"用户不需要事先知道目标公司，也不需要每天手工访问所有招聘来源；OfferFlow 根据 SearchPlan 主动在互联网中发现相关岗位机会"仍然是 P0。不得降级成"只处理用户 Manual Capture 的岗位"，否则 v0.9 产品价值发生实质性缩水。

- **新的 P0 Provider 类型：Open Web Search Provider** — 职责：根据 SearchPlan 在整个公开 Web 搜索与用户求职目标相关的招聘信息和岗位页面。典型查询维度：城市 × 岗位方向 × 关键词 × 扩展关键词。搜索结果不得因为来源是专业招聘平台而直接排除。允许被发现的来源包括 BOSS直聘、猎聘、智联招聘、拉勾、前程无忧、公司官网、公开 ATS、GitHub、掘金、技术论坛、开源社区、公开博客、招聘文章、招聘专题页及其他公开 Web 页面。

- **具体 Open Web Search Provider Vendor：Tavily Search API** — Pre-validation 结果：TAVILY_PASS。Tavily Search API（search endpoint only）是 v0.9 P0 Search Discovery Provider。配置：`search_depth=basic`、`country=china`、`include_answer=false`、`include_raw_content=false`。认证方式为 API Key（Bearer token，不进 Git、不进日志、Secret 管理）。P0 只用 Tavily Search——Tavily Crawl/Extract/Map 不在 P0 范围（Content Acquisition 由 Source Policy 决定）。Tavily 官方 ToS 不禁止本地持久化搜索结果，官方 SDK 内置将搜索结果保存到本地数据库的功能。OfferFlow 产品架构天然满足 Tavily 的 human oversight 要求（AI 做发现+分析，用户做最终判断）。Brave Search API 评估结果：BRAVE_FAIL — 基础 Search 计划不授予存储权，获取存储权需要 Enterprise 自定义定价销售流程，不适用于本地优先单用户产品。Google Programmable Search 为 SECONDARY_CANDIDATE（不做 P0）。Bing Search API 为 REJECTED_NOT_AVAILABLE（API 已退役）。Tavily Free tier（1,000 次/月、无需信用卡）足以支持 v0.9 P0 Daily Search Plan。扩展路径明确（Project $25/mo 年付）。Provider 可替换——Search Evidence 模型基于 Tavily/Brave 共同最小语义设计，不绑定 Tavily DTO。

- **核心原则：全网主动发现，按来源权限采集（Discovery != Content Acquisition）** — 两个阶段必须明确分开。Stage 1 — Search Discovery：Open Web Search Provider 可以搜索整个公开互联网，不得在 Search Provider 层建立 zhipin.com、liepin.com、zhaopin.com、lagou.com、51job.com 的硬 denylist——仅仅因为某条搜索结果来自招聘平台不得丢弃。Stage 2 — Content Acquisition：由 Source Policy 决定对某个搜索结果可以自动做到哪一步。

- **Source Policy（产品级）** — 不存在 TypeScript enum/class 级别的定义（留到设计阶段）。产品语义至少包含三种能力级别：
  - **Policy A — SEARCH_ONLY**：BOSS直聘、猎聘、智联、拉勾、前程无忧等专业招聘平台。允许：Search Discovery、保存搜索证据（title/snippet/url/domain/source/publishedAt/search score）、显示 URL、用户人工访问 → Manual Capture。禁止：自动 Fetch 完整 JD、后台批量抓岗位页面、自动翻页、模拟用户点击、使用用户 Cookie/Token 扫描、绕 CAPTCHA/风控、无限 retry。
  - **Policy B — SEARCH_AND_FETCH**：满足规则的公司官网 careers、公开 ATS、GitHub、允许自动读取的 Open Web，以及**普通 unknown public domain**（无法判明为专业招聘平台、也非 CONDITIONAL_FETCH 明确清单的来源）。允许：Search + 有限公开内容 Fetch + 结构化岗位事实。前提：公开可访问、网站规则允许、robots/Terms/usage policy 允许、有限频率、有限 Scan Budget（默认每 run 最多 50 条 Content Acquisition）、只读、无需绕登录、无需绕 CAPTCHA。**unknown public 是受控 fetch，不等于自动 FULL_EVIDENCE**——仍须经 Content Acquisition 成功 + JD 完整性验证通过 + 显式 evidence_upgrade 才产生 FULL_EVIDENCE。
  - **Policy C — CONDITIONAL_FETCH**：技术论坛、社区、博客等来源（如 juejin.cn）。是否 Fetch 取决于该来源的访问规则、公开程度、robots、Terms 和技术限制。无法确认时默认不自动 Fetch。
  - **Cross-source enrichment（identity-safe）**：专业招聘平台详情页禁止自动 Fetch，但允许对招聘平台搜索结果做一次有界 cross-source enrichment——通过 Open Web Search 寻找「同一公司同一岗位」的公开替代证据源（公司官网 careers / 公开 ATS / 普通 public web），再用替代源走 Policy B 的 Content Acquisition。**必须 identity-safe**：缺结构化 company identity → 不做 enrichment（保持 MANUAL_REVIEW_REQUIRED）；禁止 role-only 查询猜测替代来源；public alternative 必须非招聘平台、非原 URL、company 与原 item 一致、role/title 合理匹配，才允许进入 fetch。enrichment 有预算（默认每 run 最多 20 个原始招聘平台 item），禁止递归。当前 Tavily 不提供结构化 company，enrichment 在缺少 company 时 fail closed。

- **Evidence Model（产品级）** — 一个岗位被发现 ≠ OfferFlow 已拥有完整 JD。至少存在三种证据等级：
  - **SEARCH_EVIDENCE**：只有搜索结果 title/snippet/url/source/domain/搜索时间。可以进入发现池、初筛、显示给用户、进入 Daily Brief。但不能假装拥有完整岗位事实。典型场景：BOSS 搜索结果。
  - **FULL_EVIDENCE**：来源允许自动读取（Policy B），或用户完成 Manual Capture 后，OfferFlow 获得足够岗位事实。可以进入 Radar Precheck、MatchAnalysis、Recommendation reasoning。
  - **MANUAL_REVIEW_REQUIRED**：Search Evidence 看起来值得看但来源禁止自动 Fetch（Policy A），应明确标记提示用户"打开原岗位确认"，而不是丢掉这个岗位。

- **DailyJobBrief 必须允许混合证据等级** — 每日汇报未来可以同时出现 FULL_EVIDENCE、SEARCH_EVIDENCE 和 MANUAL_REVIEW_REQUIRED 三种状态的岗位。

- **Browser Manual Capture 的角色保持** — 现有 Browser Capture 不删除、不弱化。它现在承担将 SEARCH_ONLY 来源从搜索级证据升级为完整 Radar Evidence 的重要角色（Search API → 发现 BOSS 岗位 → SEARCH_EVIDENCE → 用户打开 BOSS → Manual Capture → FULL_EVIDENCE → Radar/MatchAnalysis）。不要把 Browser Capture 改造成自动招聘平台爬虫。

- **Search Provider 职责边界** — Search Provider 的职责只是搜索、发现 URL、返回 Search Evidence。不是万能 Search + Crawl + Parse Provider。Content Acquisition 是后续独立能力。这样未来 Tavily、Brave 或其他 Search API 都可以替换，而不会改变来源 Fetch Policy。

- **Company Career Provider 的新定位** — 从 P0 主入口降级为 Follow-up Provider / Deep Source。可能来源于 Open Web Search 发现某公司 Careers → Source Quality 高 → 未来持续 Follow。当前 v0.9 P0 不要求用户提前维护目标公司名单。

- **完整的 Active Discovery 概念链**：DailySearchPlan → Open Web Search Provider → Search Result / Search Evidence → Source Policy（SEARCH_ONLY → 初始 Ingestion 产生 SEARCH_EVIDENCE 或 MANUAL_REVIEW_REQUIRED 版本 → Manual Review / Manual Capture，或 identity-safe cross-source enrichment 找公开替代源；SEARCH_AND_FETCH（公司官网/公开 ATS/普通 unknown public web）→ 初始 Ingestion 产生 SEARCH_EVIDENCE 版本 → Content Acquisition → 证据验证 → Evidence Upgrade 产生新 FULL_EVIDENCE 版本；CONDITIONAL_FETCH → Policy Decision）→ Data Quality Gate → Analysis → Recommendation → DailyJobBrief（T040）。

---

## Final Scope Amendment — 2026-08-19

本 Spec 原始规划包含完整的"Discovery → Notification → Judgment → Preference Learning"闭环。

经过开发和评估，v0.9 最终冻结范围已从初始规划中移除以下 Functional Requirements，迁移至 v1.0：

### Deferred to v1.0

**FR-026～FR-035：Notification / QQ SMTP**
- NotificationChannel / NotificationOutbox / SMTP 配置与发送
- HIGH_PRIORITY_ALERT / DAILY_BRIEF / RUN_FAILED / ACTION_REQUIRED 邮件
- 邮件模板、重试、幂等性保护
- 邮件配置管理页面
- Notifications 历史与状态页面

**FR-036～FR-042：JobJudgment / 四档审批**
- VERY_SUITABLE / SOMEWHAT_SUITABLE / NOT_VERY_SUITABLE / VERY_UNSUITABLE 判断
- JudgmentCard / Judgment Repository / Judgment API
- 审批进度追踪
- 智能追问（最多 1 次 / 岗位）
- JudgmentReason 理由记录

**FR-043～FR-048：Preference Learning**
- PreferenceSignal / PreferenceRule / Rule Proposal / Rule Activation
- Search Preference Influence（关键词扩展）
- Recommendation Preference Influence（排序、抑制）
- Repeated Mistake Protection / Exploration
- Preference UI 偏好管理页面

### v0.9 Final Scope

v0.9 最终交付范围专注于：

**FR-001～FR-025：Core Discovery & Recommendation**
- DailySearchPlan 配置与版本化
- Scheduler 自动调度
- Tavily Search API（P0 Open Web Search Provider）
- Source Policy（SEARCH_ONLY / SEARCH_AND_FETCH / CONDITIONAL_FETCH）
- Evidence Model（SEARCH_EVIDENCE / FULL_EVIDENCE / MANUAL_REVIEW_REQUIRED）
- Content Acquisition / Evidence Upgrade
- Analysis（复用 v0.8）
- Recommendation（复用 v0.8 Batch）
- DailyJobBrief 汇总
- 前端最小闭环

用户可以在电脑端查看每日推荐，使用现有 RadarAction 标记岗位。

### Rationale

将 Notification / Judgment / Preference 迁移至 v1.0，可以让 v0.9 更专注于"主动发现→推荐→展示"核心闭环的稳定性和交付质量。

详细迁移记录见 `docs/prd/offerflow-v1.0.md`。

---

## 用户场景与测试 *(必填)*

### User Story 1 - 配置每日找岗计划 (Priority: P1)

用户希望一次性定义要找什么岗位、在哪些城市、从哪些来源、每天什么时间运行，而不需要每天手动重复这些配置。

**Why this priority**：没有计划，系统就无事可执行。这是使所有下游自动化成为可能的基础用户动作。

**Independent Test**：可通过以下方式独立测试：创建一个包含城市、岗位方向、关键词、来源和每日调度时间的计划，然后验证计划已保存、已版本化，并正确显示其活跃配置。

**Acceptance Scenarios**：

1. **Given** 一个首次使用的用户，**When** 他们创建新的 DailySearchPlan，设置 cities=["苏州","无锡"]、roleDirections=["前端开发","全栈"]、baseKeywords=["React","TypeScript"]、schedule={"dailyAt":"09:00"}、scanBudget={"maxScansPerRun":100}、analysisBudget={"maxAnalysesPerRun":10}，**Then** 计划以 status=active 保存，并创建一个不可变的 PlanVersion。
2. **Given** 一个拥有活跃计划的用户，**When** 他们修改城市列表，**Then** 创建新的 PlanVersion（版本号递增），旧的 SourceRun 仍然引用旧版本，新版本变为活跃版本。
3. **Given** 一个正在配置计划的用户，**When** 他们设置 sourceConfigs 包含至少一个 SearchProvider，**Then** 计划引用该 Provider 配置并在 SearchTask 展开时包含它。
4. **Given** 一个正在配置计划的用户，**When** 他们设置 latestCatchUpTime 为 "12:00"，**Then** 中午之前的错过调度可以触发补偿；中午之后的错过调度被跳过。
5. **Given** 一个正在查看计划的用户，**When** 他们点击暂停（Pause），**Then** 调度运行停止；**When** 他们点击恢复（Resume），**Then** 调度运行在下一个窗口恢复。

---

### User Story 2 - 通过 Open Web Search Provider 主动发现岗位 (Priority: P1)

系统根据用户计划主动搜索整个公开互联网，发现真实的职位列表，无需用户手动查找或粘贴每个岗位。

**Why this priority**：这是 v0.9 的核心价值主张——从手动找岗位转变为自动发现。没有可工作的 Search Provider，每日流水线就没有输入。

**Independent Test**：可通过以下方式独立测试：配置带有真实 P0 Open Web Search Provider 的计划，触发一次手动运行，验证 Provider 返回了包含来源 URL、Search Evidence（title/snippet/url/source/domain）的真实搜索结果列表。

**Acceptance Scenarios**：

1. **Given** 一个带有已配置 Search Provider 的活跃 DailySearchPlan，**When** 触发 SourceRun（调度或手动），**Then** Search Provider Adapter 执行全网搜索，返回 SearchResult 条目，每个条目包含：Provider 身份、岗位 URL、Search Evidence（title、snippet、source、domain）和采集时间戳。
2. **Given** 来自 Search Provider 的 SearchResult 条目，**When** 它们被接收，**Then** 根据 Source Policy 决定后续处理：SEARCH_ONLY 来源（专业招聘平台）保存搜索证据并标记 MANUAL_REVIEW_REQUIRED；SEARCH_AND_FETCH 来源（公司官网/公开 ATS/Open Web）在允许时执行 Content Acquisition 后进入 Radar Ingestion；CONDITIONAL_FETCH 来源在无法确认 Fetch 权限时默认不 Fetch。
3. **Given** 一个遇到登录失败的 Source（Content Acquisition 阶段），**When** 尝试 Fetch，**Then** SourceRun 记录 WAITING_FOR_USER 状态并带有明确的错误码（而非泛化的"未找到岗位"）。
4. **Given** 一个受频率限制约束的 Search Provider，**When** 分发搜索任务，**Then** Provider 遵守频率限制，不绕过平台限制。
5. **[已澄清]** P0 Provider 类型 = Open Web Search Provider（根据 SearchPlan 在整个公开 Web 搜索相关招聘信息和岗位页面）。典型查询维度：城市 × 岗位方向 × 关键词 × 扩展关键词。搜索结果不得因为来源是专业招聘平台而直接排除。具体 P0 Vendor 仍为 NEEDS CLARIFICATION（候选：Tavily、Brave Search API 等）。Provider 可替换——Open Web Search Provider 不绑定 Radar/Analysis/Recommendation 核心领域。
6. **[已澄清]** 专业招聘平台（BOSS直聘、猎聘、智联、拉勾、前程无忧等）的岗位链接允许出现在 Search Discovery 结果中。禁止在 Search Provider 层建立 zhipin.com/liepin.com 等硬 denylist。这些来源的发现采用 Policy A（SEARCH_ONLY）——保存 Search Evidence、显示 URL、用户人工访问和 Manual Capture，禁止自动 Fetch 完整 JD。
7. **[已澄清]** Jooble REST API 状态为 REJECTED_AFTER_PREVALIDATION。原因：中国大陆技术岗位覆盖不足、苏州/无锡等核心城市有效前端岗位密度不足、搜索结果存在明显职位分类噪声、API 易接入不能弥补数据价值不足。Jooble 历史记录保留，但不再作为 P0 Provider。

---

### User Story 3 - 浏览器页面关闭后流水线仍然运行 (Priority: P1)

每日找岗流水线在 OfferFlow 后端进程中以服务端方式执行。用户无需保持浏览器标签页打开即可触发调度运行。

**Why this priority**：核心承诺是"电脑在你做其他事情时替你盯着岗位"。如果浏览器页面必须保持打开，产品就未能兑现其主要价值主张。

**Independent Test**：可通过以下方式测试：打开 OfferFlow UI，验证调度器显示下次运行时间，关闭浏览器页面，等待到调度时间，然后重新打开 UI 确认已创建并执行 SourceRun。

**Acceptance Scenarios**：

1. **Given** 调度时间为 09:00 且 OfferFlow 后端服务正在运行，**When** 浏览器页面在 08:55 关闭，**Then** 09:00 时 SourceRun 仍然触发，流水线执行，结果被持久化。
2. **Given** 后端服务正在运行，**When** 用户在调度运行完成后打开 UI，**Then** DailyJobBrief、RecommendationBatch 和 Coverage 立即可见。

---

### User Story 4 - 错过调度后的补偿运行 (Priority: P2)

当电脑在调度时间处于关机、睡眠状态，或服务未运行时，系统在服务恢复后能执行一次受控的补偿运行，不重复工作。

**Why this priority**：真实电脑不是 7×24 服务器。补偿机制确保用户不会仅仅因为笔记本处于睡眠模式而静默错过一整天。

**Independent Test**：可通过以下方式测试：设置 09:00 的调度，确保 09:00 时服务停止，在 11:20 启动服务，验证恰好创建了一个 CATCH_UP SourceRun，触发类型正确且记录了实际执行时间。

**Acceptance Scenarios**：

1. **Given** 计划调度在 09:00，电脑一直睡眠到 11:20，**When** 服务恢复，**Then** 系统检测到已错过窗口，判断仍在 latestCatchUpTime 以内，创建恰好一个 CATCH_UP SourceRun。
2. **Given** 今天的 PlanVersion 已经创建过 CATCH_UP 运行，**When** 服务再次重启，**Then** 同一自然日同一 PlanVersion 不再创建额外的 CATCH_UP 运行。
3. **Given** 一个 latestCatchUpTime 已过期的计划，**When** 服务在该时间之后恢复，**Then** 跳过错过调度（不创建 CATCH_UP），DailyBrief（如有）注明当日已错过。
4. **Given** 一个已错过的日期，**When** 用户明确点击"跳过今天"（Skip Today），**Then** 无论是否在补偿资格内都不创建 CATCH_UP。

---

### User Story 5 - 真实覆盖可见性 (Priority: P2)

每次运行后，用户可以清楚地看到计划了什么、实际发生了什么、哪些成功、哪些失败。来源失败绝不被伪装成"今天没有岗位"。

**Why this priority**：对自动化的信任需要透明度。如果系统说"0 个新岗位"，用户需要知道它意味着"搜索了但没找到"还是"根本没有搜索成功"。

**Independent Test**：可通过以下方式测试：运行一次覆盖多个 SearchTask 组合（城市 × 方向 × 关键词）的 SourceRun，部分成功、部分失败，验证覆盖报告显示每个范围的详细结果。

**Acceptance Scenarios**：

1. **Given** 一个已完成的 SourceRun，**When** 用户查看运行详情，**Then** 他们看到：plannedTasks、completedTasks、failedTasks、scannedCount、newCandidateCount、materialChangeCount、duplicateCount、blockedCount、analysisRequestedCount、analysisSucceededCount、recommendationCount、alertCount，以及带具体错误原因的 failedScopes 列表。
2. **Given** 一个 Provider 在某城市失败而另一城市成功的 SourceRun，**When** 运行状态为 PARTIALLY_SUCCEEDED，**Then** 覆盖报告清楚列出哪个范围失败及原因（例如："苏州 × AI前端: login_required"）。
3. **Given** 一个所有搜索任务全部失败的 SourceRun，**When** 运行状态为 FAILED，**Then** 状态和错误码明确展示——绝不报告为"今天发现 0 个岗位"。

---

### User Story 6 - 主动发现岗位进入现有 Radar 领域 (Priority: P1)

通过主动搜索发现的岗位，进入与浏览器采集岗位相同的 v0.8 Radar 实体链。只有一个统一的岗位世界，没有两套平行的岗位模型。

**Why this priority**：创建平行岗位模型将违反"One Domain, No Shadow Models"宪法原则，分裂事实源。所有下游能力（分析、推荐、偏好学习）依赖统一领域。

**Independent Test**：可通过以下方式测试：主动发现一个岗位，验证它在与浏览器采集岗位相同的表中创建了 RadarCandidate 和 CandidateVersion，并确认它出现在同一个 RadarCandidate 列表视图中。

**Acceptance Scenarios**：

1. **Given** 一个通过主动 SearchProvider 发现的岗位，**When** 它进入 RadarIngestionService，**Then** 它使用与浏览器采集相同的表和 Repository 产生 RadarCaptureSnapshot（captureSessionId=null、captureMethod=active_search）、RadarSourceRecord、RadarCandidate 和 RadarCandidateVersion。
2. **Given** 来自主动搜索和浏览器采集两方面的岗位，**When** 身份识别运行，**Then** 无论 captureMethod 如何，都应用相同的候选人去重逻辑。
3. **Given** 一个主动搜索产生的 Candidate，**When** 它被分析和推荐，**Then** 它使用相同的 analysis_tasks、job_match_analysis_records 和 radar_recommendation_batches 表——不新增带 "search_" 或 "hunter_" 前缀的表。

---

### User Story 7 - 每日推荐上限 0-8 条 (Priority: P2)

每天系统最多生成 8 条正式推荐。质量优先于数量——当没有岗位达到标准时，0 条推荐是可接受且诚实的。

**Why this priority**：推荐上限是宪法级约束。用低质量岗位填充推荐会损害用户信任并浪费审批时间。

**Independent Test**：可通过以下方式测试：对一批已分析的候选人运行推荐流水线，验证输出批次包含 0-8 条，且对纳入或排除有清晰的解释。

**Acceptance Scenarios**：

1. **Given** 一个包含 50 个已分析候选人的池子，**When** 推荐流水线运行，**Then** RadarRecommendationBatch 最多包含 8 条。
2. **Given** 一个所有候选人均被硬约束、偏好抑制或 stale 分析阻断的池子，**When** 推荐流水线运行，**Then** 批次包含 0 条，DailyBrief 的 emptyReason 解释原因。
3. **Given** 一个包含 5 条推荐的批次，**When** 用户审查它，**Then** 每条显示系统建议（apply_now/stretch/verify/skip）及 confidence、核心理由和主要风险——而不是只给一个分数。

---

### User Story 8 - 统一每日岗位汇报 (Priority: P2)

每天系统产生恰好一份 DailyJobBrief，作为执行结果、推荐、邮件状态和审批进度的容器——不创建第二套独立的推荐列表。

**Why this priority**：DailyJobBrief 是用户的每日仪表板。它必须引用（而非复制）RecommendationBatch 以维护唯一事实源。

**Independent Test**：可通过以下方式测试：运行完整每日流水线，验证创建的 DailyJobBrief 通过 ID 引用 SourceRun 和 RecommendationBatch，并确认 Brief 中的推荐候选人与批次条目完全一致。

**Acceptance Scenarios**：

1. **Given** 一个已完成的 SourceRun 和已生成的 RecommendationBatch，**When** 构建 DailyJobBrief，**Then** 它通过 recommendationBatchId（外键）引用批次，不将候选人 ID 复制到自己的 JSON 列中，其覆盖摘要与 SourceRun 的实际结果一致。
2. **Given** 一个状态为 READY 的 DailyJobBrief，**When** 用户打开每日汇报页面，**Then** 他们看到：覆盖摘要、推荐条目（来自引用的批次）、邮件投递状态和审批进度（按判断档位计数）。
3. **Given** 用户完成了某 Brief 的所有判断，**When** Brief 状态变为 COMPLETED，**Then** 完成摘要显示：判断分布、新增 PreferenceSignal、待确认的 PreferenceRule 和成本摘要。

---

### User Story 9 - 高优先级 QQ 邮件即时提醒 (Priority: P2)

当新增或发生实质性变化的岗位超过高优先级阈值时，用户立即收到 QQ 邮件通知，以便对时效性机会及时采取行动。

**Why this priority**：高优先级提醒是通知系统中最具时效性的部分。某些岗位申请窗口很短，值得立即关注。

**Independent Test**：可通过以下方式测试：创建一个场景，新 CandidateVersion 满足高优先级标准（新发现、规则通过、分析成功、推荐为 apply_now/stretch、未被负面 PreferenceRule 抑制），触发通知流水线，验证创建并投递了类型为 HIGH_PRIORITY_ALERT 的 Outbox 条目。

**Acceptance Scenarios**：

1. **Given** 一个新发现的 CandidateVersion，满足：通过所有硬约束、有成功的当前 MatchAnalysis、被推荐为 apply_now 或 stretch、且未被活跃的负面 PreferenceRule 抑制，**When** 通知流水线运行，**Then** 创建一个 HIGH_PRIORITY_ALERT Outbox 条目。
2. **Given** 对特定 CandidateVersion + recipient + notificationType 组合已发送过 HIGH_PRIORITY_ALERT，**When** 流水线使用相同输入再次运行，**Then** 不创建重复的 Outbox 条目（通过 candidateVersionId + notificationType + recipient 实现幂等）。
3. **Given** 已提醒过的 CandidateVersion V1，**When** 同岗位发生实质性变化产生独立满足提醒标准的 V2，**Then** V2 有资格获得新提醒（新版本，新通知资格）。
4. **Given** 一封 HIGH_PRIORITY_ALERT 邮件，**When** 用户在手机上打开它，**Then** 它包含：岗位名称、公司、城市、薪资、发现日期、2-3 个核心理由、主要风险、命中的正向偏好、原岗位链接，以及"正式审批请回到电脑端 OfferFlow"的提示。

---

### User Story 10 - 每日 QQ 日报邮件 (Priority: P2)

每天系统发送一封日报邮件，汇总覆盖情况、推荐和审批状态。当没有合适岗位时，日报是一份诚实的空汇报，说明搜索了什么、为什么没有推荐。

**Why this priority**：日报是用户与系统的主要接触点。它确保用户无需打开桌面应用也能了解情况。

**Independent Test**：可通过以下方式测试：完成一次有推荐的 SourceRun，触发日报邮件，验证其包含覆盖摘要和推荐列表。同时测试零推荐情况，验证发送了诚实的空汇报。

**Acceptance Scenarios**：

1. **Given** 一份包含 5 条 RecommendationBatch 的 DailyJobBrief，**When** DAILY_BRIEF 邮件发送，**Then** 它包含：覆盖摘要（扫描、新增、变化、重复、阻断、分析、推荐数量）、5 条推荐条目及关键详情、当前审批状态。
2. **Given** 一份包含 0 条推荐的 DailyJobBrief，**When** DAILY_BRIEF 邮件发送，**Then** 它如实说明"今日没有发现值得你处理的新岗位"，并解释：搜索了什么、哪些来源成功、哪些失败、扫描了多少、为什么没有进入推荐、没有为了凑数降低标准。
3. **Given** 一个部分成功的 SourceRun，**When** 日报邮件发送，**Then** 它明确标识哪些范围失败，不写"所有来源均已正常搜索"。
4. **Given** 日报邮件，**When** 在手机上打开，**Then** 所有原岗位链接可点击并指向实际岗位页面。

---

### User Story 11 - 四档岗位判断 (Priority: P2)

用户一次一条在桌面端审查推荐岗位，做出四档判断：VERY_SUITABLE、SOMEWHAT_SUITABLE、NOT_VERY_SUITABLE 或 VERY_UNSUITABLE。判断与收藏、投递或市场反馈明确区分。

**Why this priority**：用户判断是 Preference 系统的主要学习信号。正确建立判断模型是 PreferenceRule 有效性的前提。

**Independent Test**：可通过以下方式测试：打开包含推荐的 DailyJobBrief，对每条做出四档判断，验证判断以 CandidateVersion 绑定持久化，不自动创建 RadarAction，且页面刷新后不丢失。

**Acceptance Scenarios**：

1. **Given** 一份包含 5 条推荐条目的 DailyJobBrief，**When** 用户对条目 1 选择 VERY_SUITABLE，**Then** 创建 JobJudgment，绑定：dailyBriefId、radarCandidateId、candidateVersionId、matchAnalysisId、judgment=VERY_SUITABLE，以及原始系统建议和 confidence。
2. **Given** 条目 1 的判断已完成，**When** 页面自动前进，**Then** 显示条目 2。用户可以返回修改条目 1 的判断——旧判断被取代（不物理删除），创建新的活跃判断。
3. **Given** 用户判断了 5 条中的 3 条后关闭页面，**When** 他们重新打开每日汇报，**Then** 已判断的 3 条显示其判断结果，系统自动定位到第一条未判断的条目。
4. **Given** 全部 5 条都已判断，**When** 出现完成摘要，**Then** 它显示四档分布，并高亮系统判断与用户判断之间的差异。

---

### User Story 12 - 高信息增益理由追问 (Priority: P3)

当用户判断与系统建议冲突或揭示新的偏好模式时，系统最多对每个岗位追问一个具体问题。用户总是可以跳过。

**Why this priority**：理由是偏好学习的原材料，但过度提问会降低审批体验。此 Story 为 P3，因为判断在初期可以无追问运行。

**Independent Test**：可通过以下方式测试：创建系统推荐 apply_now 但用户判断 VERY_UNSUITABLE 的场景（强冲突、未知原因），触发追问。验证恰好问了一个问题，且用户可跳过。

**Acceptance Scenarios**：

1. **Given** 用户对 apply_now 推荐做出 VERY_UNSUITABLE 判断，且没有已有 PreferenceRule 能解释该判断，**When** 判断保存，**Then** 系统最多可提出一个追问，该追问针对此 JD 具体、提供 2-4 个具体选项加"其他"和"跳过"，且不诱导答案。
2. **Given** 用户对匹配已有活跃负面 PreferenceRule 的岗位做出 VERY_SUITABLE 判断，**When** 判断保存，**Then** 系统可追问一个问题以了解是什么让这个岗位不同。
3. **Given** 用户最近对类似岗位回答过类似问题，**When** 他们做出新判断，**Then** 系统不应再次追问（信息增益低）。
4. **Given** AI 追问生成失败，**When** 判断保存，**Then** 判断成功完成不被阻塞——追问被跳过，失败被记录。
5. **Given** 用户对追问点击"跳过"，**When** 判断继续，**Then** judgmentReason 记录 source=SKIPPED，判断完成。

---

### User Story 13 - 偏好学习 (Priority: P2)

用户判断输入三层偏好模型：JobJudgment → PreferenceSignal → PreferenceRule。单次判断产生信号；重复稳定的信号可成为规则。高影响规则需要用户确认。

**Why this priority**：偏好学习是系统随时间改进的机制。没有它，v0.9 就退化为无用户品味记忆的每日搜索工具。

**Independent Test**：可通过以下方式测试：创建一系列判断，验证 PreferenceSignal 被提取，并确认满足信号阈值时生成 PreferenceRule 提案。

**Acceptance Scenarios**：

1. **Given** 一个 VERY_UNSUITABLE 判断，理由为"外包驻场"，**When** 判断保存，**Then** 创建 PreferenceSignal，feature_key=outsourcing、direction=negative、strength=strong、source=USER_SELECTED（不是 AI_EXTRACTED）。
2. **Given** 至少 2 个独立岗位在同一特征上产生强负向信号，或 3 个独立岗位产生中等负向信号，**When** 规则提案阈值满足，**Then** 生成 PreferenceRule 提案，type=SUPPRESS、effect=suppression、activation_mode=PROPOSED（用户确认后才激活）。
3. **Given** 一个拟屏蔽城市、屏蔽行业、改变主岗位方向、改变最低薪资、将技术栈变为硬排除或全局屏蔽某类公司的 PreferenceRule 提案，**When** 提案生成，**Then** 它被标记为 HIGH_IMPACT 且不能自动激活——需要用户明确确认。
4. **Given** 用户删除一条历史判断，**When** 删除操作被处理，**Then** 关联的 PreferenceSignal 失效，派生的 PreferenceRule 重新计算。
5. **Given** 一条针对正向特征的 type=RANK_BOOST PreferenceRule，**When** 未来推荐生成，**Then** 匹配该特征的候选人获得排序提升和解释（"命中偏好: 中小自研团队"）。
6. **Given** 一条针对负向特征的 type=SUPPRESS PreferenceRule，**When** 未来推荐生成，**Then** 匹配的候选人被抑制（降权或排除）。

---

### User Story 14 - 减少重复错误 (Priority: P2)

当用户持续拒绝某种岗位模式后，未来轮次应抑制类似岗位，或在重新推荐时解释显著的新差异。

**Why this priority**：反复向用户展示他们已拒绝的岗位是破坏系统信任的最快方式。这是核心体验质量特性。

**Independent Test**：可通过以下方式测试：创建一条活跃的负面 PreferenceRule，对包含匹配该规则岗位的池子生成新推荐，验证这些岗位要么被抑制，要么带有明确的差异解释。

**Acceptance Scenarios**：

1. **Given** 一条活跃的 SUPPRESS PreferenceRule（针对"外包驻场"）和一个匹配此模式且无显著新差异的新岗位，**When** 推荐运行，**Then** 该岗位被抑制（不在 0-8 批次中展示）。
2. **Given** 一条活跃的 SUPPRESS PreferenceRule（针对"外包驻场"）和一个匹配此模式但有显著新正面特征的岗位（例如"虽然是驻场但属于核心产品团队"），**When** 推荐运行，**Then** 该岗位可以出现，但必须带有对新差异的明确解释。
3. **Given** 连续轮次中用户将同一模式标记为错误，**When** 测量 Repeated Mistake Rate，**Then** 应低于 5%（命中活跃负面偏好且无显著新差异的岗位应极少进入推荐）。
4. **Given** 用户连续两次将某模式标记为错误，**When** 同一模式第三次出现，**Then** 它必须被抑制，除非能提供明确的新差异解释。

---

### User Story 15 - 正向偏好增强 (Priority: P3)

当用户反复将某些岗位特征标记为 VERY_SUITABLE 后，系统对类似岗位提升排序、扩展搜索关键词并解释偏好命中——但不将推荐范围收缩到仅限于这些模式。

**Why this priority**：正向偏好是负向抑制的自然补充，但首要痛点（重复收到差推荐）更为紧迫。P3 反映负向反馈保护优先。

**Independent Test**：可通过以下方式测试：创建正向 PreferenceRule，对混合池子运行推荐，验证匹配的候选人获得排序提升和搜索扩展建议。

**Acceptance Scenarios**：

1. **Given** 活跃的正向 PreferenceRule 覆盖"前端主导 + Node BFF + AI产品落地 + 中小自研团队"，**When** 推荐生成，**Then** 匹配这些模式的候选人获得排序提升及解释，但不具有这些模式的候选人不被排除。
2. **Given** 稳定的正向 PreferenceRule，**When** 系统处理判断，**Then** 可提出 SearchExpand 关键词（例如将"全栈偏前端"作为扩展关键词添加，source=PreferenceRule 并附解释）。
3. **Given** 正向 PreferenceRule 和一个探索位（每批 0-1 个），**When** 选择探索候选人，**Then** 它仍然通过硬约束、非已投待反馈、非已忽略未变化，且有清晰的"为什么值得探索"解释。

---

### User Story 16 - 成本可见性 (Priority: P3)

用户可以看到执行了多少扫描和分析、使用了哪些模型，以及——当有可靠用量数据时——实际 token 数量和货币成本。当成本数据不可用时，如实显示"Cost unavailable"。

**Why this priority**：成本意识对长期可持续性很重要，但不是 v0.9 上线的阻塞项。用户首先需要每日流水线运转；成本监控用于后续优化。

**Independent Test**：可通过以下方式测试：运行一次执行 AI 分析的 SourceRun，然后在 DailyJobBrief 和 SourceRun 详情页查看成本摘要。

**Acceptance Scenarios**：

1. **Given** 一个已完成的 SourceRun，**When** 用户查看其详情，**Then** 他们看到：scannedCount、analysisRequestedCount、analysisSucceededCount、使用的模型和请求数量。
2. **Given** AI Provider 返回可靠的 token 用量数据，**When** 成本摘要计算，**Then** 它包含实际 token 数量和基于 Provider 实际账单的人民币/美元成本。
3. **Given** AI Provider 不返回可靠的 token 用量数据，**When** 成本摘要计算，**Then** 显示"Cost unavailable"——绝不估算或伪造。
4. **Given** 一份 DailyJobBrief，**When** 用户查看它，**Then** 当日运行的成本摘要被包含且可见。

---

### 边缘情况

- **后端服务未运行**：无调度运行执行。UI 显示"OfferFlow 本地服务未运行。定时找岗不会执行。"不显示"从网页启动服务"按钮（一个已停止的进程无法通过 HTTP 启动自身）。
- **Search API 返回 BOSS/猎聘/智联等专业招聘平台岗位（Source Policy A — SEARCH_ONLY）**：保存 Search Evidence（title、snippet、url、source、domain、搜索时间），标记为 MANUAL_REVIEW_REQUIRED。**不自动 Fetch BOSS/猎聘/智联等页面**。不将 snippet 当完整 JD 处理。允许用户点击原岗位链接打开确认。用户可通过 Manual Capture 将 SEARCH_EVIDENCE 升级为 FULL_EVIDENCE 后进入正式 MatchAnalysis。
- **Search API 返回公司官网/公开 ATS 岗位（Source Policy B — SEARCH_AND_FETCH）**：在满足公开可访问、robots/Terms 允许、有限频率、只读、无需绕登录/CAPTCHA 等前提后，可自动 Fetch 并结构化岗位事实。岗位先经 Initial Discovery Ingestion 落为 SEARCH_EVIDENCE 的 CandidateVersion（Content Acquisition 本身不写 DB、不产生 FULL_EVIDENCE）；随后 Content Acquisition 的 Fetch 结果经 JD 完整性/证据验证，仅当验证通过并经显式 evidence_upgrade 后才创建新的 FULL_EVIDENCE 的 CandidateVersion（升级是版本事件，不原地覆写原 SEARCH_EVIDENCE 版本），进而 Analysis eligible。Fetch 成功本身不等于 FULL_EVIDENCE。
- **Search API 返回来源未知网站（普通 public domain）**：走 Policy B（SEARCH_AND_FETCH）受控 fetch——保留 Search Evidence 落为 SEARCH_EVIDENCE，允许有限自动 Fetch，但仍须经 JD 完整性验证 + 显式 evidence_upgrade 才产生 FULL_EVIDENCE；Fetch 失败或验证不通过则保留 SEARCH_EVIDENCE / 标记 MANUAL_REVIEW_REQUIRED，不伪装成 FULL_EVIDENCE。CONDITIONAL_FETCH（如 juejin.cn）仍默认不 Fetch。
- **Search Evidence 很匹配但信息不足**：保留 Candidate + SEARCH_EVIDENCE。标记 MANUAL_REVIEW_REQUIRED 并提示用户"打开原岗位确认"。**不得丢弃**。
- **Search API 搜到同一岗位多个来源**：进入现有 Radar Identity / Relation 机制。不因为来源不同建立 Shadow Candidate。
- **Content Acquisition 阶段遭遇验证码/安全验证**：Provider 记录明确的 CAPTCHA_DETECTED / SECURITY_CHECK_REQUIRED 错误码。不绕过验证。不无限重试。SourceRun 转为 WAITING_FOR_USER。注意：Open Web Search Provider（Search Discovery 阶段）本身不触发验证码——此场景适用于 Content Acquisition 阶段对 Policy B/C 来源做 Fetch 时遭遇防护。专业招聘平台（BOSS等）不通过 Crawler 做 Content Acquisition，此类风险主要存在于 Browser Manual Capture 场景（由用户人工完成验证后继续）。
- **Search Provider 对所有任务组合返回零结果**：仅当 API 请求成功 + 响应结构有效 + 实际返回空结果列表时，才属于 valid empty result。覆盖报告显示 scanned=0。DailyBrief 以 emptyReason="所有搜索范围均未返回职位列表"生成。以下均不得记为"今天没有岗位"：API Key 无效、HTTP error、rate limit、timeout、response malformed、provider unavailable——这些必须进入 Coverage Gap / FAILED / ACTION_REQUIRED 中的适当状态。
- **多个关键词命中同一外部岗位**：该岗位的 Candidate 只创建一次（通过规范化来源 URL 身份）。SourceRecord 和 CandidateVersion 反映一个岗位，而非重复项。Snapshot 记录哪些关键词命中。无重复分析或通知。
- **服务进程在 SourceRun 中途崩溃**：重启时，中断的运行被标记为 INTERRUPTED。可创建新的 RETRY SourceRun。由于摄入和分析均幂等，不创建重复事实。
- **SMTP 服务器返回临时失败**：Outbox 条目转为 FAILED_RETRYABLE 并进行有限退避。SourceRun、Candidate、Analysis、RecommendationBatch 和 DailyJobBrief 不回滚。
- **SMTP 授权失效**：Outbox 条目转为 ACTION_REQUIRED 并附解释。不无限重试。
- **用户判断了所有候选人后又修改了其中一条**：旧判断记录被取代（不物理删除）。旧 PreferenceSignal 失效。派生的 PreferenceRule 重新计算。
- **每日推荐数为 0 但邮件已发送**：空汇报邮件正确描述覆盖情况并解释为什么没有候选人被推荐。
- **计划版本在一天中途变更**：旧计划版本的 SourceRun（已执行）继续引用旧版本。新版本下的新运行重新开始。
- **手动触发与调度运行并发**：以明确消息拒绝——每个计划同时最多一个活跃运行。
- **用户 QQ 邮箱已满或拒收邮件**：Outbox 记录 FAILED_FINAL 及 SMTP 错误。DailyBrief 和 Judgment 数据不受影响。
- **岗位在发现后被来源删除**：该岗位已有的 CandidateVersion 和分析保留在 OfferFlow 中。未来重新检查可能检测到岗位不可用，但这记录在 SourceRecord 元数据中——Candidate 不被删除。
- **Content Acquisition 命中爬虫防护或频率限制**：Provider 记录明确的 RATE_LIMITED 错误码。不绕过防护，进入有限退避。连续触发时 SourceRun 转为 WAITING_FOR_USER。
- **OpenWebJobProvider 检测到内容不是招聘信息**：匹配结果标记为 low_confidence 或 false_positive。不强行创建 Candidate。SourceRun coverage 中记录 matched_but_rejected 计数。
- **公司官网招聘页面结构发生实质性变化**：与专业招聘平台的 DOM 变化类似——解析失败显式标记为 PROVIDER_STRUCTURE_CHANGED，不静默返回 0 结果。已成功解析的岗位不受影响。

## 需求 *(必填)*

### 功能性需求

#### 计划与调度

- **FR-001**：系统必须允许用户创建和管理 DailySearchPlan，包含：cities（含优先级）、roleDirections、baseKeywords、expandedKeywords（系统建议、用户可批准）、hardConstraints（薪资、经验、学历、公司类型排除项）、sourceConfigs、schedule（每日运行时间）、latestCatchUpTime、scanBudget、analysisBudget、briefPolicy、notificationPolicy 和 explorationPolicy。
- **FR-002**：系统必须在每次计划变更时创建不可变的 DailySearchPlanVersion。所有 SourceRun 必须引用执行时活跃的特定 PlanVersion。
- **FR-003**：系统必须支持四种 SourceRun 触发类型：SCHEDULED、CATCH_UP、MANUAL 和 RETRY。
- **FR-004**：系统必须从现有 OfferFlow Fastify 后端进程运行调度任务——而非从浏览器页面定时器或独立微服务。
- **FR-005**：系统必须在服务启动时检测错过的调度，并在 latestCatchUpTime 范围内为每个 PlanVersion 每个自然日创建最多一次 CATCH_UP 运行。
- **FR-006**：系统必须支持计划的暂停/恢复（暂停的计划不自动调度）和 Skip Today（用户明确跳过当天的调度）。
- **FR-007**：系统必须防止同一计划的并发活跃运行（同一计划同时最多一个 pending/running SourceRun）。
- **FR-008**：RETRY 运行必须创建新的 SourceRun（不原地覆盖失败运行的状态）。

#### 主动发现

- **FR-009**：系统必须支持 P0 Active Search Provider = Open Web Search Provider。P0 Vendor = Tavily Search API（Pre-validation 结果：TAVILY_PASS；Brave Search API 因持久化权限在基础计划不授予而 FAIL；Google Programmable Search 为 Secondary Candidate；Bing Search API 为 REJECTED_NOT_AVAILABLE——API 已退役）。Tavily Search 配置：`search_depth=basic`（1 credit/search）、`country=china`、`topic=general`、`include_answer=false`、`include_raw_content=false`。认证方式为 Bearer Token API Key（不进 Git、不进日志、使用 Secret 管理；无效 Key 必须显式失败）。P0 只用 Tavily Search endpoint——Tavily Crawl/Extract/Map 不在 P0 范围（Content Acquisition 由 Source Policy 决定）。Tavily Free tier：1,000 次/月免费、无需信用卡（足以支持 v0.9 P0 Daily Search Plan，预计 ~720 次/月）。扩展路径：Project $25/mo 年付（4,000 次/月）。付费扩展不绑定 Tavily DTO——Search Evidence 模型基于 Tavily/Brave 共同最小语义设计，Provider 可替换。Tavily 的 human oversight ToS 要求天然满足（OfferFlow AI 做发现+分析，用户做最终判断，不产生自动化就业决策）。搜索结果持久化权利已确认（Tavily Platform Terms 不禁止本地持久化 Output，官方 SDK 内置本地数据库存储功能）。
- **FR-010**：SearchProviderAdapter 必须返回 SearchResult 条目，包含：Provider 身份、Source Policy（SEARCH_ONLY/SEARCH_AND_FETCH/CONDITIONAL_FETCH）、Search Evidence（title、snippet、url、domain、source、publishedAt 如存在、search score/rank 如存在）、采集时间戳和抓取元数据——而非 Candidate 领域实体。Search Provider 的职责只是搜索、发现 URL、返回 Search Evidence。Content Acquisition 是后续独立能力。
- **FR-011**：系统必须将所有 SearchResult 条目通过共享的 RadarIngestionService 进入，该服务处理：快照创建、身份识别（规范化 URL）、指纹计算、实质性变化检测、Candidate/CandidateVersion 创建和 SourceRecord 管理——无论来源是主动搜索还是浏览器采集。
- **FR-012**：系统必须允许主动搜索来源的 Snapshot 的 captureSessionId 为 null，无需创建第二种 Snapshot 变体或表。
- **FR-013**：浏览器扩展必须仅作为 Manual Capture Source——不得通过添加后台扫描能力将其扩展为 Active SearchProvider。专业招聘平台（BOSS直聘、拉勾、猎聘、智联招聘、前程无忧等）禁止作为网页爬虫或浏览器自动化 Content Acquisition 目标。这些平台仅通过以下链进入系统：Search Discovery（Open Web Search Provider 发现 → 保存 Search Evidence + URL）→ 用户人工浏览 → Browser Manual Capture → Radar（FULL_EVIDENCE）。
- **FR-013a**：Content Acquisition（自动 Fetch 岗位内容）仅允许用于 Policy B（SEARCH_AND_FETCH）来源：公司官方招聘网站（公开 careers 页面/ATS）、公开技术社区（GitHub、掘金、开源社区招聘板块、公开 Issue/Discussion/Post 中的招聘内容）及其他允许公开读取的 Open Web 招聘来源。必须满足以下所有前提：公开可访问、网站规则允许、robots/Terms/usage policy 允许、有限频率、有限 Scan Budget、只读、无需绕登录、无需绕 CAPTCHA。Policy C（CONDITIONAL_FETCH）来源无法确认 Fetch 权限时默认不自动 Fetch。
- **FR-013b**：如果未来某专业招聘平台提供明确授权的官方 API（不是网页爬虫），可作为独立 Provider Proposal 重新评估，通过特定的 Api Provider 接入。API 接入不属于网页爬虫。但 v0.9 P0 不依赖此假设——当前专业招聘平台的所有入口均为 Search Discovery + Manual Capture。

#### 覆盖与汇报

- **FR-014**：每个 SourceRun 必须产生包含以下内容的覆盖报告：plannedTasks、completedTasks、failedTasks、scannedCount、ingestedCount、newCandidateCount、materialChangeCount、duplicateCount、conflictCount、blockedCount、analysisRequestedCount、analysisSucceededCount、recommendationCount、alertCount、failedScopes（含每个范围的错误码）和来源特定元数据。
- **FR-015**：来源失败（登录过期、验证码、网络错误、解析失败）必须产生明确的、可区分的错误码——绝不合并为"0 结果"或"今天没有岗位"。

#### 分析与推荐复用

- **FR-016**：系统必须复用现有 v0.8 的 analysis_tasks 和 job_match_analysis_records 表进行所有岗位分析。不得创建新的分析任务变体（如"search_analysis_task"）。
- **FR-017**：系统必须复用现有 v0.8 的 radar_recommendation_batches 表进行所有每日推荐。
- **FR-018**：每个 RadarRecommendationBatch 必须包含 0-8 条。0 是可接受且有效的数量。
- **FR-019**：推荐不得使用 stale 分析。v0.8 的硬约束、忽略和已投待反馈抑制继续适用。
- **FR-020**：系统必须支持每批 0-1 个探索位，用于满足以下条件的候选人：通过硬约束、非已投待反馈、非已忽略未变化，且包含明确的"为什么值得探索"解释。

#### 偏好感知推荐

- **FR-021**：系统必须将活跃 PreferenceRule 应用于推荐流水线：正向规则提供排序提升、搜索扩展和解释；负向规则提供排序降权、抑制和解释。
- **FR-022**：基于偏好的效果不得覆盖硬约束、已投待反馈状态、明确忽略或数据质量阻断。

#### DailyJobBrief

- **FR-023**：系统必须为每次每日流水线运行创建恰好一个 DailyJobBrief，通过外键（recommendationBatchId）引用 RecommendationBatch，不将候选人 ID 复制到自己的 JSON 列中。
- **FR-024**：DailyJobBrief 状态必须按以下顺序推进：GENERATING → READY → IN_REVIEW → COMPLETED（或在不可恢复错误时 FAILED）。
- **FR-025**：DailyJobBrief 必须包含：coverageSummary、costSummary、邮件投递状态和审批进度。当为空时（0 条推荐），emptyReason 必须解释原因。

#### QQ 邮箱与通知

- **FR-026**：系统必须支持 QQ SMTP 作为 P0 邮件渠道，包含：sender、recipient、smtpHost、smtpPort、TLS、secretRef（授权码加密存储，不入 Git、日志和普通数据库备份）。
- **FR-027**：系统必须支持五种通知类型：HIGH_PRIORITY_ALERT、DAILY_BRIEF、RUN_FAILED、ACTION_REQUIRED 和 TEST_EMAIL。
- **FR-028**：所有邮件发送流程必须经过 NotificationOutbox：业务事件 → INSERT Outbox → Worker Claim → SMTP → SENT。临时失败进入 FAILED_RETRYABLE 并进行有限退避。永久失败进入 FAILED_FINAL。授权失败进入 ACTION_REQUIRED。
- **FR-029**：邮件投递失败不得回滚 SourceRun、Candidate、Analysis、RecommendationBatch、DailyJobBrief 或 JobJudgment。
- **FR-030**：系统必须对通知强制执行幂等：即时提醒使用 (candidateVersionId + notificationType + recipient + notificationRuleVersion)；日报使用 (dailyBriefId + recipient + templateVersion)。重复的幂等键不得创建重复投递。
- **FR-031**：高优先级提醒邮件必须包含：岗位名称、公司、城市、薪资、发现日期、2-3 个核心理由、主要风险、最大不确定性、命中的正向偏好、原岗位链接，以及"正式审批请回到电脑端"的提示。
- **FR-032**：日报邮件必须包含：覆盖摘要、推荐列表（或诚实的空汇报及解释）、审批状态和成本摘要。
- **FR-033**：邮件不得包含：简历全文、API key、token、调试日志或岗位页面的原始 HTML 注入。仅允许经过验证的 HTTP/HTTPS URL 作为链接。邮件链接不得提供本地高风险写操作。

#### 四档判断

- **FR-034**：系统必须支持四个判断档位：VERY_SUITABLE、SOMEWHAT_SUITABLE、NOT_VERY_SUITABLE、VERY_UNSUITABLE。
- **FR-035**：JobJudgment 必须绑定：dailyBriefId、radarCandidateId、candidateVersionId、matchAnalysisId、judgment、systemRecommendation（原始，不二次映射）和 systemConfidence。
- **FR-036**：系统不得将四档判断等同于：收藏、已投递状态、Application 实体、客观招聘反馈或能力事实。
- **FR-037**：修改判断必须：取代旧判断（不物理删除）、使旧 PreferenceSignal 失效、触发 PreferenceRule 重新计算。
- **FR-038**：审批进度必须通过以下方式派生：(RecommendationBatch 条目) - (已有有效 JobJudgment 的条目)，使得页面刷新或服务重启后能自然恢复，无需"当前索引"字段。

#### 理由追问

- **FR-039**：系统可在以下情况提出追问：VERY_SUITABLE 且原因未知、VERY_UNSUITABLE 且原因未知、用户判断与系统建议冲突、当前判断与相似岗位历史冲突、或出现新的强偏好特征。
- **FR-040**：系统不得在以下情况提出追问：已有 PreferenceRule 足够解释该判断、最近对相似岗位已回答过、信息增益低、用户明确跳过、用户开启快速审批模式、或 AI 不确定该问什么。
- **FR-041**：每个岗位最多允许一个自动生成的追问。问题必须：针对具体 JD、提供 2-4 个选项外加"其他"和"跳过"、不诱导答案。
- **FR-042**：AI 追问生成失败不得阻塞判断完成。

#### 偏好记忆

- **FR-043**：系统必须实现三层偏好模型：JobJudgment → PreferenceSignal → PreferenceRule。单次判断仅产生信号。稳定规则需要至少：2 个独立岗位产生强同向信号，或 3 个独立岗位产生中等同向信号，或用户明确确认。
- **FR-044**：PreferenceRule 激活模式必须区分：EXPLICIT_CONFIRM（用户已确认）、THRESHOLD_AUTO（达到信号阈值，自动活跃）和 PROPOSED（等待用户审查）。
- **FR-045**：HIGH_IMPACT 规则（屏蔽城市、屏蔽行业、改变主岗位方向、改变最低薪资、将技术栈变为硬排除、全局屏蔽某类公司）必须要求 EXPLICIT_CONFIRM——绝不自激活。
- **FR-046**：系统必须将用户原始理由（source=USER_SELECTED、USER_TEXT）与 AI 派生结论（source=AI_EXTRACTED）分开保存。AI_EXTRACTED 不得作为用户原话呈现。
- **FR-047**：PreferenceRule 必须：可停用、可删除、可追溯到来源 Judgment。删除/撤销 Judgment 必须使派生的 Signal 失效并重新计算 Rule。
- **FR-048**：偏好评估结果必须输入现有 RadarRuleAssessment 表（category='preference'），而非单独的"preference_assessments"表。
- **FR-049**：单次判断不得创建永久硬排除。正向规则主要用于排序提升。负向规则区分"降权"和"抑制"。必须保留探索位以防止反馈闭环收窄。

#### 成本可见性

- **FR-050**：每个 SourceRun 必须记录：scannedCount、analysisRequestedCount、analysisSucceededCount、使用的模型和请求数量。
- **FR-051**：当有可靠的 Provider 用量数据时，成本摘要必须包含 token 数量和实际货币成本。不可用时，必须显示"Cost unavailable"——绝不估算或伪造。

#### 幂等与可靠性

- **FR-052**：Radar Ingestion 必须幂等：重放相同的 SearchResult 产生相同的 Candidate 和 CandidateVersion（无重复）。
- **FR-053**：分析任务创建必须幂等：相同的冻结输入快照产生相同的分析任务（无重复分析）。
- **FR-054**：推荐批次创建必须幂等：相同规则下的相同已分析池子产生相同的推荐批次。
- **FR-055**：Notification Outbox 必须强制执行幂等键以防止重复邮件投递。
- **FR-056**：服务重启恢复必须：检查错过调度、符合条件的创建 CATCH_UP、将中断的 SourceRun 标记为 INTERRUPTED、允许创建 RETRY、恢复 Outbox 处理、处理长时间 SENDING 的租约过期、保留已有 DailyBrief 和 Judgment、且不自动创建重复的 CandidateVersion、分析、推荐或邮件。

#### 安全与平台边界

- **FR-057**：系统不得：自动投递、自动打招呼、自动上传简历、自动添加 HR、绕过验证码、绕过登录校验、绕过平台频率限制、或读取/存储用户密码。
- **FR-058**：系统不得将 OfferFlow 暴露到公网。
- **FR-059**：SearchProvider 必须在请求之间实现频率限制。外部岗位页面必须视为不可信输入。
- **FR-060**：SMTP 授权码必须加密存储，不入 Git、不入明文日志、不入普通数据库备份，API 响应不得返回明文 Secret。

#### Source Policy 与 Evidence Model（v0.9 Spec Amendment 新增）

- **FR-061**：系统必须实现 Source Policy 机制，在 Search Discovery 之后、Content Acquisition 之前决定对某个来源可以自动做到哪一步。Source Policy 至少包含三种能力级别：Policy A（SEARCH_ONLY——仅搜索发现，不自动 Fetch）、Policy B（SEARCH_AND_FETCH——搜索 + 公开内容自动 Fetch）、Policy C（CONDITIONAL_FETCH——根据来源规则决定是否 Fetch，默认不 Fetch）。
- **FR-062**：Policy A（SEARCH_ONLY）必须应用于专业招聘平台（BOSS直聘、猎聘、智联、拉勾、前程无忧等）。允许：保存 Search Evidence（title、snippet、url、source、domain、搜索时间）、显示 URL、用户人工访问 → Manual Capture。禁止：自动 Fetch 完整 JD、后台批量抓岗位页面、自动翻页、模拟用户点击、使用登录 Session 批量发现、绕 CAPTCHA/风控、无限重试。
- **FR-063**：系统禁止在 Search Provider 层建立 zhipin.com、liepin.com、zhaopin.com、lagou.com、51job.com 等专业招聘平台域名的硬 denylist。Search Discovery 的结果不得因为来源是专业招聘平台而直接丢弃——仅根据 Source Policy 决定后续 Content Acquisition 行为。
- **FR-064**：Policy B（SEARCH_AND_FETCH）可应用于公司官网 careers、公开 ATS、GitHub、允许自动读取的 Open Web 招聘来源，以及**普通 unknown public domain**（无法判明为专业招聘平台、也非 CONDITIONAL_FETCH 明确清单的来源）。前提必须满足：公开可访问、网站规则允许（robots/Terms/usage policy）、有限频率、有限 Scan Budget（默认每 run 最多 50 条自动 Content Acquisition，超过预算的 item 保留 discovery/manual-review，不算 failure）、只读、无需绕登录、无需绕 CAPTCHA。
- **FR-065**：Policy C（CONDITIONAL_FETCH）必须用于无法确认 Fetch 权限的来源（技术论坛、社区、博客等，如 juejin.cn）。默认行为是不自动 Fetch，保留 Search Evidence。仅在后续 Source Policy Decision 明确允许后才可 Fetch。
- **FR-065a**：unknown public domain 的受控 fetch 不改变证据安全边界——fetch success ≠ FULL_EVIDENCE，validation PASS ≠ 自动字段覆写，FULL_EVIDENCE 只能由 EvidenceUpgradeService 在 validation PASS 后显式产生。登录墙 / CAPTCHA / 401 / 403 / SSRF / 需要 Cookie/Auth / ContentFetcher 拒绝 / validation FAIL 一律 fail closed，回到 discovery / manual-review，不得伪造成 FULL_EVIDENCE。
- **FR-065b**：cross-source enrichment 必须 identity-safe。只有能证明 public alternative 与原招聘平台 item 是「同一公司 / 同一岗位」时才允许 fetch alternative 并升级证据。缺结构化 company identity → 不做 enrichment（保持 MANUAL_REVIEW_REQUIRED）；禁止 role-only 查询猜测替代来源；禁止引入 LLM 猜测公司；public alternative 必须非招聘平台、非原 URL、company 与原 item 一致、role/title 合理匹配。enrichment 有预算（默认每 run 最多 20 个原始招聘平台 item），禁止 enrichment → enrichment 递归。
- **FR-066**：系统必须区分三种 Evidence Level：SEARCH_EVIDENCE（只有搜索结果 title/snippet/url/source/domain/搜索时间，不可用于正式 MatchAnalysis）、FULL_EVIDENCE（完整岗位事实，可用于 MatchAnalysis/Recommendation reasoning）、MANUAL_REVIEW_REQUIRED（Search Evidence 值得查看但来源禁止自动 Fetch，提示用户打开原岗位确认，不得丢弃）。
- **FR-067**：DailyJobBrief 必须能够同时呈现不同 Evidence Level 的岗位（FULL_EVIDENCE → 已做正式分析；SEARCH_EVIDENCE → 搜索发现，有限初筛；MANUAL_REVIEW_REQUIRED → 值得查看，需用户打开原站确认）。
- **FR-068**：Search Provider 的职责仅限于搜索、发现 URL、返回 Search Evidence——不得定义为万能 Search + Crawl + Parse Provider。Content Acquisition 是后续独立能力，由 Source Policy 和 Content Fetcher（非 Search Provider）负责。这保证未来 Tavily、Brave 或其他 Search API 均可替换而不改变来源 Fetch Policy。
- **FR-069**：系统不得将 Company Career Provider（公司官网监控）设为 Active Discovery 的主入口——因为产品不能要求用户先维护 5～10 家目标公司名单才能主动找岗位。用户只需维护城市、岗位方向、关键词和基础过滤条件。OfferFlow 自己发现"哪个公司正在招"。Company Career 降级为 Follow-up Provider / Deep Source（未来由 Open Web Search 发现某公司 Careers → Source Quality 高 → Follow）。
- **FR-070**：系统必须保留现有 Browser Manual Capture 能力，不删除、不弱化。Browser Manual Capture 现在承担将 SEARCH_ONLY 来源（专业招聘平台）从 SEARCH_EVIDENCE 升级为 FULL_EVIDENCE 的关键角色（Search API → 发现 BOSS 岗位 → SEARCH_EVIDENCE → 用户打开 BOSS → Manual Capture → FULL_EVIDENCE → Radar/MatchAnalysis）。Browser Capture 不得被改造成自动招聘平台爬虫。
- **FR-071**：P0 Open Web Search Provider 的具体 Vendor 当前为 NEEDS CLARIFICATION。候选包括 Tavily、Brave Search API、Bing、Google 及其他正式 Search API。下一次 Provider 选择的验收标准顺序冻结为：（1）苏州/无锡/上海/杭州真实岗位发现能力 →（2）前端/AI应用/Full-stack 技术岗位相关性 →（3）全网覆盖能力 →（4）能否发现专业招聘平台岗位链接 →（5）能否发现公司官网/GitHub/Open Web 岗位 →（6）Search result 质量 →（7）时效性 →（8）API 稳定性 →（9）合规与使用边界 →（10）成本 →（11）API/SDK 易用程度。必须首先拿真实查询做 Pre-validation 才允许进入正式 Provider Implementation。

#### Data Quality Gate（保持，补充 Evidence 上下文）

- **FR-072**：Data Quality Gate 继续保留：Discovery eligible ≠ Analysis eligible。SEARCH_EVIDENCE 岗位（如 BOSS 搜索结果 title + snippet + URL）可以 Discovery Eligible = YES，但 Analysis Eligible = NO——这完全正常。AI 不得根据 snippet 编造完整 JD。只有当 Source Policy 允许 Auto Fetch 且 Content Acquisition 成功并通过 JD 完整性验证（经显式 evidence_upgrade），或用户完成 Manual Capture 后，岗位才获得 FULL_EVIDENCE 并可进入正式 MatchAnalysis。

### 关键实体

- **DailySearchPlan**：用户的找岗配置——城市、岗位方向、关键词、约束、来源配置、调度、预算、通知策略。拥有不可变的 DailySearchPlanVersion。
- **DailySearchPlanVersion**：计划配置在某一时点的不可变快照。每个 SourceRun 引用一个特定版本。
- **SourceRun**：一次发现流水线的执行——触发类型（SCHEDULED/CATCH_UP/MANUAL/RETRY）、状态、阶段、覆盖计数、成本摘要、错误。引用一个 PlanVersion。
- **SearchProviderAdapter**：主动岗位来源的接口。P0 = Open Web Search Provider = Tavily Search API（search endpoint only，`search_depth=basic`、`country=china`；Tavily Crawl/Extract/Map 不在 P0 范围）。返回 SearchResult 条目（Search Evidence：title、url、content/snippet、score、domain/source），但不拥有 Candidate 语义。不负责 Content Acquisition。Provider 产品级分类：OpenWebSearchProvider（全网搜索，P0 = Tavily）、CompanyCareerProvider（公司官网/公开 ATS，Follow-up）、OpenWebJobProvider（GitHub/掘金/技术社区/公开招聘内容，Later）。Jooble REST API 状态为 REJECTED_AFTER_PREVALIDATION（Product Suitability Failure）。Brave Search API 状态为 BRAVE_FAIL（基础计划无存储权，Enterprise 需自定义定价）。专业招聘平台的 Search Discovery 是合法且期望的，但 Content Acquisition 受 Policy A（SEARCH_ONLY）限制。
- **SearchResult**：来自 SearchProvider 的原始输出——Search Evidence 的容器（不假定包含完整 JD 文本）。后续由 Source Policy 决定是否可以进入 Content Acquisition。
- **SourcePolicy**：产品级策略，决定某个 Search Result 被发现后可以对这个来源自动做到哪一步。三种级别：SEARCH_ONLY（仅搜索发现）、SEARCH_AND_FETCH（搜索 + 公开内容 Fetch）、CONDITIONAL_FETCH（根据规则决定）。
- **RadarIngestionService**：将来自主动搜索（Content Acquisition 成功后）和浏览器采集两方面的岗位摄入现有 Radar 领域链的共享服务。SEARCH_EVIDENCE 岗位在升级为 FULL_EVIDENCE 之前不进入正式 Analysis。
- **DailyJobBrief**：每日执行结果、覆盖、推荐引用、邮件状态和审批进度的容器。引用（不复制）RecommendationBatch。
- **JobJudgment**：用户对推荐岗位的四档评估——绑定 CandidateVersion、MatchAnalysis、DailyBrief 和原始系统建议。
- **JudgmentReason**：用户对判断的陈述理由——明确标记为 USER_SELECTED、USER_TEXT 或 AI_EXTRACTED。AI 派生理由不得与用户陈述混淆。
- **PreferenceSignal**：从一次 JobJudgment 派生的一条偏好证据——特征键、方向（正向/负向）、强度、置信度。
- **PreferenceRule**：从重复信号或用户确认派生的稳定偏好——类型（RANK_BOOST、RANK_PENALTY、SUPPRESS、SEARCH_EXPAND）、效果、状态、激活模式。
- **NotificationChannel**：邮件配置——QQ SMTP 设置、Secret 引用、启用的通知类型、静默时段。
- **NotificationOutbox**：邮件投递的持久化发件箱——幂等键、状态（PENDING→SCHEDULED→SENDING→SENT 或失败状态）、尝试次数、重试计划。

## 成功标准 *(必填)*

### 可测量结果

- **SC-001**：系统连续至少 3 个自然日真实运行 P0 Open Web Search Provider，Scheduler 自动触发、Provider 返回真实岗位搜索结果、搜索结果进入统一 Radar Ingestion（SEARCH_EVIDENCE 岗位保存为 Discovery Candidate；FULL_EVIDENCE 岗位进入正式 CandidateVersion 事实链）、重复岗位不重复创建 Candidate、岗位变化进入 CandidateVersion 事实链、Provider 失败不伪装 0 岗位、Coverage 完整可追踪、至少形成一次真实 MatchAnalysis（来自 FULL_EVIDENCE 岗位）、一次真实 RecommendationBatch、一次真实 DailyJobBrief（可包含混合 Evidence Level）。
- **SC-002**：每日推荐岗位审查的中位时间不超过 15 分钟。
- **SC-003**：无追问判断平均每个岗位不超过 3 秒。
- **SC-004**：平均自动追问次数保持在每个岗位 0.35 次或以下。
- **SC-005**：Repeated Mistake Rate（命中活跃负面偏好且无显著新差异仍进入推荐的岗位）低于 5%。
- **SC-006**：CandidateVersion 通知重复率为 0（同一版本绝不因同一类型+收件人被通知两次）。
- **SC-007**：DailyBrief 邮件重复率为 0（同一 Brief 绝不发送两次）。
- **SC-008**：正常 SMTP 条件下，≥99% 的成功 Outbox 条目到达 SENT。
- **SC-009**：临时 SMTP 错误下，≥95% 的可重试 Outbox 条目最终恢复并到达 SENT。
- **SC-010**：授权错误在单次失败内进入 ACTION_REQUIRED（无重试循环）。
- **SC-011**：浏览器页面打开不是调度流水线执行的前提条件。
- **SC-012**：来源失败被明确报告——绝不伪装为"今天没有岗位"。
- **SC-013**：每个 SourceRun 的成本数据可见：扫描数量、分析数量、模型使用情况，以及在可获得时显示 token 数量和实际成本，不可获得时显示"Cost unavailable"。

## 假设

- 现有 OfferFlow Fastify 后端可以在不改变架构的情况下承载 Scheduler、Discovery Pipeline、Notification Outbox Worker 和 SMTP Sender。
- 现有 v0.8 Radar 领域（CaptureSnapshot、SourceRecord、Candidate、CandidateVersion、AnalysisTask、MatchAnalysisRecord、RecommendationBatch、RadarAction、RadarPromotion、RadarRuleAssessment）是稳定的，v0.9 不会对其进行重构。
- 用户电脑将 OfferFlow 后端服务作为长期进程运行（Windows 支持操作系统自启动）。
- QQ SMTP 可用，用户能够获取 SMTP 授权码。
- v0.8 已在 RadarRuleAssessment.category 枚举中预留 'preference' 类别，可以无需 schema migration 即可激活，或为 'preference' 类别做最小 migration 也是可接受的。
- P0 SearchProvider 类型（Open Web Search Provider）已在 V9-0 澄清阶段冻结。P0 Vendor = Tavily Search API（Pre-validation：TAVILY_PASS）。配置：`search_depth=basic`、`country=china`、`include_answer=false`、`include_raw_content=false`。Brave Search API = BRAVE_FAIL（持久化权在基础计划不授予）。Google Programmable Search = Secondary Candidate。Bing Search API = REJECTED_NOT_AVAILABLE（API 已退役）。API Key 认证，无需用户平台登录或浏览器 Session。Tavily Free tier（1,000 次/月、无信用卡）足以支持 P0。Discovery != Content Acquisition——Tavily Search 只负责搜索发现，Tavily Crawl/Extract/Map 不在 P0 范围，Content Acquisition 由 Source Policy 决定。
- DeepSeek 仍为活跃的 AI 分析 Provider；PreferenceSignal 提取和追问生成可使用同一 Provider 或轻量模型。
- v0.9 新增表（daily_search_plans、daily_search_plan_versions、source_runs、daily_job_briefs、job_judgments、judgment_reasons、preference_signals、preference_rules、notification_channels、notification_outbox、notification_links）将通过显式的、经过测试的 migration 在新的 schema 版本（v9 或 v10）上创建，不修改 v8 表。
- 邮件内容为纯文本或安全的 HTML（无原始 JD HTML 注入）。
- 手机用户可以从邮件客户端打开标准 HTTPS 岗位 URL；不需要特殊的移动端渲染。

## 不在范围内

- 自动投递、自动打招呼、自动上传简历或自动添加 HR
- 专业招聘平台（BOSS直聘、拉勾、猎聘、智联招聘、前程无忧等）的**后台自动网页爬取**——禁止：后台批量抓岗位页面、自动翻页、使用招聘平台登录 Session 批量采集、自动绕 CAPTCHA/风控。注意：专业招聘平台的岗位链接**允许**出现在 Search Discovery 结果中，仅自动 Content Acquisition 被禁止——不得写成"BOSS/猎聘/智联等不得出现在搜索结果中"
- 绕过验证码、登录校验、安全验证或平台风控机制
- iOS App
- 手机端正式岗位审批和判断
- OfferFlow 公网暴露
- 跨设备同步
- 云端 7×24 托管
- 成熟的多平台搜索（超出单一 P0 Provider）
- 公司情报平台
- HR 联系人数据库
- 通用 Agent Runtime（LangGraph、Prime Agent、Temporal 等）
- Multi-Agent Runtime、Sub-Agent、Generic Checkpoint、Generic Resume
- 第二套 Job、第二套 Application、第二套 Candidate、第二套 CandidateVersion、第二套 Analysis、第二套 Recommendation
- NovaWing 长期人格 Memory
- 自动修改职业战略、能力基线、薪资底线
- 自动修改目标城市
- RAG、向量数据库、Embedding 基础设施
- PostgreSQL、Redis、BullMQ、微服务、Kubernetes
