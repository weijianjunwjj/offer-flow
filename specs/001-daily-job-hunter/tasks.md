# OfferFlow v0.9 实施任务清单：每日岗位猎手

> **对应 Spec：** `specs/001-daily-job-hunter/spec.md`
> **对应 Plan：** `specs/001-daily-job-hunter/plan.md`
> **对应 PRD：** `docs/prd/offerflow-v0.9.md` (v2.3 Final Candidate)
> **创建日期：** 2026-08-11
> **状态：** 等待 `/speckit.analyze`
> **前置阶段：** PRD ✅ → Constitution ✅ → Specification ✅ → Clarify ✅ → Plan ✅ → **Tasks ← 本轮**

---

## 约定

- `[P]` = 可并行执行（无共享写入、无前置状态依赖、不覆盖同一文件）
- `[USx]` = 对应 User Story x（见 spec.md）
- `[GATE]` = 审批门——必须通过才能继续后续阶段
- 标记为 `[P]` 的 Task 不存在写入冲突

---

## Phase 0 — Jooble Provider Validation Gate

**目标：** 在投入完整 Discovery 基建之前，先验证 Jooble REST API 的真实覆盖与数据质量。只有 PASS 才允许进入完整的 Jooble Discovery 实现。

**失败处理：** 如果 Provider Validation 返回 FAIL → 记录 Provider Validation Failed，不偷改 Radar 质量规则、不爬专业招聘平台补数据、不根据 snippet 编造完整 JD、回到 Provider Decision。

---

### T001 [GATE] 编写 Jooble Provider Validation 独立验证脚本

**目标：** 创建独立于业务代码的验证脚本，对 Jooble API 进行真实请求测试。

**文件范围（新增）：**
- `scripts/provider-validation/jooble-validate.ts` — 独立验证脚本（仅依赖 `node-fetch` 或内置 `fetch`）

**完成条件：**
1. 脚本可以通过命令行独立运行（`pnpm run provider:validate`）
2. 从环境变量 `OFFERFLOW_JOOLE_API_KEY` 读取 API Key
3. 不依赖任何 OfferFlow 业务服务、数据库或 Fastify 启动
4. 不写数据库，输出写入 `scripts/provider-validation/output/` 目录（JSON 文件）
5. 验证项必须覆盖 T002–T007 的所有检查点

**备注：** 此脚本是临时验证工具，不纳入正式业务代码。API Key 通过环境变量注入，不进 Git。

---

### T002 [GATE] 验证 Jooble API Key 可达性

**目标：** 确认 API Key 能否通过申请获取，以及申请到的 Key 能否真实调用 Jooble API。

**具体检查：**
1. API Key 申请流程是否真实可用（记录申请 URL：`https://jooble.org/api/about`）
2. API Key 认证是否生效（返回 HTTP 200，非 401/403）
3. 无效 API Key 是否返回明确的 auth 错误

**完成条件：**
1. 验证脚本输出 `auth.status` = `pass` | `fail` | `blocked`
2. 如果申请中/待 approval → 记录 `blocked` 和原因
3. 如果 API Key 无效 → 记录 `fail` 和 HTTP 状态码 / 错误 body

---

### T003 [GATE] 验证中国地区搜索真实可用

**目标：** 确认 Jooble API 在中国地区是否返回有效岗位数据。

**具体检查：**
1. `location=苏州` 搜索是否返回 `jobs` 数组
2. `location=无锡` 搜索是否返回 `jobs` 数组
3. `location=上海` 搜索是否返回 `jobs` 数组
4. 跨多个城市的结果是否真实（标题/公司/地点与中国市场一致）

**完成条件：**
1. 每个目标城市的验证结果记录：`{ city, totalCount, sampleSize, hasRealJobs }`
2. 至少一个目标城市返回 `totalCount > 0` 且 `jobs` 数组非空
3. 记录典型样本的 `title` / `company` / `location` 实际内容

---

### T004 [GATE] 验证 Jooble API 返回字段与官方 Contract 的一致性

**目标：** 逐字段确认 Jooble 的实际响应是否符合 `contracts/search-provider.md` 中记录的 Jooble API Contract。

**具体检查：**
1. `jobs[].id` — 是否存在、是否字符串、是否唯一
2. `jobs[].title` — 是否存在、是否非空
3. `jobs[].company` — 是否存在、是否非空
4. `jobs[].location` — 是否存在
5. `jobs[].salary` — 是否存在、格式如何（文本 vs 数字）
6. `jobs[].snippet` — 是否存在、平均长度、是否包含描述内容
7. `jobs[].source` — 是否存在、常见值有哪些
8. `jobs[].link` — 是否存在、是否是有效 URL
9. `jobs[].updated` — 是否存在、格式如何
10. `jobs[].type` — 是否存在、常见值有哪些
11. `totalCount` — 是否存在、是否与 `jobs` 数组长度逻辑一致

**完成条件：**
1. 输出字段覆盖矩阵：每个字段的 `{ exists, type, nonEmptyRate, sampleValue }`
2. 标注与官方文档的差异项
3. 标注哪些字段可能为 null / undefined / 空字符串

---

### T005 [GATE] 验证 Jooble 真实结果的数据质量

**目标：** 评估 `snippet` 的实际内容质量，判断多少结果具备进入 Radar 的充分事实。

**具体检查：**
1. `snippet` 平均长度（字符数）
2. `snippet` 是否包含 JD 核心要素（技术栈、职责、要求）的典型描述
3. 多少结果的 `snippet` 只有一句话或极其简短
4. 多少结果的 `snippet` 包含足够的文本可以成为 `visibleText`
5. 薪资字段可解析率（`salary` 文本 → 可尝试解析为 `minK/maxK` 的比例）
6. 多少真实样本达到"可进入正式 MatchAnalysis 的最低事实要求"

**完成条件：**
1. 输出数据质量报告：`{ snippetAvgLength, snippetDistribution, salaryParseableRate, analysisEligibleEstimate }`
2. 明确判断：Jooble 结果是否可以至少为部分 CandidateVersion 提供足够事实进入正式 MatchAnalysis
3. 标注数据质量边界情况（例如：只有 title + company + location，snippet 为空或极短）

---

### T006 [GATE] 验证 source / link 可追踪性

**目标：** 确认 Jooble 返回的 `source` 和 `link` 字段行为，判断是否可用于来源追踪和去重。

**具体检查：**
1. `source` 字段常见值分布（如 "BOSS 直聘"、"拉勾"、"前程无忧" 等）
2. `link` 字段是否是有效 URL、是否可点击跳转
3. `link` 是否指向专业招聘平台页面（BOSS/拉勾/猎聘等）
4. 同一岗位（同 `id`）多次请求是否返回相同 `link` 和 `source`
5. 不同来源的 `link` 域名差异

**完成条件：**
1. 输出 `source` 分布报告和 `link` 域名分布报告
2. 确认 `source`/`link` 可以可靠用于 provenance 追踪
3. 标注 `link` 指向专业招聘平台的情况（这些链接在邮件中仍然可以展示，但不会自动抓取）

---

### T007 [GATE] 验证 rate-limit 与 quota 真实环境行为

**目标：** 观察 Jooble API 的频率限制行为，为后续 Provider 实现提供真实参数。

**具体检查：**
1. 短时间内连续请求（如 5 次 / 5 秒）是否触发 rate limit
2. 响应头中是否有 rate limit 相关信息
3. 速率限制触发后的错误表现（HTTP 状态码、错误 body）
4. 单日可请求总量的大致范围（在有限测试范围内）
5. `totalCount` 与实际返回 `jobs` 数量的关系

**完成条件：**
1. 记录 rate limit 观察结果
2. 如果真实触发 rate limit → 记录触发条件和恢复时间
3. 如果无法在测试中触发 → 记录"未观察到 rate limit"
4. 给出 Provider 实现的 rate-limit 策略建议

---

### T008 [GATE] Provider Validation Gate 裁决

**目标：** 汇总 T002–T007 的验证结果，做出 PASS / FAIL 裁决。

**完成条件：**
1. 生成 `scripts/provider-validation/output/validation-report.md` — 包含所有验证项目的结论
2. 明确判定：`PASS`（可进入 V9-1 完整实现）或 `FAIL`（停止 Jooble 后续 Tasks，回到 Provider Decision）
3. 如果 PASS → 记录已知风险和数据质量边界
4. 如果 FAIL → 记录失败原因和建议的替代 Provider 方向
5. **禁止在 FAIL 后**：降低 Radar 数据质量要求、爬专业招聘平台、根据 snippet 编造完整 JD

---

## Phase 1 — Shared Radar Ingestion Core

**目标：** 从现有 `RadarCaptureService` 抽取共享 `RadarIngestionService`，使 Browser Capture 和 Active Discovery 使用同一事实入口。扩展 `capture_method` CHECK 以支持 `'api_discovery'`。保持 Browser Capture 行为完全兼容。

**前置：** Phase 0 — Provider Validation Gate PASS

---

### T009 [P] 补充 Browser Capture 当前行为回归测试

**目标：** 在抽取 Shared Ingestion 之前，固定当前 `RadarCaptureService.materializeItem()` 的完整行为，确保抽取不引入回归。

**文件范围（新增）：**
- `server/radar/service.spec.ts` — **新建文件**：补充 materializeItem 完整链路测试

**完成条件：**
1. 覆盖 `materializeItem` 的以下路径：
   - 新岗位（new_identity）：创建 Snapshot + SourceRecord + Candidate + Version
   - 无变化岗位（no_change）：仅创建 Snapshot，不创建新 Version
   - 实质性变化（material_change）：创建 Snapshot + 新 CandidateVersion
   - Snapshot-only（snapshot_only / extraction_regression）：仅创建 Snapshot
   - Identity conflict（identity_conflict）：仅创建 Snapshot，不创建 Candidate
   - Ambiguous change（ambiguous_change）：仅创建 Snapshot
2. 覆盖 `captureSessionId` 正常写入
3. 覆盖 `captureMethod` 现有五个值（`boss_current_page` / `generic_visible_text` / `pasted_text` / `shared_link_and_text` / `json_import`）
4. 所有测试在抽取前后保持通过

---

### T010 [P] 固定当前 normalize / identity / fingerprint / material change 行为测试

**目标：** 为低层 Ingestion 函数补充独立单元测试，确保抽取到共享服务后语义不变。

**文件范围（新增/修改）：**
- `server/radar/commitDecision.spec.ts` — 补充 fingerprint、material change 边界测试
- `server/radar/normalizationV8_3.spec.ts` — 确保现有 normalize 测试完整
- `server/radar/ingestion/ingestionIdentity.spec.ts` — 新增：identity resolution 独立测试

**完成条件：**
1. fingerprint 对相同输入产生相同 hash
2. fingerprint 对不同输入产生不同 hash
3. material change 判定逻辑覆盖：salary change、location change、title change、description change、组合变化
4. identity resolution 覆盖：同 providerKey + 同 externalRecordId → 同一 identity；不同 providerKey → 不同 identity；sourceUrl 标准化去重
5. 现有 `commitDecision.spec.ts` 和 `normalizationV8_3.spec.ts` 全部通过

---

### T011 从 RadarCaptureService 抽取共享 RadarIngestionService

**目标：** 将 `materializeItem` 的核心 Ingestion 逻辑提升为独立的 `RadarIngestionService`。Browser Capture 改为调用共享服务。行为完全等价。

**文件范围（新增/修改）：**
- `server/radar/ingestion/RadarIngestionService.ts` — 新增：共享 Ingestion 核心
- `server/radar/ingestion/IngestionInput.ts` — 新增：输入契约类型
- `server/radar/ingestion/IngestionOutcome.ts` — 新增：输出结果类型
- `server/radar/service.ts` — 修改：`materializeItem` 改为调用 `RadarIngestionService.ingest()`
- `server/radar/ingestion/RadarIngestionService.spec.ts` — 新增：共享 Ingestion 独立测试

**完成条件：**
1. `RadarIngestionService.ingest(input)` 接收标准化的 `RadarIngestionInput`，返回 `RadarIngestionOutcome`
2. 核心逻辑包含：`buildSnapshot` → `normalizeCandidateFields` → `resolveIdentity` → `decideCommit` → 分路径执行
3. `RadarCaptureService.materializeItem()` 改为构造 `RadarIngestionInput`（含 `captureSessionId`、`captureMethod`），调用 `RadarIngestionService.ingest()`
4. Browser Capture 的所有现有行为不变（Snapshot/Candidate/Version/SourceRecord 创建语义完全一致）
5. 现有 `server/radar/service.spec.ts` 全部通过
6. 新增 `RadarIngestionService.spec.ts` 覆盖与 Browser Capture 相同的 ingestion 路径

---

### T012 [P] 支持 API Discovery 的 Ingestion 输入（captureSessionId=null, captureMethod='api_discovery'）

**目标：** `RadarIngestionService` 支持来自主动搜索来源的输入：`captureSessionId=null`、`captureMethod='api_discovery'`。

**文件范围（修改）：**
- `server/radar/ingestion/RadarIngestionService.ts` — 确保 captureSessionId=null 不触发 session-based 逻辑
- `server/radar/ingestion/IngestionInput.ts` — `captureSessionId: string | null`

**完成条件：**
1. `captureSessionId=null` 时 Snapshot 正常创建（不报错、不伪造 sessionId）
2. `captureMethod='api_discovery'` 可以写入 Snapshot（需要 Phase 1 migration 先完成）
3. Snapshot / Candidate / Version / SourceRecord 创建行为与 Browser Capture 路径一致
4. SourceRecord 正确记录 `providerKey='jooble'`
5. 新增测试覆盖 `captureSessionId=null` + `captureMethod='api_discovery'` 路径

---

### T013 [P] 补充 Active Discovery 来源的 Ingestion 测试

**目标：** 为 `api_discovery` 路径补充独立测试，不与 Browser Capture 测试混用。

**文件范围（新增）：**
- `server/radar/ingestion/apiDiscoveryIngestion.spec.ts` — 新增：API Discovery ingestion 路径测试

**完成条件：**
1. 同 source（jooble）同 externalRecordId → 同一 Candidate（去重）
2. 同一 candidate 被多 keyword 命中 → 不重复创建 Candidate
3. Material change → 新 CandidateVersion
4. Unchanged → 不创建新 Version
5. Snapshot `captureSessionId=null` + `captureMethod='api_discovery'` 正确写入
6. SourceRecord `providerKey='jooble'` 正确记录
7. `sourceUrl` / `sourceDomain` 正确从 `link` 解析

---

### T014 高风险 Migration：扩展 capture_method CHECK 约束（表重建）

**目标：** 在 `radar_capture_snapshots` 表的 `capture_method` CHECK 约束中新增 `'api_discovery'`。

**文件范围（新增/修改）：**
- `server/migrations/dailyJobHunterSchemaV9.ts` — 新增：包含表重建 migration 的 schema v9 定义
- `server/migrations.ts` — 修改：在 `SCHEMA_MIGRATIONS` 数组中注册 v9 migration
- `server/schema.ts` — 修改：`LATEST_SCHEMA_VERSION` 提升到 9

**迁移方式（SQLite 表重建，与 schema v8 的 `radar_actions` 表重建流程一致）：**
```
backupDatabase()
  ↓
transaction
  ↓
CREATE TABLE radar_capture_snapshots_v9_new（同结构 + 扩展 CHECK）
  ↓
INSERT INTO ... SELECT ...（copy 所有既有行）
  ↓
preserve FK / indexes / constraints
  ↓
DROP TABLE radar_capture_snapshots
  ↓
ALTER TABLE radar_capture_snapshots_v9_new RENAME TO radar_capture_snapshots
  ↓
PRAGMA foreign_key_check
  ↓
integrity verification
```

**完成条件：**
1. Miration 文件 `dailyJobHunterSchemaV9.ts` 遵循现有 migration 模式（参考 `server/migrations/radarDomainSchemaV7.ts`）
2. 扩展后的 CHECK 包含：`'boss_current_page'`, `'generic_visible_text'`, `'pasted_text'`, `'shared_link_and_text'`, `'json_import'`, `'api_discovery'`
3. Fresh DB 初始化创建 v9 schema（含扩展 CHECK）
4. v8 → v9 升级：所有既有行完整复制、不改写任何数据
5. 升级后 v0.8 Radar 功能回归测试通过（Browser Capture、Analysis、Recommendation）
6. 备份文件在 migration 前自动创建
7. `PRAGMA foreign_key_check` 无错误
8. **绝对禁止**：`PRAGMA writable_schema` 直接手改生产 schema、把 `api_discovery` 假装成 `json_import`

**前置：** T009、T010、T011（确保 Ingestion 行为固定后再做 migration）

---

### T015 表重建 Migration 回归与恢复验证

**目标：** 验证 v8 → v9 migration 的完整性和可恢复性。

**文件范围（新增/修改）：**
- `server/migrations/dailyJobHunterSchemaV9.spec.ts` — 新增：migration 测试
- `scripts/migrations.selftest.ts` — 修改：补充 v9 migration selftest entry

**完成条件：**
1. Fresh DB 创建 v9 schema → 所有 v0.8 表 + 新增 CHECK 正常
2. v8 DB → v9 升级 → 所有既有数据不丢失
3. Backup → migration → restore → 数据一致
4. v0.8 Radar 核心操作在升级后的 DB 上回归通过
5. `captureMethod='api_discovery'` 可以在升级后的表中写入
6. 旧 `captureMethod` 值不受影响
7. 故意写非法 `captureMethod` → 被 CHECK 拒绝
8. `PRAGMA foreign_key_check` 通过

---

## Phase 2 — SearchPlan + Scheduler + Jooble Discovery

**目标：** 构建每日找岗计划的配置、版本、调度与主动发现能力。实现 Jooble REST API Provider 接入。

**前置：** Phase 1 — Shared Radar Ingestion Core 完成

---

### T016 [P] [US1] DailySearchPlan 与 DailySearchPlanVersion 数据模型与 Repository

**目标：** 实现 `daily_search_plans` 和 `daily_search_plan_versions` 两张表的完整 CRUD Repository。

**文件范围（新增）：**
- `server/search-plan/searchPlanRepository.ts` — 新增：Plan 与 PlanVersion Repository
- `server/search-plan/searchPlanRepository.spec.ts` — 新增：Repository 测试
- `server/search-plan/types.ts` — 新增：Plan / PlanVersion 类型定义

**完成条件：**
1. `createPlan(name)` — 创建 Plan（status='active'）+ 首个 PlanVersion（version=1）在同一事务中
2. `getPlan(id)` — 返回 Plan + activeVersion
3. `listPlans(filter?)` — 按 status 过滤
4. `createVersion(planId, config)` — 创建新 Version（version 递增），不改变 activeVersionId
5. `activateVersion(planId, versionId)` — 将 Plan 的 activeVersionId 指向指定 Version，设置 activatedAt
6. `updateStatus(planId, status)` — 更新 Plan status（active/paused/deleted）
7. `getVersion(id)` — 返回单个 Version
8. PlanVersion JSON 字段（cities_json 等）正确序列化/反序列化
9. `searchPlanRepository.spec.ts` 覆盖所有 CRUD 路径
10. 遵循现有 Repository 模式（参考 `server/repositories/jobRepository.ts`）

---

### T017 [P] [US1] DailySearchPlan API 路由

**目标：** 实现 SearchPlan 的 REST API 端点。

**文件范围（新增）：**
- `server/search-plan/searchPlanRoutes.ts` — 新增：SearchPlan API 路由
- `server/search-plan/searchPlanRoutes.spec.ts` — 新增：路由测试
- `server/search-plan/searchPlanDtoSchemas.ts` — 新增：请求/响应 DTO Schema

**API 端点：**
- `POST /api/daily-search-plans` — 创建 Plan（含首个 Version）
- `GET /api/daily-search-plans` — 列出 Plans
- `GET /api/daily-search-plans/:id` — 获取 Plan 详情
- `POST /api/daily-search-plans/:id/versions` — 创建新 Version
- `POST /api/daily-search-plans/:id/activate` — 激活指定 Version
- `POST /api/daily-search-plans/:id/pause` — 暂停 Plan
- `POST /api/daily-search-plans/:id/resume` — 恢复 Plan

**完成条件：**
1. 所有端点遵循 `contracts/api.md` 的请求/响应格式
2. DTO 校验（Zod schema）覆盖必填字段
3. `POST /api/daily-search-plans` 在创建 Plan 的同时创建首个 PlanVersion
4. `POST /api/daily-search-plans/:id/versions` 创建不可变的 PlanVersion（version 递增）
5. 路由注册到 Fastify（在 `server/routes/` 或通过主入口注册）
6. 路由测试覆盖：正常创建、参数缺失、Plan 不存在、状态转换合法性
7. HTTP 状态码遵循 `contracts/api.md` 规范

---

### T018 [P] [US1] DailySearchPlan 前端配置页面

**目标：** 创建找岗计划的配置 UI。

**文件范围（新增）：**
- `src/pages/SearchPlanPage.vue` — 新增：找岗计划配置页
- `src/components/search-plan/SearchPlanEditor.vue` — 新增：计划编辑器组件
- `src/components/search-plan/CityConfigPanel.vue` — 新增：城市配置面板
- `src/components/search-plan/KeywordEditor.vue` — 新增：关键词编辑组件
- `src/router/index.ts` — 修改：新增 `/radar/search-plan` 路由

**完成条件：**
1. 创建新 Plan 的表单：name、cities（含优先级）、roleDirections、baseKeywords
2. 配置项：sourceConfigs（至少可选 Jooble）、schedule（dailyAt 时间选择器）、scanBudget、analysisBudget
3. 保存后创建 Plan + 首个 Version
4. 显示当前活跃 Version 的配置摘要
5. 修改配置时创建新 Version（不可覆盖旧版本）
6. Pause / Resume 按钮
7. 遵循现有 Naive UI 组件风格（`src/components/radar/*.vue` 参考）

---

### T019 [P] SearchProviderAdapter 接口定义与类型

**目标：** 定义 `SearchProviderAdapter` 接口和所有相关类型，但不实现具体 Provider。

**文件范围（新增）：**
- `server/search-provider/SearchProviderAdapter.ts` — 新增：Adapter 接口
- `server/search-provider/types.ts` — 新增：SearchTask、SearchResultItem、SearchProviderResult、SearchCoverage、FailedScope、SearchProviderErrorCode 等类型
- `server/search-provider/errors.ts` — 新增：8 种 Provider Error Code + 错误分类

**完成条件：**
1. 接口与 `contracts/search-provider.md` 完全一致
2. `SearchProviderErrorCode` 八种：`VALID_EMPTY` / `AUTH_ERROR` / `RATE_LIMITED` / `TIMEOUT` / `NETWORK_ERROR` / `MALFORMED_RESPONSE` / `PROVIDER_UNAVAILABLE` / `ACTION_REQUIRED`
3. `SearchResultItem` 不包含 Candidate 业务语义
4. `SearchCoverage` 含 `taskResults[]`（每个 task 的详细结果）
5. 类型文件独立，不导入 Radar 或 Scheduler 模块

---

### T020 [P] SecretStore 抽象与实现

**目标：** 实现 `SecretStore` 抽象，支持 Production（Windows DPAPI）和 Development（环境变量）两种模式。

**文件范围（新增）：**
- `server/secret/SecretStore.ts` — 新增：SecretStore 抽象接口
- `server/secret/WindowsDpapiSecretStore.ts` — 新增：Windows DPAPI 实现（Production）
- `server/secret/EnvSecretStore.ts` — 新增：环境变量实现（Development/Test）
- `server/secret/SecretStore.spec.ts` — 新增：SecretStore 测试

**完成条件：**
1. `SecretStore` 接口：`store(key, value): Promise<string>` → 返回 `secretRef`；`resolve(secretRef): Promise<string>` → 返回明文
2. `WindowsDpapiSecretStore`：使用 Windows DPAPI 加密，解密能力绑定当前 Windows 用户/机器
3. `EnvSecretStore`：从环境变量读取，用于本地开发和测试
4. SecretRef 不包含明文
5. `resolve` 失败时抛出明确错误（可用于通知 `ACTION_REQUIRED`）
6. 不引入 Vault / KMS / 外部密钥管理服务
7. `EnvSecretStore` 默认用于 `NODE_ENV=development` 或 `OFFERFLOW_SECRET_STORE_MODE=env`
8. 测试文件覆盖：store → resolve 往返、错误处理

---

### T021 Jooble REST API Provider 实现

**目标：** 实现 P0 `SearchProviderAdapter`：Jooble REST API。

**文件范围（新增）：**
- `server/search-provider/jooble/JoobleSearchProvider.ts` — 新增：Jooble Provider 实现
- `server/search-provider/jooble/joobleFieldMapping.ts` — 新增：Jooble 字段映射逻辑
- `server/search-provider/jooble/joobleRateLimiter.ts` — 新增：Token Bucket 速率限制
- `server/search-provider/jooble/JoobleSearchProvider.spec.ts` — 新增：Jooble Provider 测试（mock HTTP）

**完成条件：**
1. 实现 `SearchProviderAdapter` 接口（`providerKey='jooble'`, `providerVersion='1.0.0'`）
2. API Key 从 `SecretStore` 读取
3. 请求格式：`POST /api/<API_KEY>` + `{ keywords, location, salary?, page?, ResultOnPage? }`
4. 响应解析：逐字段映射（`id→externalRecordId`, `title/location/salary/snippet/source/link/updated`）
5. 完整 API 原始响应写入 `rawResponse`（每个 SearchResultItem）
6. 分页：`page` 参数从 1 开始，受 `scanBudget.maxPagesPerTask` 限制
7. Token Bucket 速率限制（最小请求间隔）
8. 错误分类：HTTP 200 + jobs=[] → `VALID_EMPTY`；401 → `AUTH_ERROR`；429 → `RATE_LIMITED`；timeout → `TIMEOUT`；5xx → `PROVIDER_UNAVAILABLE`；malformed JSON → `MALFORMED_RESPONSE`
9. `AbortSignal` 支持取消
10. 测试文件覆盖：成功返回、VALID_EMPTY、AUTH_ERROR、RATE_LIMITED、TIMEOUT、MALFORMED_RESPONSE、PROVIDER_UNAVAILABLE、速率限制行为

---

### T022 [P] SearchTask 展开逻辑

**目标：** 根据 `DailySearchPlanVersion` 配置展开为 `SearchTask[]` 列表。

**文件范围（新增）：**
- `server/pipeline/taskExpansion.ts` — 新增：SearchTask 展开逻辑
- `server/pipeline/taskExpansion.spec.ts` — 新增：展开逻辑测试

**完成条件：**
1. 基础展开：`city × roleDirection × keyword × source`
2. `baseKeywords` 与 `expandedKeywords` 分别展开为独立 task（标记 keyword source）
3. 每个 SearchTask 包含：`city`、`roleDirection`、`keyword`、`taskKey`（如 `"苏州×前端开发×React"`）
4. `expandedKeywords` 的 task 记录：来源 PreferenceRule、规则版本、为何扩展
5. Scan Budget 控制：`maxTotalPages` 总量限制在展开时计算
6. 测试覆盖：单城市单词、多城市多方向多关键词、含 expandedKeywords、空配置边界

---

### T023 Scheduler 核心实现

**目标：** 实现运行于 Fastify 进程内的每日 Scheduler。

**文件范围（新增）：**
- `server/scheduler/DailyScheduler.ts` — 新增：Scheduler 核心
- `server/scheduler/schedulerState.ts` — 新增：调度状态管理
- `server/scheduler/DailyScheduler.spec.ts` — 新增：Scheduler 测试

**完成条件：**
1. Fastify 启动时初始化 Scheduler（`initSchema` → 注册路由 → 检查错过 Schedule → 启动 Scheduler → listen）
2. `setTimeout` 链调度（非 setInterval，避免重叠）
3. 同一 Plan 最多一个活跃 SourceRun（pending/running 状态拒绝新触发）
4. 四种触发类型：`SCHEDULED` / `CATCH_UP` / `MANUAL` / `RETRY`
5. Fire 流程：冻结 PlanVersion → 展开 SearchTask → 创建 SourceRun → 执行 Pipeline
6. 服务关闭时通过 Fastify `onClose` 清理 timer
7. `checkMissedSchedules()`：服务恢复时检查错过调度 → 符合条件的创建 CATCH_UP
8. 同一 PlanVersion + 同一自然日 + SCHEDULED 最多一次成功/部分成功 Run
9. 手动触发（MANUAL）不受自然日次数限制，但不能与活跃 Run 并发
10. 测试覆盖：正常 SCHEDULED 触发、CATCH_UP 补偿触发、并发拒绝、Pause/Resume、Skip Today、服务恢复检测

---

### T024 [P] SourceRun 数据模型与 Repository

**目标：** 实现 `source_runs` 表 Repository，支持 SourceRun 完整生命周期。

**文件范围（新增）：**
- `server/source-run/sourceRunRepository.ts` — 新增：SourceRun Repository
- `server/source-run/types.ts` — 新增：SourceRun 类型定义
- `server/source-run/sourceRunRepository.spec.ts` — 新增：Repository 测试

**完成条件：**
1. `createRun(run)` — 创建 SourceRun（triggerType、status=PENDING、phase=PREPARING）
2. `updateStatus(id, status)` — 状态转换
3. `updatePhase(id, phase)` — Phase 转换
4. `updateCounts(id, counts)` — 更新各个计数
5. `updateCoverage(id, coverage)` — 更新 coverageJson
6. `updateCost(id, cost)` — 更新 costSummaryJson
7. `updateError(id, errorCode, errorMessage)` — 记录错误
8. `getRun(id)` / `listRuns(filter)` — 查询
9. `getActiveRunForPlan(planVersionId)` — 检查是否有活跃 Run
10. `getSuccessfulScheduledRunForDate(planVersionId, date)` — 检查同日 SCHEDULED Run
11. 测试覆盖：CRUD、状态转换、活跃 Run 检测、同日去重

---

### T025 SourceRun API 路由与前端页面

**目标：** 实现 SourceRun 的查询 API 和历史列表 UI。

**文件范围（新增/修改）：**
- `server/source-run/sourceRunRoutes.ts` — 新增：SourceRun API 路由
- `server/source-run/sourceRunRoutes.spec.ts` — 新增：路由测试
- `src/pages/SourceRunsPage.vue` — 新增：来源运行历史页
- `src/router/index.ts` — 修改：新增 `/radar/source-runs` 路由

**完成条件：**
1. `GET /api/source-runs` — 列表查询（支持 planId / status / triggerType 过滤）
2. `GET /api/source-runs/:id` — 详情（含完整 coverage、cost、error）
3. `POST /api/source-runs/:id/retry` — 创建 RETRY Run
4. `POST /api/source-runs/:id/cancel` — 取消 PENDING/RUNNING Run
5. SourceRunsPage 展示：triggerType、status、phase、planned/actual time、coverage counts、failures
6. 遵循 contracts/api.md 响应格式

---

### T026 Windows Autostart 管理

**目标：** 实现 Windows 开机自启动的 enable / disable / status 功能。

**文件范围（新增）：**
- `server/autostart/AutostartManager.ts` — 新增：Autostart 管理（注册表 HKCU Run 读写）
- `server/autostart/autostartRoutes.ts` — 新增：Autostart API 路由
- `src/pages/LocalServicePage.vue` — 新增：本地服务状态页
- `src/router/index.ts` — 修改：新增 `/settings/local-service` 路由

**完成条件：**
1. `POST /api/local-service/autostart/enable` — 写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 注册表键
2. `POST /api/local-service/autostart/disable` — 删除注册表 Run 键
3. `GET /api/local-service/status` — 返回 `{ online, uptime, autostartEnabled, scheduler: {...}, outbox: {...} }`
4. `GET /api/scheduler/status` — 返回 Scheduler 状态和活跃 Plans
5. LocalServicePage 展示：在线/离线状态、Scheduler 状态、下次运行时间、Autostart 安装状态、今日状态
6. 离线时显示"OfferFlow 本地服务未运行"——不显示 HTTP 启动按钮
7. P0 只选 HKCU Run 单一机制，不预先维护两套 Autostart

---

### T027 Plan 控制端点（Run Now / Skip Today / Pause / Resume）

**目标：** 实现 Plan 的动态控制 API 端点。

**文件范围（修改/新增）：**
- `server/search-plan/searchPlanRoutes.ts` — 修改：补充控制端点
- `server/scheduler/planControl.ts` — 新增：Run Now / Skip Today 控制逻辑
- `server/search-plan/searchPlanRoutes.spec.ts` — 修改：补充控制端点测试

**完成条件：**
1. `POST /api/daily-search-plans/:id/run-now` — 手动触发 MANUAL SourceRun（202 Accepted）
2. `POST /api/daily-search-plans/:id/skip-today` — 跳过今天（写入 Skip 标记，阻止 SCHEDULED 和 CATCH_UP）
3. `POST /api/daily-search-plans/:id/pause` — Plan status → paused（已存在的 Run 不受影响）
4. `POST /api/daily-search-plans/:id/resume` — Plan status → active
5. 并发控制：如果已有活跃 Run → 409 Conflict
6. 测试覆盖：正常触发、已暂停 Plan 拒绝、并发拒绝、Skip Today 后不触发

---

## Phase 3 — Discovery → Analysis → Recommendation → DailyJobBrief

**目标：** 构建完整每日 Pipeline：Discovery → Ingestion → Analysis → Recommendation → DailyJobBrief。严格复用 v0.8 分析/推荐体系，不新增第二套。

**前置：** Phase 2 — SearchPlan + Scheduler + Jooble Discovery 完成

---

### T028 [P] Data Quality Gate 实现

**目标：** 在 Ingestion 和 Analysis 之间插入数据质量门禁，阻止信息不足的 CandidateVersion 进入正式 MatchAnalysis。

**文件范围（新增）：**
- `server/pipeline/DataQualityGate.ts` — 新增：数据质量评估逻辑
- `server/pipeline/DataQualityGate.spec.ts` — 新增：数据质量测试

**完成条件：**
1. 评估 `visibleText` 长度和信息密度（snippet 是否包含 JD 核心要素）
2. 事实充分的 CandidateVersion → `analysisEligible=true`
3. 事实不足的 CandidateVersion → `analysisEligible=false` + `dataQualityEvidence`（记录缺失字段和原因）
4. 信息不足的 Candidate 保留在 Radar（不删除、不影响后续 Ingestion）
5. CandidateVersion 保留 `dataQuality` metadata
6. **禁止**：根据 snippet 编造完整 JD、为补全 JD 自动抓取招聘平台页面
7. 测试覆盖：snippet 充分/不足/边界情况
8. Data Quality Gate 判定标准可配置（留 Plan 参数）

---

### T029 Discovery Pipeline 核心实现

**目标：** 实现核心 Pipeline 执行流程（discover → ingest → assess → analyze → recommend → buildBrief）。

**文件范围（新增）：**
- `server/pipeline/DailyPipeline.ts` — 新增：Pipeline 编排
- `server/pipeline/DailyPipeline.spec.ts` — 新增：Pipeline 集成测试

**完成条件：**
1. `runPipeline(sourceRun, planVersion)` — 执行完整每日流水线
2. 步骤编排：
   - `DISCOVERING`：调用 SearchProviderAdapter.search() → 更新 SourceRun coverage
   - `INGESTING`：每个 SearchResultItem → RadarIngestionService.ingest() → 更新计数
   - `ANALYZING`：每个 analysisEligible CandidateVersion → AnalysisService.createTask() → 等待/记录
   - `RECOMMENDING`：RecommendationBatchService.generateBatch() → 创建 Batch
   - `BUILDING_BRIEF`：创建 DailyJobBrief（引用 RecommendationBatch）
3. 每个 phase 的 SourceRun phase 和计数同步更新
4. 失败处理：SourceRun FAILED / PARTIALLY_SUCCEEDED + 具体 errorCode
5. Ingestion 幂等：重放不创建重复 Candidate/Version
6. Analysis 幂等：`input_hash UNIQUE` 保护重复分析
7. 测试覆盖：完整 Pipeline 成功、部分 Task 失败、空结果、中断恢复

---

### T030 [P] Analysis 复用——主动 Discovery 触发分析

**目标：** 确保主动 Discovery Pipeline 通过现有 `AnalysisService.createTask()` 触发分析，不新增分析任务类型。确认现有分析链路与主动来源的兼容性。

**文件范围（修改）：**
- `server/radar/analysis/analysisService.ts` — 确认 `createTask(candidateVersionId)` 可被 Pipeline 调用
- `server/pipeline/DailyPipeline.ts` — 调用 `AnalysisService.createTask()`

**完成条件：**
1. Pipeline 调用 `AnalysisService.createTask(candidateVersionId)` — 不新建第二套分析
2. AnalysisTask 的 `entityType='radar_candidate_version'` 继续适用
3. 现有 `input_hash UNIQUE` 约束保护重复分析
4. Pipeline 记录 `analysisRequestedCount` / `analysisSucceededCount`
5. 不创建 `SearchAnalysisTask` 或 `DailyAnalysisTask` 等新分析类型
6. 测试：主动 Discovery 触发分析与 Browser Capture 触发分析走同一代码路径

---

### T031 [P] Recommendation 复用——Preference 扩展推荐排序

**目标：** 确保主动 Discovery 使用现有 `RecommendationBatchService.generateBatch()`，并扩展 PreferenceRule 评估输入。

**文件范围（修改）：**
- `server/radar/recommendation/recommendationBatchService.ts` — 修改：接受 Preference 评估结果作为额外输入
- `server/radar/recommendation/recommendationService.ts` — 修改：在排序中应用 Preference boost/penalty
- `server/pipeline/DailyPipeline.ts` — 调用 `generateBatch()`

**完成条件：**
1. 现有 `generateBatch()` 接口扩展为接受 `PreferenceContext`（可选）
2. 活跃 PreferenceRule 评估结果输入推荐排序
3. 正向 Rule → ranking boost + 解释
4. 负向 Rule → ranking penalty / suppression + 解释
5. 0-8 条上限不变
6. 探索位 0-1 条（标记 `exploration=true`）
7. 不凑数——0 条可接受
8. 现有推荐门禁（stale、hard constraint、ignored、applied_pending）继续适用
9. 测试：Preference boost、Preference suppression、exploration、0 推荐、8 推荐上限

---

### T032 DailyJobBrief 数据模型与 Repository

**目标：** 实现 `daily_job_briefs` 表 Repository。

**文件范围（新增）：**
- `server/daily-brief/dailyBriefRepository.ts` — 新增：DailyJobBrief Repository
- `server/daily-brief/types.ts` — 新增：DailyJobBrief 类型定义
- `server/daily-brief/dailyBriefRepository.spec.ts` — 新增：Repository 测试

**完成条件：**
1. `createBrief(brief)` — 创建 DailyJobBrief
2. `getBrief(id)` / `getTodayBrief(planVersionId, date)` — 查询
3. `listBriefs(filter)` — 列表
4. `updateStatus(id, status)` — 状态转换（GENERATING → READY → IN_REVIEW → COMPLETED / FAILED）
5. `updateCoverage(id, coverage)` / `updateCost(id, cost)` — 更新摘要
6. Brief **不保存** `selectedCandidateVersionIds`——推荐通过 `recommendationBatchId` 引用
7. 测试覆盖：CRUD、状态转换、今日 Brief 查询

---

### T033 [P] [US7] [US8] DailyJobBrief API 路由

**目标：** 实现 DailyJobBrief 的 REST API 端点。

**文件范围（新增）：**
- `server/daily-brief/dailyBriefRoutes.ts` — 新增：DailyJobBrief API 路由
- `server/daily-brief/dailyBriefRoutes.spec.ts` — 新增：路由测试
- `server/daily-brief/dailyBriefDtoSchemas.ts` — 新增：DTO Schema

**API 端点：**
- `GET /api/daily-job-briefs` — 列出 Brief
- `GET /api/daily-job-briefs/today` — 获取今日 Brief
- `GET /api/daily-job-briefs/:id` — 获取 Brief 详情（含审批进度）
- `POST /api/daily-job-briefs/:id/complete` — 标记完成

**完成条件：**
1. `GET /api/daily-job-briefs/:id` 返回 Brief + RecommendationBatch 引用 + 审批进度（total/judged/pending/四档分布）
2. 审批进度派生：`Batch.selectedCandidateVersionIds - 已有有效 JobJudgment`
3. 不存 `currentIndex` 作为进度标记
4. `POST /api/daily-job-briefs/:id/complete` → Brief status = COMPLETED
5. 响应格式遵循 `contracts/api.md`

---

### T034 [P] [US7] [US8] DailyJobBrief 前端页面

**目标：** 创建每日汇报的查看页面（审批功能在 Phase 5 完成）。

**文件范围（新增）：**
- `src/pages/DailyBriefPage.vue` — 新增：今日汇报页
- `src/components/daily-brief/CoverageSummaryCard.vue` — 新增：覆盖摘要卡片
- `src/components/daily-brief/RecommendationList.vue` — 新增：推荐列表组件
- `src/pages/DailyBriefHistoryPage.vue` — 新增：历史汇报列表
- `src/router/index.ts` — 修改：新增 `/radar/daily-brief` 和 `/radar/daily-brief/history` 路由

**完成条件：**
1. Coverage 摘要展示：城市、方向、关键词、扫描/新增/变化/重复/阻断/分析/推荐数量
2. 失败范围展示（failedScopes）
3. 推荐列表：0-8 条候选条目（岗位、公司、城市、薪资、系统建议、核心理由、主要风险）
4. 0 推荐时展示 emptyReason
5. 成本摘要展示（scannedCount、analysisCount、模型、请求数、Cost unavailable 如适用）
6. 邮件投递状态展示
7. 遵循现有 Naive UI 组件风格

---

### T035 [P] Cost Summary 成本追踪

**目标：** 在 SourceRun 和 DailyJobBrief 中实现成本追踪。

**文件范围（新增/修改）：**
- `server/pipeline/costTracking.ts` — 新增：成本摘要构建逻辑
- `server/source-run/sourceRunRepository.ts` — 修改：支持 costSummaryJson 更新
- `server/daily-brief/dailyBriefRepository.ts` — 修改：支持 costSummaryJson 更新

**完成条件：**
1. SourceRun 记录：`scannedCount`、`analysisRequestedCount`、`analysisSucceededCount`、`modelUsage`、`tokenCount`（可用时）、`actualCost`（可用时）
2. 成本数据来源于 Provider meta 和 AnalysisService
3. 无可靠成本数据时标记 `"Cost unavailable"`——不估算、不伪造
4. DailyJobBrief 汇总当日所有关联 SourceRun 的成本
5. 测试覆盖：有成本数据、无成本数据场景

---

## Phase 4 — QQ SMTP + NotificationOutbox

**目标：** 实现 QQ 邮箱通知渠道、持久化 Outbox 与 SMTP 发送。所有邮件必须经过 Outbox。幂等防重复。

**前置：** Phase 3 — DailyJobBrief 完成（Outbox 写入需要 DailyBrief 实体）

---

### T036 [P] NotificationChannel 数据模型与 Repository

**目标：** 实现 `notification_channels` 表 Repository。

**文件范围（新增）：**
- `server/notification/channelRepository.ts` — 新增：NotificationChannel Repository
- `server/notification/types.ts` — 新增：Channel / Outbox 类型定义
- `server/notification/channelRepository.spec.ts` — 新增：Repository 测试

**完成条件：**
1. `createChannel(channel)` — 创建 Channel（QQ_SMTP_EMAIL）
2. `getChannel(id)` / `listChannels()` — 查询
3. `updateChannel(id, updates)` — 更新配置
4. `deleteChannel(id)` — 删除 Channel（同时删除关联 Secret）
5. `updateTestResult(id, success, timestamp)` — 更新测试/发送时间戳
6. `secret_ref` 存储经 SecretStore 保护后的密文引用
7. API 响应中 `secretRef` 始终返回 `"***"`
8. 测试覆盖：CRUD、Secret 掩码、删除时级联 Secret

---

### T037 [P] NotificationChannel API 与测试邮件

**目标：** 实现 NotificationChannel 的 REST API 端点和测试邮件发送。

**文件范围（新增）：**
- `server/notification/channelRoutes.ts` — 新增：NotificationChannel API 路由
- `server/notification/channelRoutes.spec.ts` — 新增：路由测试
- `server/notification/channelDtoSchemas.ts` — 新增：DTO Schema

**API 端点：**
- `GET /api/notification-channels` — 列出 Channels
- `POST /api/notification-channels/email` — 创建 QQ 邮箱 Channel
- `PATCH /api/notification-channels/:id` — 更新 Channel
- `DELETE /api/notification-channels/:id` — 删除 Channel
- `POST /api/notification-channels/:id/test` — 发送测试邮件

**完成条件：**
1. `POST /api/notification-channels/email` 接收 `secret` 明文 → SecretStore 加密存储 → 返回 `secretRef="***"`
2. `POST /api/notification-channels/:id/test` → 创建 TEST_EMAIL Outbox → SMTP 发送 → 更新 `lastTestedAt`
3. `PATCH` 可更新 Secret（新授权码替换旧授权码）
4. `DELETE` 删除 Channel 和对应的 Secret
5. Secret 不进入 API 响应、不进日志
6. 测试覆盖：创建/更新/测试/删除、Secret 不泄露

---

### T038 [US9] [US10] NotificationOutbox 数据模型与 Repository

**目标：** 实现 `notification_outbox` 和 `notification_links` 表 Repository。

**文件范围（新增）：**
- `server/notification/outboxRepository.ts` — 新增：Outbox Repository
- `server/notification/outboxRepository.spec.ts` — 新增：Repository 测试

**完成条件：**
1. `enqueue(entry)` — INSERT Outbox（含 `idempotency_key`）
2. `claimNext()` — Worker Claim 下一个 PENDING/SCHEDULED 条目（`locked_at`）
3. Mark `SENT(id)` / `FAILED_RETRYABLE(id, nextRetryAt, error)` / `FAILED_FINAL(id, error)` / `ACTION_REQUIRED(id, error)`
4. `getByIdempotencyKey(key)` — 幂等键查询
5. UNIQUE constraint on `idempotency_key`（数据库层幂等保护）
6. `releaseStaleLocks(timeout)` — 释放超时 SENDING 条目的 lock
7. Notification Links：`linkEntity(notificationId, entityType, entityId)`
8. `listByEntity(entityType, entityId)` — 按实体查通知
9. 测试覆盖：入队、幂等拒绝、Claim、状态转换、stale lock 释放、实体关联

---

### T039 [US9] [US10] SMTP Sender 实现

**目标：** 实现 QQ SMTP 邮件发送 Worker。

**文件范围（新增）：**
- `server/notification/SmtpSender.ts` — 新增：SMTP 发送器
- `server/notification/OutboxWorker.ts` — 新增：Outbox Worker（轮询 + 发送）
- `server/notification/SmtpSender.spec.ts` — 新增：SMTP 测试（mock nodemailer）

**完成条件：**
1. 新增依赖：`nodemailer` + `@types/nodemailer`
2. `SmtpSender`：从 `NotificationChannel` 读取配置 → 连接 QQ SMTP（`smtp.qq.com:465` TLS）→ 发送邮件
3. 授权码从 `secretRef` → `SecretStore.resolve()` 获取
4. `OutboxWorker`：定时轮询（如每 30s）→ claim PENDING/SCHEDULED → SMTP 发送 → 更新状态
5. 临时失败 → `FAILED_RETRYABLE` + 有限退避（如：1min、5min、15min、30min）
6. 永久失败（授权码无效、邮箱不存在等）→ `FAILED_FINAL`
7. 授权失败 → `ACTION_REQUIRED`（不无限 retry）
8. 静默时段（quietHours）不发送非紧急邮件
9. Worker 运行于 Fastify 进程内
10. 测试覆盖：成功发送、SMTP 临时失败、授权失败、静默时段、retry 退避

---

### T040 [US9] [US10] 通知触发逻辑

**目标：** 实现 Pipeline 中触发通知的业务逻辑：高优先级即时提醒和每日日报。

**文件范围（新增）：**
- `server/notification/NotificationTrigger.ts` — 新增：通知触发业务逻辑
- `server/notification/NotificationTrigger.spec.ts` — 新增：触发逻辑测试

**完成条件：**
1. `triggerHighPriorityAlert(candidateVersionId)`：
   - 条件：新 CandidateVersion + 规则通过 + MatchAnalysis 成功 + recommend=apply_now/stretch + 未被强负向 PreferenceRule 抑制 + 未对同一 candidateVersionId+notificationType+recipient 通知过
   - 通过后 → `enqueue` HIGH_PRIORITY_ALERT Outbox
2. `triggerDailyBrief(dailyBriefId)`：
   - DailyBrief READY → `enqueue` DAILY_BRIEF Outbox
   - 幂等键 = `dailyBriefId + recipient + templateVersion`
3. `triggerRunFailed(sourceRunId)`：
   - SourceRun FAILED → `enqueue` RUN_FAILED Outbox
4. `triggerActionRequired(sourceRunId, reason)`：
   - SourceRun WAITING_FOR_USER → `enqueue` ACTION_REQUIRED Outbox
5. 幂等：相同幂等键不得创建重复 Outbox
6. 测试覆盖：各类型触发条件、幂等保护、防重复

---

### T041 [US9] 高优先级邮件内容构建

**目标：** 构建 HIGH_PRIORITY_ALERT 邮件内容。

**文件范围（新增）：**
- `server/notification/emailTemplates.ts` — 新增：邮件模板
- `server/notification/emailTemplates.spec.ts` — 新增：模板测试

**完成条件：**
1. HIGH_PRIORITY_ALERT 邮件包含：岗位名称、公司、城市、薪资、发现日期、2-3 个核心理由、主要风险、最大不确定性、命中的正向 Preference、原岗位链接、"正式审批请回到电脑端 OfferFlow"
2. 邮件不包含：匹配度分数、简历全文、Token、API Key、调试日志、原始 HTML 注入
3. 原岗位链接经过 HTTP/HTTPS 协议校验
4. 纯文本或安全 HTML 格式（无第三方 CSS/JS）
5. 测试覆盖：必需字段存在、禁止字段不出现、链接校验

---

### T042 [US10] 日报邮件内容构建

**目标：** 构建 DAILY_BRIEF 邮件内容（含有推荐和空汇报两种）。

**文件范围（新增/修改）：**
- `server/notification/emailTemplates.ts` — 修改：补充日报模板

**完成条件：**
1. 有推荐时日报包含：
   - Coverage 摘要（城市、方向、关键词、扫描/新增/变化/重复/阻断/分析/推荐数量）
   - 计划时间、实际时间、是否补偿
   - 推荐列表：每条岗位/公司/城市/薪资/系统建议/核心理由/主要风险/是否 exploration/是否已即时提醒/原链接
   - 审批状态
2. 空日报（0 推荐）包含："今日没有发现值得你处理的新岗位" + 解释：搜索了什么、哪些来源成功/失败、扫描了多少、为什么没有推荐、没有凑数
3. 部分成功日报：明确标识失败范围
4. 不写"所有来源均已正常搜索"（在部分失败时）
5. 货币成本：有可靠数据时展示，无可靠数据时不展示不伪造
6. 测试覆盖：有推荐、空推荐、部分成功三种场景

---

### T043 [P] 通知中心前端页面

**目标：** 创建通知中心 UI。

**文件范围（新增）：**
- `src/pages/NotificationsPage.vue` — 新增：通知中心页
- `src/pages/EmailSettingsPage.vue` — 新增：邮箱配置页
- `src/router/index.ts` — 修改：新增 `/notifications` 和 `/settings/notifications/email` 路由

**完成条件：**
1. NotificationsPage 展示：Outbox 列表（类型、状态、收件人、attempts、错误、发送时间）
2. 支持按 status / notificationType 过滤
3. 支持手动 Retry（`POST /api/notifications/:id/retry`）
4. 关联业务实体展示
5. EmailSettingsPage 展示：Channel 配置表单（sender、recipient、smtpHost、smtpPort、TLS、授权码输入）、Test Email 按钮、启用/禁用开关
6. 授权码输入框为 password 类型，不展示明文

---

## Phase 5 — JobJudgment（四档审批）

**目标：** 实现四档岗位判断的持久化、历史版本、撤销、理由与 UI。

**前置：** Phase 3 — DailyJobBrief 完成（Brief 是 Judgment 的容器）

---

### T044 [P] [US11] JobJudgment 数据模型与 Repository

**目标：** 实现 `job_judgments` 和 `judgment_reasons` 表 Repository。

**文件范围（新增）：**
- `server/judgment/judgmentRepository.ts` — 新增：JobJudgment + JudgmentReason Repository
- `server/judgment/types.ts` — 新增：JobJudgment / JudgmentReason 类型定义
- `server/judgment/judgmentRepository.spec.ts` — 新增：Repository 测试

**完成条件：**
1. `createJudgment(judgment)` — 创建四档判断（VERY_SUITABLE / SOMEWHAT_SUITABLE / NOT_VERY_SUITABLE / VERY_UNSUITABLE）
2. `getActiveJudgment(dailyBriefId, candidateId, candidateVersionId)` — 获取有效判断
3. `getActiveJudgmentsForBrief(dailyBriefId)` — 获取 Brief 下所有有效判断
4. `supersedeJudgment(oldId, newJudgment)` — 旧判断被取代（`supersedesJudgmentId`），新判断成为有效版本
5. `revertJudgment(id)` — 撤销判断（`revertedAt` 设置，不物理删除）
6. `createReason(reason)` — 创建理由（source: USER_SELECTED / USER_TEXT / AI_EXTRACTED / SKIPPED）
7. Partial unique index：同一 (brief, candidate, version) 最多一个有效判断
8. 测试覆盖：创建、修改（supersedes）、撤销、有效判断查询、理由 source 区分

---

### T045 [US11] JobJudgment API 路由

**目标：** 实现 JobJudgment 的 REST API 端点。

**文件范围（新增）：**
- `server/judgment/judgmentRoutes.ts` — 新增：JobJudgment API 路由
- `server/judgment/judgmentRoutes.spec.ts` — 新增：路由测试
- `server/judgment/judgmentDtoSchemas.ts` — 新增：DTO Schema

**API 端点：**
- `POST /api/daily-job-briefs/:briefId/items/:candidateId/judgment` — 创建判断 + 理由
- `PATCH /api/job-judgments/:id` — 修改判断（创建新版本）
- `DELETE /api/job-judgments/:id` — 撤销判断
- `POST /api/job-judgments/:id/reason` — 补充/修改理由

**完成条件：**
1. `POST` 接受 `{ judgment, reason?: { source, reasonCode?, reasonText? } }`
2. 创建时自动绑定：dailyBriefId、radarCandidateId、candidateVersionId、matchAnalysisId、systemRecommendation、systemConfidence
3. `PATCH` → 旧判断 superseded + 新判断创建（保留历史）
4. `DELETE` → 旧判断 reverted → 关联 Signal 失效 → 派生 Rule 重算 → 返回 affectedRules
5. 不存在无需创建判断的端点
6. 审批进度通过 `(Batch 条目) - (已有有效 Judgment)` 派生，不需要单独 API
7. 响应格式遵循 `contracts/api.md`

---

### T046 [US11] 四档审批前端页面（日报审批卡）

**目标：** 在日报页面中实现逐条审批 UI。

**文件范围（新增/修改）：**
- `src/components/daily-brief/JudgmentCard.vue` — 新增：单岗位审批卡片
- `src/components/daily-brief/JudgmentButtons.vue` — 新增：四档按钮组
- `src/pages/DailyBriefPage.vue` — 修改：集成分步审批流程
- `src/components/daily-brief/CompletionSummary.vue` — 新增：完成摘要组件

**完成条件：**
1. 审批卡片展示：岗位、公司、城市、薪资、发布时间、JD 核心职责、系统建议、核心理由、主要风险、最大不确定性、命中 Preference、原始来源、原岗位链接
2. 四档按钮：VERY_SUITABLE / SOMEWHAT_SUITABLE / NOT_VERY_SUITABLE / VERY_UNSUITABLE
3. 选择判断后自动前进到下一条
4. 支持键盘快捷键（默认：1/2/3/4 对应四档）
5. 可返回修改前一条（PATCH → supersedes）
6. 可中途退出（页面刷新不丢审批进度）
7. 服务重启不丢审批进度（审批进度派生自已有 Judgment）
8. 不依赖 `currentIndex` 作为进度事实源
9. 全部判断完成后展示 Completion Summary：四档分布、新增理由/Signal、待确认 Rule、系统 vs 用户差异
10. 默认不填写文字理由（可选补充）
11. 跟进现有 Naive UI 组件风格

---

### T047 [US11] 审批进度派生逻辑

**目标：** 实现审批进度的纯派生逻辑（不依赖 `currentIndex` 或 `lastProcessedIndex`）。

**文件范围（新增/修改）：**
- `server/daily-brief/reviewProgress.ts` — 新增：审批进度派生逻辑
- `server/daily-brief/reviewProgress.spec.ts` — 新增：派生逻辑测试

**完成条件：**
1. 输入：`RecommendationBatch.selectedCandidateVersionIds` + 已有有效 `JobJudgment` 列表
2. 输出：`{ total, judged, pending, breakdown: { VERY_SUITABLE, SOMEWHAT_SUITABLE, NOT_VERY_SUITABLE, VERY_UNSUITABLE }, nextCandidateToJudge }`
3. `nextCandidateToJudge` = Batch 中第一个无有效 Judgment 的条目
4. 判断修改后不影响进度计算（superseded 旧判断不计入）
5. 判断撤销后对应 Candidate 回到 pending
6. 测试覆盖：无判断、部分判断、全部判断、修改后、撤销后

---

### T048 [US12] 智能追问生成（AI 辅助）

**目标：** 实现高信息增益场景下的自动追问生成（AI 辅助），每个岗位最多一个追问。

**文件范围（新增）：**
- `server/judgment/followUpGenerator.ts` — 新增：追问生成逻辑（含 AI 调用）
- `server/judgment/followUpGenerator.spec.ts` — 新增：追问生成测试

**完成条件：**
1. 可以追问的场景：VERY_SUITABLE 且原因未知、VERY_UNSUITABLE 且原因未知、用户判断与系统建议明显冲突、当前判断与历史相似岗位冲突、出现新的强偏好特征
2. 不应该追问的场景：已有 PreferenceRule 足够解释、最近类似岗位已回答、信息增益低、用户跳过、用户开启快速审批、AI 不确定该问什么
3. 问题必须：基于当前 JD 具体、优先 2-4 个选项 + "其他" + "跳过"、不诱导答案
4. AI 追问失败 → 不阻塞判断完成（跳过追问、记录失败）
5. 每个岗位最多 1 个自动追问
6. 追问的 answer → 写入 JudgmentReason（source=USER_SELECTED）
7. 测试覆盖：可追问/不应追问判断、AI 返回格式校验、AI 失败回退、选项上限

---

## Phase 6 — Preference Learning

**目标：** 实现三层偏好模型（JobJudgment → PreferenceSignal → PreferenceRule），以及规则对搜索扩展、候选抑制和推荐排序的影响。

**前置：** Phase 5 — JobJudgment 完成

---

### T049 [US13] PreferenceSignal 提取与 Repository

**目标：** 实现 `preference_signals` 表 Repository 和从 Judgment/Reason 提取 Signal 的逻辑。

**文件范围（新增）：**
- `server/preference/signalRepository.ts` — 新增：PreferenceSignal Repository
- `server/preference/signalExtractor.ts` — 新增：Signal 提取逻辑
- `server/preference/signalRepository.spec.ts` — 新增：Signal Repository 测试
- `server/preference/signalExtractor.spec.ts` — 新增：Signal 提取测试

**完成条件：**
1. `extractSignals(judgment, reasons)` — 从 Judgment + Reason 提取 `PreferenceSignal[]`
2. Signal 字段：`featureKey`（如 "company_type"）、`featureValueJson`、`direction`（positive/negative）、`strength`（strong/medium/weak）、`scopeJson`、`confidence`（0-1）
3. Source 区分：`USER_SELECTED`/`USER_TEXT` → 用户原话；`AI_EXTRACTED` → AI 派生
4. `createSignal(signal)` / `invalidateSignal(id)` — 创建/失效
5. `getActiveSignalsByFeature(featureKey, direction)` — 按特征查询活跃 Signal
6. Judgment 撤销→关联 Signal 失效（`invalidatedAt` 设置，不物理删除）
7. 测试覆盖：Signal 创建/失效、feature extraction 准确度、source 区分

---

### T050 [US13] PreferenceRule 数据模型与 Repository

**目标：** 实现 `preference_rules` 和 `preference_rule_sources` 表 Repository。

**文件范围（新增）：**
- `server/preference/ruleRepository.ts` — 新增：PreferenceRule Repository
- `server/preference/ruleRepository.spec.ts` — 新增：Rule Repository 测试

**完成条件：**
1. `createRule(rule)` — 创建 Rule（type: RANK_BOOST/RANK_PENALTY/SUPPRESS/SEARCH_EXPAND, status=PROPOSED/ACTIVE/DISABLED/DELETED）
2. `activateRule(id)` / `disableRule(id)` / `markDeleted(id)` — 状态管理
3. `getActiveRules()` — 查询所有 ACTIVE Rule
4. `getProposedRules()` — 查询 PROPOSED Rule（待用户确认）
5. `getHighImpactProposedRules()` — 查询 HIGH_IMPACT + PROPOSED Rule
6. `linkRuleSource(ruleId, signalId)` — 追溯 Rule 来源 Signal
7. `getRuleSources(ruleId)` — 获取 Rule 的所有来源 Signal
8. 测试覆盖：CRUD、状态转换、来源追溯

---

### T051 [US13] PreferenceRule 提案与激活逻辑

**目标：** 实现 PreferenceRule 的自动提案、阈值激活和高影响规则 Human Confirm 逻辑。

**文件范围（新增）：**
- `server/preference/ruleProposer.ts` — 新增：Rule 提案逻辑
- `server/preference/ruleProposer.spec.ts` — 新增：提案逻辑测试

**完成条件：**
1. Signal 阈值提案：
   - 强信号 ×2 独立岗位 → 生成 PROPOSED Rule
   - 中信号 ×3 独立岗位 → 生成 PROPOSED Rule
   - 否则不自动提案
2. HIGH_IMPACT 规则识别：屏蔽城市、屏蔽行业、改主岗位方向、改最低薪资、技术栈变硬排除、全局屏蔽某类公司
3. HIGH_IMPACT 规则 → `activation_mode=EXPLICIT_CONFIRM`（绝不自激活）
4. 非 HIGH_IMPACT → `activation_mode=THRESHOLD_AUTO`（达到阈值自动激活）
5. `recomputeRulesForFeature(featureKey)` — Judgment 修改/撤销后重新计算关联 Rule
6. 测试覆盖：强/中信号阈值、HIGH_IMPACT 识别、THRESHOLD_AUTO 激活、EXPLICIT_CONFIRM 不自动激活、撤销后重算

---

### T052 [US13] [US14] PreferenceRule 对推荐与搜索的影响

**目标：** 将活跃 PreferenceRule 评估结果输入 Recommendation Pipeline 和 Search Task 展开。

**文件范围（新增/修改）：**
- `server/preference/ruleAssessor.ts` — 新增：Rule 对 CandidateVersion 的评估
- `server/preference/ruleAssessor.spec.ts` — 新增：评估测试
- `server/search-plan/searchPlanRoutes.ts` — 修改：SearchExpand 关键词

**完成条件：**
1. `assessCandidate(candidateVersion, activeRules)` — 每个 CandidateVersion 匹配活跃 Rule
2. 评估结果写入 `RadarRuleAssessment`（`category='preference'`）
3. 正向 RANK_BOOST → 排序提升
4. 负向 RANK_PENALTY → 排序降权
5. SUPPRESS → 候选人被抑制（不在推荐中展示，除非有显著新差异）
6. SEARCH_EXPAND → 建议扩展关键词（写入 `expandedKeywords`，标记来源 Rule）
7. Repeated Mistake Protection：连续 2 次用户标记同类错误 → 第三次必须抑制或给出明确新差异解释
8. 测试覆盖：正/负/抑制/扩展评估、RadarRuleAssessment 集成、repeated mistake

---

### T053 [US14] [US15] Repeated Mistake Protection 与 Exploration 位

**目标：** 减少重复错误推荐，保留探索能力防止反馈闭环收窄。

**文件范围（新增/修改）：**
- `server/pipeline/DailyPipeline.ts` — 修改：集成 Exploration 位选择和 Repeated Mistake 检查
- `server/preference/repeatedMistakeDetector.ts` — 新增：重复错误检测
- `server/preference/explorationSelector.ts` — 新增：探索位选择逻辑

**完成条件：**
1. Repeated Mistake Detection：
   - 检测命中活跃负向 PreferenceRule 且无显著新差异的 Candidate
   - 已经在相同模式上被连续两次标记为错误 → 第三次必须抑制
   - Repeated Mistake Rate 目标 <5%
2. Exploration 位（0-1 条 / Brief）：
   - 选择标准：通过 hard constraint、非已投待反馈、非已忽略未变化、有 clear "why explore" 解释
   - 不突破硬约束
   - 属于同一个 RecommendationBatch（不建立第二推荐集合）
3. 测试覆盖：repeated mistake 抑制、新差异例外、exploration 选择

---

### T054 [US13] PreferenceRule API 与用户确认

**目标：** 实现 PreferenceRule 的管理 API（列出、启用/停用、删除、确认）。

**文件范围（新增）：**
- `server/preference/preferenceRoutes.ts` — 新增：PreferenceRule API 路由
- `server/preference/preferenceRoutes.spec.ts` — 新增：路由测试
- `server/preference/preferenceDtoSchemas.ts` — 新增：DTO Schema

**API 端点：**
- `GET /api/preference-rules` — 列出 Rules（支持 status / ruleType 过滤）
- `PATCH /api/preference-rules/:id` — 更新 Rule（启用/停用）
- `DELETE /api/preference-rules/:id` — 删除 Rule
- `GET /api/preference-signals` — 列出 Signals（支持 direction / activeOnly 过滤）

**完成条件：**
1. `GET /api/preference-rules` 返回：Rule 详情 + 激活模式 + Signal 来源列表
2. `PATCH /api/preference-rules/:id` 支持：`{ status: 'ACTIVE' | 'DISABLED' }`
3. HIGH_IMPACT PROPOSED Rule 需要通过此 API 显式确认才能变为 ACTIVE
4. `DELETE /api/preference-rules/:id` → status=DELETED（不物理删除）
5. `GET /api/preference-signals` 返回：Signal + 关联 Judgment + 是否 active
6. 响应格式遵循 `contracts/api.md`

---

### T055 [US13] [US14] [US15] 偏好记忆前端页面

**目标：** 创建偏好记忆管理 UI。

**文件范围（新增）：**
- `src/pages/PreferencesPage.vue` — 新增：偏好记忆页
- `src/components/preference/SignalList.vue` — 新增：Signal 列表
- `src/components/preference/RuleCard.vue` — 新增：Rule 卡片
- `src/router/index.ts` — 修改：新增 `/radar/preferences` 路由

**完成条件：**
1. Signals 列表：featureKey、direction、strength、来源岗位、创建时间、是否 active
2. Active Rules 列表：ruleType、featureKey、效果、解释、激活模式、最近命中
3. Proposed Rules 列表：待确认的高影响规则（EXPLICIT_CONFIRM）显式标注
4. Rule 操作：Disable / Delete（不物理删除）
5. 高影响规则确认：用户点击确认后 Rule 变为 ACTIVE
6. 正/负方向标识
7. 追溯来源 Judgment

---

## Phase 7 — Production Validation

**目标：** 全面验证 v0.9 系统的迁移、恢复、稳定性、真实运行与文档。

**前置：** Phase 1–6 全部完成

---

### T056 Production Migration 演练

**目标：** 验证 v8 → v9 完整 migration 流程在生产副本上可执行、可恢复。

**完成条件：**
1. 准备一份生产数据库副本（sandbox）
2. 执行完整 v8 → v9 migration（含 12 张新表 + capture_method 表重建）
3. `PRAGMA foreign_key_check` 无错误
4. `PRAGMA integrity_check` 通过
5. v0.8 Radar 核心功能回归（Browser Capture、Candidate、Version、Analysis、Recommendation）
6. Backup → migration → restore → 数据一致
7. 记录 migration 耗时、各步骤状态
8. 如果生产数据库升级，仍必须由用户独立授权（`db:upgrade-real -- --confirm`）
9. 禁止在生产 DB 自动升级

---

### T057 [P] Backup / Restore 验证

**目标：** 验证 v0.9 数据库备份与恢复流程。

**完成条件：**
1. 现有 `backupDatabase()` 函数覆盖 v0.9 新增表
2. Backup 包含所有 12 张新表 + v0.8 既有表
3. Restore 后：Plan/Version/SourceRun/DailyBrief/Judgment/Signal/Rule/Channel/Outbox 数据完整
4. Secret（授权码/API Key）不进入普通 Backup
5. Host Snapshot V3 覆盖 v0.9 新表
6. Cross-machine restore：Secret 需要重新配置（预期行为，不是 bug）

---

### T058 [P] Scheduler 恢复与重试验证

**目标：** 验证 Scheduler 在服务崩溃、关机、睡眠后的恢复行为。

**完成条件：**
1. 服务崩溃（进程 kill），重启后：
   - 原 RUNNING SourceRun → INTERRUPTED
   - 不冒充 checkpoint resume
2. 可以创建新 RETRY Run
3. RETRY 不制造重复事实（Ingestion + Analysis + Recommendation 幂等验证）
4. CATCH_UP：错过调度 → 服务恢复 → 正确创建 CATCH_UP（同一 PlanVersion 同日最多一次）
5. Skip Today → 不创建 CATCH_UP
6. 超过 latestCatchUpTime → 不创建 CATCH_UP
7. Scheduler 恢复后正确 schedule next run

---

### T059 [P] SMTP 失败矩阵验证

**目标：** 验证 NotificationOutbox 在各失败场景下的行为。

**完成条件：**
1. SMTP 正常 → PENDING → SCHEDULED → SENDING → SENT
2. SMTP 临时失败（如网络抖动）→ FAILED_RETRYABLE → 自动重试 → SENT
3. SMTP 授权失效 → 首次失败后直接进入 ACTION_REQUIRED（不无限 retry）
4. SMTP 永久失败（如邮箱不存在）→ FAILED_FINAL
5. Outbox 幂等：相同 `idempotency_key` 不重复投递
6. Stale lock 回收：超时 SENDING → 重新 Claim → 重新发送
7. 邮件失败不污染业务实体（SourceRun/Candidate/Analysis/RecommendationBatch/DailyJobBrief/Judgment 不回滚）

---

### T060 [P] 连续 ≥3 个自然日真实运行验证计划

**目标：** 制定验证计划，等待真实运行时确认：

**验证清单（不在此 Task 中运行，而是列出验证步骤供实施阶段执行）：**
1. **第 1 日：**
   - 配置真实 SearchPlan（苏州/无锡，前端方向，Jooble Provider）
   - Scheduler 自动触发 → Jooble 返回真实岗位 → 进入 Radar Ingestion
   - 重复岗位不重复创建 Candidate
   - 至少形成一次真实 MatchAnalysis → 一次真实 RecommendationBatch → 一次真实 DailyJobBrief
   - HIGH_PRIORITY_ALERT 邮件（如有）和 DAILY_BRIEF 邮件正常送达
   - Provider 失败显式记录（不伪装 0 岗位）
2. **第 2 日：**
   - 再次 Scheduler 触发 → 重复岗位不重复创建 Candidate
   - 变化岗位进入新的 CandidateVersion
   - 新岗位正常摄入
   - 无无限 retry
3. **第 3 日：**
   - 完成四档判断 → PreferenceSignal 生成
   - Rule 提案/激活
   - 下一轮推荐受 Preference 影响（boost/suppress/explain）
4. **中途测试：**
   - 关机/睡眠后恢复 → Catch-up 机制
   - Provider 失败场景（如网络断开）→ WAITING_FOR_USER
   - 服务崩溃 → INTERRUPTED → RETRY
5. **验收标准：** 见 spec.md SC-001～SC-013

---

### T061 [P] JobJudgment 修改 / 撤销 → Preference 重算验证

**目标：** 验证 Judgment 修改和撤销后 Preference 系统的级联更新。

**完成条件：**
1. 修改 Judgment → 旧 Signal 失效 → 新 Signal 生成 → Rule 提案重算
2. 撤销 Judgment → 关联 Signal 失效 → 派生 Rule 重算
3. 不影响其他 Judgment 的 Signal/Rule
4. 不影响已发送的通知（通知不回溯）
5. 旧 Judgment 历史保留、不可变

---

### T062 [P] Recommendation Quality Eval

**目标：** 对推荐质量进行基本评测。

**完成条件：**
1. 验证 0-8 条上限（含 0 条）
2. 不凑数——手动构造全被抑制的池子，验证输出 0
3. Preference boost 正向影响排序
4. Negative suppression 抑制有效
5. Exploration 位不突破 hard constraint
6. Repeated Mistake Rate 在可接受范围
7. Stale 分析不进入正式推荐

---

### T063 [P] Cost Visibility 验证

**目标：** 验证成本摘要的准确性。

**完成条件：**
1. SourceRun 的 costSummaryJson 包含 scannedCount、analysisCount、modelUsage
2. 当 Provider 返回可靠 token 用量时 → tokenCount 和 actualCost 正确
3. 当无可靠成本数据时 → 显示 "Cost unavailable"（不伪造）
4. DailyJobBrief 汇总当日关联 SourceRun 成本
5. UI 展示成本数据（SourceRunsPage + DailyBriefPage）

---

### T064 [P] README / Changelog / Architecture 文档更新

**目标：** 更新项目文档以反映 v0.9 变化。

**文件范围（修改）：**
- `README.md` — 修改：补充 v0.9 功能概述、新增依赖（nodemailer）、启动说明
- `CHANGELOG.md` — 修改：新增 v0.9.0 条目
- `docs/architecture.md` — 如存在则更新；如不存在则新增架构说明

**完成条件：**
1. README 包含 v0.9 核心功能介绍（每日找岗、QQ 邮件、四档审批、偏好学习）
2. CHANGELOG 按波次列出 v0.9 新增功能
3. 文档标注"本版本不承诺公网暴露、云端常驻、自动投递"
4. 新增依赖明确列出（nodemailer）

---

### T065 全量回归测试

**目标：** 运行全量测试确保 v0.9 不破坏 v0.8 既有功能。

**执行命令：**
```bash
pnpm vitest run
pnpm vue-tsc --noEmit
pnpm build
pnpm migration:selftest
pnpm db:doctor
```

**完成条件：**
1. 所有 vitest 测试通过（含 v0.8 既有 + v0.9 新增）
2. TypeScript 编译无错误
3. Vite 构建成功
4. Migration selftest 通过（v8→v9）
5. DB doctor 无异常
6. Browser Capture 回归通过
7. Analysis 回归通过
8. Recommendation 回归通过

---

## 执行分类说明

Task 的最终执行者与模型路由不在本阶段冻结。

将在 `/speckit.analyze` 完成依赖、冲突和覆盖检查后，再将任务划分为：

- **低风险、局部、明确任务** → cc-auto 候选
- **中复杂度、明确跨文件任务** → cc-auto + V4 Pro 候选
- **架构、高风险 Migration、核心状态机** → Claude Code / V4 Pro 主执行

---

## 任务统计

| 统计项 | 数量 |
|--------|------|
| **Total Tasks** | 65 |
| **Phase 数量** | 8（Phase 0–7） |
| **[P] Parallel Tasks** | 29 |
| **User Story Tasks [USx]** | 21 |
| **Infrastructure Tasks** | 22 |
| **Test / Validation Tasks** | 22 |
| **Approval Gates [GATE]** | 5 |

### 各 Phase Task 数

| Phase | 名称 | Task 数 |
|-------|------|---------|
| Phase 0 | Jooble Provider Validation Gate | 8 |
| Phase 1 | Shared Radar Ingestion Core | 7 |
| Phase 2 | SearchPlan + Scheduler + Jooble Discovery | 12 |
| Phase 3 | Discovery → Analysis → Recommendation → DailyJobBrief | 8 |
| Phase 4 | QQ SMTP + NotificationOutbox | 8 |
| Phase 5 | JobJudgment（四档审批） | 5 |
| Phase 6 | Preference Learning | 7 |
| Phase 7 | Production Validation | 10 |

---

## 关键路径

```
T001–T008（Provider Validation Gate）
  → T009–T015（Shared Ingestion + Migration）
    → T016–T027（SearchPlan + Scheduler + Jooble）
      → T028–T035（Daily Pipeline + DailyBrief）
        → T036–T043（QQ SMTP + Outbox）
        → T044–T048（JobJudgment）
          → T049–T055（Preference Learning）
            → T056–T065（Production Validation）
```

Phase 4 和 Phase 5 可在 Phase 3 完成后并行推进（均依赖 DailyBrief 实体但互不依赖）。

Phase 6 严格依赖 Phase 5（Preference 需要 Judgment 数据）。

---

## 最高风险 Task

| # | Task | 风险 |
|---|------|------|
| 1 | T001–T008 | **Jooble Provider Validation** — 如果真实覆盖不足，整个 v0.9 Discovery 可能失去 P0 Provider |
| 2 | T014 | **SQLite CHECK Migration** — 表重建 migration，修改 `capture_method` CHECK 约束，必须保证数据完整性和 v0.8 回归 |
| 3 | T011 | **Shared Ingestion Extraction** — 从 `RadarCaptureService.materializeItem()` 抽取共享核心，行为必须完全等价 |
| 4 | T023 | **Scheduler Recovery** — 错过调度检测、CATCH_UP 去重、并发控制、服务崩溃恢复 |
| 5 | T038 | **Outbox Idempotency** — 幂等键 UNIQUE 约束、Worker Claim、状态转换、stale lock 回收 |
| 6 | T051 | **PreferenceRule 提案与激活** — HIGH_IMPACT 规则 Human Confirm、撤销重算的级联逻辑 |
| 7 | T056 | **Production Migration** — 生产库升级演练，必须可恢复且不影响 v0.8 功能 |

---

## Constitution Check

是否发现 Task 与 Constitution 冲突：**NO**

所有 65 个 Task 均通过 Constitution 十二项原则检查。无创建影子模型、无绕过 Human Authority、无伪造成本数据、无自动投递相关 Task。关键边界（0-8 推荐、NotifiationOutbox 幂等、Preference 三层模型、Human Confirm for HIGH_IMPACT、Secret 不进 Git/日志/Backup）均已落实为专门 Task。

---

## Scope Check

是否出现 spec/plan 之外任务：**NO**

所有 65 个 Task 均在 spec.md 功能需求（FR-001～FR-060）、plan.md 技术设计和 data-model.md 12 张表定义的范围内。未出现：Opportunity 系统、新 Analysis Runtime、通用 Agent Runtime、generic checkpoint、BOSS/拉勾/猎聘 crawler、手机审批、云端服务器、CompanyCareerProvider（Future）、GitHub/掘金 Provider（Later）。

---

## Git

```bash
git status --short
git diff --stat
```

---

## 停止点

**本轮已完成 `/speckit.tasks`。**

- 未执行 `/speckit.analyze`。
- 未执行 `/speckit.implement`。
- 未修改业务源码。
- 未执行 Migration。
- 未修改真实数据库。
- 未 commit。
- 未 push。

**等待用户审核 tasks.md 后进入 `/speckit.analyze`。**
