# OfferFlow v0.7 阶段交接（2026-07-13）

本文档是 v0.7.0-A 完成后的阶段事实与 v0.7.0-B 技术设计入口。产品范围仍以 `docs/prd/offerflow-v0.7.md` 为准，A 的实现约束与决策依据仍以 `docs/architecture/offerflow-v0.7.0-a-technical-design.md` 为准。

## 1. 当前阶段

v0.7.0-A 已完成、合并并推送。当前 App 版本仍为 `0.6.2`；这次阶段完成不等于正式发布 `0.7.0`。

| 项目 | 状态 |
|---|---|
| v0.7.0-A | 已完成 |
| 功能分支 | `feat/v0.7.0-a-page-foundation` |
| 功能分支 HEAD | `a89f29d1292de88879f7b7f138d9b1169ca28173` |
| main 合并提交 | `9f935dbec65f860bb8d62bb1c1f231128dc900f6` |
| main | 已推送 |
| 功能分支 | 已推送并保留 |
| PR | 未创建；个人项目默认禁止创建 PR |
| Tag | 未创建 |
| Release | 未发布 |
| App 版本 | `0.6.2` |

## 2. v0.7.0-A 已落地能力

- 使用 Hash Router 建立 `/jobs`、`/jobs/new`、`/jobs/:jobId` 等可定位页面入口，并完成创建页、列表页和详情页的职责拆分。
- `JobDetailPage` 是详情 Page Scope 的唯一 owner；五个稳定 Section 通过 Scope 注入消费页面能力，不重复创建 Scope。
- Page Scope 将服务端事实、编辑草稿、分析工作区状态和 UI 瞬态分开：服务端与 SQLite 仍是永久事实源，Scope 不成为跨页面 Store。
- Runtime `loadJobBundle` Gate 1 已接管详情页只读加载并默认开启；Runtime 与 direct fallback 由 feature flag 单路径选择，不并发执行两套 loader。
- 读取链支持 `AbortSignal`、run 身份校验和销毁保护，覆盖 A→B→C 快速切换、abort、leave、destroy 与 loading 收口，旧响应不能覆盖当前页面。
- legacy SSE 与 OCR 仍沿用既有链路，并保留重复执行、组件销毁和路由离开时的旧写防护；SSE 尚未进入 Runtime Gate 2。
- Router smoke 具备可控启动、端口探测、清理和退出行为，Windows 下可以连续执行。
- 未修改数据库 schema、migration、snapshot 语义或正式业务状态；AI 分析、JD 导入、状态改变、消息发送和投递仍保留 Human-in-the-loop，系统不执行外部自动动作。

## 3. 最终验收事实

以下是 v0.7.0-A 合并前后已经完成的最终验收记录，本次文档归档没有重新运行完整业务测试：

| 检查 | 最终结果 |
|---|---|
| Vitest | 8 files / 26 tests，通过 |
| typecheck | 通过 |
| build | 通过 |
| selftest | 通过 |
| OfferFlow JSON eval | 10/10，通过 |
| snapshot:check | 通过 |
| Backend API selftest | 通过 |
| Router smoke | 连续两次通过，端口均释放 |
| `git diff --check` | 通过 |

## 4. 已知非阻塞风险与短期债务

- `vue-page-runtime` 仍为 alpha 版本，当前精确锁定 `0.2.0-alpha.5`。
- direct loader fallback 暂时保留；是否删除必须在稳定观察后作为独立决策处理。
- SSE 尚未进入 Runtime Gate 2，不得默认塞入 v0.7.0-B。
- Vite build 约 670 KB 的大 chunk 提示作为独立性能工作处理，不在 B 技术设计中顺手解决。

## 5. v0.7.0-B 范围预审

### 5.1 唯一核心业务目标

建立可信求职记忆，使系统第一次能够准确表达“发生过什么”：Job 只表达岗位与 JD 事实，Application 表达一次真实求职机会，FeedbackEvent 表达不可被当前状态覆盖的过程事件，ResumeVersion 标记每次机会所使用的简历上下文。

### 5.2 与 A、C 和后续版本的边界

- A 已完成 Router、详情页拆分、Page Scope、Runtime Gate 1 和异步读取安全；B 可以复用这些页面入口与生命周期基础，但不能重新扩张 A，也不要求所有 B 写操作 Runtime 化。
- B 包含 ResumeVersion、Job / Application 分离、FeedbackEvent、重复投递与多渠道归属、事件时间线、migration 与旧数据兼容。
- C 才包含最小历史基线补录、高价值详细补录、按城市 / 岗位 / 渠道 / ResumeVersion 的基础漏斗，以及 Runtime SSE Gate 2。
- CandidateEvidence、CapabilityBaseline、MarketPositionProfile、EvidenceSufficiency 和 AI Proposal 属于 v0.7.1；StrategyWindow 与完整 Proposal Review 历史属于 v0.7.2，均不得偷跑进 B。

### 5.3 B 对 A 基建的依赖

- 页面：复用 `/jobs/:jobId` 与 `JobDetailPage`，预计新增或启用 Application 区域和 Feedback 时间线；是否在 B 同步提供 `/applications`、`/profile-versions` 的完整独立页面，需要技术设计明确最小验收界面。
- Page Scope：只承载当前路由页的读取结果、编辑草稿和 UI 瞬态；Application、FeedbackEvent、ResumeVersion 的正式事实必须由服务端和 SQLite 持有。
- Runtime：可用于读取和刷新；创建 Application、新增或纠正 FeedbackEvent、切换当前 ResumeVersion 等写命令仍由普通 Action 调用后端门禁和持久化，成功后再刷新读取任务。

### 5.4 预计涉及范围

| 维度 | PRD 已明确的方向 |
|---|---|
| 页面 | 岗位详情中的 Application 区域、Feedback 时间线；独立列表或 ResumeVersion 管理入口的最小范围待确认 |
| 领域模型 | ResumeVersion、Application、FeedbackEvent，并保持 Job 仅表示岗位事实 |
| API | 上述实体的读取与用户明确触发的写入；具体资源路径、纠错和幂等语义待设计 |
| SQLite | 预计新增或调整持久化实体与 migration，并要求旧 Job 数据兼容、无丢失；本轮不设计表结构或 migration |
| AI 与人工确认 | B 不引入正式 AI Proposal；现有 AI 分析与 JD 导入人工门禁继续保留，业务事实写入必须由用户明确触发 |

### 5.5 已明确的业务规则

- 同一 Job 可以有不同渠道、不同 ResumeVersion、不同 HR 或重新开放后的多次 Application，不能覆盖旧机会。
- FeedbackEvent 必须归属 Application，并保留发生时间、来源、置信度、证据强度与必要上下文。
- 用户主动退出与招聘方拒绝必须分离；未投递、主动放弃、岗位过期和无真实互动不构成市场拒绝。
- 能力证据可以跨城市参考；薪资、回复率、面试转化率、学历筛选强度、岗位供给等市场数据不得跨城市混算。
- B 负责保存未来判断所需的城市、渠道、ResumeVersion、招聘主体和信号来源上下文，不在 B 提前生成城市画像、漏斗或降薪建议。

### 5.6 技术设计必须消除的关键歧义

1. `ApplicationStage`、`ApplicationOutcome`、渠道和事件类型的冻结枚举，以及它们与现有 `communicationStatus` 的关系尚未完整定义。
2. Application 的 `currentStage` / `outcome` 是事件投影还是可独立编辑事实；事件纠错、撤销和删除如何保留历史，尚未明确。
3. 旧 Job migration 何时创建 Application、无法确认是否真实投递时如何表达未知、如何保证幂等与 snapshot 兼容，缺少可执行规则。
4. ResumeVersion 的创建、当前版本切换、指纹、不可变字段和旧记录默认归属规则尚未冻结。
5. 同 Job 多渠道、多 HR、同一招聘主体的身份与去重键如何录入和纠正，PRD 只有原则，没有 B 的验收条件。
6. B 的最小页面集合、列表与详情交互、空状态、错误恢复以及是否需要 `/applications`、`/profile-versions` 独立页面，尚未裁定。
7. API 的资源边界、并发冲突、幂等写入、排序分页和错误映射尚未定义。
8. 城市市场隔离原则明确，但 B 应把哪些城市 / 岗位族 / 薪资 / 公司上下文固化在 Job、Application 或事件快照中，数据所有权仍需明确。
9. 样本不足禁止降薪的原则明确，但 B 不产生降薪 Proposal；技术设计仍需确保事件模型保留来源独立性、可比性、ResumeVersion 和主动退出等信息，避免后续版本无法执行该保护。
10. B 不包含正式 AI Proposal，但新增或纠正求职事实是否需要二次确认、哪些操作属于高影响写入，以及与现有两条人工门禁如何并存，需要明确状态与交互边界。

因此，PRD 的阶段范围和产品原则已经明确，但尚不足以直接开始 B 代码实施；必须先完成技术设计并冻结上述可执行规则与验收条件。

## 6. v0.7.0-B 开始前必须完成

1. 确认 B 的唯一业务目标。
2. 明确 B 与 C 的功能边界。
3. 明确是否新增或修改数据库实体。
4. 明确 AI 提议、人工确认和正式生效的状态机。
5. 明确不同城市市场证据隔离规则。
6. 明确样本不足时禁止建议降薪的可执行规则。
7. 编写 v0.7.0-B 技术设计。
8. 技术设计确认后再创建功能分支。

## 7. 下一轮唯一正确任务

```text
审查正式 PRD 中 v0.7.0-B 的业务范围
→ 消除关键歧义
→ 编写 v0.7.0-B 技术设计
→ 设计确认后再开始代码实施
```
