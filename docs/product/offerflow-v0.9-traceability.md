# OfferFlow v0.9 Traceability：全自动巡航模式

> **矩阵版本：** 0.1（设计基线）
> **状态：** 设计已审核通过（含最终裁决）；**代码未实施**；后续实施仍需在 V8-3～V8-6 依赖满足后获得单独明确授权。
> **权威设计：** `docs/technical/offerflow-v0.9-auto-cruise-design.md`
> **硬边界：** 不改 schema/migration、不改 DTO 领域持久层、不做后台/定时、不投递/打招呼、不绕风控/反爬、不改搜索条件；未 commit/push/merge/Tag/Release。

---

## 1. V8-2 ↔ v0.9 最终边界

### 1.1 V8-2 正式范围（必须先完成并真实验收）
- BOSS `job_detail` 一键采集；
- BOSS 列表页**手动批量选卡**（Shadow DOM 手动选择，用户勾选是唯一身份锚点）；
- **串行右侧详情采集** + known identity 校验；
- **单批最多 8 条**；
- **一个批量 preview session**；
- 不保留任何用户可见的手工 JD 文本粘贴、链接加文本或 JSON 对象/数组导入入口；
- fail-closed 安全逻辑与不可变 Snapshot/CandidateVersion 写入 + 精确去重。

> **low-energy 自动预筛不再作为 V8-2 Done 条件。** list_panel「自动猜测当前 selected 卡片」不作为正式能力，仅保留为单项失败诊断探针。

### 1.2 v0.9 已批准设计范围（尚未授权实施）
- 低能量自动预筛；
- 服务端批量 prefilter（`POST /radar/prefilter`）；
- 历史身份批量预检（`POST /radar/source-identities/check`）；
- 自动滚动加载；
- 全自动巡航（AutoCruiseRun / SourceScanRun）；
- 最多发现 100 条新匹配岗位（Cruise Shortlist）；
- shortlist 分批（每批 ≤8）进入详情采集。

---

## 2. 「100 条 targetCount」新定义

- **targetCount = Cruise Shortlist 的逻辑岗位数**，预设 20 / 50 / 100 / 直到没有新岗位。
- 计入 targetCount 的「新匹配岗位」须同时满足：externalRecordId 可靠 + 巡航批次未重复 + OfferFlow 历史不存在 + 通过卡片级预筛（仅 recommended；uncertain 视配置）+ 非 blocked identity。
- **targetCount ≠ Capture Session item 数**。历史重复不计入 targetCount，计入 `duplicateCount`。

---

## 3. session=8 最终处理策略

- 服务端单 session 硬上限保持 **8**（`MAX_PREVIEW_ITEMS_PER_SESSION=8`），**本轮不提升、不改 DTO**。
- 三层数量模型：Cruise Shortlist（≤targetCount，客户端内存）→ Detail Capture Batch（每批 ≤8）→ Preview Session（每批一个 ≤8 会话）。
- 每次只处理并生成**一个** ≤8 preview session；剩余 shortlist 留在巡航页面，用户处理完再取下一批。
- **不默认自动创建 13 个预览页、不一次性打开大量 tab、不静默截断 100 条、不把 preview session 当持久化仓库。**
- 提升 session 上限、持久化巡航结果均为后续独立提案，需 schema/DTO/migration 时另行审批。

---

## 4. W1 只读接口裁决（已批准，未实施）

| 接口 | 状态 | schema/migration |
|---|---|---|
| `POST /radar/source-identities/check`（≤200，new/existing/conflict，保序，幂等，conflict 仅稳定身份冲突，动态 query/securityId 不构成 conflict） | 已批准，未实施 | 不改 |
| `POST /radar/prefilter`（≤200，服务端读 profile snapshot，确定性规则，不用生成式 LLM 裁决，profile 缺失报错，expectedProfileVersion 不符返回 stale_profile） | 已批准，未实施 | 不改 |

均复用现有 `radar_source_records` / `job-match-profile`，套用 `/radar/*` 安全闸门。

---

## 5. 实施波次

| 波次 | 内容 | 状态 |
|---|---|---|
| 前置 | V8-2 批量 Runner（semanticCard / Shadow DOM 手动选择 / 串行采集 / known identity / ≤8 / 单 preview / 全测试 + 真实 Chrome 验收 / checkpoint） | 已完成；生产 schema v7 受控激活不属于 v0.9 实施授权 |
| W1 | 两个服务端只读批量接口 + 单测 | 未开始 |
| W2 | 自动扫描、去重、滚动与停止条件（纯逻辑 + 状态机） | 未开始 |
| W3 | 低能量预筛接入 + 巡航 UI（overlay/控制/实时统计） | 未开始 |
| W4 | shortlist → 每批 8 条详情采集 + 多批次预览汇总 | 未开始 |
| W5 | 真实 Chrome 验收 | 未开始 |

---

## 6. 决策日志

| # | 裁决 | 结论 |
|---|---|---|
| D1 | 历史身份批量预检接口 | 批准 `POST /radar/source-identities/check`（只读、≤200、保序、幂等、conflict 收紧、不改 schema） |
| D2 | 预筛方案 | 选**服务端** `POST /radar/prefilter`；扩展不得直接获取或长期持有完整 profile |
| D3 | 数量模型 | 不默认自动创建 13 个预览会话；采用 Shortlist / Detail Batch(≤8) / Preview Session(≤8) 三层；每次只生成一个 ≤8 会话 |
| D4 | 完成模式 | `review_before_capture`（默认，用户选 ≤8）；`auto_capture_after_filter`（自动取评分前 8、单会话、不自动续批、不自动 commit） |
| D5 | MVP 生命周期 | 无 storage 权限、无持久化表；shortlist 存前台运行上下文，刷新/离开丢失并 UI 提示；持久化留 v0.9.1 |
| D6 | 版本归属 | 低能量预筛/自动预筛/巡航/自动滚动/历史预检统一进 v0.9；不作为 V8-2 Done 条件 |
| D7 | 实施顺序 | V8-2 完成只解除设计前置，不自动授权实现；须满足 V8-3～V8-6 依赖或由用户重新明确批准后，才能进入 v0.9 W1→W5 |

---

## 7. 发布授权追踪

| 动作 | 当前授权 |
|---|---|
| 实施 v0.9 W1 接口 | 未授权（V8-2 完成不构成实施授权） |
| 修改 DTO / schema / migration | 未授权 |
| 修改 manifest | 未授权（v0.9 实施时随 W3/W4） |
| 合并/推送 main / Tag / Release | 未授权 |
