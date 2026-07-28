# OfferFlow v0.8 · UX 收口波次 — 审计与改造方案

> 状态：**方案（未实施）**。本文档只做审计与改造设计，不含任何代码改动。
> 波次 id 待用户指定（本文内暂记为「UX 收口波次」）。
> 生成日期：2026-07-28。

## 0. 目的与硬边界

本波次目标：把 v0.7 之后逐波堆叠出来的核心页面，收口成**一条用户主线**：

1. 收集和整理岗位
2. 审核并处理岗位
3. 晋升并跟踪结果

**只改表达层，不改行为层。** 本波次严格不做：

- 不改领域模型、Repository、任务状态机；
- 不改 API 契约、请求/响应结构；
- 不改数据库结构与 migration；
- 不改业务规则（判决引擎、标准化、规则、推荐、晋升、RC-11 追踪口径）；
- 不新增依赖、不接新 AI Provider、不动 SSE/任务机制；
- 不触碰 BOSS 自动化、BYOK、正式记忆边界；
- 不改 Human-in-the-loop 环节。

**必须保留：** 现有路由与路由名、组件逻辑与 props/emit、全部 `data-testid`、全部 E2E 与单测。
本波次只允许新增「展示型」结构（步骤条、行动卡、页面三问、折叠容器）与文案。

## 1. 权威文档与读取范围

- 入口：`CLAUDE.md`、`AGENTS.md`（产品/工程边界）。
- 契约：`docs/product/offerflow-v0.8-release-contract.md`、`docs/product/offerflow-v0.8-traceability.md`。
- 现状代码（本次已直接通读/勘察）：
  - `src/router/index.ts`、`src/App.vue`
  - `src/pages/RadarImportPage.vue`（阶段 1）
  - `src/pages/RadarReviewPage.vue`（阶段 2 + 晋升入口）
  - `src/pages/JobListPage.vue`、`src/pages/JobDetailPage.vue` → `src/pages/BattlefieldPage.vue`（阶段 3 落点）
  - `src/config/features.ts`（门禁）

## 2. 现状审计

### 2.1 信息架构：主线断裂，Radar 无入口

- 顶部导航（`App.vue` 的 `app-nav`）罗列了 8+ 个 v0.7 能力入口（简历配置、简历版本、岗位匹配画像、能力基线、基础漏斗、历史补录、市场位置画像、求职策略、岗位台账），**没有任何「岗位雷达」入口**。
- Radar 三页（`/radar/import`、`/radar/review`）只能靠直接输入 URL 到达，且被 `radarEnabled` 门禁（生产默认 `false`）重定向回 `/jobs`。
- 品牌行仍显示 `v0.7.0`，与 v0.8 心智不符。
- 根路由 `/` 直接 redirect 到 `jobs`，用户对「先采集 → 再评审 → 再晋升跟踪」这条主线毫无路径感知。

**结论：** 用户看到的是并列的能力清单，而不是一条主线。三阶段主线在导航层不可见。

### 2.2 命名冲突：两个「雷达」

同一产品里「雷达」指两个不同东西，极易混淆：

| 名称 | 位置 | 含义 | 门禁 |
| --- | --- | --- | --- |
| 机会雷达（OpportunityRadar） | `BattlefieldPage` 内 5 轴雷达图 | v0.7 单岗位机会评分可视化 | 随岗位详情常开 |
| 岗位雷达（RadarCandidate 流） | `/radar/import`、`/radar/review` | v0.8 候选采集/评审/晋升主线 | `radarEnabled` 等，默认关 |

改造须在文案上明确区分，避免「雷达」一词在两处语义打架。

### 2.3 阶段 1（收集）：`RadarImportPage`

- 头部：「当前页采集预览」+ 副标题「核对采集到的字段，纠正后再确认写入…」，eyebrow「OfferFlow v0.8 · V8-2」。
- 暴露 `session id`（截断）与原始 `session.status` tag。
- 主操作：`radar-commit`（确认写入）/ `radar-cancel`（取消）。
- 写入后提示：「已确认写入，草稿采集会话结束」。
- **缺口：** 写入成功后没有「下一步去评审」的引导；用户不知道成果流向了阶段 2。结果表暴露原始 `decisionType`。

### 2.4 阶段 2（审核处理）：`RadarReviewPage`

- h1「岗位雷达 · 人工评审工作台」，双栏（待处理关系 / 决策审阅 feed）+ 推荐面板 + 晋升面板 + 候选对比 + 规则证据 + 人工操作按钮 + 确认弹窗。
- 技术码大量内联（`rel.status`、`decisionType`、`activeCandidateVersionId`、`reasonCode`、`outcome`），虽已用 `.tech-code` 视觉弱化、证据内部 ID/hash 已收进 `<details class="tech-details">`，但**默认仍可见的技术码偏多**。
- 已有中文 label 映射（`RELATION_STATUS_LABELS` 等）。
- **缺口：** 无页面级「这是做什么 / 现在做什么 / 完成后去哪」引导；动作完成后只弹「${label}已完成」，不引导下一步（继续下一条 / 去晋升 / 回台账）。

### 2.5 阶段 3（晋升与跟踪）：Review 内晋升面板 → JobList / Battlefield

- 晋升在 `RadarReviewPage` 的 `RadarPromotionPanel` 内执行（RC-11 反向追踪面板即挂于此）。
- 晋升面板暴露原始 Job/Application/Promotion ID（`<code class="oid">`），空态仅「请先选择一个岗位建议」。
- 晋升后结果落到 **v0.7 老界面**：`JobListPage`（流程摘要、决策徽章）与 `BattlefieldPage`（岗位主战场，含「下一步」决策标签、机会雷达图）。
- **缺口：** 从 Radar 界面跨到 Jobs 界面是**静默切换**，没有过桥说明，用户不知道「晋升后去哪看结果」。`BattlefieldPage` 已有「下一步」判决，可复用为跟踪落点，但与 Radar 主线无显式衔接。

### 2.6 技术码/内部细节暴露总览

默认可见、应折叠或语义化的项：会话/候选/版本/晋升 ID、`status`/`decisionType`/`outcome`/`reasonCode` 原始枚举、hash、`cityCode`、批次 `id`/`status`。原则：**默认给人看结论（中文标签），技术码收进「查看技术细节」折叠区**（沿用现有 `.tech-details`/`.tech-summary` 模式，不新建机制）。

## 3. 目标态：唯一主线

```
① 收集和整理岗位      ② 审核并处理岗位        ③ 晋升并跟踪结果
   /radar/import         /radar/review           晋升面板 → /jobs · 主战场
   采集当前页 JD    →    人工评审关系/候选   →   正式晋升 + 结果追踪
```

- 一条主线三阶段，任一时刻只推一个「主 CTA」。
- 每个阶段页面回答三问：**这是做什么 / 现在做什么 / 完成后去哪**。
- 阶段内动作完成后，明确引导到下一步（下一条 / 下一阶段 / 回台账）。

## 4. 改造设计

### 4.1 Radar 顶部三阶段步骤条（新增展示组件）

- 新增 `RadarStageStepper.vue`（纯展示，无业务逻辑）：横向三步「收集 → 审核 → 晋升跟踪」，高亮当前阶段。
- 挂载点：`RadarImportPage`（高亮①）、`RadarReviewPage`（高亮②/③）。
- 当前阶段由**所在页面**静态传入 prop（`current: 'collect' | 'review' | 'promote'`），不新引入路由或状态推断依赖。
- 步骤可点击跳转到对应路由（复用现有 route name，不新增路由）。

### 4.2 「你现在最该做什么」行动卡（新增展示组件）

- 新增 `RadarNextActionCard.vue`：接收由页面从**已有响应数据**派生的一个 `nextStep` 描述对象 `{ title, why, cta:{label,to}, secondary? }`，渲染单一主 CTA。
- 派生逻辑放在页面 `computed` 内，**只读现有状态**（如：有未确认关系 → 「先处理 N 条待确认关系」；已可晋升 → 「晋升选中候选」；无待办 → 「去岗位台账看结果」）。不新增 API、不改判决引擎。
- 阶段 3 落点：晋升成功后行动卡切为「去主战场跟踪结果」，CTA 指向 `/jobs`（或该岗位 `job-detail`）。

### 4.3 每页「三问」引导条（新增展示文案）

在三页顶部（步骤条下方）加一条轻量说明区（可复用 `n-alert` 或既有 hint 样式）：

| 页面 | 这是做什么 | 现在做什么 | 完成后去哪 |
| --- | --- | --- | --- |
| RadarImport | 预览当前页采集到的岗位字段 | 核对纠错后确认写入 | 去「人工评审工作台」处理 |
| RadarReview | 人工判断候选是否同一岗位并处理 | 逐条确认/区分/复检 | 满足条件后晋升为正式岗位 |
| 晋升/跟踪 | 把候选正式晋升并追踪结果 | 选定候选执行晋升 | 去岗位台账/主战场看后续 |

### 4.4 动作后引导下一步

- `RadarReviewPage` 人工操作完成后，除现有「${label}已完成」通知，追加下一步指引（feed 里还有待办 → 「继续下一条」；无待办 → 「本批已处理完，去晋升/回台账」）。**只加提示与 CTA，不改动作本身的调用与副作用。**
- `RadarImportPage` 写入成功后，`radar-commit` 结果区追加「去评审」CTA（route push 到 `radar-review`）。

### 4.5 技术码与内部细节默认折叠

- 默认呈现中文标签（沿用现有 label 映射）；原始枚举/ID/hash/版本号收进「查看技术细节」`<details class="tech-details">`。
- 覆盖：Import 结果表的 `decisionType`、session id/status；Review 的 `rel.status`/`decisionType`/`reasonCode`/`outcome`/版本 ID；晋升面板的 Job/Application/Promotion 原始 ID；推荐批次 `id`/`status`。
- **实现约束：保留承载技术码的 DOM 节点与其 `data-testid`**，仅用折叠容器包裹或以 label 替换可见文本；E2E 若断言原始码，改包裹不改文本值，或把断言目标留在折叠内节点（详见 §6）。

## 5. 变更清单（预期，逐项待实施波次执行）

新增（纯展示组件与文案，无业务逻辑）：

- `src/components/RadarStageStepper.vue`
- `src/components/RadarNextActionCard.vue`
- 三页顶部「三问」引导区（页面内模板 + 文案，或抽一个 `RadarGuideBar.vue`）。

修改（仅展示层）：

- `src/App.vue`：品牌行 `v0.7.0` → 当前版本；（可选）在导航加「岗位雷达」入口，受 `radarEnabled` 门禁，默认关，不改门禁语义。
- `src/pages/RadarImportPage.vue`：挂步骤条 + 三问 + 写入后「去评审」CTA + `decisionType`/session 技术码折叠。
- `src/pages/RadarReviewPage.vue`：挂步骤条 + 三问 + 行动卡 + 动作后下一步 CTA + 技术码折叠。
- `RadarPromotionPanel.vue` / `RadarRecommendationPanel.vue`：原始 ID/批次码折叠，空态补一句「这是做什么」。
- `JobListPage.vue` / `BattlefieldPage.vue`：作为阶段 3 落点，补「结果从雷达晋升而来」的轻量说明（可选，不改判决与摘要逻辑）。

**不修改：** 任何 `src/domain/**`、`src/api/**`、`src/storage/**`、Repository、迁移、判决引擎、features 门禁默认值。

## 6. 兼容性护栏（路由 / 组件逻辑 / testid / E2E）

- **路由：** 不新增、不重命名、不删除路由；步骤条与 CTA 仅 `router.push` 到现有 route name。
- **组件逻辑：** 不改现有组件的 props/emit/内部状态机；新增组件为叶子展示件，数据由父页面从已有响应派生传入。
- **testid：** 现有 `data-testid` 一律保留在原节点；折叠改造只包裹或换可见文案，不移除/改名 testid。新增元素用新增 testid（如 `radar-stage-stepper`、`radar-next-action`、`radar-guide-bar`）。
- **E2E：** 现有 selector 若依赖当前可见的技术码文本，需先跑一遍现有 `radar` / `review` / `promotion` / `trace` E2E，定位受影响断言；折叠时把该文本保留在折叠内的同一 testid 节点，使断言不破。实施波次以「先跑基线 → 改 → 再全绿」为准。

## 7. 验证计划（实施波次执行，本波次不跑）

实施时按序：`vue-tsc` 类型检查 → `vitest` 全量 → 相关 E2E（radar/review/promotion/trace）→ `vite build`。
核心三页需真实截图 + 中文文案人工验收（对照 §3 三阶段与 §4.3 三问表）。未运行的验证必须显式说明。

## 8. 风险与遗留

- **命名冲突（§2.2）** 若不同步处理，步骤条「雷达」与主战场「机会雷达」仍会混淆；建议文案上把主线统一叫「岗位雷达」，图表叫「机会雷达图」。
- **导航入口开关：** 生产 `radarEnabled` 默认关，导航加入口须受同一门禁，避免在未激活环境暴露半成品主线。
- **E2E 技术码断言：** 折叠是本波次最可能触碰测试的点，须以基线 diff 驱动，不可盲改。
- **阶段 3 跨界：** Radar → Jobs 是既有事实，本波次只加「过桥说明」，不做界面合并（合并属更大重构，超出 UX 收口范围）。

## 9. 边界确认（需用户在实施前拍板）

1. 本波次的正式波次 id 与命名（建议 `V8-UX 收口` 或独立标注，不占用 V8-6 范围）。
2. 导航是否新增「岗位雷达」入口（受 `radarEnabled` 门禁）——涉及用户可见 IA，需确认。
3. 品牌行版本号目标文案。

以上未确认前不进入实施。**本次仅交付审计与方案，未改业务代码、未改数据库、未新增依赖、未动 AI/SSE/任务机制、未 commit。**

