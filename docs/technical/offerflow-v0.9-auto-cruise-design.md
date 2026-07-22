# OfferFlow v0.9 技术设计：全自动巡航模式（AutoCruiseRun / SourceScanRun）

> **文档状态：** 设计已审核通过（含最终裁决与调整），**尚未实施**。
> **版本归属：** v0.9（不计入 V8-2 Done；V8-2 必须先完成并真实验收）。
> **硬边界：** 本设计不改 schema/migration、不改 DTO 领域持久层、不做后台/定时运行、不投递/打招呼、不绕过风控/反爬字体、不改搜索条件。
> **前置依赖：** 复用 V8-2「批量选卡 + 串行右侧详情采集」Runner（semanticCard / Shadow DOM 手动选择 / 串行采集 / known identity 校验 / 单批≤8 / 单批量 preview）。V8-2 完成只解除设计前置，不构成实现授权；后续实施仍须满足 V8-3～V8-6 依赖或获得用户新的明确批准。

---

## 0. 一句话定位

用户主动启动后，在**当前前台标签页**的 BOSS 列表页：自动滚动加载 → 扫描卡片 → 稳定身份提取 → 历史精确去重 → 卡片级透明预筛 → 维护 shortlist（最多 targetCount，客户端内存）→ 用户或低能量策略从 shortlist 选 ≤8 条串行采集详情 → 每批生成一个 ≤8 条 preview session → 用户最终确认后才落库。**巡航发现量（≤100）与单次可确认量（≤8）是两个不同的数。**

---

## 1. 现有能力审计结论（v0.9 设计前实测）

| 项 | 结论 |
|---|---|
| 批量历史身份预检 API | 不存在。仅 `RadarSourceRecordRepository.findByProviderKey` / `findByNormalizedSourceUrl` 单行查找。→ 新增 **W1 只读接口**。 |
| 预筛 / matching profile API | `GET /job-match-profile` 存在（返回 profile + activeVersion）；无"单岗位预筛判定"接口。→ 新增 **W1 服务端 prefilter**。 |
| profileVersion | 存在（`activeVersionId` + `versions[]` + activate 流程）。 |
| 单 session item 上限 | **硬上限 8**（`MAX_PREVIEW_ITEMS_PER_SESSION=8`，`addItem` 强制校验）。 |
| commit `confirmedIndexes` | max 20，但受 session≤8 约束实际 ≤8。 |
| 扩展权限 | `activeTab`+`scripting`+host `127.0.0.1:17365` 足够前台滚动/注入；`chrome.tabs.create` 无需 `tabs`。 |
| MV3 SW | V8-2 已有 background service worker；SW 会被浏览器回收，**不得承载 10 分钟巡航**，v0.9 仅复用它做最终提交与只读接口代理。 |
| 全局 CORS | `onRequest` 反射 origin；但 `/radar/*` 额外有 loopback + capture-client 头 + origin 白名单闸门，`/job-match-profile` 无此闸门（这也是选择服务端 prefilter 而非扩展直读 profile 的原因之一）。 |

---

## 2. W1 新增只读接口（已批准，无 schema/migration）

### 2.1 `POST /radar/source-identities/check`（历史身份批量预检，已批准）
- 单次最多 **200** 条；输入 `{ items: [{ providerKey, externalRecordId, canonicalSourceUrl }] }`。
- 输出**保持输入顺序**：`{ results: [{ providerKey, externalRecordId, status }] }`，`status ∈ { new, existing, conflict }`。
- **不返回**岗位正文、Candidate 内容或任何敏感数据。
- 复用现有 `radar_source_records` 与仓储查询（`findByProviderKey` / `findByNormalizedSourceUrl`）。
- **幂等**（纯只读查询，天然幂等）。
- 安全闸门与 `/radar/*` 一致：loopback + extension origin allow-list + capture-client 头。
- **conflict 语义（收紧）**：仅当「同 `providerKey+externalRecordId` 已存在，但传入的 **normalized canonical identity** 与已有来源不可兼容冲突」时返回 conflict。**动态 query / securityId / 普通 URL 参数差异不得构成 conflict**（先按现有 `normalizeSourceUrl` 规范化后再比较）。
- 不改 schema/migration。

### 2.2 `POST /radar/prefilter`（服务端批量预筛，已批准）
- 扩展**不得**直接获取或长期持有完整 job-match-profile。
- 单次最多 **200** 个卡片级最小字段：`providerKey, externalRecordId, role, companyDisplayName, city, salary, experience, education, strategy, expectedProfileVersion?`。
- `strategy ∈ { survival_first(默认), balanced, precision_first }`。
- 输出每项：`verdict ∈ { recommended, uncertain, not_recommended }`、`matchedRules`、`warningRules`、`rejectedRules`、`missingFields`、`confidence`、`profileVersion`、`hardBlock`。
- 必须：服务端读取 active profile snapshot；**透明确定性规则**裁决；**不使用自由生成式 LLM 做最终裁决**；profile 缺失返回明确错误（不允许扩展硬编码画像）；`expectedProfileVersion` 与当前不一致返回 `stale_profile`（巡航暂停并提示用户刷新筛选结果）；安全闸门同 Radar；不改 schema/migration。
- 预筛不得因「缺薪资 / 公司性质未知 / JD 未加载」直接 reject（这些进 `uncertain` 或 `missingFields`）。

---

## 3. 三层数量模型（最终裁决）

**明确区分，不得混淆：**

### 3.1 Cruise Shortlist（巡航发现量，客户端内存）
- 巡航在当前标签页发现并维护最多 **targetCount** 条「新匹配岗位」。
- targetCount 预设：**20 / 50 / 100 / 直到没有新岗位**。
- **「新匹配岗位」定义（targetCount 计数口径）**：同时满足
  1. externalRecordId 可靠；
  2. 当前巡航批次未重复；
  3. OfferFlow 历史不存在（经 §2.1 批量预检）；
  4. 通过卡片级预筛（§2.2，仅 `recommended` 计入；`uncertain` 视配置）；
  5. 非 blocked identity。
- **这不是 Capture Session 的 item 数。** 历史重复不计入 targetCount，但计入 `duplicateCount`。

### 3.2 Detail Capture Batch（每批详情采集量）
- 用户或低能量策略从 shortlist 选**下一批**，**每批最多 8 条**（= 服务端 session 硬上限）。
- 默认三种取批方式：采集选中的岗位(≤8) / 采集评分最高前 8 条 / 采集下一批 8 条。

### 3.3 Preview Session（每批一个预览会话）
- 每次详情采集完成后**只创建一个 ≤8 条 preview session**。
- 原巡航标签页继续保留 shortlist 与剩余队列；用户处理完当前预览后返回处理下一批。
- **禁止**：默认自动创建 13 个预览页；一次打开大量 preview tab；静默截断 100 条；把 preview session 当作巡航结果持久化仓库。
- 「用户显式选择按 8 条分块生成多个预览」保留为**未来选项**，非 v0.9 MVP 默认流程。

---

## 4. 完成模式（最终定义）

### 4.1 `review_before_capture`（默认）
巡航达停止条件后停在 shortlist，用户二筛，选 **≤8** 条进入详情采集。

### 4.2 `auto_capture_after_filter`（重定义）
- 巡航达停止条件；
- 自动按预筛优先级选**评分最高前 8 条**；
- 串行采集详情；
- 创建**一个** preview session；
- 其余 shortlist 仍保留在原巡航页面；
- **不自动继续生成第二个 preview session**；
- **不自动 commit**。

两种模式都**绝不自动 commit**。

---

## 5. 巡航状态机

**批次级**
```
idle → initializing → scanning → filtering → scrolling → waiting_for_load → scanning …
     → shortlist_ready
     → (review_before_capture: 用户二筛 ≤8) → capturing_details
     → (auto_capture_after_filter: 自动取前 8) → capturing_details
     → preview_submitting → completed | cancelled | stopped_by_guard
     ⇄ paused
```
**单项级**
```
discovered → identity_resolved → duplicate | prefilter_rejected | shortlisted
          → resolving_card → navigating → observing → extracting → verifying
          → captured | needs_correction | failed | retryable_failed
```

---

## 6. 自动滚动逻辑

每轮：① 记录当前逻辑岗位 ID 集合 → ② 扫描已渲染卡片 → ③ 归并 semanticCardRoot → ④ 批次内 `providerKey+externalRecordId` 去重 → ⑤ 批量历史预检（§2.1）→ ⑥ 卡片级预筛（§2.2）→ ⑦ 匹配项入 shortlist → ⑧ 滚到列表底 → ⑨ 等 loading 状态结束 → ⑩ 等 ID 集合在 **300–800ms** 内稳定 → ⑪ 下一轮。

- **不得**仅以单次 DOM mutation 判定加载完成（loading 结束 + ID 集合去抖双条件）。
- **不得**自动改变搜索条件、城市或关键词。

---

## 7. 停止条件（结构化记录原因）

满足任一即停自动滚动：① shortlist 新匹配达 targetCount；② 连续 3 轮无新 externalRecordId；③ 连续 3 轮全为历史重复；④ 页面明示无更多岗位；⑤ 达最长运行时间（默认 **10 分钟**）；⑥ 达最大滚动轮次；⑦ 验证码 / 登录失效 / 风控 / 页面异常；⑧ 身份提取失败率超阈值；⑨ 用户暂停或取消。每个停止原因写入 `stopReason`（结构化枚举 + 详情）。

---

## 8. 预筛策略

复用 active profile snapshot（经 §2.2 服务端接口），**扩展不硬编码画像**。`survival_first`（默认，高召回少错杀）/ `balanced` / `precision_first`。输出 recommended / uncertain / not_recommended；**仅 recommended 自动进 shortlist**；`uncertain` 可配置（进详情复核 或 留用户二筛）；缺薪资 / 公司性质未知 / JD 未加载**不得直接 reject**。

---

## 9. 精确去重（三层）

1. **当前 DOM 内**：semanticCardRoot + externalRecordId（同卡嵌套/克隆节点合并为一条逻辑卡）；
2. **当前巡航批次内**：providerKey + externalRecordId；
3. **OfferFlow 历史**：只读批量 identity check（§2.1）。

**禁止**用岗位名 / 公司名 / 语义相似度判历史重复。已有岗位不计入 targetCount，计入 `duplicateCount`。

---

## 10. 详情采集（复用 V8-2 批量 Runner）

队列不留长期 DOM 引用；处理前按 externalRecordId 重定位卡片；串行点击（无并发）；MutationObserver 等 fingerprint 改变并稳定；右侧 identity 校验（href 或 role+salary crosscheck）；单项失败继续；PUA 薪资回退**同卡**可读薪资；`3–5年` 永不为薪资；JD-first 定位；失败不回退整页；identity 不可靠 fail-closed。

---

## 11. v0.9 MVP 生命周期（无持久化）

- **不新增 storage 权限，不新增巡航结果持久化表。** shortlist 仅存当前前台页面运行上下文。
- 页面刷新 / 整页导航 / 标签关闭 → **未处理的巡航结果丢失**，UI 必须明确提示。
- 持久化 AutoCruiseRun / SourceScanRun 作为 **v0.9.1 或后续独立设计**，需 schema/migration 时另行审批。

---

## 12. 运行安全与控制

- 实时状态面板：已扫描 / 历史重复 / recommended / uncertain / rejected / 已采集详情 / 当前滚动轮次 / 停止原因。
- 控制：暂停 / 继续 / 停止并保留结果 / 取消并丢弃结果。
- 允许：自动滚动、等无限列表加载、扫描新渲染卡片、卡片级预筛、对筛选后岗位串行点击、批量详情采集。
- **禁止**：自动投递 / 打招呼 / 聊天；自动翻页到其他搜索条件；多标签并发；后台定时无人值守；绕过验证码/登录/风控；解码逆向反爬字体；扫描用户未主动启动的页面。
- 出现验证码 / 登录失效 / 风控 / 页面异常 → 立即停止并提示。
- v0.9 初版不做后台恢复与定时运行。

---

## 13. 权限边界

- 复用 V8-2 已有 background service worker，仅承担最终提交与 §2 只读接口代理；巡航状态不得放在其中。
- **无新增敏感权限**（activeTab/scripting/host 已够；不加 `tabs`/`alarms`/广域 host/`storage`）。

---

## 14. 影响文件（实施时；本轮不动）

**新增（扩展）**：`src/content/cruiseController.ts`、`cruiseOverlay.ts`、`src/extractors/cardScan.ts`、`src/api/{identityCheckClient,prefilterClient}.ts` + fixtures/specs。
**新增（服务端，W1，无 schema/migration）**：`server/radar/routes.ts` 两个只读路由、`dtoSchemas.ts` request/response schema、`service.ts` 批量方法（identity-check / prefilter）+ 单测。
**修改**：既有 `src/background/background.ts`（只读代理）、`manifest.json`/`build.mjs`（若实现入口确需调整）、`src/popup/*`（巡航启动 + targetCount/strategy/完成方式）、`src/pages/RadarImportPage.vue`（多批次预览汇总）。
**不改**：schema/migration、领域模型持久层、正式记忆、现有 commit 不可变写入与精确去重、DTO 领域契约。

---

## 15. 实施波次（仅设计；尚未授权实施）

以下波次是已批准的设计顺序，不因 V8-2 checkpoint 或 schema v7 激活而自动进入实施：

- **W1**：两个服务端只读批量接口（`/radar/source-identities/check`、`/radar/prefilter`）+ 单测。
- **W2**：自动扫描、去重、滚动与停止条件（纯逻辑 + 状态机）。
- **W3**：低能量预筛接入与巡航 UI（overlay + 控制 + 实时统计）。
- **W4**：shortlist → 每批 8 条详情采集（复用 V8-2 Runner）+ 多批次预览汇总。
- **W5**：真实 Chrome 验收。

---

## 16. 风险与真实 Chrome 验收

**风险**：无限列表虚拟化致 DOM 引用失效（按 id 重定位）；加载稳定误判（loading 结束 + ID 去抖双条件）；反爬字体致卡片薪资不可读（预筛不因缺薪资 reject）；风控/验证码（即停不绕过）；session=8 与 100 目标（三层数量模型，不静默截断）；预筛画像来源（服务端 prefilter，扩展不持画像）。

**真实 Chrome 验收（人工）**：真实 BOSS 列表页启动巡航 → 自动滚动+加载稳定、历史去重命中、预筛分类、停止原因结构化、每批 ≤8 预览生成、验证码/登录失效即停；核对运行期**零正式写入**、仅用户确认后落库、串行无并发、单项失败续跑、刷新/离开即终止且有提示。

**测试计划**：§十三 的 24 条按「纯逻辑单测（启动门禁、滚动发现新 id、clone 去重、批次/历史去重、targetCount 与三轮/无更多/超时停止判定、不改搜索条件、profile 缺失不硬编码、两种完成方式分支、串行无并发、单项失败续跑、运行期零 DB 调用、只建一个 ≤8 会话、分批策略、不投递/聊天/绕风控守卫）」与「真实页手动（自动滚动加载、验证码即停、刷新清理、MutationObserver 稳定）」拆分。
