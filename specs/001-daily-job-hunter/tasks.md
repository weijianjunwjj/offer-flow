# OfferFlow v0.9 实施任务清单：每日岗位猎手

> **对应 Spec：** `specs/001-daily-job-hunter/spec.md`
> **对应 Plan：** `specs/001-daily-job-hunter/plan.md` (v3.0 — Plan Amendment: Tavily Search API)
> **对应 PRD：** `docs/prd/offerflow-v0.9.md` (v2.3 Final Candidate)
> **创建日期：** 2026-08-11
> **最后修订：** 2026-08-11（Tasks Amendment：Jooble → Tavily，新增 Evidence / Source Policy / Content Acquisition / Terms Compliance 任务）
> **状态：** Tasks Amendment 完成 —— 等待 `/speckit.analyze`
> **前置阶段：** PRD ✅ → Constitution ✅ → Specification ✅ → Clarify ✅ → Plan ✅ → Plan Amendment ✅ → **Tasks Amendment ← 本轮**

---

## 约定

- `[P]` = 可并行执行（无共享写入、无前置状态依赖、不覆盖同一文件）
- `[USx]` = 对应 User Story x（见 spec.md）
- `[GATE]` = 审批门——必须通过才能继续后续阶段
- `[EVIDENCE]` = evidenceLevel-aware task（新增标签）
- 标记为 `[P]` 的 Task 不存在写入冲突

---

## Phase 0 — Tavily Search API Smoke Gate

**目标：** 在投入完整 Discovery 基建之前，先验证 Tavily Search API 的真实能力、合约和合规边界。只有 PASS 才允许进入后续 Phase。

**失败处理：** 如果 Phase 0 任何 GATE 返回 FAIL → 记录失败原因，不偷改 Radar 规则、不爬专业招聘平台、不编造 JD、回到 Provider Decision。

**前置：** V8.x 基线

---

### T001 [GATE] 编写 Tavily Smoke Gate 独立验证脚本

**目标：** 创建独立于业务代码的验证脚本，对 Tavily Search API 进行真实请求测试。

**文件范围（新增）：**
- `scripts/provider-validation/tavily-smoke.ts` — 独立验证脚本（仅依赖 `fetch`）

**完成条件：**
1. 脚本可以通过命令行独立运行（`pnpm run provider:validate`）
2. 从环境变量 `TAVILY_API_KEY` 读取 API Key
3. 不依赖任何 OfferFlow 业务服务、数据库或 Fastify 启动
4. 不写数据库，输出写入 `scripts/provider-validation/output/` 目录（JSON 文件）
5. 验证项必须覆盖 T002–T007 的所有检查点

---

### T002 [GATE] 验证 Tavily API Key 可达性

**目标：** 确认 API Key 能否真实调用 Tavily Search API。

**具体检查：**
1. `POST https://api.tavily.com/search` → 使用 Bearer token 认证 → HTTP 200
2. 无效 API Key → 401 Unauthorized（验证错误处理）
3. 记录 Free tier 申请流程（`https://app.tavily.com/home`，无需信用卡）

**完成条件：**
1. 验证脚本输出 `auth.status` = `pass` | `fail`
2. 记录 response 状态码和错误 body

---

### T003 [GATE] 验证中国地区搜索真实可用（country=china）

**目标：** 确认 Tavily Search 在 `country=china` 下返回有效结果。

**具体检查：**
1. `query="苏州 前端工程师 招聘"` + `country=china` → 返回 results 数组
2. `query="无锡 前端工程师 招聘"` + `country=china` → 返回 results 数组
3. `query="上海 AI 前端 招聘"` + `country=china` → 返回 results 数组
4. `query="杭州 Node.js 全栈 招聘"` + `country=china` → 返回 results 数组
5. 跨多个城市的 results 是否真实（title/url/content 与中国市场一致）

**完成条件：**
1. 每个目标城市的验证结果记录：`{ city, query, resultCount, sampleTitles }`
2. 至少一个目标城市返回 `results.length > 0`
3. 记录典型样本的 title / url / domain / content 实际内容

---

### T004 [GATE] 验证 Tavily Response Contract 与字段一致性

**目标：** 逐字段确认 Tavily 实际响应是否与 `contracts/search-provider.md` 中记录的 Tavily Contract 一致。

**具体检查：**
1. `results[].title` — 是否存在、是否非空
2. `results[].url` — 是否存在、是否有效 URL
3. `results[].content` — 是否存在、平均长度、是否包含描述内容
4. `results[].score` — 是否存在、类型是否为 number、取值范围
5. `results[].raw_content` — P0 配置下（`include_raw_content=false`）应为 null
6. `query` — 回显是否正确
7. `response_time` — 是否存在、类型
8. `images` — 是否存在
9. `usage` 对象（如有）— `credit_used` 字段是否存在
10. `search_depth=basic` → 确认消耗 1 credit

**完成条件：**
1. 输出字段覆盖矩阵：每个字段的 `{ exists, type, nonEmptyRate, sampleValue }`
2. 标注与官方文档的差异项
3. 确认 `include_raw_content=false` 不返回 raw_content

---

### T005 [GATE] 验证 Tavily Terms / AUP Persistence 约束合规性

**目标：** 确认 OfferFlow 保存 Search Evidence 的行为与 Tavily Platform Terms / AUP 一致。明确禁止保存 `raw_content`。

**具体检查：**
1. 重新读取 Tavily 当前 Platform Terms 和 Acceptable Use Policy
2. 确认 search results（title/url/content/score）持久化未被禁止
3. 检查 `include_raw_content=true` 场景下 `raw_content` 的 ToS 约束
4. 明确记录：P0 不保存 `raw_content`（`include_raw_content=false`）
5. 如果未来启用 `include_raw_content`，需要重新评估 ToS 合规性

**完成条件：**
1. 生成 `scripts/provider-validation/output/tavily-compliance.md` —— 包含检查结果
2. 明确记录：
   - OfferFlow 保存的 Search Evidence 字段列表（title/url/content/score/query/domain/searchedAt）
   - 不保存的字段（raw_content、images、answer）
   - 与 Tavily Platform Terms 的一致性声明
3. 禁止保存 raw_content 的约束写入 Plan/Tasks（未来启用的前置条件）

---

### T006 [GATE] 验证 Tavily 中国招聘平台结果发现能力

**目标：** 确认 Tavily Search 在 `country=china` 下能否发现专业招聘平台的公开索引结果。

**具体检查：**
1. 跑一组查询，分析 `results[].url` 的域名分布
2. 确认 liepin.com、zhaopin.com 等招聘平台 domain 出现在结果中
3. 记录 zhipin.com 出现频率
4. 结果中 company careers / ATS domain 的分布
5. 结果中 tech community domain 的分布

**完成条件：**
1. 输出 source domain 分布报告
2. 确认至少部分结果来自招聘平台、公司官网和开放 Web
3. 标记 domain 分类（RECRUITMENT_PLATFORM / COMPANY_CAREER / TECH_COMMUNITY / OTHER / UNKNOWN）

---

### T007 [GATE] 验证 Tavily Rate Limit / Credit Usage 真实行为

**目标：** 观察 Tavily API 的频率限制和 credit 消耗行为。

**具体检查：**
1. 单次 basic search 消耗的 credits（预期 1 credit）
2. `usage.credit_used` 是否在 response 中返回
3. 连续请求（如 5 次 / 5 秒）是否触发 rate limit（429）
4. 月度额度耗尽时是否返回 432 Usage Limit Exceeded
5. Pay-as-you-go limit 是否返回 433

**完成条件：**
1. 记录 credit usage 观察结果（实际消耗 vs 预期）
2. 记录 rate limit 观察结果（触发条件、恢复时间）
3. 如果无法在测试中触发 → 记录"未观察到，以 Tavily 官方文档为准"
4. 给出 Provider Adapter 的 rate-limit 策略建议

---

### T008 [GATE] Tavily Smoke Gate 裁决

**目标：** 汇总 T002–T007 的验证结果，做出 PASS / FAIL 裁决。

**完成条件：**
1. 生成 `scripts/provider-validation/output/smoke-report.md` — 包含所有验证项目的结论
2. 明确判定：`PASS`（可进入 Phase 1 及后续）或 `FAIL`（停止 Tavily 后续 Tasks，回到 Provider Decision）
3. 如果 PASS → 记录已知风险和数据质量边界
4. 如果 FAIL → 记录失败原因和建议方向
5. **禁止在 FAIL 后**：降低 Radar 数据质量要求、爬专业招聘平台、根据 snippet 编造完整 JD

---

## Phase 1 — Schema Migration + Evidence Model Foundation

**目标：** 在重构 Ingestion 之前，先落地 v0.9 所需的 schema 变更：`capture_method` CHECK 扩展、`evidence_level` additive column、`origin_type` CHECK 扩展。保持 v0.8 完全兼容。

**前置：** Phase 0 — Tavily Smoke Gate PASS

---

### T009 [P] Schema Migration v9 —— capture_method CHECK 扩展（表重建）

**目标：** 在 `radar_capture_snapshots` 表的 `capture_method` CHECK 约束中新增 `'search_discovery'` 和 `'open_web_fetch'`。

**文件范围（新增/修改）：**
- `server/migrations/dailyJobHunterSchemaV9.ts` — 新增：schema v9 定义
- `server/migrations.ts` — 修改：注册 v9 migration
- `server/schema.ts` — 修改：`LATEST_SCHEMA_VERSION` 提升到 9

**迁移方式**（SQLite 表重建，与 schema v8 的 `radar_actions` 重建流程一致）：
```
backupDatabase()
  ↓ transaction
CREATE TABLE radar_capture_snapshots_v9_new（同结构 + 扩展 CHECK，新增 'search_discovery' + 'open_web_fetch'）
  ↓ INSERT INTO ... SELECT ...（copy 所有既有行，不改写数据）
  ↓ preserve FK / indexes / constraints
  ↓ DROP TABLE radar_capture_snapshots
  ↓ RENAME new → radar_capture_snapshots
  ↓ PRAGMA foreign_key_check
  ↓ integrity verification
```

**扩展后的 CHECK：**
```sql
capture_method IN (
  'boss_current_page', 'generic_visible_text',
  'pasted_text', 'shared_link_and_text', 'json_import',
  'search_discovery',
  'open_web_fetch'
)
```

**完成条件：**
1. Fresh DB 初始化创建 v9 schema（含扩展 CHECK）
2. v8 → v9 升级：所有既有行完整复制、不改写数据
3. 升级后 v0.8 Radar 功能回归通过
4. 备份文件在 migration 前自动创建
5. `PRAGMA foreign_key_check` 无错误
6. **绝对禁止**：`PRAGMA writable_schema`

---

### T010 [P] Schema Migration v9 —— evidence_level additive column

**目标：** 在 `radar_candidate_versions` 表新增 `evidence_level` 列。

**文件范围（修改）：**
- `server/migrations/dailyJobHunterSchemaV9.ts` — 包含 `ALTER TABLE ADD COLUMN evidence_level`
- `src/domain/radar/types.ts` — 新增 `RadarEvidenceLevel` enum、`RadarCandidateVersion` 新增 `evidenceLevel` 字段
- `server/radar/rowMappers.ts` — 更新 row mapper 映射 `evidence_level`

**SQL：**
```sql
ALTER TABLE radar_candidate_versions
ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'FULL_EVIDENCE' CHECK (
  evidence_level IN ('SEARCH_EVIDENCE', 'FULL_EVIDENCE', 'MANUAL_REVIEW_REQUIRED')
);
```

**完成条件：**
1. 默认值 `'FULL_EVIDENCE'` 对已有行兼容（所有 v0.8 CandidateVersion 视为 FULL_EVIDENCE）
2. `RadarCandidateVersion` TypeScript 类型新增 `evidenceLevel: RadarEvidenceLevel`
3. Row mapper 正确映射 `evidence_level` ↔ `evidenceLevel`
4. Schema validator 接受三个 legal values
5. 非 legal value 被 CHECK 拒绝

---

### T011 [P] Schema Migration v9 —— origin_type CHECK 扩展（表重建）

**目标：** 在 `radar_candidate_versions` 表的 `origin_type` CHECK 约束中新增 `'evidence_upgrade'`。

**迁移方式**：同样需要表重建 migration（修改 CHECK 约束）。可以与 T009 的 `radar_capture_snapshots` 表重建在同一 migration 中执行。

**扩展后的 CHECK：**
```sql
origin_type IN ('captured', 'manual_correction', 'source_change', 'merge_resolution', 'evidence_upgrade')
```

**完成条件：**
1. 新增 `'evidence_upgrade'` value 可在 v9 schema 中写入
2. 已有行不受影响
3. `RadarCandidateVersionOriginType` TypeScript const 数组扩展
4. `PRAGMA foreign_key_check` 通过

---

### T012 [P] 表重建 Migration 回归与恢复验证

**目标：** 验证 v8 → v9 所有 migration 的完整性和可恢复性。

**文件范围（新增/修改）：**
- `server/migrations/dailyJobHunterSchemaV9.spec.ts` — 新增：migration 测试
- `scripts/migrations.selftest.ts` — 修改：补充 v9 migration selftest entry

**完成条件：**
1. Fresh DB 创建 v9 schema → 所有 v0.8 表 + 新增 CHECK/列正常
2. v8 DB → v9 升级 → 所有既有数据不丢失
3. Backup → migration → restore → 数据一致
4. v0.8 Radar 核心操作在升级后 DB 上回归通过
5. `captureMethod='search_discovery'` + `evidenceLevel='SEARCH_EVIDENCE'` 可写入
6. 旧 `captureMethod`/`originType` 值不受影响
7. 故意写非法值 → 被 CHECK 拒绝
8. `PRAGMA foreign_key_check` 通过

---

### T013 [EVIDENCE] evidenceLevel-aware commitDecision 扩展

**目标：** 扩展 `decideCommit()` 纯函数，使 evidenceLevel 影响 `analysisEligible` 判定。

**文件范围（新增/修改）：**
- `server/radar/commitDecision.ts` — 修改：接收 `evidenceLevel` 参数 → 影响 `analysisEligible`
- `server/radar/commitDecision.spec.ts` — 修改：补充 evidenceLevel 相关测试

**完成条件：**
1. `evidenceLevel = 'SEARCH_EVIDENCE'` → `analysisEligible = false`（不论 identity/material-change 判定）
2. `evidenceLevel = 'MANUAL_REVIEW_REQUIRED'` → `analysisEligible = false`
3. `evidenceLevel = 'FULL_EVIDENCE'` → 正常判定（新身份/material_change = true；no_change/extraction_regression = false）
4. Candidate / Version 仍正常创建（不阻断 ingestion，只阻断 analysis）
5. 测试覆盖：normal full-evidence flow → analysisEligible=true；search-evidence flow → false；manual-review → false

---

### T014 [EVIDENCE] evidenceLevel-aware commitDecision 集成测试

**目标：** 在 service.ts 的 `materializeItem()` 中实际传递 evidenceLevel，并验证全链路。

**文件范围（修改）：**
- `server/radar/service.ts` — `materializeItem()` 调用 `decideCommit()` 时传递 evidenceLevel
- `server/radar/service.spec.ts` — 补充 evidenceLevel 集成测试

**完成条件：**
1. IngestionInput 携带 `evidenceLevel = 'SEARCH_EVIDENCE'` → `materializeItem()` → `outcome.analysisEligible = false`
2. IngestionInput 携带 `evidenceLevel = 'FULL_EVIDENCE'` → `outcome.analysisEligible` 正常判定
3. SEARCH_EVIDENCE 路径：Snapshot 写入正确、Candidate/Version 创建、SourceRecord 正确关联
4. Browser Capture 路径不受影响（默认 `evidenceLevel = 'FULL_EVIDENCE'`）
5. 测试覆盖：
   - SEARCH_EVIDENCE：analysisEligible=false，但 candidate/version 已创建
   - FULL_EVIDENCE：existing behavior preserved

---

## Phase 2 — Shared Radar Ingestion Core + Search Evidence

**目标：** 从 `RadarCaptureService` 抽取共享 `RadarIngestionService`，扩展以支持 Search Evidence 摄入和 Evidence Upgrade 路径。

**前置：** Phase 1 完成

---

### T015 [P] 补充 Browser Capture 当前行为回归测试

**目标：** 在抽取 Shared Ingestion 之前，固定当前 `RadarCaptureService.materializeItem()` 的完整行为。

**文件范围（新增）：**
- `server/radar/service.spec.ts` — 新建：补充 materializeItem 完整链路测试

**完成条件：**
1. 覆盖所有 commitDecision 路径（new_identity / no_change / material_change / snapshot_only / extraction_regression / identity_conflict / ambiguous_change）
2. 覆盖现有五个 capture_method 值
3. 覆盖 `captureSessionId` 正常写入
4. 所有测试在抽取前后保持通过

---

### T016 [P] 固定 normalize / identity / fingerprint / materialChange 行为测试

**目标：** 为低层 Ingestion 函数补充独立测试，确保语义不变。

**文件范围（新增/修改）：**
- `server/radar/commitDecision.spec.ts` — 补充 fingerprint / material change 边界测试
- `server/radar/ingestion/ingestionIdentity.spec.ts` — 新增：identity resolution 独立测试

**完成条件：**
1. fingerprint 确定性：相同输入 → 相同 hash
2. material change 判定覆盖：salary / location / title / description / 组合变化
3. identity resolution：同 providerKey + 同 externalRecordId → 同一 identity；sourceUrl 标准化去重
4. 现有测试全部通过

---

### T017 从 RadarCaptureService 抽取共享 RadarIngestionService

**目标：** 将 `materializeItem` 的核心 Ingestion 逻辑提升为独立的 `RadarIngestionService`。

**文件范围（新增/修改）：**
- `server/radar/ingestion/RadarIngestionService.ts` — 新增：共享 Ingestion 核心
- `server/radar/ingestion/IngestionInput.ts` — 新增：输入契约类型（含 evidenceLevel、sourcePolicy）
- `server/radar/ingestion/IngestionOutcome.ts` — 新增：输出结果类型
- `server/radar/service.ts` — 修改：`materializeItem` 改为调用 `RadarIngestionService.ingest()`
- `server/radar/ingestion/RadarIngestionService.spec.ts` — 新增：共享 Ingestion 独立测试

**完成条件：**
1. `RadarIngestionService.ingest(input)` 接收标准化的 `RadarIngestionInput`，返回 `RadarIngestionOutcome`
2. `IngestionInput` 新增字段：
   - `evidenceLevel: 'SEARCH_EVIDENCE' | 'FULL_EVIDENCE' | 'MANUAL_REVIEW_REQUIRED'`
   - `sourcePolicy: 'SEARCH_ONLY' | 'SEARCH_AND_FETCH' | 'CONDITIONAL_FETCH'`
3. Browser Capture 行为完全兼容（默认 `evidenceLevel='FULL_EVIDENCE'`）
4. 现有 `server/radar/service.spec.ts` 全部通过
5. 新增 `RadarIngestionService.spec.ts` 覆盖与 Browser Capture 相同的 ingestion 路径

---

### T018 [P] Search Evidence 摄入路径（captureSessionId=null, captureMethod='search_discovery'）

**目标：** `RadarIngestionService` 支持来自 Tavily Search 的 SEARCH_EVIDENCE 输入。

**文件范围（新增/修改）：**
- `server/radar/ingestion/RadarIngestionService.ts` — 确保 captureSessionId=null 不触发 session 逻辑
- `server/radar/ingestion/IngestionInput.ts` — `captureSessionId: string | null`

**完成条件：**
1. `captureSessionId=null` + `captureMethod='search_discovery'` → Snapshot 正常创建
2. `evidenceLevel='SEARCH_EVIDENCE'` → CandidateVersion 创建、`analysisEligible=false`
3. `providerKey='tavily'` → SourceRecord 正确记录
4. Snapshot `rawSnapshot` 包含完整 Search Evidence（query/providerScore/providerRequestId 等）
5. 新增测试覆盖此路径

---

### T019 [EVIDENCE] Evidence Upgrade 路径实现

**目标：** SEARCH_EVIDENCE Candidate 通过 Manual Capture 升级为 FULL_EVIDENCE 时，创建新 CandidateVersion（`originType='evidence_upgrade'`）。

**文件范围（新增/修改）：**
- `server/radar/ingestion/RadarIngestionService.ts` — 支持 evidence upgrade 判定
- `server/radar/ingestion/RadarIngestionService.spec.ts` — 补充 evidence upgrade 测试

**完成条件：**
1. SEARCH_EVIDENCE Candidate A + Manual Capture（同一 URL）→ Identity Resolution 匹配到 Candidate A
2. 创建新 CandidateVersion V2：
   - `evidenceLevel = 'FULL_EVIDENCE'`
   - `originType = 'evidence_upgrade'`
   - `supersedesVersionId = V1.id`
3. V2 的 `analysisEligible = true`（正常 commitDecision 判定）
4. V1 不变（保留 SEARCH_EVIDENCE 历史）
5. Candidate 的 `activeVersionId` 指向 V2
6. 测试覆盖：
   - Evidence upgrade 创建新版本且 supersedesVersionId 正确
   - V1 不变、V2 成为 active version
   - analysisEligible 从 false → true

---

### T020 [EVIDENCE] Evidence Upgrade 去重验证测试

**目标：** Tavily Search 发现 + Manual Capture → same Candidate，不创建 duplicate。

**文件范围（新增）：**
- `server/radar/ingestion/evidenceUpgrade.spec.ts` — 新增：Evidence Upgrade 独立测试

**完成条件：**
1. Tavily → BOSS 岗位 URL → Candidate A（SEARCH_EVIDENCE）
2. Manual Capture → 同一 BOSS 岗位 URL → identity resolution → Candidate A
3. 不创建 Candidate B
4. Candidate 只有一个（`lifecycleStatus='active'`）
5. SourceRecord 正确关联两个来源
6. SEARCH_EVIDENCE ≠ FULL_EVIDENCE versions 区分正确

---

## Phase 3 — SearchPlan + Scheduler + Tavily Discovery

**目标：** 构建每日找岗计划的配置、版本、调度与 Tavily Search Discovery。实现 Query Expansion（含 dedupe + budget）、Source Policy、Content Acquisition。

**前置：** Phase 2 完成

---

### T021 [P] [US1] DailySearchPlan 与 DailySearchPlanVersion 数据模型与 Repository

**目标：** 实现 `daily_search_plans` 和 `daily_search_plan_versions` 两张表的完整 CRUD Repository。

**文件范围（新增）：**
- `server/search-plan/searchPlanRepository.ts` — 新增
- `server/search-plan/searchPlanRepository.spec.ts` — 新增
- `server/search-plan/types.ts` — 新增

**完成条件：**
同旧 Plan T016。

**`source_configs_json` 示例（Tavily-specific）：**
```json
[{"providerKey": "tavily", "searchDepth": "basic", "country": "china", "enabled": true}]
```

---

### T022 [P] [US1] DailySearchPlan API 路由

**目标：** 实现 SearchPlan 的 REST API 端点。同旧 Plan T017。

**文件范围（新增）：**
- `server/search-plan/searchPlanRoutes.ts`
- `server/search-plan/searchPlanRoutes.spec.ts`
- `server/search-plan/searchPlanDtoSchemas.ts`

**API 端点：** 同旧 Plan。

---

### T023 [P] [US1] DailySearchPlan 前端配置页面

**目标：** 创建找岗计划的配置 UI。同旧 Plan T018。

**文件范围（新增）：**
- `src/pages/SearchPlanPage.vue` 等

**完成条件：** 同旧 Plan。Provider selector 改为 Tavily。

---

### T024 [P] SearchProviderAdapter 接口定义与 Provider-neutral 类型

> **实施状态（2026-08-14）：absorbed/completed by Phase 3。** `server/search-provider/` 已实现 `SearchProviderAdapter` 接口、Provider-neutral 类型（`SearchQuery` / `SearchEvidenceItem` / `SearchProviderResult` / `SearchCoverage` / `SearchProviderErrorCode`）与 9 种错误码（`errors.ts`）。契约与 `contracts/search-provider.md` v2.0 一致，Tavily DTO 仅存在于 `tavily/` 子模块。

**目标：** 定义 `SearchProviderAdapter` 接口和所有 Provider-neutral 类型。Tavily DTO 只在 Adapter section。

**文件范围（新增）：**
- `server/search-provider/SearchProviderAdapter.ts` — 新增：Adapter 接口（Provider-neutral）
- `server/search-provider/types.ts` — 新增：`SearchQuery`、`SearchEvidenceItem`、`SearchProviderResult`、`SearchCoverage`、`SearchProviderErrorCode` 等
- `server/search-provider/errors.ts` — 新增：9 种 Provider Error Code（含 USAGE_LIMIT）

**完成条件：**
1. 接口与 `contracts/search-provider.md` v2.0 完全一致
2. `SearchProviderErrorCode` 九种：`VALID_EMPTY` / `AUTH_ERROR` / `RATE_LIMITED` / `USAGE_LIMIT` / `TIMEOUT` / `NETWORK_ERROR` / `MALFORMED_RESPONSE` / `PROVIDER_UNAVAILABLE`
3. `SearchEvidenceItem` 是 Provider-neutral type——不绑定 Tavily DTO
4. 不包含 Jooble-specific 类型

---

### T025 [P] SecretStore 抽象与实现

> **实施状态（2026-08-14）：absorbed/completed by Phase 3。** `SecretStore` 接口 + `EnvSecretStore` + `MemorySecretStore`（测试用）+ `SecretStore.spec.ts` 已实现。`WindowsDpapiSecretStore`（DPAPI 加密存储）按 `SecretStore.ts` 注释明确延后（"future, not in T025"），非本轮缺口。

**目标：** 实现 `SecretStore` 抽象。同旧 Plan T020（无变化）。

**文件范围（新增/修改）：**
- `server/secret/SecretStore.ts`
- `server/secret/WindowsDpapiSecretStore.ts`
- `server/secret/EnvSecretStore.ts`
- `server/secret/SecretStore.spec.ts`

---

### T026 Tavily Search Provider 实现

> **实施状态（2026-08-14）：absorbed/completed by Phase 3。** `TavilySearchProvider` + `tavilyFieldMapping` + `tavilyRateLimiter` + `TavilySearchProvider.spec.ts` 已实现。覆盖 P0 `/search` endpoint、Bearer 认证、Token Bucket、超时/取消、9 种错误分类、`include_raw_content=false`、`auto_parameters` 禁用；Tavily DTO 仅存于 Adapter boundary。

**目标：** 实现 P0 `SearchProviderAdapter`：Tavily Search API（`/search` endpoint only）。

**文件范围（新增）：**
- `server/search-provider/tavily/TavilySearchProvider.ts` — 新增：Tavily Provider 实现
- `server/search-provider/tavily/tavilyFieldMapping.ts` — 新增：Tavily → SearchEvidenceItem 映射
- `server/search-provider/tavily/tavilyRateLimiter.ts` — 新增：速率限制
- `server/search-provider/tavily/TavilySearchProvider.spec.ts` — 新增：Tavily Provider 测试（mock HTTP）

**完成条件：**
1. 实现 `SearchProviderAdapter` 接口（`providerKey='tavily'`, `providerVersion='1.0.0'`）
2. API Key 从 `SecretStore` 读取（通过 `TAVILY_API_KEY` 环境变量或 DPAPI）
3. 请求格式：`POST /search` + `{ query, search_depth='basic', country='china', topic='general', max_results, include_answer=false, include_raw_content=false }`
4. 响应解析：`results[]` → `SearchEvidenceItem[]`（逐字段映射，见 contract §Tavily → SearchEvidenceItem mapping）
5. **禁止保存 `raw_content`**（`include_raw_content = false`）
6. **禁止使用 `auto_parameters`**
7. Tavily-specific DTO 只在 Adapter boundary —— `SearchEvidenceItem` 是 Provider-neutral
8. Rate limit handling（Token Bucket）
9. 错误分类正确（含 USAGE_LIMIT/432）
10. `AbortSignal` 支持取消
11. 测试覆盖：成功返回、VALID_EMPTY、AUTH_ERROR、RATE_LIMITED、USAGE_LIMIT、TIMEOUT、MALFORMED_RESPONSE、PROVIDER_UNAVAILABLE

---

### T027 [EVIDENCE] Query Expansion + Budget 控制

**目标：** 根据 `DailySearchPlanVersion` 配置展开为 `SearchQuery[]` 列表。**不是笛卡尔积**——添加 dedupe、budget、high-value selection。

**文件范围（新增）：**
- `server/pipeline/taskExpansion.ts` — 新增：SearchQuery 展开逻辑（含 dedupe + budget）
- `server/pipeline/taskExpansion.spec.ts` — 新增：展开逻辑测试

**完成条件：**
1. 基础展开：`city × roleDirection × baseKeyword` → template-based query（如 `"苏州 前端工程师 招聘"`）
2. Expanded keywords：受 `scanBudget.maxExpandedKeywords` 配额控制
3. Query dedupe：相同或高度相似的查询合并（case-insensitive 去重）
4. Query budget：`scanBudget.maxQueriesPerRun` 限制单次总 query 数
5. High-value selection：city × 方向 × 基础关键词优先于扩展关键词
6. 每个 SearchQuery 包含 `queryKey`（如 `"苏州×前端开发×React"`）——用于覆盖追踪
7. **禁止笛卡尔积**：测试覆盖 4 cities × 3 keywords × 5 expanded keywords = 60 potential → capped at maxQueriesPerRun
8. 测试覆盖：基础展开、dedupe、budget 上限、expanded keyword 配额

---

### T028 Scheduler 核心实现

> **实施状态（2026-08-14）：completed（T028 + DailyRunCoordinator 闭环）。** `server/scheduler/DailyJobScheduler.ts`（WHEN，Fastify 进程内 setTimeout 链 + startup CATCH_UP）+ `server/daily-run/DailyRunCoordinator.ts`（ONE RUN LIFECYCLE）+ `server/daily-run/runtime.ts`（composition root 组装真实 Tavily/Ingestion/Fetch/Upgrade/Analysis/Recommendation）。schedule contract = `{ dailyAt, timezone }`（v0.9 默认 `Asia/Shanghai`）；`scheduledFor` = 绝对 occurrence instant；`scheduledDay` = plan timezone 自然日 YYYY-MM-DD；v14 迁移补 source_runs `search_plan_id`/`scheduled_day` + occurrence/active 去重 partial UNIQUE（FR-005/FR-007）。
>
> **DailyBrief Recommendation Reconciliation Hardening（2026-08-14，同 T028 闭环）。** `DailyRunCoordinator.persistBrief` 原实现无条件用本次 batch 覆盖既有 brief 的 `recommendationBatchId`，存在「run-1 非空推荐被 run-2 空结果降级为空」的语义缺口。已改为 MONOTONIC USEFULNESS reconciliation：空→空 保持空、空→非空 升级、非空→空 保留既有非空、非空→非空 取最新；是否含推荐以真实 batch `selectedCandidateVersionIds` 判断；`emptyReason` 与最终 selected batch 保持一致。新增 `getBatch` 依赖（接 `RecommendationBatchService.getBatch`）。

**目标：** 同旧 Plan T023。Fastify 进程内 Scheduler。无变化（Provider 无关组件）。

---

### T029 [P] SourceRun 数据模型与 Repository（Provider-neutral）

**目标：** 实现 `source_runs` 表 Repository。结构为 Provider-neutral（不再有 Jooble-specific 字段）。

**文件范围（新增）：**
- `server/source-run/sourceRunRepository.ts` — 新增
- `server/source-run/types.ts` — 新增（Provider-neutral 结构）
- `server/source-run/sourceRunRepository.spec.ts` — 新增

**完成条件：**
同旧 Plan T024 + 字段更新：
- `queriesAttempted` / `queriesSucceeded` / `queriesFailed`（替换 Jooble-specific 字段）
- `resultsDiscovered` / `relevantResults`
- `searchEvidencePersisted` / `manualReviewRequired` / `fullEvidenceCount`
- `estimatedSearchCredits` / `actualSearchCredits`
- 删除：`scannedCount`、`ingestedCount`、`plannedTaskCount`、`completedTaskCount`、pages

---

### T030 SourceRun API 路由与前端页面

**目标：** 同旧 Plan T025。响应格式更新为 Provider-neutral 结构。

---

### T031 Windows Autostart 管理

**目标：** 同旧 Plan T026。无变化（Provider 无关组件）。

---

### T032 Plan 控制端点（Run Now / Skip Today / Pause / Resume）

> **实施状态（2026-08-14）：completed。** 复用 `DailySearchPlan.status`（`active`/`paused`/`deleted`）表达 Pause/Resume；新增 v15 迁移 `daily_search_plan_skips`（identity = `search_plan_version_id × scheduled_day`，PK 幂等）表达 Skip Today 持久化；`DailyJobScheduler.trigger` 在 SCHEDULED/CATCH_UP 前检查 skip（MANUAL Run Now 绕过 skip）；新增 `searchPlanRoutes` 控制端点 `POST /daily-search-plans/:id/{pause,resume,skip-today,run-now}`（run-now 复用 `DailyRunCoordinator.run`，triggerType=MANUAL，FR-007 并发冲突返回 409）。`dailySearchPlan` capability 开启时注册控制端点；与 `dailyJobScheduler` 共享同一 coordinator（API 开启 ≠ timer 开启）。

**目标：** 同旧 Plan T027。无变化。

---

## Phase 4 — Source Policy + Content Acquisition + Pipeline

**目标：** 实现 Source Policy 判定、最小 Content Acquisition、完整 Pipeline、DailyJobBrief（含 discoveryItems）。严格保证 SEARCH_EVIDENCE ≠ RecommendationBatch，MANUAL_REVIEW_REQUIRED 只进 discoveryItems。

**前置：** Phase 3 完成

---

### T033 [P] Source Policy 实现（code/config）

**目标：** P0 Source Policy 为 code/config policy（不建 DSL/Engine/Platform/DB 表）。实现 domain classification + static policy。

**文件范围（新增）：**
- `server/source-policy/sourcePolicy.ts` — 新增：Source Policy 纯判定函数
- `server/source-policy/sourcePolicy.spec.ts` — 新增：Source Policy 测试

**完成条件：**
1. `classifyDomain(url)` → `'RECRUITMENT_PLATFORM' | 'COMPANY_CAREER' | 'TECH_COMMUNITY' | 'OPEN_WEB' | 'OTHER'`
2. `determineSourcePolicy(domain, classification)` → `'SEARCH_ONLY' | 'SEARCH_AND_FETCH' | 'CONDITIONAL_FETCH'`
3. Recruitment Platforms（zhipin.com/liepin.com/zhaopin.com/lagou.com/51job.com）→ `SEARCH_ONLY`
4. Company Careers / ATS / GitHub → `SEARCH_AND_FETCH`
5. Tech communities / blogs（如 juejin.cn）→ `CONDITIONAL_FETCH`；普通 unknown public domain → `SEARCH_AND_FETCH`（受控 fetch，仍须 validation + evidence_upgrade 才 FULL_EVIDENCE）；空/无效 domain → `SEARCH_ONLY`
6. **不在 Search Provider 层建立招聘平台 domain 硬 denylist**
7. 配置可维护（code-based，不是 DB 表）
8. 测试覆盖：all five recruitment platforms → SEARCH_ONLY；company careers → SEARCH_AND_FETCH；unknown public → SEARCH_AND_FETCH（受控 fetch）；empty → SEARCH_ONLY

---

### T034 [EVIDENCE] Source Policy → Evidence Level Mapping

**目标：** Source Policy 结果映射到 Evidence Level。这是 Search Evidence 和 Source Policy 之间的关键产品逻辑。

**文件范围（新增/修改）：**
- `server/source-policy/evidenceMapping.ts` — 新增：Source Policy → Evidence Level 映射
- `server/source-policy/evidenceMapping.spec.ts` — 新增：测试

**完成条件：**
1. `SEARCH_ONLY`（招聘平台）→ `evidenceLevel = 'MANUAL_REVIEW_REQUIRED'`
2. `SEARCH_AND_FETCH`（Policy B 来源，含普通 unknown public domain）→ 允许 Content Acquisition；仅当 fetch 成功 **且** JD 完整性/证据验证通过，并执行显式 `evidence_upgrade` 后 → `evidenceLevel = 'FULL_EVIDENCE'`（fetch 成功本身不直接产生 FULL_EVIDENCE）
3. `CONDITIONAL_FETCH`（Fetch 权限未确认）→ `evidenceLevel = 'MANUAL_REVIEW_REQUIRED'`（默认不 Fetch）
4. 所有初始 Search Evidence → `evidenceLevel = 'SEARCH_EVIDENCE'`（temporary——Source Policy 判定后可能升级为 MANUAL_REVIEW_REQUIRED 或 FULL_EVIDENCE）
5. 测试覆盖：
   - SEARCH_ONLY → MANUAL_REVIEW_REQUIRED
   - SEARCH_AND_FETCH + fetch success + completeness validation PASS → evidence_upgrade → FULL_EVIDENCE
   - CONDITIONAL_FETCH → MANUAL_REVIEW_REQUIRED

---

### T035 [P] Content Acquisition（最小实现——仅 SEARCH_AND_FETCH allowlist）

**目标：** Policy B（SEARCH_AND_FETCH）来源的简单 HTTP Fetch + 文本提取。**不处理招聘平台页面抓取。**

**文件范围（新增）：**
- `server/content-acquisition/ContentFetcher.ts` — 新增：简单 `fetch()` wrapper + 文本提取
- `server/content-acquisition/ContentFetcher.spec.ts` — 新增：测试

**完成条件：**
1. 只对 `sourcePolicy='SEARCH_AND_FETCH'` 的来源执行 Fetch
2. Simple HTTP GET + basic text extraction（不是通用 Crawler）
3. 有限频率、有限超时（30s）、只读
4. 失败 → 保留 SEARCH_EVIDENCE，标记 MANUAL_REVIEW_REQUIRED
5. Fetch 成功 ≠ FULL_EVIDENCE。ContentFetcher 区分并输出：transport 成功（HTTP 200 + 可解析正文）、extraction 成功（title/plainText 等最小字段）、completeness validation 结果（JD 是否完整）。仅当 completeness validation PASS 时输出 `evidenceUpgradeEligible=true`；FULL_EVIDENCE 由后续显式 `evidence_upgrade` 落库才产生（→ Radar Ingestion → analysis eligible）。ContentFetcher 本身不写 FULL_EVIDENCE、不做 DB 持久化
6. **禁止**：
   - Fetch 招聘平台页面（BOSS/猎聘/拉勾/智联/前程无忧）
   - GenericCrawlerRuntime / CrawlerAgent / BrowserAutomationRuntime
   - 绕过 robots.txt / CAPTCHA / 登录
7. Allowlist-based（仅允许公开的公司 careers/ATS/GitHub 等 Policy B domain）
8. 测试覆盖：allowlist fetch 成功、blocklist 拒绝、network error、timeout、respect robots、fetch 成功但 JD 不完整（`evidenceUpgradeEligible=false`）、completeness validation PASS（`evidenceUpgradeEligible=true`，但不直接写 FULL_EVIDENCE）

---

### T036 [EVIDENCE] Data Quality Gate（两层 gate 语义：evidenceLevel-aware + input-readiness）

**目标：** 在 Ingestion 和 Analysis 之间建立两层 gate：Evidence Eligibility（evidenceLevel 维度）与 Analysis Input Readiness（core-facts 维度）。

**文件范围（复用，无需新增）：**
- `server/radar/commitDecision.ts` — Evidence Eligibility Gate：`canEnterAnalysis(evidenceLevel)` / `evidenceGateReason(evidenceLevel)`
- `server/radar/analysis/inputSnapshot.ts` — Analysis Input Readiness Gate：`hasCoreFacts` → `INPUT_NOT_READY`

**DO NOT CREATE `server/pipeline/DataQualityGate.ts`：** Data Quality Gate 是逻辑阶段，不要求对应单一文件；其职责已分别由上述两文件承担（有意职责拆分，不是缺失文件）。当前 `server/pipeline/` 仅含 Phase 3 Query Expansion 的 `taskExpansion.ts`。

**完成条件：**
1. `evidenceLevel='SEARCH_EVIDENCE'` → evidence eligibility blocked → `analysisEligible=false`（不进入 MatchAnalysis）
2. `evidenceLevel='MANUAL_REVIEW_REQUIRED'` → evidence eligibility blocked → `analysisEligible=false`
3. `evidenceLevel='FULL_EVIDENCE'` → evidence eligibility passes → `analysisEligible=true`
4. FULL_EVIDENCE 在真正创建 Analysis Task 时，仍须经 input readiness / core-facts 校验
5. core facts 不足 → Analysis task creation 返回 `INPUT_NOT_READY`；不执行 MatchAnalysis、不改 evidenceLevel、不新增持久化 analysisEligible、不需要 `dataQualityEvidence` 字段
6. 信息不足的 Candidate 保留在 Radar（不影响后续 Ingestion / Evidence Upgrade）
7. **禁止**根据 snippet / 搜索摘要补造缺失 JD
8. 测试覆盖：
   - SEARCH_EVIDENCE → blocked（`commitDecision.spec.ts`：`canEnterAnalysis=false`）✅
   - MANUAL_REVIEW_REQUIRED → blocked（`commitDecision.spec.ts`：`canEnterAnalysis=false`）✅
   - FULL_EVIDENCE → 正常进入分析（`commitDecision.spec.ts`：`canEnterAnalysis=true`）✅
   - core facts missing → `INPUT_NOT_READY`（`inputSnapshot.spec.ts` 已覆盖，含 role-only 正向边界）✅
   - no_current_analysis 仍阻止 RecommendationBatch ✅

---

### T037 Discovery Pipeline 核心编排

> **T037 Reality Check 结论：NEEDS_SPLIT，已接受。** 本 Task 拆分为两个受控实施子阶段：**Phase 5A — Evidence Upgrade Persistence** 与 **Phase 5B — Discovery Pipeline Core Orchestration**（此为 T037 内部 implementation sub-phase，与 tasks.md 顶层 Phase 0–8 编号无冲突）。二者严格顺序依赖：Phase 5A 先行，Phase 5B 在其上编排。具体实现文件与 repository/service 形状留各子阶段 Scope Lock 决定，本节只固化权威任务边界。

**Canonical Pipeline 阶段顺序（修正后权威版本）：**

```text
DISCOVERING
→ SOURCE_POLICY
→ INITIAL_INGESTING
→ CONTENT_ACQUISITION（仅 fetchEligible）
→ EVIDENCE_UPGRADE（validation PASS 时）
→ QUALITY_GATE（Evidence Eligibility + Analysis Input Readiness 两层，复用 T036）
→ ANALYZING
→ RECOMMENDING
→ STOP（不实现 BUILDING_BRIEF）
```

**跨子阶段关键约束：**

- **严禁** Provider Result → 直接 FULL_EVIDENCE；**严禁** FetchResult → 直接 Analysis。
- Content Acquisition 本身不写 DB、不产生 FULL_EVIDENCE；evidence_upgrade 必须有已存在的 Candidate / CandidateVersion 作为升级对象。
- evidence_upgrade 是**版本事件**：创建新 `RadarCandidateVersion`（`originType='evidence_upgrade'`、`evidenceLevel='FULL_EVIDENCE'`），**不是字段覆写**（禁止原地 `UPDATE evidence_level` SEARCH_EVIDENCE → FULL_EVIDENCE）；原 SEARCH_EVIDENCE 版本保留。此版本语义与 T019 已确立的语义一致——T019 触发源为 Manual Capture，Phase 5A 触发源为 validated Content Acquisition。
- SOURCE_POLICY 是逻辑阶段，**不得**在 Pipeline 中复制 policy 判断。Pipeline 只消费既有 `getSourcePolicyDecision()` / `initialEvidenceLevel` mapping（复用 defense-in-depth，不重实现 domain allowlist / fetchEligible / evidence mapping）。
- QUALITY_GATE 复用 T036 两层语义：`canEnterAnalysis(evidenceLevel)`（Evidence Eligibility）+ `hasCoreFacts` → `INPUT_NOT_READY`（Analysis Input Readiness）。**不得暗示存在 `DataQualityGate.ts`。**
- Recommendation 前置条件是 **FULL_EVIDENCE + current MatchAnalysis**（缺 current MatchAnalysis 不得进入推荐）。复用现有 `RecommendationBatchService.buildRecommendationSet` / `blockReasonFor`（`no_current_analysis`），Pipeline 不自行重实现 recommendation eligibility。
- Pipeline 自身不重实现 identity resolution / dedupe / material-change detection / analysis task dedupe / recommendation batch dedupe——这些继续由下层服务负责。
- **Failure Isolation**：item-level failure（fetch failure / validation FAIL / INPUT_NOT_READY / 单 item Analysis failure）只影响当前 item outcome，其他 items 继续；仅 run-level fatal failure 才终止 run。不发明复杂 failure enum，具体 contract 留 Phase 5B Scope Lock。

---

#### Phase 5A — Evidence Upgrade Persistence（T037 子阶段）

**职责：** validated Content Acquisition result + existing candidate/version identity → explicit `evidence_upgrade` → 新的 FULL_EVIDENCE `CandidateVersion`。

**负责：**
- 版本创建（`originType='evidence_upgrade'`、`evidenceLevel='FULL_EVIDENCE'`）
- `origin_type` / `capture_method` / `evidenceLevel` / normalized facts / content 落库
- identity association（关联已有 Candidate 与已有 SEARCH_EVIDENCE 版本）
- 幂等（补齐当前唯一缺失的 evidence_upgrade idempotency，具体规则留 5A Scope Lock）

**不负责：** Search Provider、Pipeline orchestration、Analysis、Recommendation、Brief、Scheduler。

**依赖：** T019（evidence_upgrade 版本语义）、T020（evidence upgrade 去重）、T035（Content Acquisition 输出 evidenceUpgradeEligible）。

---

#### Phase 5B — Discovery Pipeline Core Orchestration（T037 子阶段）

**职责：** `DailyPipeline` 只做 orchestration，编排既有能力，**禁止把 EvidenceUpgrade persistence 内联进 DailyPipeline**：

```text
DISCOVER → SOURCE_POLICY → INITIAL_INGEST → optional CONTENT_ACQUISITION → optional EVIDENCE_UPGRADE → QUALITY_GATE → ANALYSIS → RECOMMENDATION
```

**Pipeline 输入依赖（Amendment 后）：** 取消 `runPipeline(sourceRun, planVersion)` 作为必须完成条件（`SourceRun` / `DailySearchPlanVersion` 尚未落地，T037 不得被未实现的 T021 / Scheduler 类型阻塞）。最小 Pipeline 输入只依赖已存在的运行时能力，最终由 Phase 5B Scope Lock 基于 `SearchQuery[]` / `SearchProviderConfig` / `AbortSignal` 等真实类型决定；未来 `SourceRun` / `DailySearchPlanVersion` 落地后，由 adapter 调用 Pipeline，而非让 Pipeline 反向依赖 Scheduler domain。

**discoveryItems 语义：** Phase 5B 在 `PipelineRunResult` 中以内存 outcome 分类 `discovery / manual-review / blocked`，**不落 DailyJobBrief.discoveryItems**（正式 brief persistence 属 T040，T037 不得依赖尚不存在的 DailyBrief repository）。

**完成条件（Phase 5B）：**
1. `runPipeline(input)` 编排完整每日流水线，停在 Recommendation result / RecommendationBatch（不进入 BUILDING_BRIEF）
2. 步骤按 Canonical Pipeline 顺序执行（INITIAL_INGESTING 先于 CONTENT_ACQUISITION）
3. SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 候选以内存 outcome 分类（discovery / manual-review / blocked），不进入 RecommendationBatch
4. FULL_EVIDENCE + current MatchAnalysis 候选 → analysis → recommendation → batch reference
5. Ingestion / Analysis / Recommendation 幂等由下层服务保证（Pipeline 不重实现）
6. Failure Isolation：item-level failure 不中断其它 items；仅 run-level fatal 终止
7. 测试覆盖：完整 Pipeline 成功、部分 Task 失败、空结果、SEARCH_EVIDENCE → 内存 discovery 分类、FULL_EVIDENCE → batch、item 失败隔离

**Phase 5B 实施状态（2026-08-13，实现完成待人工 Gate）：** `DailyPipeline`（`server/pipeline/DailyPipeline.ts` + `types.ts` + `DailyPipeline.spec.ts`）已实现并验证。Canonical Flow 与本节一致：`DISCOVER → INITIAL_INGEST → per-item evidence resolve（getVersion 精确读取 evidenceLevel）→ optional CONTENT_ACQUISITION → optional EVIDENCE_UPGRADE → QUALITY_GATE → ANALYSIS → RECOMMENDATION（每次 run 至多一次 createBatch）`。32 个 contract tests 通过；回归 229 通过；typecheck delta 0（baseline 10 errors / 3 files 不变）。Existing FULL fast path 与 repeat-run 幂等已覆盖。停在本子阶段，不进入 T040 / DailyJobBrief。

**从 T037 移除：** BUILDING_BRIEF / DailyJobBrief（归属 T040 / downstream，not implemented by T037）。

**P0 追加（2026-08-18，公开来源自动证据获取链路修复）：** 在 Phase 5B 基础上追加三件事，均已在 `DailyPipeline` + `sourcePolicy` 落地：① unknown public domain → `SEARCH_AND_FETCH`（受控 fetch，不再一律 manual review），保留招聘平台 `SEARCH_ONLY` 硬边界；② per-run fetch budget（`DEFAULT_FETCH_BUDGET=50`）与 cross-source enrichment（`DEFAULT_ENRICHMENT_BUDGET=20`，identity-safe：缺结构化 company 即 fail closed，禁止 role-only 查询）；③ `DailyPipelineResult.stageCounts` 阶段诊断，经 `DailyRunCoordinator` 写入 `SourceRun.progressJson.pipelineStages`，由 `/source-runs/:id` 的 `diagnostics` 透出。FULL_EVIDENCE 仍只能经 Content Acquisition 成功 + validation PASS + EvidenceUpgradeService 显式产生。

---

### T038 [P] Analysis 复用——主动 Discovery 触发分析

> **实施状态（2026-08-13）：absorbed/completed by Phase 5B。** `DailyPipeline`（`server/pipeline/DailyPipeline.ts`）已通过 `deps.createTask(finalVersionId)` + `deps.runTask(task.id)` 编排复用现有 `AnalysisService`，证据门（SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED → `analysisEligible=false` → 不调用 `createTask()`）与输入就绪门（`INPUT_NOT_READY`）已落实。无独立实现代码，后续 task traversal 不得再识别为未完成。

**目标：** 确保主动 Discovery Pipeline 通过现有 `AnalysisService.createTask()` 触发分析。同旧 Plan T030（无变化）。

---

### T039 [P] Recommendation 复用——Preference 扩展推荐排序

> **实施状态（2026-08-13）：absorbed/completed by Phase 5B。** `DailyPipeline` 每次 run 至多调用一次 `deps.createBatch(recommendationScope)` 复用现有 `RecommendationBatchService`；`recommendationScope` 只含 `analysisCompleted` 的 FULL_EVIDENCE 最终版本，SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 候选不进入 batch。无独立实现代码，后续 task traversal 不得再识别为未完成。

**目标：** 同旧 Plan T031。关键约束：FULL_EVIDENCE 候选 ≠ SEARCH_EVIDENCE 候选。SEARCH_EVIDENCE 候选经 DataQualityGate 后 `analysisEligible=false`，因此 `createTask()` 不被调用 → `no_current_analysis` → `blockReasonFor()` 阻止进入 batch。

---

### T040 DailyJobBrief 数据模型与 Repository

**目标：** 实现 `daily_job_briefs` 表 Repository（含 `discovery_item_ids_json`）。

**文件范围（新增/修改）：**
- `server/daily-brief/dailyBriefRepository.ts` — 新增
- `server/daily-brief/types.ts` — 新增（含 `discoveryItemIds?: string[]`）
- `server/daily-brief/dailyBriefRepository.spec.ts` — 新增

**完成条件：**
同旧 Plan T032 + 新增 `discoveryItemIds` 字段支持。

---

### T041 [P] [US7] [US8] DailyJobBrief API 路由

> **实施状态（2026-08-14）：completed。** `server/daily-brief/dailyBriefRoutes.ts` + `dailyBriefRepository.ts` 已实现只读 API：`GET /daily-job-briefs`（列表，按日期降序）、`GET /daily-job-briefs/today`（今日简报）、`GET /daily-job-briefs/:id`（含 recommendationBatch + discoveryItems 展开）。`today` 的 product-day 按 `DEFAULT_TIMEZONE = Asia/Shanghai` 计算（复用 `todayInTimeZone(now, DEFAULT_TIMEZONE)`），不按各 PlanVersion timezone 动态解析——v0.9 Scheduler officially supported timezone 收敛为 Asia/Shanghai，多 IANA timezone 是未来扩展 contract。`discoveryItems` 从 `discoveryItemIds`（CandidateVersion IDs）展开最小安全视图，不暴露内部 hash/原始行。

**目标：** 同旧 Plan T033。新增 discoveryItems 在 response 中。

---

### T042 [P] [US7] [US8] DailyJobBrief 前端页面

> **实施状态（2026-08-14）：completed。** `src/api/dailyJobBriefApi.ts` + `src/pages/DailyJobBriefPage.vue` + `src/pages/DailyJobBriefPage.spec.ts` 已实现只读简报页：复用 `dailySearchPlanEnabled` 门禁注册 `/daily-job-briefs` 路由与导航；只调用 `/daily-job-briefs/today` + `/:id`，today 以后端 `briefDate` 为真源；推荐（kind/置信度/rationale/条件/证据）+ discovery（title/company/city/evidenceLevel/source）+ coverage + sourceRun 次数 + 4 态空批区分。不触发 Pipeline / 推荐生成 / 直连 DB。

**目标：** 同旧 Plan T034。新增 discovery items section（supplementary——不是第二套推荐）。

---

### T043 [P] Cost Summary 成本追踪

**目标：** 同旧 Plan T035。新增 `estimatedSearchCredits` / `actualSearchCredits`。

---

## Phase 5 — QQ SMTP + NotificationOutbox

**目标：** Provider 无关组件。Secret 引用 `TAVILY_API_KEY`（替换 `OFFERFLOW_JOOLE_API_KEY`）。完整任务描述如下——邮件模板中 SourceRun reference 更新为 Provider-neutral 字段。

**前置：** Phase 4 完成

---

### T044 [P] NotificationChannel 数据模型与 Repository

**目标：** 实现 `notification_channels` 表 Repository。

**文件范围（新增）：**
- `server/notification/channelRepository.ts` — 新增
- `server/notification/types.ts` — 新增
- `server/notification/channelRepository.spec.ts` — 新增

**完成条件：**
1. `createChannel(channel)` — 创建 QQ_SMTP_EMAIL Channel
2. `getChannel(id)` / `listChannels()` — 查询
3. `updateChannel(id, updates)` — 更新配置
4. `deleteChannel(id)` — 删除 Channel + 关联 Secret
5. `secret_ref` 通过 SecretStore 保护
6. API 响应中 `secretRef` 返回 `"***"`
7. 测试覆盖：CRUD、Secret 掩码、删除级联

---

### T045 [P] NotificationChannel API 与测试邮件

**目标：** 实现 NotificationChannel REST API + 测试邮件发送。

**文件范围（新增）：**
- `server/notification/channelRoutes.ts` — 新增
- `server/notification/channelRoutes.spec.ts` — 新增
- `server/notification/channelDtoSchemas.ts` — 新增

**API 端点：**
- `GET /api/notification-channels`
- `POST /api/notification-channels/email`
- `PATCH /api/notification-channels/:id`
- `DELETE /api/notification-channels/:id`
- `POST /api/notification-channels/:id/test`

**完成条件：**
1. `POST .../email` 接收 `secret` 明文 → SecretStore 加密 → `secretRef="***"`
2. `POST .../test` → TEST_EMAIL Outbox → SMTP 发送 → 更新 `lastTestedAt`
3. `PATCH` 可更新 Secret
4. `DELETE` 删除 Channel + 对应 Secret
5. Secret 不进入 API 响应/日志

---

### T046 [P] [US9] [US10] NotificationOutbox 数据模型与 Repository

**目标：** 实现 `notification_outbox` + `notification_links` 表 Repository。

**文件范围（新增）：**
- `server/notification/outboxRepository.ts` — 新增
- `server/notification/outboxRepository.spec.ts` — 新增

**完成条件：**
1. `enqueue(entry)` — INSERT Outbox（含 `idempotency_key`）
2. `claimNext()` — Worker Claim（`locked_at`）
3. `mark SENT / FAILED_RETRYABLE / FAILED_FINAL / ACTION_REQUIRED`
4. `getByIdempotencyKey(key)` — 幂等键查询
5. UNIQUE on `idempotency_key`
6. `releaseStaleLocks(timeout)` — stale lock 回收
7. Notification Links：`linkEntity()` / `listByEntity()`
8. 测试覆盖：入队、幂等拒绝、Claim、状态转换、stale lock

---

### T047 [P] [US9] [US10] SMTP Sender 实现

**目标：** QQ SMTP 邮件发送 Worker（新增依赖 `nodemailer`）。

**文件范围（新增）：**
- `server/notification/SmtpSender.ts` — 新增
- `server/notification/OutboxWorker.ts` — 新增
- `server/notification/SmtpSender.spec.ts` — 新增

**完成条件：**
1. QQ SMTP（`smtp.qq.com:465` TLS）连接
2. 授权码从 `SecretStore.resolve(secretRef)` 获取
3. OutboxWorker 定时轮询（30s）→ claim → SMTP → update status
4. 临时失败 → FAILED_RETRYABLE + 有限退避（1/5/15/30min）
5. 授权失败 → ACTION_REQUIRED（不无限 retry）
6. 静默时段不发送非紧急邮件
7. Worker 运行于 Fastify 进程内

---

### T048 [P] [US9] [US10] 通知触发逻辑

**目标：** Pipeline 中触发通知：高优先级提醒、日报、失败、需操作。

**文件范围（新增）：**
- `server/notification/NotificationTrigger.ts` — 新增
- `server/notification/NotificationTrigger.spec.ts` — 新增

**完成条件：**
1. `triggerHighPriorityAlert(candidateVersionId)` — 条件满足 → HIGH_PRIORITY_ALERT Outbox
2. `triggerDailyBrief(dailyBriefId)` — DAILY_BRIEF Outbox，幂等键 = `dailyBriefId + recipient + templateVersion`
3. `triggerRunFailed(sourceRunId)` — RUN_FAILED Outbox
4. `triggerActionRequired(reason)` — ACTION_REQUIRED Outbox
5. 幂等保护：相同键不得重复 Outbox
6. SourceRun reference 字段使用 Provider-neutral 结构（`queriesAttempted` 等，不使用 Jooble-specific 字段）

---

### T049 [P] [US9] 高优先级邮件内容构建

**目标：** HIGH_PRIORITY_ALERT 邮件内容。

**文件范围（新增）：**
- `server/notification/emailTemplates.ts` — 新增
- `server/notification/emailTemplates.spec.ts` — 新增

**完成条件：**
1. 邮件包含：岗位名称、公司、城市、薪资、发现日期、核心理由、主要风险、原岗位链接、"正式审批请回到电脑端 OfferFlow"
2. 不含：匹配度分数、简历全文、Token/API Key/调试日志/原始 HTML
3. 原岗位链接 HTTP/HTTPS 白名单校验
4. 纯文本或安全 HTML 格式

---

### T050 [P] [US10] 日报邮件内容构建

**目标：** DAILY_BRIEF 邮件（含推荐和空汇报两种）。

**文件范围（修改）：**
- `server/notification/emailTemplates.ts` — 补充日报模板

**完成条件：**
1. 有推荐时：Coverage 摘要 + 推荐列表（每条含岗位/公司/城市/薪资/建议/理由/风险/原链接）+ 审批状态
2. 空日报："今日没有发现值得你处理的新岗位" + 解释（搜索了什么、哪些成功/失败、为什么没推荐、没凑数）
3. 部分成功时标识失败范围
4. 含 discovery items summary（SEARCH_EVIDENCE/MANUAL_REVIEW_REQUIRED 计数）
5. 不含伪造成本数据

---

### T051 [P] 通知中心前端页面

**目标：** 通知中心 + 邮箱配置 UI。

**文件范围（新增）：**
- `src/pages/NotificationsPage.vue` — 新增
- `src/pages/EmailSettingsPage.vue` — 新增
- `src/router/index.ts` — 修改：新增 `/notifications` + `/settings/notifications/email`

**完成条件：**
1. NotificationsPage：Outbox 列表（类型/状态/收件人/attempts/错误/发送时间）、过滤、手动 Retry、关联实体
2. EmailSettingsPage：Channel 配置表单、Test Email 按钮、授权码为 password 类型
3. 遵循现有 Naive UI 风格

---

## Phase 6 — JobJudgment（四档审批）+ Evidence-aware 审批

**目标：** 同旧 Plan Phase 5。新增 evidenceLevel-aware 审批行为。

**前置：** Phase 4 完成

---

### T052 [P] [US11] JobJudgment 数据模型与 Repository

**目标：** 同旧 Plan T044。无实质变化。

---

### T053 [US11] JobJudgment API 路由

**目标：** 同旧 Plan T045。新增 `candidateEvidenceLevel` 在 response 中。

---

### T054 [US11] [EVIDENCE] 四档审批前端页面（日报审批卡 + evidenceLevel context）

**目标：** 在日报页面中实现逐条审批 UI。SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED discovery items 展示为"需人工核实"。

**文件范围（新增/修改）：**
- `src/components/daily-brief/JudgmentCard.vue` — 新增
- `src/components/daily-brief/DiscoveryItemCard.vue` — 新增：SEARCH_EVIDENCE 发现条目卡片
- `src/pages/DailyBriefPage.vue` — 修改：区分 recommendation items 和 discovery items

**完成条件：**
1. Recommendation batch 候选项：FULL_EVIDENCE，正常四档审批
2. Discovery items：SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED
   - 展示：title、company、source domain、snippet、原链接
   - 明确标记"信息不足，需打开原岗位确认"
   - 不展示 MatchAnalysis 相关内容
   - 用户可点击原链接 → 浏览器打开
   - 用户可选择"确认已查看"或跳过
3. 两套 items 视觉区分清晰（不是两套推荐——Discovery items 是 supplementary）
4. keyboard shortcuts 保持

---

### T055 [US11] 审批进度派生逻辑

**目标：** 同旧 Plan T047。无实质变化。

---

### T056 [US12] 智能追问生成（evidenceLevel-aware 抑制）

**目标：** 同旧 Plan T048。新增约束：MANUAL_REVIEW_REQUIRED 候选不触发追问（信息不足时追问无意义）。

**完成条件：**
1. 原有可追问/不应追问逻辑保持
2. 新增：`evidenceLevel !== 'FULL_EVIDENCE'` → **不追问**（信息不足时不追问）
3. 测试覆盖：MANUAL_REVIEW_REQUIRED → 跳过追问

---

## Phase 7 — Preference Learning

**目标：** 同旧 Plan Phase 6。新增 evidenceLevel-aware signal 生成约束。

**前置：** Phase 6 完成

---

### T057 [US13] PreferenceSignal 提取与 Repository

**目标：** 同旧 Plan T049。新增 evidenceLevel context in signal generation。

**完成条件：**
1. 原有 signal extraction 逻辑保持
2. 新增约束：MANUAL_REVIEW_REQUIRED 候选的 judgment → signal 标记 `confidence` 较低（信息不足）
3. 不因"信息不足→点击不适合"自动形成强负规则

---

### T058 [US13] PreferenceRule 数据模型与 Repository

**目标：** 同旧 Plan T050。无实质变化。

---

### T059 [US13] PreferenceRule 提案与激活逻辑

**目标：** 同旧 Plan T051。无实质变化。

---

### T060 [US13] [US14] PreferenceRule 对推荐与搜索的影响

**目标：** 同旧 Plan T052。无实质变化。

---

### T061 [US14] [US15] Repeated Mistake Protection 与 Exploration 位

**目标：** 同旧 Plan T053。无实质变化。

---

### T062 [US13] PreferenceRule API 与用户确认

**目标：** 同旧 Plan T054。无实质变化。

---

### T063 [US13] [US14] [US15] 偏好记忆前端页面

**目标：** 同旧 Plan T055。无实质变化。

---

## Phase 8 — Production Validation

**目标：** 同旧 Plan Phase 7。Provider-specific 更新。

**前置：** Phase 1–7 全部完成

---

### T064 Production Migration 演练

**目标：** 验证 v8 → v9 完整 migration 流程。同旧 Plan T056。

---

### T065 [P] Backup / Restore 验证

**目标：** 同旧 Plan T057。

---

### T066 [P] Scheduler 恢复与重试验证

**目标：** 同旧 Plan T058。

---

### T067 [P] SMTP 失败矩阵验证

**目标：** 同旧 Plan T059。

---

### T068 [P] [EVIDENCE] Evidence-aware 端到端验收

**目标：** 在真实环境中验证 Evidence Model 全链路。

**验证清单：**
1. SEARCH_EVIDENCE CandidateVersion 可创建（via Tavily Search）
2. SEARCH_EVIDENCE → NOT analysis eligible（commitDecision）
3. SEARCH_EVIDENCE → NOT in RecommendationBatch
4. SEARCH_EVIDENCE → appears in DailyJobBrief.discoveryItems
5. MANUAL_REVIEW_REQUIRED → NOT analysis eligible
6. MANUAL_REVIEW_REQUIRED → appears in DailyJobBrief.discoveryItems
7. FULL_EVIDENCE → analysis eligible → MatchAnalysis
8. FULL_EVIDENCE → enters RecommendationBatch
9. Evidence Upgrade：SEARCH_EVIDENCE → Manual Capture → FULL_EVIDENCE（same Candidate）
10. evidence_upgrade：新 CandidateVersion，supersedesVersionId 正确
11. no_current_analysis 仍阻止 RecommendationBatch
12. Source Policy 正确判定 SEARCH_ONLY / SEARCH_AND_FETCH / CONDITIONAL_FETCH

---

### T069 [P] 连续 ≥3 个自然日真实运行验证计划

**目标：** 同旧 Plan T060。Provider 相关更新。

**验证清单：**
1. **第 1 日：** Tavily Search → Search Evidence + Source Policy → SEARCH_EVIDENCE/MANUAL_REVIEW_REQUIRED → discoveryItems；FULL_EVIDENCE（Policy B）→ MatchAnalysis → RecommendationBatch → DailyBrief；邮件发送
2. **第 2 日：** 重复岗位不重复创建；变化岗位新 CandidateVersion；SEARCH_EVIDENCE 旧岗正确不分析
3. **第 3 日：** 四档判断 → PreferenceSignal；Rule 激活；Evidence Upgrade 路径验证（SEARCH_EVIDENCE → Manual Capture → FULL_EVIDENCE）

---

### T070 [P] JobJudgment 修改 / 撤销 → Preference 重算验证

**目标：** 同旧 Plan T061。

---

### T071 [P] Recommendation Quality Eval

**目标：** 同旧 Plan T062。额外验证：SEARCH_EVIDENCE 候选不在任何推荐中。

---

### T072 [P] Cost Visibility 验证

**目标：** 同旧 Plan T063。额外验证：`actualSearchCredits` 来源真实 Tavily response。

---

### T073 [P] README / Changelog / Architecture 文档更新

**目标：** 同旧 Plan T064。

---

### T074 全量回归测试

**目标：** 同旧 Plan T065。

---

## 执行分类说明

同旧 Plan。`/speckit.analyze` 将划分 cc-auto vs main 执行。

---

## 任务统计

| 统计项 | Before (Tasks v1.0) | After (Tasks v2.0) |
|--------|---------------------|---------------------|
| **Total Tasks** | 65 | 74 |
| **Phase 数量** | 8 | 8 |
| **Jooble-specific Tasks** | 8 (Phase 0) + scattered | **0**（全部删除/重写） |
| **Tavily-specific Tasks** | 0 | 8 (Phase 0) |
| **Evidence-aware Tasks [EVIDENCE]** | 0 | 9 |
| **[GATE] Tasks** | 5 | 5（全部替换为 Tavily） |
| **[P] Parallel Tasks** | 29 | 31 |

### 各 Phase Task 数

| Phase | 名称 | Before | After |
|-------|------|--------|-------|
| Phase 0 | Provider Validation Gate | 8 (Jooble) | **8 (Tavily Smoke)** |
| Phase 1 | Schema Migration + Evidence Foundation | 7 | **6** |
| Phase 2 | Shared Ingestion + Search Evidence | 6 | **6** |
| Phase 3 | SearchPlan + Scheduler + Tavily Discovery | 12 | **12** |
| Phase 4 | Source Policy + Content Acquisition + Pipeline | 8 | **11** |
| Phase 5 | QQ SMTP + Outbox | 8 | **8** |
| Phase 6 | JobJudgment + Evidence-aware | 5 | **5** |
| Phase 7 | Preference Learning | 7 | **7** |
| Phase 8 | Production Validation | 10 | **11** |

---

## 关键路径

```
T001–T008（Tavily Smoke Gate）
  → T009–T014（Schema Migration + Evidence Foundation）
    → T015–T020（Shared Ingestion + Search Evidence + Evidence Upgrade）
      → T021–T032（SearchPlan + Scheduler + Tavily Discovery）
        → T033–T043（Source Policy + Content Acquisition + Pipeline + DailyBrief）
          → T044–T051（QQ SMTP + Outbox）
          → T052–T056（JobJudgment + Evidence-aware）
            → T057–T063（Preference Learning）
              → T064–T074（Production Validation）
```

Phase 5 和 Phase 6 可在 Phase 4 完成后并行。

Phase 7 严格依赖 Phase 6。

---

## 最高风险 Task

| # | Task | 风险 |
|---|------|------|
| 1 | T001–T008 | **Tavily Smoke Gate** — 如果真实覆盖不足，整个 v0.9 Discovery 可能失去 P0 Provider |
| 2 | T005 | **Tavily Terms/AUP Compliance** — 持久化 Search Evidence 的合规性硬前提 |
| 3 | T009/T011 | **SQLite CHECK Migration** — 两张表重建，需保证数据完整性和 v0.8 回归 |
| 4 | T013 | **evidenceLevel-aware commitDecision** — 核心逻辑变更，SEARCH_EVIDENCE ≠ analysis eligible |
| 5 | T017 | **Shared Ingestion Extraction** — 从 RadarCaptureService 抽取核心 |
| 6 | T019 | **Evidence Upgrade** — SEARCH→FULL 版本链，dedupe 关键路径 |
| 7 | T033/T034 | **Source Policy + Evidence Mapping** — 招聘平台 SEARCH_ONLY 判定 |
| 8 | T068 | **Evidence-aware E2E** — 全链路验收 |

---

## Constitution Check

所有 74 个 Task 均通过 Constitution 十二项原则检查。

关键检查（新增）：
- **One Domain, No Shadow Models** ✅ — SEARCH_EVIDENCE 候选进入现有 `radar_candidates` 和 `radar_candidate_versions`；不创建 `DiscoveryCandidate`、`SearchRecommendationBatch`
- **Immutable Evidence** ✅ — evidence_upgrade 创建新不可变版本（旧 SEARCH_EVIDENCE 版本保留）
- **Cost Is a Product Constraint** ✅ — `actualSearchCredits` 来源真实 Tavily response，不估算
- **Third-Party Replaceability** ✅ — Search Evidence 基于 Tavily/Brave 共同最小语义；Tavily DTO 停留在 Adapter boundary
- **Human Authority** ✅ — MANUAL_REVIEW_REQUIRED 候选由用户自己打开原链接确认

---

## Scope Check

所有 Task 均在 spec.md FR-001～FR-072、plan.md v3.0 和 data-model.md v2.0 定义的范围内。

---

## Git 约束确认

- ✅ 未修改 `src/` `server/` `browser-extension/` 业务源码
- ✅ 仅修改 `specs/001-daily-job-hunter/tasks.md`

---

## 停止点

**本轮已完成 Tasks Amendment（`/speckit.tasks` Amendment）。**

- 未执行 `/speckit.analyze`。
- 未执行 `/speckit.implement`。
- 未修改业务源码。
- 未执行 Migration。
- 未修改数据库。
- 未 commit。
- 未 push。
- 未启动 cc-auto。

**等待用户审核 tasks.md 后进入 `/speckit.analyze`。**
