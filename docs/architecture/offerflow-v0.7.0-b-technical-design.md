# OfferFlow v0.7.0-B 技术设计

## 1. 文档状态

- **状态**：已确认，B0–B7 已完成，B8 待开始
- **日期**：2026-07-14
- **产品输入**：`docs/prd/offerflow-v0.7.md` Draft 0.4
- **实施状态输入**：`docs/handoffs/offerflow-v0.7-stage-handoff-2026-07-13.md`
- **页面基建输入**：`docs/architecture/offerflow-v0.7.0-a-technical-design.md`
- **设计基线**：main `8484d10a91d9e79bb973ded9dfac1c40270ba42a`
- **App 版本**：`0.6.2`
- **设计文档初始输出**：技术设计，不包含当时的业务代码、migration、schema、snapshot 或版本修改
- **B2 启用边界**：Job Memory repositories 和 API 已实现，但默认 Server 不启用 v2 capability；B2 测试只通过显式 Server option 和显式 schema target v2 的临时数据库启用，真实数据库正式启用仍留到 B7
- **B3 启用边界**：ResumeVersion 页面与前端 API adapter 已实现，但默认生产前端入口保持关闭；只有专用临时联调命令会在系统临时目录新建 schema v2 SQLite，并同时显式开启后端 capability 与前端 flag。真实数据库和生产入口仍留到 B7。
- **B4 完成边界**：统一的 Job Memory v2 前端 capability、JobDetail 聚合 Bundle、ApplicationSection、同岗位多次 Application、上下文纠正与作废、JobList 最小流程摘要和临时库 smoke 已完成。B4 只消费后端投影并保留事件 source，不展示 FeedbackTimeline，也不提供普通事件录入、事件纠错或事件作废 UI。
- **B5 完成边界**：FeedbackEvent 时间线、手工事实录入、事件作废和可选替代事件已完成。正式事实继续由用户确认后写入，历史事件不原地覆盖。
- **B6 完成边界**：v2 模式的决策输入已切换到 ApplicationProjection；存在 Application 时不再读取 Job legacy 沟通状态，零 Application 的历史岗位只允许只读 legacy fallback。v2 capability 已禁用新的 legacy 沟通事实写入，默认 v1 模式保持兼容。
- **B7 完成边界**：B7-B 已绑定批准备份 `20260714-102807-b7a-6f0ac3d1` 完成正式升级：真实数据库 schema 1→2，Job 13、Application 7、FeedbackEvent 7、ResumeVersion 0，保守 skip 6、manual review 0，Projection degraded 7/invalid 0，Job canonical hash changes 0；Snapshot v2 consistency/roundtrip 通过，pre-apply checkpoint 为 `20260714-112449-b7a-8d54a08b`，升级后备份为 `20260714-112746-b7b-475bd682`。生产默认 schema、后端 capability、前端 flag 与 Snapshot 已切换到 v2；Job legacy 字段和显式 v1 兼容入口继续保留。

正式 PRD 决定产品范围，阶段交接决定实际完成状态。A 技术设计仍保留实施前的 Draft 和历史依赖事实；B 以 main 中已经完成的 Hash Router、Page Scope、Runtime Gate 1 与生命周期保护为真实基线，不将 A 文档中的历史“待安装”状态解释为当前事实。

### 1.1 核心结论

v0.7.0-B 的唯一业务目标是：

> 建立可信求职记忆，让系统通过 ResumeVersion + Application + FeedbackEvent 准确表达“发生过什么”。

本设计采用一个正式方案：

1. Job 只保存岗位、JD、机会评估、导入 Review 等岗位级事实，不再作为一次投递流程。
2. Application 保存一次独立求职流程的身份和上下文，不持久化 stage/outcome/communicationStatus 作为第二事实源。
3. FeedbackEvent 是流程事实的不可变日志；纠错通过追加 `event_voided` 和可选替代事件完成。
4. Application 当前状态由纯函数在查询时投影；小规模单用户 SQLite 不需要 CQRS 或持久化投影表。
5. Job 上现有沟通字段只作为零 Application 旧记录的兼容输入；一旦有 Application，决策和 UI 只读事件投影。
6. 未投递、未知、用户主动退出、招聘方拒绝严格分开；没有 Application 的 Job 不进入投递或拒绝样本。
7. 所有用户手动写入都由普通 Action 完成；Runtime Gate 1 只负责读取 `loadJobBundle`。

---

## 2. 背景与目标

当前系统以 Job 当前快照为中心，能表达“这个岗位现在看起来怎样”，但不能稳定表达：同一 Job 的多次投递、不同渠道、不同简历版本、多名招聘联系人，以及当前状态之前发生过什么。Job 上的 `communicationStatus`、跟进次数和时间会覆盖旧值，无法形成可信时间线。

B 完成后必须满足：

- 一个 Job 可以有零个、一个或多个 Application。
- Application 可以区分渠道、简历版本、招聘主体、联系人和投递时城市语境。
- FeedbackEvent 保存过程事实，晚录、纠错和重复提交都有确定规则。
- 当前流程状态可由事件稳定重算，事件历史不会被一次 PATCH 覆盖。
- 旧数据保守迁移，不把未知或未投递岗位制造成负面样本。
- 后续 v0.7.1 能基于来源、置信度、城市、渠道、ResumeVersion 和独立招聘主体做样本判断。

---

## 3. 范围与非目标

### 3.1 范围矩阵

| 能力 | A | B | C | v0.7.1 | v0.7.2 |
|---|---|---|---|---|---|
| Router / Page Scope / Runtime Gate 1 | 已完成 | 复用 | 复用 | 复用 | 复用 |
| Job / Application 分离 |  | 实现 |  |  |  |
| ResumeVersion |  | 实现 |  |  |  |
| FeedbackEvent / 时间线 |  | 实现 |  |  |  |
| 重复投递 / 多渠道 |  | 实现 |  |  |  |
| 历史补录 |  |  | 实现 |  |  |
| 基础漏斗 |  |  | 实现 |  |  |
| Runtime SSE Gate 2 |  |  | C 或独立 Gate |  |  |
| 动态画像 / EvidenceSufficiency / AI Proposal |  |  |  | 实现 |  |
| StrategyWindow / 完整 Proposal Review |  |  |  |  | 实现 |

### 3.2 B 明确不做

- 不做历史批量补录页、漏斗、转化率或统计仪表盘。
- 不实现 CandidateEvidence、CapabilityBaseline、MarketPositionProfile 或 EvidenceSufficiency。
- 不生成降薪、画像调整或 Strategy Proposal。
- 不实现通用 AI Proposal Review；现有 JD import review 语义不扩张。
- 不让 AI/OCR 自动生成正式 Application 或 FeedbackEvent。
- 不接管 SSE，不创建 Runtime 写 Task，不删除 direct fallback。
- 不做 Contact 主实体、自动公司/JD 合并、复杂简历编辑器或文件管理器。
- 不自动把所有 Job 迁移为 Application。
- 不持久化可由事件重算的状态投影。

---

## 4. 当前实现审计

### 4.1 当前模型职责过载

| 字段 / 数据 | 当前归属 | 实际含义 | B 后建议归属 | 兼容要求 |
|---|---|---|---|---|
| company/role/city/salaryRange/jdText | Job | 岗位与 JD 事实 | Job | 原样保留 |
| companyInput/analysis/report/matchScore | Job | 岗位评估与人工确认结果 | Job | 原样保留 |
| importStatus/reviewStatus/importedDraft | Job | JD 导入候选及人工决议 | Job | 保持现有 Review 语义 |
| communicationStatus | Job | 当前一次沟通流程状态 | FeedbackEvent 投影；Job 字段 deprecated | 零 Application 旧记录可继续读取，禁止进入统计 |
| lastGreetedAt/lastFollowupAt | Job | 流程动作时间 | FeedbackEvent 投影 | 迁移种子中保留原值与置信度 |
| followupCount | Job | 当前流程跟进次数 | FeedbackEvent 投影 | 只计有效 `follow_up_sent` |
| lastCommunicationNote | Job | 最近一次沟通备注 | FeedbackEvent.note | 旧值放入迁移种子，不伪造具体事件 |
| draftMessageText | Job | 当前沟通话术草稿 | Application 可变草稿字段 | 不是市场事实，不进入事件统计 |
| highValueSignal | Job | 岗位级人工价值标记 | Job | 保留 |
| strategyOverride | Job | 岗位级用户策略覆盖 | Job | 保留；不转为市场事实 |
| updatedAt | Job | 任意 Job 写入时间 | 各实体自己的 updatedAt | 不再用作流程事件时间 |

### 4.2 communicationStatus 与决策现状

当前 8 态为：

| 状态 | 当前文案语义 | 当前 deriveDecision 行为 |
|---|---|---|
| `not_contacted` | 未沟通 | 根据分析建议决定打招呼或等待 |
| `greeted_unread` | 已打招呼未读 | 依据 3 天 cooldown 和跟进次数决定跟进 |
| `greeted_read_no_reply` | 已读未回 | 首次可换角度跟进 |
| `replied` | 已回复 | 继续沟通 |
| `interviewing` | 面试推进中 | 准备面试 |
| `paused` | 暂停观察 | 暂停 |
| `closed` | 已结束 | 停止跟进 |
| `rejected` | 已拒绝 | 停止跟进 |

`deriveDecision` 还读取 `followupCount`、`lastFollowupAt ?? lastGreetedAt`、`highValueSignal`、Job 分析建议、import `reviewStatus`，并用同公司其他 Job 的 communicationStatus 生成 company warning。cooldown 固定 3 天，最多跟进 2 次。当前“无回复”不是独立历史事实，只由当前状态和时间字段共同表达。

### 4.3 SQLite、repository、API 与 snapshot

- 当前 schema version 为 1，业务表只有 `profiles`、`jobs`、`import_logs`；Job 采用索引列加完整 `data_json` 的混合存储。
- `JobRepository.patch()` 对 `Partial<JobRecord>` 做宽泛合并，没有 runtime DTO validation、row version 或 409 并发检查。
- `/jobs` 提供 list/create/get/replace/patch/delete；不存在 Application、ResumeVersion 或事件 API。
- migration 已具备连续版本校验和单 migration SQLite transaction，可复用为 v2 schema/data migration。
- snapshot schema version 为 1，只同步 `app_meta/profiles/jobs/import_logs`，按主键和 updated_at 做保守 LWW 合并。
- `JobDetailPage` 是唯一 Scope owner；`BattlefieldPage` 仍承载分析工作区与沟通编辑，五个 Section 目前主要是稳定注入边界。
- 新建 Job、更新沟通、确认分析和 import review 最终都 PATCH Job；AI 分析与 JD import 均保留人工门禁。

### 4.4 可复用的 A 基础

- Hash Router、`/jobs/:jobId`、JobDetailPage owner 和 Section 注入。
- `$source` 服务端快照、`state` 草稿、局部 UI 瞬态的所有权原则。
- `loadJobBundle` 的 AbortSignal、runId、requestedJobId、owner token 和一次提交。
- direct loader fallback 与 Runtime 单路径选择。
- dirty guard、写请求不绑定 read AbortSignal、legacy SSE/OCR 生命周期保护。

---

## 5. 核心领域模型

以下类型是实施级草案；实现时用 Zod 或等价 schema 作为 HTTP/SQLite JSON 边界的 runtime validation，不能仅做 TypeScript 断言。

```ts
type ApplicationOrigin = 'outbound' | 'inbound' | 'unknown'

type ApplicationChannel =
  | 'boss'
  | 'official_site'
  | 'referral'
  | 'headhunter'
  | 'email'
  | 'wechat'
  | 'other'
  | 'unknown'

type WorkMode = 'onsite' | 'hybrid' | 'remote' | 'unknown'

interface CityContext {
  jobCity: string | null
  marketCity: string | null
  workMode: WorkMode
}

interface RecruitingEntitySnapshot {
  kind: 'direct_employer' | 'outsourcing_vendor' | 'staffing_agency' | 'headhunter' | 'unknown'
  name: string | null
  employerGroupKey: string | null
  endClientName: string | null
}

interface ContactSnapshot {
  displayName: string | null
  role: 'company_hr' | 'hiring_manager' | 'headhunter' | 'platform_recruiter' | 'unknown'
  platformId: string | null
}

interface ApplicationRecord {
  id: string
  jobId: string
  resumeVersionId: string | null
  origin: ApplicationOrigin
  channel: ApplicationChannel
  channelOtherLabel: string | null
  recruitingEntity: RecruitingEntitySnapshot
  primaryContact: ContactSnapshot | null
  cityContext: CityContext
  draftMessageText: string | null
  createdAt: number
  updatedAt: number
  voidedAt: number | null
  voidReason: string | null
  supersededByApplicationId: string | null
  rowVersion: number
}
```

`resumeVersionId = null` 明确表示未知，而不是“没有使用简历”。`origin`、channel、city 和招聘主体也允许 unknown；unknown 不能在统计层转成 false 或默认城市。

---

## 6. Job 与 Application 的关系

### 6.1 Job 最终职责

Job 表达岗位与机会评估：公司、岗位、JD、岗位城市、薪资、公司补充、AI 原文、结构化分析、导入 Review 和岗位级人工偏好。Job 不等于投递，也不持有正式流程状态。

### 6.2 Application 创建规则

- 用户确认发生了一次独立投递或招聘接触时创建 Application。
- 同一 Job 换渠道、换 ResumeVersion、流程结束后重新投递或确认是独立招聘流程时，新建 Application。
- 同一流程中新增 HR、补记面试或补记回复，只追加事件或更新联系人快照，不新建 Application。
- 仅浏览、收藏、准备话术、未投递或无法确认是否发生真实互动时，不创建 Application。
- inbound 招聘接触可以没有 `applied` 事件；它仍是一条真实 Application，origin 为 `inbound`。

Application 不设置业务自然唯一键。合法重复投递必须被允许；`id` 唯一，`idempotencyKey` 只防同一次按钮提交/网络重试重复创建。

### 6.3 当前 Application 选择

不持久化 `isCurrent`，避免与关闭状态形成第二事实源。默认选择规则为：

1. 当前 Job 中未作废且未关闭的 Application，按 `lastMeaningfulEventAt`、`createdAt`、`id` 倒序取第一条。
2. 若全部关闭，取最近一条未作废 Application。
3. 用户在详情页可临时选择其他 Application；选择仅是 Page Scope UI 状态，不改变事实。

列表摘要和决策面板使用同一纯函数选择规则。同一 Job 再次投递必须创建新 Application，拒绝后的旧流程不会被“重开”。

### 6.4 作废、纠错和合并

- Application 不提供物理删除；误录通过用户确认的 void 命令设置 `voidedAt/voidReason` 并追加 `application_voided` 审计事件。
- 如果误录实际属于另一条 Application，可设置 `supersededByApplicationId`；这不是自动合并，旧记录仍可审计。
- Job/JD 相似、名称相似或 AI 去重建议只显示提示，用户确认前不合并、不覆盖。
- Job 有 Application 后，Job 删除返回 409；先处理或作废关联流程，仍不级联删除历史。

作废事实源不变量：`Application.voidedAt/voidReason` 是生命周期当前正式事实；`application_voided` 是修改该事实时同一事务追加的审计事件，不能独立决定作废状态。投影以 Application 行为准：行已作废但缺少审计事件，或只有审计事件但行未作废，都输出 degraded warning。B2 必须在同一 SQLite transaction 中同时更新 Application 行并追加审计事件。

元数据纠正不变量：Application 行保存当前正式上下文；`application_metadata_corrected` 只记录修改审计，不是第二套当前值来源。投影不得根据 correction event 覆盖 Application 当前字段。

### 6.5 去重与招聘主体裁定

| 场景 | B 的唯一处理 |
|---|---|
| 同公司、相似 JD | 仅提示可能重复；只有用户确认是同一岗位事实才复用 Job，否则分别保存 |
| 同一 Job、不同渠道投递 | 默认新建 Application；用户确认是同一招聘流程的跨渠道沟通时，事件记录各自 channel，不拆流程 |
| 同一 Job、不同 HR | 同一面试/招聘流水线内作为同一 Application 的不同事件 actor/contact snapshot；独立联系且流程互不承接时新建 Application |
| 猎头联系 | recruitingEntity.kind=`headhunter`，Job.company 仍是目标岗位公司；endClientName 可记录实际用工方 |
| 外包/驻场 | Job.company 表示发布岗位的公司事实；recruitingEntity 表示实际运营招聘流程的主体，endClientName 表示已确认的用工方 |
| 名称或文本相似 | AI/规则只能给候选，不自动改 employerGroupKey、不自动 merge |

B 不创建 Contact 主实体。Application 保存主要联系人快照，事件保存当次 actor 和必要 payload；出现跨岗位联系人关系的真实需求后再独立评估 Contact。

---

## 7. ResumeVersion 设计

```ts
type ResumeVersionSource = 'profile_snapshot' | 'pasted_text' | 'imported_file_text'

interface ResumeVersionRecord {
  id: string
  name: string
  source: ResumeVersionSource
  contentHash: string
  summary: string
  contentSnapshot: {
    resumeText: string
    projectExperience: string
  }
  createdAt: number
  archivedAt: number | null
  rowVersion: number
}
```

裁定：

- 每个 ResumeVersion 保存足以复现投递时内容的文本快照和 SHA-256 内容哈希，不只存本机文件路径。
- 内容一经创建不可修改；后续简历变化必须创建新版本。名称和 summary 属描述元数据，可用 rowVersion 乐观并发修改。
- 当前默认版本由 `app_meta.active_resume_version_id` 指针表示；`active/available/archived` 是查询派生状态，不在多行上保存互斥 active 标记。
- 创建 Application 时默认预选 active 版本，但用户必须在提交前看到并确认；允许明确选择“未知历史版本”，落库为 null。
- 相同 contentHash 再创建返回 409 并指向已有版本，避免同内容重复版本。
- B 不创建“Unknown ResumeVersion”或“Legacy Imported ResumeVersion”假实体；旧记录的 null 就是可审计 unknown。
- 不提供物理删除：已被 Application 引用的版本只能 archive；未引用版本也统一 archive，降低误删风险。
- B 只提供快照创建、列表、激活、归档和元数据修改，不做复杂简历编辑器或二进制文件管理。

---

## 8. FeedbackEvent 设计

### 8.1 类型草案

```ts
type FeedbackEventType =
  | 'application_created'
  | 'applied'
  | 'hr_contacted'
  | 'greeting_sent'
  | 'message_viewed'
  | 'hr_replied'
  | 'resume_requested'
  | 'phone_screen'
  | 'interview_scheduled'
  | 'interview_completed'
  | 'interview_advanced'
  | 'follow_up_sent'
  | 'no_response_recorded'
  | 'rejected'
  | 'user_withdrew'
  | 'offer_received'
  | 'offer_declined'
  | 'offer_accepted'
  | 'recruitment_paused'
  | 'recruitment_frozen'
  | 'process_resumed'
  | 'position_closed'
  | 'marked_stale'
  | 'legacy_status_imported'
  | 'application_metadata_corrected'
  | 'application_voided'
  | 'event_voided'

interface FeedbackEventRecord {
  id: string
  applicationId: string
  eventType: FeedbackEventType
  eventAt: number | null
  timePrecision: 'exact' | 'date' | 'approximate' | 'unknown'
  actor: 'user' | 'hr' | 'interviewer' | 'recruiter' | 'system'
  recordedBy: 'user' | 'system_migration'
  sourceConfidence: 'exact' | 'approximate' | 'recalled' | 'inferred'
  evidenceLevel: 'strong' | 'medium' | 'weak'
  channel: ApplicationChannel | null
  note: string | null
  reasonCode: string | null
  payload: Record<string, unknown>
  targetEventId: string | null
  idempotencyKey: string
  createdAt: number
}
```

`eventAt` 是业务发生时间，允许 null 以诚实表达旧数据未知；`createdAt` 是写入系统的时间，永远存在。payload 必须按 eventType 使用判别联合 schema 校验，不能接受任意 JSON 后直接进入正式层。

### 8.2 不可变与纠错

- 普通事件写入后不 UPDATE、不 DELETE。
- 误录时追加 `event_voided`，`targetEventId` 指向同一 Application 的普通事件并记录原因。
- 如需替换，在同一事务追加 void 事件和一个新的正常业务事件。
- 不允许 void `event_voided`；要恢复原语义只能追加新的正常事件，避免递归反转。
- `status_corrected` 不作为独立万能状态事件：它会绕过真实业务语义并制造第二状态源，故本设计用“void + 替代业务事件”。

### 8.3 自动生成边界

- 系统只能在用户创建 Application 的同一事务生成中性的 `application_created`，或在 migration 生成 `legacy_status_imported`。
- 用户明确保存的事件直接成为正式事实；拒绝、作废、Offer 结果等高影响事件需要确认对话框。
- “已过 3 天无回复”是查询时派生，不自动写事件。`no_response_recorded` 只在用户明确记录某个 as-of 时间时写入，且不是拒绝或能力负向证据。
- B 不从 AI/OCR/自由文本自动抽取正式事件。未来候选必须先进入独立审核层，确认前不能调用正式事件写 API。

---

## 9. communicationStatus 兼容与投影

### 9.1 唯一正式方案

`communicationStatus` 在 B 后是 Application 事件投影中的兼容视图，不是 Application 持久字段。Job 上同名字段保留为 deprecated 兼容字段，但选择规则固定：

```text
存在选中的 Application → 只读 FeedbackEvent 投影
没有 Application         → 可读 Job legacy communication 字段用于旧决策 UI
统计 / 漏斗              → 永远只认 Application + Event，不读 Job legacy 字段
```

B6 完成后 Job PATCH 禁止写 `communicationStatus/followupCount/lastGreetedAt/lastFollowupAt/lastCommunicationNote`，返回 422 `LEGACY_COMMUNICATION_WRITE_DISABLED`。这些字段不再被新页面更新，也不镜像事件投影，避免双事实源。

### 9.2 八态映射

| 投影事实 | 兼容 communicationStatus |
|---|---|
| 无有效沟通事件 | `not_contacted` |
| 最新有效外发为 greeting，未出现 viewed/reply | `greeted_unread` |
| 已 viewed，之后无 reply | `greeted_read_no_reply` |
| hr reply/resume request/phone screen | `replied` |
| interview scheduled/completed/advanced | `interviewing` |
| recruitment paused/frozen | `paused` |
| Application.voidedAt 非空，或 user withdrew/position closed/marked stale/offer accepted/declined | `closed` |
| rejected | `rejected` |
| offer received 且未结束 | `replied`，新 UI 以 stage=`offer` 展示，不显示为普通回复 |

“已拒绝”专指招聘方或明确流程拒绝；用户主动结束使用 outcome=`user_withdrew` 并兼容映射 `closed`。

### 9.3 deriveDecision 输入迁移

`deriveDecision` 不再直接要求完整 JobRecord 的沟通字段，而接受明确的决策事实：

```ts
interface DecisionOpportunityFacts {
  job: JobRecord
  application: ApplicationRecord | null
  projection: ApplicationProjection | null
  legacyCommunication: LegacyJobCommunicationFacts | null
}
```

- 有 Application 时，cooldown、最多两次跟进、当前状态和时间全部来自 projection。
- 无 Application 时继续支持岗位评估和首次沟通建议，但该结果不进入市场样本。
- company warning 使用各 Job 默认 Application 的 projection；只有无 Application 的旧 Job 才使用 legacy fallback，并标记为兼容提示。
- 同一 Job 多次投递时，详情决策面板针对用户当前选择或默认选择的 Application。

---

## 10. 状态机与事件投影

### 10.1 输出

```ts
type ApplicationStage =
  | 'created'
  | 'applied'
  | 'contacted'
  | 'screening'
  | 'interviewing'
  | 'offer'
  | 'paused'
  | 'closed'

type ApplicationOutcome =
  | 'rejected'
  | 'user_withdrew'
  | 'position_closed'
  | 'stale'
  | 'offer_declined'
  | 'offer_accepted'
  | null

interface ApplicationProjection {
  stage: ApplicationStage
  outcome: ApplicationOutcome
  communicationStatus: CommunicationStatus
  submissionState: 'applied' | 'not_applied' | 'unknown'
  appliedAt: number | null
  lastMeaningfulEventAt: number | null
  followUpCount: number
  lastGreetedAt: number | null
  lastFollowUpAt: number | null
  nextAllowedFollowUpAt: number | null
  isClosed: boolean
  isVoided: boolean
  statusSourceEventId: string | null
  projectionStatus: 'valid' | 'degraded' | 'invalid'
  warnings: string[]
}
```

### 10.2 存储与所有权

| 数据 | 归属 |
|---|---|
| Application 身份和上下文 | applications 表正式事实 |
| FeedbackEvent | feedback_events 表正式事实 |
| stage/outcome/communicationStatus/followUpCount/时间 | 查询时纯函数投影 |
| nextAllowedFollowUpAt/isClosed | 查询时派生 |
| isVoided | 由 Application.voidedAt 派生；审计事件不单独决定 |
| statusSourceEventId/warnings | 投影诊断信息 |
| selectedApplicationId | Page Scope UI 状态 |
| projection 缓存表 | B 不创建 |

### 10.3 投影算法

1. 校验事件均属于目标 Application，ID 唯一且类型 payload 合法。
2. 按 `createdAt,id` 处理 `event_voided`，建立被作废事件集合；目标不存在、跨 Application 或目标也是 void 事件时输出 warning。
3. `legacy_status_imported` 只作为基线种子，先于所有正常事件处理，不因 migration 的 createdAt 较晚而覆盖真实新事件。
4. 正常事件按 `eventAt ?? createdAt`、`createdAt`、`id` 升序稳定排序。迟到事件会触发全量重算；相同时间仍确定。
5. reduce 得到 stage、outcome、submissionState、兼容状态、时间和跟进次数。只有有效 `follow_up_sent` 计数；`greeting_sent` 不算 follow-up。
6. 关闭事件后的新推进事件默认不改变投影并产生 degraded warning；用户应先 void 错误关闭事件或新建 Application。
7. 无法识别的 schema/引用错误返回 invalid，API 暴露投影错误，不静默回退到 Job 状态。

`nextAllowedFollowUpAt = max(lastFollowUpAt, lastGreetedAt) + 3 天`；达到 2 次后仍返回时间，但 `deriveDecision` 必须 stop loss。未来改变 cooldown 规则只改纯函数和测试，不改历史事件。

### 10.4 主要事件转换

| 事件 | stage | outcome | 其他投影影响 |
|---|---|---|---|
| `application_created` | created | null | submissionState 保持 unknown |
| `applied` | applied | null | submissionState=applied，记录 appliedAt |
| `hr_contacted` | contacted | null | inbound 可明确 submissionState=not_applied，否则保持 unknown |
| `greeting_sent` | contacted | null | 更新 lastGreetedAt，兼容为 greeted_unread |
| `message_viewed` | contacted | null | 无后续 reply 时兼容为 greeted_read_no_reply |
| `hr_replied` | contacted | null | 兼容为 replied |
| `resume_requested` / `phone_screen` | screening | null | 兼容为 replied |
| interview 三类事件 | interviewing | null | 兼容为 interviewing |
| `follow_up_sent` | 保持当前活跃 stage | null | followUpCount +1，更新 lastFollowUpAt |
| `recruitment_paused` / `recruitment_frozen` | paused | null | 保存 pause 前 stage；不是能力负向结果 |
| `process_resumed` | 恢复 pause 前有效 stage | null | 无可恢复 stage 时 degraded warning |
| `offer_received` | offer | null | 兼容为 replied |
| `rejected` | closed | rejected | isClosed=true |
| `user_withdrew` | closed | user_withdrew | 不计招聘方拒绝 |
| `position_closed` | closed | position_closed | 不评价能力 |
| `marked_stale` | closed | stale | 不等于明确拒绝 |
| `offer_declined` / `offer_accepted` | closed | 对应 outcome | isClosed=true |
| `no_response_recorded` | 保持当前 stage | null | 仅记录 as-of 观察，不关闭、不转 rejected |

`legacy_status_imported` 使用 migration 决策表建立初始投影，evidenceLevel=weak；任何后续正常事件都优先于该种子。

---

## 11. SQLite Schema 草案

数据库 schema version 由 1 升为 2。以下为设计草案，本轮不创建 migration。

```sql
CREATE TABLE resume_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  row_version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  resume_version_id TEXT REFERENCES resume_versions(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_other_label TEXT,
  job_city_snapshot TEXT,
  market_city TEXT,
  work_mode TEXT NOT NULL,
  recruiting_entity_kind TEXT NOT NULL,
  recruiting_entity_name TEXT,
  employer_group_key TEXT,
  end_client_name TEXT,
  primary_contact_json TEXT,
  draft_message_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  voided_at INTEGER,
  void_reason TEXT,
  superseded_by_application_id TEXT REFERENCES applications(id) ON DELETE RESTRICT,
  row_version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  migration_key TEXT UNIQUE
);

CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  event_at INTEGER,
  time_precision TEXT NOT NULL,
  actor TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  source_confidence TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  channel TEXT,
  note TEXT,
  reason_code TEXT,
  payload_json TEXT NOT NULL,
  target_event_id TEXT REFERENCES feedback_events(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX applications_job_idx
  ON applications(job_id, voided_at, updated_at DESC);
CREATE INDEX applications_resume_idx
  ON applications(resume_version_id);
CREATE INDEX applications_market_idx
  ON applications(market_city, channel, employer_group_key);
CREATE INDEX feedback_events_application_time_idx
  ON feedback_events(application_id, event_at, created_at, id);
CREATE INDEX feedback_events_reason_idx
  ON feedback_events(reason_code, evidence_level);
```

枚举 CHECK 约束可在 migration 中加入，但应用层仍必须 runtime validate。`app_meta.active_resume_version_id` 保存默认版本指针。Job 表和 `data_json` 本轮不删除旧字段。

---

## 12. 旧数据迁移与幂等

### 12.1 安全原则

- B1 将默认 migration target 固定为当前生产安全版本 v1；schema v2 只允许通过显式 `targetVersion: 2` 门禁在临时数据库中执行。
- 默认应用启动、默认 `db:init`、默认 selftest 和用户数据路径不得因 B1 自动升级到 schema v2。
- 正式用户数据库启用 v2 的唯一入口留到 B7；启用前必须完成备份、dry-run、分类报告和用户确认。
- schema v2 migration 只在单个 SQLite transaction 中创建空表、索引和外键并记录 schema_migrations，不自动分类真实 Job。
- B7 的数据 backfill 是显式升级步骤：先创建 SQLite 与 snapshot 备份并输出 dry-run 分类；备份失败则拒绝执行。
- 正式 backfill 在单个 SQLite transaction 中保守创建 Application/Event 并写 audit import_log；任一步失败整体回滚。
- 不重写 Job.data_json，不清空旧沟通字段，不伪造精确时间或简历版本。
- `migration_key = v2:legacy-job:<jobId>:communication` 与 event idempotencyKey 保证重复执行不重复造数据。
- migration helper 可在临时数据库 dry-run，输出分类计数和原因；正式执行结果写现有 import_logs 作为 audit report。

### 12.2 是否存在可靠互动证据

以下任一条件视为可靠存在求职流程：

- status 为 `greeted_unread`、`greeted_read_no_reply`、`replied` 或 `interviewing`；
- `lastGreetedAt`、`lastFollowupAt` 存在；
- `followupCount > 0`。

`not_contacted/paused/closed/rejected` 单独出现不能证明真实投递或互动。尤其 import review 的 deferred/rejected 仍是 Job 候选决议，不创建 Application。

### 12.3 migration 决策表

| 旧状态 | 创建 Application | 初始 stage/outcome | 初始事件 | 处理说明 |
|---|---:|---|---|---|
| `not_contacted` | 否 | 无 | 无 | 明确不制造投递事实 |
| `greeted_unread` | 是 | contacted/null | `legacy_status_imported` | origin unknown；保留 lastGreetedAt，时间可 unknown |
| `greeted_read_no_reply` | 是 | contacted/null | `legacy_status_imported` | 不伪造 message_viewed 精确时间 |
| `replied` | 是 | contacted/null | `legacy_status_imported` | 可能是 inbound，appliedAt 保持 null |
| `interviewing` | 是 | interviewing/null | `legacy_status_imported` | 不伪造具体面试轮次 |
| `paused` | 仅有可靠互动证据时 | paused/null | `legacy_status_imported` | import deferred 或无互动时不创建 |
| `closed` | 仅有可靠互动证据时 | closed/无法确定 | `legacy_status_imported` | 不猜 user withdrew/position closed |
| `rejected` | 仅有可靠互动证据且 reviewStatus 非 rejected 时 | closed/rejected | `legacy_status_imported` | 单一手动状态不足以成为负样本 |

所有迁移 Application 的 `resumeVersionId = null`、channel/origin/recruiting entity/city 不确定部分均保留 unknown；Job.city 只作为 `jobCitySnapshot`，marketCity 不自动推断。迁移种子的 evidenceLevel 为 weak、sourceConfidence 为 inferred，未来统计不得当作强明确反馈。

若创建了 Application，旧 `draftMessageText` 复制到该 Application 的非事实草稿字段，旧 `lastCommunicationNote` 放入 legacy seed note；`highValueSignal/strategyOverride` 继续留在 Job。Job 原字段均不删除、不清空。

### 12.4 snapshot 升级

- snapshot schema version 升为 2，新增 `resume_versions/applications/feedback_events`，导入顺序保证外键先父后子。
- B 正常同步只接受 v2；v1 snapshot 仅允许在显式 legacy upgrade 模式、B 三张新表为空时导入，随后运行同一幂等 backfill。
- 升级完成后重新 export snapshot/manifest，并将三张新表加入 consistency report 和 roundtrip selftest。
- 混用 v0.6.x 客户端与 v2 snapshot 明确不支持；旧客户端应拒绝未知 snapshot version，不能丢弃新表后继续写。
- 中断发生在 transaction 内则回滚并可重跑；snapshot export 使用现有原子写机制，失败不替换上一份有效 snapshot。

---

## 13. API 与 DTO 草案

### 13.1 最小 API

| Method | Endpoint | 作用 | 成功响应 |
|---|---|---|---|
| GET | `/resume-versions` | 列表及 active 指针 | `ResumeVersionSummary[]` |
| POST | `/resume-versions` | 从确认后的文本快照创建版本 | `ResumeVersionRecord` |
| PATCH | `/resume-versions/:id` | 仅修改 name/summary，带 expectedVersion | `ResumeVersionRecord` |
| POST | `/resume-versions/:id/activate` | 切换默认版本 | `ResumeVersionRecord` |
| POST | `/resume-versions/:id/archive` | 归档版本 | `ResumeVersionRecord` |
| GET | `/jobs/summaries` | JobList 的 Application 数与默认投影摘要 | `JobListItemV2[]` |
| GET | `/jobs/:id/bundle` | Job/Profile/allJobs/全局应用摘要/当前 Job memory | `JobDetailBundleV2` |
| POST | `/jobs/:id/applications` | 创建独立流程及 application_created | `JobMemoryBundle` |
| PATCH | `/applications/:id` | 纠正上下文或话术草稿 | `JobMemoryBundle` |
| POST | `/applications/:id/void` | 作废误录流程 | `JobMemoryBundle` |
| POST | `/applications/:id/events` | 追加用户确认事件 | `JobMemoryBundle` |
| POST | `/feedback-events/:id/void` | void 事件，可同事务带替代事件 | `JobMemoryBundle` |

不提供 Application/Event DELETE，不新增 Runtime 写接口，不在 B 提供全局 `/applications` 漏斗查询页。

### 13.2 DTO 与 validation

写 DTO 必须白名单：

```ts
interface CreateApplicationRequest {
  idempotencyKey: string
  resumeVersionId: string | null
  origin: ApplicationOrigin
  channel: ApplicationChannel
  channelOtherLabel: string | null
  recruitingEntity: RecruitingEntitySnapshot
  primaryContact: ContactSnapshot | null
  cityContext: CityContext
  initialEvent: CreateFeedbackEventInput | null
}
```

创建 ResumeVersion/Application/Event 以及 void 命令必须带 idempotencyKey；服务端保存规范化 requestHash。元数据 PATCH、activate/archive 使用 expectedVersion 做乐观并发，不假装成可重放创建命令。客户端遇到网络结果不明时先 GET 当前资源，再决定是否重试。

- 400：无效 JSON。
- 404：Job/Application/Event/ResumeVersion 不存在。
- 409：expectedVersion 冲突、内容哈希重复、idempotencyKey 对应不同 payload、流程已关闭、外键仍被引用。
- 422：DTO/schema 或业务语义不合法、旧 Job 沟通字段写入被禁、事件转换不允许。
- 错误响应固定 `{ code, message, fieldErrors?, currentVersion? }`，前端不得解析自由文本决定逻辑。

### 13.3 幂等和事务

- 相同 idempotencyKey + 相同 requestHash 返回第一次结果；相同 key + 不同 requestHash 返回 409。
- 创建 Application 时，application、application_created、可选初始事件在同一 transaction。
- 追加/void 事件时，校验 expectedVersion、写事件、递增 Application rowVersion 在同一 transaction。
- Application 上下文纠正时写 before/after 审计事件并更新行、递增 rowVersion，同一 transaction。
- ResumeVersion activate 在同一 transaction 更新 app_meta 指针；archive active 版本前必须先选择替代版本或显式清空指针。
- 写成功后返回服务端重新查询的完整 JobMemoryBundle；Scope 原子替换 memory，不拼局部投影。

---

## 14. 页面与 Page Scope 设计

### 14.1 B 必须实现的页面范围

| 路由/区域 | B 决策 | 内容 |
|---|---|---|
| `/profile-versions` | 新增最小管理页 | 版本列表、从当前 profile 快照创建、激活、归档；无复杂编辑器 |
| `/jobs/:jobId` ApplicationSection | 必须 | 流程列表、当前选择、新建/重复投递、上下文摘要、void |
| `/jobs/:jobId` FeedbackTimelineSection | 必须 | 时间线、手动录入、纠错/作废、projection warning |
| JobDetail 决策区 | 必须调整 | 明确显示针对哪个 Application；无 Application 时显示岗位级建议 |
| `/jobs` | 最小摘要 | Application 数、默认流程 stage/outcome、ResumeVersion/渠道摘要 |
| `/applications` | B 不创建 | 全局流程和漏斗延后 C |
| `/history-backfill` | C | 历史补录 |
| `/strategy` 和画像证据 UI | v0.7.1/v0.7.2 | 不在 B |

### 14.2 Scope 数据所有权

```ts
interface JobMemoryBundle {
  applications: Array<{
    record: ApplicationRecord
    projection: ApplicationProjection
    events: FeedbackEventRecord[]
  }>
  resumeVersions: ResumeVersionSummary[]
}

interface JobDetailBundleV2 {
  jobId: string
  job: JobRecord
  profile: JobSeekerProfile | null
  allJobs: JobRecord[]
  applicationSummariesByJob: Record<string, ApplicationSummary[]>
  memory: JobMemoryBundle
}
```

| 数据 | 所有者 | Scope 位置 |
|---|---|---|
| Job/Application/Event/ResumeVersion 正式事实 | SQLite/Fastify | `$source.bundle` 页面快照 |
| Application/Event 表单 | 当前 Page Scope | `state.applicationDraft/eventDraft` |
| 当前选中 Application | 当前 Page Scope | `state.selectedApplicationId` |
| 确认弹窗、展开、hover | Section 局部状态 | 不进 Scope |
| stage/outcome/communicationStatus | 后端共享纯投影函数的返回值 | source 只读，不在前端重算第二套规则 |
| dirty、可提交、决策 | getter/纯函数 | 不持久化 |

Runtime `loadJobBundle` 改为读取新的 `/jobs/:id/bundle`，仍使用 A 的 signal/runId/owner guard 和一次 `acceptBundle`。direct fallback 调用同一 API 和 accept 入口。写 Action 不经 Runtime；成功响应通过 `acceptMemoryBundle` 原子替换 memory，必要时 manual reload 整 Bundle。

ApplicationSection 和 FeedbackTimelineSection 只 inject Scope，不自己缓存正式副本。JobDetailPage 继续作为编排壳，不吸收时间线业务逻辑。

---

## 15. Human-in-the-loop 与审核

| 输入来源 | 正式写入规则 |
|---|---|
| 用户手动创建 Application | 用户检查表单并点击创建后直接成为正式事实 |
| 用户手动新增普通事件 | 点击保存后成为事实；无自动保存 |
| rejected/withdrawn/offer result/void | 二次确认后写入 |
| AI 从文本提取的 Application/Event | B 不实现；未来必须进入候选审核，不能直调正式 API |
| OCR 识别事件 | B 不实现；识别文本即使存在也必须人工确认 |
| migration legacy seed | system_migration + inferred + weak，完整标识来源 |

现有 `reviewStatus` 只服务 JD import draft，不能复用为 Application/Event 的通用 Review，否则会混淆“是否接纳一个 Job 候选”和“某流程是否发生某事件”。B 不新增通用 ReviewRecord；未确认的 AI/OCR 候选仅能停留在页面草稿，不能持久化为正式事实，也不能影响 deriveDecision、列表摘要或未来统计。

---

## 16. 并发、事务和错误处理

- 创建/追加/void 命令带 idempotencyKey 和 requestHash；元数据修改、激活和归档带 expectedVersion。
- rowVersion 每次 Application 元数据变化、事件追加或 void 后加一，解决重复标签页/双击冲突。
- 前端收到 409 时保留草稿，显示服务端当前版本并要求 reload/rebase，不静默覆盖。
- 写请求不绑定页面 read AbortSignal；提交期间禁重复点击并触发离页 guard。组件销毁后不提交前端状态，但数据库结果由幂等重读确认。
- 所有多表写在单 SQLite transaction；无部分 Application、孤儿 Event 或只更新 rowVersion 的状态。
- foreign_keys 必须开启，doctor 检查 FK；Job/ResumeVersion/Application 均 RESTRICT 删除。
- projection invalid 返回明确诊断并阻止高影响决策；不得回退到看似正常的旧 Job 状态。
- 本地单用户规模不引入消息队列、事件总线、CQRS、后台 projector 或微服务。

---

## 17. 城市隔离与未来画像兼容

### 17.1 城市所有权

| 层级 | 城市含义 | 修改规则 |
|---|---|---|
| Job.city | 当前岗位描述中的城市 | 可人工修正 |
| Application.cityContext | 建立流程时的岗位城市快照、市场城市和工作模式 | 历史事实；Job 后改不联动 |
| FeedbackEvent | 默认继承 Application；只有明确跨城事件才在 payload 覆盖 | 不复制无必要城市 |
| MarketPositionProfile | v0.7.1 的聚合维度 | B 不实现 |

remote/hybrid 使用 workMode 明确表达；marketCity 可为 null，不能从用户所在地或 Job.city 强推。一个多地 Job 的不同城市流程可共享 Job，但每个 Application 保存独立 cityContext。若 JD 本身是不同城市、不同岗位事实，优先建立不同 Job。

### 17.2 未来证据完整性

B 必须保存或可派生：

- submissionState，而不是把缺少 applied 事件当 false。
- HR reply、面试、拒绝、Offer 的明确事件和来源。
- 拒绝 reasonCode（如 education/salary/skills/unknown），unknown 不自动分类。
- ResumeVersion、channel、marketCity、时间精度、置信度和 employerGroupKey。
- user_withdrew 与 rejected 分离，no_response 与 rejected 分离。

因此 v0.7.1 可以排除未投递、unknown、回忆弱信号和同源重复样本。B 不实现“样本充分度”，但任何缺失都保留为 null/unknown；没有事件就是没有记录，绝不能自动变成负反馈。后续样本不足时无法满足多个独立主体、近期明确因果反馈和 ResumeVersion 可比性，自然不得建议降薪。

---

## 18. 测试策略

| 层级 | 必测场景 |
|---|---|
| 模型 | Job 0/1/多 Application；重复投递；多渠道/HR；不同 ResumeVersion；unknown 与 false |
| ResumeVersion | 内容不可变；hash 去重；active 指针；archive；引用保护 |
| 投影 | 正常顺序、迟到、同时间稳定排序、重复幂等、void+替代、关闭后事件、拒绝后新 Application、Offer 关闭 |
| communication 兼容 | 8 态映射；无 Application fallback；有 Application 不读 Job legacy；cooldown 3 天；最多 2 次 |
| migration | 八态决策表、import review 排除、无时间、无简历、重复执行、中途失败回滚、audit report |
| SQLite | FK、索引、transaction rollback、rowVersion、idempotency 冲突、Job/Resume 引用保护 |
| API | 400/404/409/422；DTO 白名单；同 key 同 payload；同 key 异 payload；无部分写入 |
| Scope/UI | ResumeVersion 管理、manual create、重复投递、时间线、纠错/void、dirty guard、无自动保存 |
| 竞态/销毁 | Bundle A→B→C、写后 reload、owner 销毁后迟到响应不写、Runtime/direct 单路径 |
| snapshot | v2 export/import/consistency/roundtrip；v1 显式升级；父子表顺序；混版拒绝 |
| 数据安全 | 只使用临时 SQLite；无真实 LLM/OCR；未确认候选不入库；未投递 Job 不入负面样本 |

实施时必须扩展现有 `selftest`，至少新增领域投影、migration、repository/API、snapshot 和组件测试。修改 storage/schema/repository/decision 后按 AGENTS 规则运行完整 selftest；本技术设计任务本身不运行业务测试。

---

## 19. 实施切片与 Commit 计划

每个切片独立测试、独立中文 Commit、可用 `git revert` 回滚，不夹带 C 或 v0.7.1。

| 切片 | 内容 | 验收 | 回滚边界 | 建议中文 Commit |
|---|---|---|---|---|
| B0 | 领域类型、Zod schema、事件投影纯函数、测试 | 投影矩阵全绿，无 DB 写 | 纯代码 revert | `feat: 建立可信求职记忆领域模型与事件投影` |
| B1 | schema v2 空表、索引、FK 与临时库 migration 测试；不 backfill Job | migration/rollback/重复运行通过 | revert migration 提交；新表尚无业务数据 | `feat: 新增求职记忆数据库结构与迁移门禁` |
| B2 | repositories、事务、幂等、rowVersion、最小 API | 404/409/422/rollback 通过 | revert API/repo；表可空置 | `feat: 实现求职记忆事务仓储与接口` |
| B3 | ResumeVersion 最小管理页和 active 指针 | 快照不可变、激活/归档通过 | revert 页面/API adapter | `feat: 新增简历版本最小管理` |
| B4 | ApplicationSection、重复投递、上下文与 JobList 摘要 | 0/1/多流程、dirty guard | revert UI；新表事实保留 | `feat: 支持岗位多次投递与流程归属` |
| B5 | FeedbackTimeline、事件录入、纠错/void | 时间线和投影全绿 | revert UI；事件数据保留 | `feat: 新增求职反馈时间线与纠错流程` |
| B6 | deriveDecision 切换 projection、禁旧沟通 PATCH、兼容 fallback | 无双事实源；现有决策回归 | revert adapter/写禁用，保留新模型 | `refactor: 切换沟通决策到事件投影` |
| B7 | 备份 + dry-run + 保守旧数据 backfill、snapshot v2、audit/doctor | 临时副本、真实备份、幂等和一致性通过 | backfill 事务回滚；使用备份恢复 | `feat: 完成旧求职数据兼容与快照升级` |
| B8 | 全量回归、两次 Router smoke、发布前数据审计 | 全测试、eval、snapshot、API、端口通过 | 只修阻塞问题，不扩范围 | `test: 完成 v0.7.0-B 可信求职记忆验收` |

B1 只能先在临时数据库验证；B7 才允许在明确备份和 audit 后升级真实用户库。技术设计确认后才创建功能分支并开始 B0。

---

## 20. 风险、回滚与开放问题

### 20.1 主要风险与护栏

| 风险 | 护栏 |
|---|---|
| Event 与 Application 字段成为双事实源 | stage/outcome/status 不入 applications 表，只查询投影 |
| Job legacy 状态继续被误用 | 有 Application 时强制只读 projection；统计永不读 legacy |
| 未投递 Job 被迁成拒绝样本 | 保守证据门槛；not_contacted/模糊 closed/rejected 不建 Application |
| 简历历史被编辑 | 内容快照和 hash 不可变，改内容即新版本 |
| 迟到/同时间事件不确定 | 固定三段排序与全量纯函数重算 |
| 纠错递归复杂 | 只允许 void 普通事件；恢复通过新事件 |
| snapshot 混版丢新表 | v2 正常同步，v1 仅显式空表升级，旧客户端拒绝 v2 |
| 自动去重覆盖历史 | 只提示，用户确认后 void/supersede，不自动 merge |
| AI 候选污染正式统计 | B 不实现抽取；正式 API 不接受 AI 未审候选 |
| Scope 再次膨胀 | 新建 ApplicationSection/TimelineSection，owner 只编排和持有草稿 |

### 20.2 回滚

- B0–B6 优先 revert 最近切片；新表中的正式数据不因 UI 回滚删除。
- B6 可暂时恢复 legacy decision adapter，但不得把 projection 反写 Job。
- migration 任一失败由 SQLite transaction 回滚；正式升级前已有 SQLite/snapshot 备份。
- B7 后若发现数据错误，停止写入，保存 audit report，使用升级前备份恢复；禁止手工批量改真实表。
- Runtime loader 可切 direct fallback，但两者仍读同一 Bundle API 和事实模型。

### 20.3 反向设计自审

| 反向问题 | 结论 |
|---|---|
| 是否有两个正式状态源 | 否；事件是流程事实，投影不持久化，Job 字段仅零 Application 兼容 |
| communicationStatus 是否与 stage/outcome 打架 | 否；三者由同一投影一次产出 |
| 未投递 Job 是否可能成为负面样本 | 否；保守 migration 且统计只认 Application/Event |
| unknown 是否会变成 false | 否；null/unknown/submissionState 明确分开 |
| 简历历史是否会被后改 | 否；内容快照不可变，改内容即新版本 |
| Event 是否能稳定纠错 | 是；void + 替代事件，稳定排序后全量重算 |
| migration 是否可重跑/恢复 | 是；schema transaction、backfill transaction、migration/idempotency key 和备份 |
| 多次投递是否可区分 | 是；Application 无业务自然唯一约束，流程 ID 独立 |
| 城市事实是否隔离 | 是；Application 固化 cityContext，Job 后改不联动 |
| AI 未确认内容能否进入统计 | 否；B 不实现抽取，正式 API 不接受候选 |
| 是否偷跑 C/v0.7.1/SSE Gate 2 | 否；页面、API、测试和切片均显式排除 |
| 是否引入不必要基础设施 | 否；三张领域表、纯函数查询投影、SQLite transaction，无 CQRS/后台 projector |

### 20.4 开放问题

当前没有必须由用户重新裁定的产品问题。核心模型、状态来源、迁移保守边界、页面范围和 Human-in-the-loop 均已给出唯一方案；实施前只需人工确认本设计是否接受。

---

## 21. 验收标准

### 21.1 模型与事实

- [ ] Job 可以有零个、一个或多个 Application，未投递 Job 不自动建流程。
- [ ] 重复投递、换渠道、换简历和独立招聘流程不会覆盖旧 Application。
- [ ] ResumeVersion 内容不可变，旧 Application 的版本归属不受后续修改影响。
- [ ] FeedbackEvent 不原地修改或删除，纠错可审计且投影稳定。
- [ ] stage/outcome/communicationStatus 只有事件投影一个正式来源。

### 21.2 兼容与迁移

- [ ] 8 态 communicationStatus 有确定投影，deriveDecision 读取 projection。
- [ ] 零 Application 旧 Job 可继续做岗位级决策，但不进入市场统计。
- [ ] unknown 与 false、user_withdrew 与 rejected、no response 与 rejection 分离。
- [ ] migration 决策表、幂等、中断回滚、备份和 audit report 全部验证。
- [ ] snapshot v2 同步三张新表并通过 consistency/roundtrip。

### 21.3 API、页面与安全

- [ ] API 有 runtime validation、404/409/422、idempotency、expectedVersion 和事务测试。
- [ ] `/profile-versions`、ApplicationSection、FeedbackTimelineSection 和 JobList 摘要可用。
- [ ] 写操作是普通 Action，不注册 Runtime Task；`loadJobBundle` 保持只读、可取消、无旧写。
- [ ] AI/OCR 未确认候选不能进入正式事实或统计；现有 import review 保持原语义。
- [ ] 没有实现 C、v0.7.1、v0.7.2、Runtime SSE Gate 2、自动投递或自动沟通。

### 21.4 回归 Gate

- [ ] typecheck、build、Vitest、selftest、OfferFlow JSON eval 全部通过。
- [ ] migration、repository/API、snapshot 和 Browser Router smoke 通过。
- [ ] Router smoke 连续两次退出码 0 且端口释放。
- [ ] 测试只使用临时 SQLite，不调用真实 LLM/OCR，不改真实用户数据。
- [ ] 完整差异、数据安全和发布前审计通过后，才可将 B 标记完成。
