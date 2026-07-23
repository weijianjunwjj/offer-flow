# OfferFlow v0.8 V8-3 人工评审工作台实施证据

> 日期：2026-07-23
> 结果：PASS（沙箱/演练环境）
> 生产 schema：保持 v7（未改动）
> Radar 正式入口：DISABLED（未改动）
> V8-3：ACCEPTED / ACTIVATION PENDING（代码实现完成、自动化回归通过、人工验收 ACCEPTED；仅 schema≥v8 的沙箱/演练库可用；生产 v8 激活仍需独立授权 BR-1）
> schema v8：IMPLEMENTED IN CODE / NOT ACTIVATED IN PRODUCTION
> RC-05 / RC-06：Done（人工验收 ACCEPTED，采用 MA-01/MA-02 截图裁切证据例外，详见 `offerflow-v0.8-v8-3-manual-acceptance-pending.md`）

## 1. 范围与边界

- 在 Wave 1~5 已落地的领域能力（标准化 / identity / 材料变化决策 / 重复裁决 / 规则证据）
  之上，补齐**只读评审 + 人工确认 + 规则覆盖**的 API 与前端工作台。
- 不重写任何领域逻辑；写操作全部委托既有 DuplicateAdjudication + RuleEvidence service，
  仅叠加乐观并发校验。
- **未新增 schema、未编写新 migration、未推进 `PRODUCTION_SCHEMA_VERSION`（保持 2）。**
  评审依赖既有 v8 迁移（`008_v0_8_radar_candidate_relations_schema`）产生的候选关系表。
- **未改动真实生产库** `data/offerflow.sqlite3`（仍为 schema v7、Radar 表为空）。
- **未改动 Radar 正式入口 / feature flag 默认值**（`radarEnabled` 默认 false）。

## 2. 后端交付

- `server/radar/reviewDtoSchemas.ts`：严格 Zod 请求/响应契约。响应绝不含
  Cookie/Token/securityId/完整 JD/无限 raw metadata；JD 仅受限摘要（≤280 字），来源仅
  规范化 URL + 域名；关系 signals 经白名单脱敏；写请求 reason 必填限长并携带乐观并发期望状态。
- `server/radar/reviewService.ts`：候选决策详情 / 决策 feed / 关系列表 / 规则证据视图只读组装；
  写操作委托既有 service，仅追加 `expectedCurrentStatus` / `expectedOverrideState` 校验
  （不符→409）。决策从 committedResult 载体还原，identity_conflict（无候选）经决策 feed 以
  snapshotId 展示。
- `server/radar/routes.ts`：评审路由与采集桥共用同一安全网关（loopback + Host + Origin +
  自定义头）。**评审路由仅在 `getDatabaseSchemaVersion(db) ≥ 8` 时注册**，否则整体缺席
  （404），避免 v7 库运行时 "no such table"；Radar 能力关闭时整体不注册。
- `server/radar/reviewFixture.ts`：经真实 service 落库的 12 类确定性场景，仅受控 v8 环境使用。

## 3. 前端交付

- `src/pages/RadarReviewPage.vue`（`/radar/review`，radarEnabled 门控）：六区域——待处理
  关系 / 决策审阅 feed / 候选并排对比 / 变化字段摘要 / 规则证据三态 / 人工操作。所有写操作
  强制二次确认 + 原因必填；并发冲突（409）提示刷新且保留已填原因不静默失败。“确认相同”文案
  明确：仅登记为同一岗位，不物理合并、不删除、不迁移历史数据。
- `src/api/radarReviewApi.ts`：与采集桥同源客户端，携带 `x-offerflow-capture-client` 头触发预检。
- 路由门控：radarEnabled 关闭时 `/radar/review` 安全重定向到 `jobs?feature=radar-review-disabled`，
  不加载组件。

## 4. 验收证据

### 4.1 自动化（`vitest run`：96 files / 943 tests PASS；`tsc` + `vue-tsc` + `extension:typecheck` 均 0 报错）

- `server/radar/reviewRoutes.spec.ts`（13 项）：关系过滤 + signals 脱敏、状态过滤与 limit、
  候选详情脱敏（无 Cookie/securityId、JD 仅摘要）、决策 feed 四类
  （material/regression/ambiguous/identity_conflict）、reason 缺失 422、confirmed_distinct
  幂等 + 409、撤销、recheck、证据三态、override 设置+撤销+原评估不变+RadarAction 追加、
  正式 Job/Application 零新增、capability 关闭 404、**radar 开启但 schema=v7 时评审 404 而采集桥可用**。
- `src/pages/RadarReviewPage.spec.ts`（9 项）：关系/feed 渲染、identity_conflict 结构化冲突原因、
  候选对比 + 变化字段、feed 单候选加载详情+证据、无候选条目禁用、证据三态、确认相同语义文案、
  写操作二次确认 + 原因必填、409 提示且保留输入。
- `src/router/router.spec.ts`（+2 项）：`/radar/review` 开启注册 / 关闭安全重定向且不加载组件。

### 4.1a 正式自动化浏览器 E2E（`npm run review:e2e`，Playwright 无头 chromium，9 项 PASS）

编排器 `review-e2e/harness.ts` 全程 in-process：临时 **v8** 库（系统临时目录，动态端口，
绝不指向真实生产库、绝不占用人工沙箱固定的 17365/17366），启动 v8 评审后端 + v7 采集后端
+ flag 开/关两套前端；`globalSetup` 返回的 teardown 关闭全部 server、显式关闭注入 db 句柄并清理临时库。

- 门禁：flag 关闭时 `/radar/review` 重定向（`radar-review-disabled`）且工作台不渲染；
  schema=v7 时评审 API 404、采集桥仍在（非 404）；schema=v8 沙箱评审页可访问并列出待处理关系。
- 决策 feed：material/regression/ambiguous/identity_conflict 四类均带结构化原因。
- 规则证据：structured/legacy_scalar/corrupt 三态呈现；override 设置→撤销经真实 UI 弹窗完成，
  只读回查临时库确认**原 RuleAssessment 行不变、评估不删除、`radar_actions` 追加 set+revert 两条**。
- 关系裁决：疑似重复并排对比 → 确认不同（原因为空提交禁用、填写后成功）→ 移出默认列表 → 刷新保持；
  confirmed_same 明确提示不物理合并；提交前状态被抢先改变时返回 **409** 且用户输入的原因保留；
  裁决后两候选仍可读、候选数不减少。
- 全流程后回查临时库：Job/Application/FeedbackEvent 零新增，候选数不因裁决减少。

> 与 4.2 的区别：4.1a 为可重复、无人值守的自动化断言（含只读 SQLite 不变量校验），
> 4.2 为人工驱动的真实浏览器观察。二者互补，均在临时 v8 库、绝不触碰生产库。

### 4.2 真实浏览器 E2E（沙箱 `npm run dev:radar-review-sandbox`，chrome-devtools MCP）

- 独立临时 **v8** 库（系统临时目录，非真实生产库），经真实 service 落库 12 类 fixture。
- 六区域渲染正常；决策 feed 呈现四类结构化原因（变化字段、待确认字段、冲突原因、阻断）。
- 候选并排对比显示受限 JD 摘要 + 规范化 URL；变化字段带分类与原因；规则证据三态 + 覆盖状态。
- 写操作二次确认：原因为空时提交禁用，填写后成功，列表刷新移除已裁决关系。
- 截图：`docs/evidence/v8-3-review-evidence-states.png`。

### 4.3 v7 沙箱回归（`npm run dev:radar-sandbox`，真实进程）

- schema=7；`/radar/review/relations` 返回 **404**（评审路由未注册）；
  `/radar/capture-sessions` 空体返回 **422**（采集桥路由存在、校验失败），证明采集桥不受影响。

### 4.4 生产库保护

- 验收前后核验 `data/offerflow.sqlite3` 未出现在 git 变更中，修改时间不变，schema 仍为 v7。

## 5. 已知边界与后续

- 决策 feed 取每候选/快照最近一次非 no_change 决策，`limit` 默认 50；分页与时间窗口过滤后续可在
  service 层扩展查询参数（不改契约形状）。
- “确认相同”仅登记语义关系；物理合并（跨候选版本链归并）不在本波范围，须另立设计与授权。
- 生产启用 V8-3 需先完成 schema v8 受控激活（设计文档 BR-1 授权 + 迁移演练），本次未涉及。
