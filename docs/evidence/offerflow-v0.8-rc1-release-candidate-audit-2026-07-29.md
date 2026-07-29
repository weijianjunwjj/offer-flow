# OfferFlow v0.8.0-rc1 · 发布候选收口审计

> **状态：`ENGINEERING COMPLETE / RELEASE CANDIDATE`（v0.8.0-rc1）——非 GA。**
> **日期：** 2026-07-29
> **分支：** `feat/v0.8-v8-6`
> **收口前 HEAD：** `eb43f1af57a07bf0d3b19fb296953d3f20fc2faf`
> **相对 main：** 领先 48 commit，180 文件，+20699 / -85
> **本次不改功能代码**：仅文档口径收口 + 本审计报告；未 merge / push / tag。

---

## 1. 收口结论

v0.8 已达 **工程完成 / 发布候选（Release Candidate）**：面向用户的核心结果已实现、可解释、有自动化回归与人工验收证据。但 **§4「版本完成判定」尚未全部满足**，因此**只声明 rc1，不得声明 GA / 正式发布 / 版本完成**。

阻塞项（不由工程侧解除）：

1. **30 条真实评测** —— 数据与人工标注阻塞（RC-09 相关、RC-12 发布闭环）。
2. **生产 v8 migration / backup / recovery** —— 授权阻塞（BR-1，需用户单独授权 + 演练）。
3. **核心页面真实截图与产品文案人工验收** —— 未完成。
4. **V8-UX「人工无说明 smoke」** —— 待补（不看技术码、仅凭中文文案走通三阶段主线）。

以上 1～3 属 Release Contract §4 判定条件，未满足前不得 GA。

---

## 2. RC 逐项状态

| RC | 结果 | 依据 |
|---|---|---|
| RC-01 BOSS 当前页采集 | Done | V8-2 真实链路 + 最终 Preview 零写入 |
| RC-02 通用降级 | Done | 真实 MV3 + generic fallback E2E |
| RC-03 入口收敛统一预览 | Done | 手工入口删除、JSON route 404 |
| RC-04 不可变来源/版本 | Done | schema v7 激活 + 写入闭环 |
| RC-05 重复与变化 | Done | V8-3 人工验收（证据例外） |
| RC-06 透明规则 | Done | V8-3 人工验收 |
| RC-07 可解释单岗位分析 | Done | V8-4 人工验收（2026-07-27） |
| RC-08 0～8 条推荐 | Done | V8-5 人工验收（2026-07-27） |
| RC-09 误区/证据不足 | **Not Started** | 待 formed/insufficient 样本 |
| RC-10 雷达动作 | Done | 人工验收（2026-07-28） |
| RC-11 正式晋升/反向追踪 | Done | 人工验收（2026-07-28） |
| RC-12 可靠任务与发布闭环 | **Partial / Blocked** | 分析任务已验收；发布闭环三项被阻塞 |

---

## 3. 波次状态

| 波次 | 状态 | 说明 |
|---|---|---|
| V8-1 领域模型与 migration | 完成 | schema v7 生产受控激活（2026-07-22） |
| V8-2 采集桥与导入 | `CLOSED / FROZEN` | 真实 BOSS 单条/批量 + 通用降级 |
| V8-3 标准化/重复/变化/规则 | `ACCEPTED / ACTIVATION PENDING` | schema v8 仅沙箱；生产 v7 |
| V8-4 任务与单岗位分析 | 功能开发完成（人工验收通过） | RC-07 + RC-12 单分析部分 |
| V8-5 推荐批次 | 功能开发完成（人工验收通过） | RC-08 |
| V8-6 晋升/评测/发布验收 | 功能开发完成；发布闭环 Partial/Blocked | RC-11 Done；评测/迁移/截图未完成 |
| V8-UX 表达层收口 | **实现完成，人工 smoke 待补** | commit `633eb0d`、`eb43f1a` |

**V8-UX 交付：** 纯展示层——`RadarStageStepper`（三阶段步骤条）、`RadarNextActionCard`（单一主 CTA 行动卡）、`RadarGuideBar`（每页三问）、导航「岗位雷达」入口（受既有 `radarEnabled` 门禁，默认关）、技术码默认折叠进 `<details class="tech-details">`。**未改**行为层：路由/route name、props/emit/状态机、全部 `data-testid`、E2E/单测断言目标文本值、`src/domain|api|storage/**`、Repository、migration、判决引擎、features 门禁默认值均未变；未新增依赖、未动 AI/SSE/任务机制、未触碰 BOSS 自动化/BYOK/正式记忆。

---

## 4. 最终门禁执行结果（2026-07-29）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（`vue-tsc --noEmit`） | 通过 |
| 单元/集成 | `npm run test`（`vitest run`） | **1456 / 1456**，141 文件 |
| 构建 | `npm run build`（`vue-tsc && vite build`） | 通过，3140 模块 |
| 评审 E2E | `npm run review:e2e` | 11 / 11 |
| 推荐 E2E | `npm run recommendation:e2e` | 5 / 5 |
| 晋升 E2E | `npm run promotion:e2e` | 11 / 11 |
| 动作 E2E | `npm run action:e2e` | 10 / 10 |
| 追踪 E2E | `npm run trace:e2e` | 13 / 13 |
| 迁移自检 | `npm run migration:selftest` | passed |
| 数据库体检 | `npm run db:doctor` | `ok`，`integrity=ok`，FK 违例 0 |

radar E2E 合计 **50 / 50**。`promotion:e2e` 日志中 `UNIQUE constraint failed: radar_promotions.id` 属「原子失败零残留」用例的**预期**注入错误，用例本身通过。

---

## 5. main 差异概览

- 领先 `main` **48** commit（`git rev-list --count main..HEAD`）。
- **180** 文件变更，**+20699 / -85**。
- 覆盖波次：V8-4（可靠单岗位分析）、V8-5（推荐批次）、V8-6（晋升 + 反向追踪）、V8-UX（表达层收口）、以及配套沙箱/E2E/文档/备份兼容修复。
- 本次收口 commit 仅含**文档**：3 份 product 文档口径更新 + 本审计报告，**零功能代码改动**。

---

## 6. 边界与授权状态

- 生产 schema 仍 **v7**；`PRODUCTION_SCHEMA_VERSION` 保持 **2**；Radar 与 Analysis 正式入口 **DISABLED**。
- 真实 AI Provider 仍为 DeepSeek；未接新 Provider、未做 BYOK、未绑定 SSE。
- Human-in-the-loop 全程保留（预览与确认分离、无自动晋升、append-only 审计）。
- **合并 main / 推送 main / Tag / Release 均未授权**，本次不执行。

---

## 7. 遗留风险与未完成项

1. **RC-09（误区/证据不足）Not Started** —— 需 formed/insufficient 样本。
2. **30 条真实评测** —— 数据与人工标注阻塞。
3. **生产 v8 受控激活（BR-1）** —— 授权阻塞；未运行 v8 生产 migration/backup/recovery 演练。
4. **核心页面真实截图 + 产品文案人工验收** —— 未完成（含 V8-UX「人工无说明 smoke」）。
5. **BR-2** —— §9 规则证据缺口字段证据严格性档位仍待裁决。
6. **已知遗留：** `App.vue` 品牌行仍显示 `v0.7.0`（V8-UX 方案 §4.5 建议改为当前版本，本波未改）。

**以上 2～4 属 GA 前置且不由工程侧解除。在其全部满足并获用户明确批准前，v0.8 保持 Release Candidate，不得声明 GA。**
