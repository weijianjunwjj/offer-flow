# 规格质量检查清单：OfferFlow v0.9 — 每日岗位猎手

**用途**：在进入计划阶段之前验证规格说明书的完整性和质量
**创建日期**：2026-08-11
**最后修订**：2026-08-11（Spec Amendment v2 — Open Web Search Provider Pre-validation：Tavily PASS，Brave FAIL，Clarification 清零）
**功能**：[spec.md](../spec.md)

## 内容质量

- [x] 不包含不必要的实现细节（语言、框架、API）
- [x] 聚焦用户价值和业务需求
- [x] 面向非技术干系人可读
- [x] 所有必填章节已完成

## 需求完备性

- [x] **[RESOLVED]** 所有 NEEDS CLARIFICATION 已解决 —— P0 Open Web Search Provider vendor = Tavily Search API（Pre-validation 确认）
- [x] 需求可测试且无歧义
- [x] 成功标准可衡量
- [x] 成功标准与技术无关（不含实现细节）
- [x] 所有验收场景已定义
- [x] 边缘情况已识别
- [x] 范围边界清晰
- [x] 依赖与假设已识别

## 功能就绪度

- [x] 所有功能性需求有明确的验收标准
- [x] 用户场景覆盖主要流程
- [x] 功能满足成功标准中定义的可测量结果
- [x] 无实现细节泄露到规格说明书中

## Spec Amendment 专项检查（2026-08-11）

### Amendment v1 — Active Discovery Source Strategy（Jooble Rejection + Open Web Search）

#### Jooble 状态
- [x] Jooble 不再被写成 P0 Active SearchProvider
- [x] Jooble 已记录为 REJECTED_AFTER_PREVALIDATION（Product Suitability Failure）
- [x] Jooble 历史决策链保留（最初选择 → Pre-validation → 淘汰原因）
- [x] Jooble 淘汰不推翻 Provider-independent 架构设计

#### Open Web Search Provider
- [x] P0 Provider 类型冻结为 Open Web Search Provider
- [x] 具体 Vendor 已冻结为 Tavily Search API（Pre-validation TAVILY_PASS）
- [x] Brave Search API 记录为 BRAVE_FAIL（持久化权在基础计划不授予）
- [x] Google Programmable Search 记录为 Secondary Candidate
- [x] Bing Search API 记录为 REJECTED_NOT_AVAILABLE（API 已退役）
- [x] 专业招聘平台未被错误排除（Search Discovery 允许，仅自动 Content Acquisition 禁止）
- [x] 下次 Provider 选择的验收标准已冻结（岗位价值优先于开发容易）

#### Discovery / Acquisition 分离
- [x] Discovery != Content Acquisition 已明确写入 Spec
- [x] Tavily Search endpoint only — Crawl/Extract/Map 不在 P0 范围
- [x] Search Provider 职责限定为搜索发现（非 Crawl + Parse）

#### Source Policy
- [x] Source Policy 三种能力级别已明确（SEARCH_ONLY / SEARCH_AND_FETCH / CONDITIONAL_FETCH）
- [x] Policy A（SEARCH_ONLY）行为明确：专业招聘平台 Search Discovery = YES，Auto Fetch = NO，Manual Capture = YES
- [x] Policy B（SEARCH_AND_FETCH）行为明确：公司官网/公开 ATS/GitHub/Open Web 在满足规则时允许 Auto Fetch
- [x] Policy C（CONDITIONAL_FETCH）默认不 Fetch
- [x] 禁止在 Search Provider 层建立招聘平台域名硬 denylist

#### Evidence Model
- [x] SEARCH_EVIDENCE / FULL_EVIDENCE / MANUAL_REVIEW_REQUIRED 已定义
- [x] DailyJobBrief 允许混合 Evidence Level
- [x] Data Quality Gate 保留（Discovery eligible ≠ Analysis eligible）
- [x] AI 不得根据 snippet 编造完整 JD 的约束保持
- [x] Tavily content 字段虽比传统 snippet 丰富，但仍视为 SEARCH_EVIDENCE（不因 Tavily 做过提取就直接升级）

#### Browser Manual Capture
- [x] 保留且不弱化
- [x] 承担 SEARCH_ONLY → FULL_EVIDENCE 升级关键角色
- [x] 不改造为自动爬虫

#### Company Career Provider
- [x] 从 P0 主入口降级为 Follow-up Provider / Deep Source
- [x] v0.9 P0 不要求用户提前维护目标公司名单

### Amendment v2 — Provider Pre-validation & Vendor Decision

#### Tavily Search API
- [x] API Contract 已验证（search endpoint, country=china, search_depth=basic, include_answer=false, include_raw_content=false）
- [x] 持久化权利 CONFIRMED（ToS 不禁止本地持久化 Output，官方 SDK 内置本地数据库存储功能）
- [x] Human oversight 要求满足（OfferFlow AI 做发现+分析，用户做最终判断）
- [x] Free tier（1,000 次/月，无信用卡）足以支持 P0 Daily Search Plan
- [x] 成本扩展路径明确（Project $25/mo 年付，4,000 次/月）
- [x] 真实搜索质量验证通过（苏州/无锡/上海/杭州技术岗位均可发现）
- [x] 招聘平台发现能力验证通过（猎聘/智联等公开索引结果可发现）
- [x] 公司官网/公开 ATS 发现能力验证通过
- [x] Vendor lock-in 风险可控（Search Evidence 模型基于 Tavily/Brave 共同最小语义）

#### Brave Search API
- [x] 评估完成，结论 BRAVE_FAIL
- [x] 失败原因明确：基础 Search 计划（$5 免费额度）不授予存储权
- [x] 获取存储权需 Enterprise 自定义定价（bizdev@brave.com）
- [x] 未因搜索质量好而忽略持久化权限硬阻门
- [x] 未"偷偷存着以后再说"

#### Pre-validation Report
- [x] `search-provider-prevalidation.md` 已生成（含完整 Comparison Matrix 和 Decision Rationale）
- [x] 不含 API Key

### NEEDS CLARIFICATION
- [x] **NEEDS CLARIFICATION now = 0**（P0 Open Web Search Provider vendor 已冻结为 Tavily Search API）

### 边缘情况
- [x] Case A: Search API 返回 BOSS 岗位 → SEARCH_EVIDENCE + MANUAL_REVIEW_REQUIRED
- [x] Case B: Search API 返回公司官网岗位 → 允许时 Auto Fetch → 完整性验证 → evidence_upgrade → FULL_EVIDENCE
- [x] Case C: Search API 返回来源未知网站 → CONDITIONAL_FETCH → 默认不 Fetch
- [x] Case D: Search Evidence 很匹配但信息不足 → MANUAL_REVIEW_REQUIRED，不得丢弃
- [x] Case E: Search API 搜到同一岗位多个来源 → 现有 Identity/Relation 机制
- [x] 专业招聘平台自动后台爬取/翻页/Session 批量采集已加入 Out of Scope

### 不涉及的范围
- [x] 未修改 `src/` 业务源码
- [x] 未修改 `server/` 业务源码
- [x] 未修改 `browser-extension/` 业务源码
- [x] 本轮仅完成 Spec Amendment + Provider Pre-validation，未执行任何 speckit 下游命令

## 备注

- **决策链完整**：最初选择 Jooble → 公开市场 Pre-validation → Jooble FAIL → 重新定义 Active Discovery Source Strategy → Tavily vs Brave Pre-validation → Tavily PASS。
- **澄清数量变化**：
  - After Spec Amendment v1: 1 NEEDS CLARIFICATION — P0 Open Web Search Provider vendor
  - After Spec Amendment v2 (本轮): **0 NEEDS CLARIFICATION** — Tavily Search API 已冻结
- **FR 数量变化**：
  - Baseline: FR-001 ~ FR-060（60 个）
  - After Amendment v1: FR-001 ~ FR-072（72 个）
  - After Amendment v2: FR-001 ~ FR-072（72 个，无新增，仅 FR-009 更新为 Tavily-specific）
- **US 数量**：US1–US16（16 个，US2 验收场景已更新为 Tavily-specific）
- **Provider 候选状态汇总**：
  | Provider | Status |
  |----------|--------|
  | Jooble REST API | REJECTED_AFTER_PREVALIDATION |
  | Tavily Search API | **P0 SELECTED** |
  | Brave Search API | BRAVE_FAIL（持久化权硬阻门） |
  | Google Programmable Search | SECONDARY_CANDIDATE |
  | Bing Search API | REJECTED_NOT_AVAILABLE |
- **Downstream artifacts requiring amendment**（本轮未修改）：
  - `plan.md` — Jooble-specific 全文 + Constitution Check
  - `research.md` — Jooble API 全文
  - `tasks.md` — Phase 0 T001–T008 全部 Jooble-specific；T019/T021 Provider-specific
  - `contracts/search-provider.md` — 全文 Jooble-specific
  - `data-model.md` — 可能需要 Search Evidence / Source Policy 设计
- **新增文件**：`search-provider-prevalidation.md`（Provider Pre-validation Report）
- 下一轮：进行统一的 Plan Amendment + Tasks Amendment + Analyze，将 Tavily 替换进所有 downstream artifacts
