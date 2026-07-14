# OfferFlow v0.7 动态岗位画像与策略技术设计

- 状态：R0 设计冻结稿；本轮不实现领域对象、schema、migration、API 或页面
- 日期：2026-07-14
- 上位产品契约：`docs/product/offerflow-v0.7-release-contract.md`
- PRD：`docs/prd/offerflow-v0.7.md`
- 实施顺序：R1 → R2 → R3 → R4 → R5
- 当前结论：可信求职记忆底座已完成；动态画像与策略尚未完成；禁止发布

## 1. 约束与优先级

发布契约高于本技术设计。本设计只能说明如何实现已冻结产品结果，不能删除、降级、延后或替换发布契约。若设计与发布契约或 PRD 冲突，应暂停实现并取得用户明确批准，不得由工程实现自行改写产品范围。

R0 只形成文档与中文展示收口，不创建本设计中的表、迁移、API、领域对象或页面。App 版本保持 `0.6.2`。

## 2. 设计目标

基于 Job Memory v2 已保存的 ResumeVersion、Application 和 FeedbackEvent，建立三层相互隔离、可版本化、可追溯的判断：

1. `CapabilityBaseline`：候选人较长期、跨城市可复用的能力事实。
2. `MarketPositionProfile`：限定城市、岗位族和市场上下文的可达区间。
3. `StrategyWindow`：7–14 天内可执行、可复盘的阶段策略。

三层之间只允许单向引用已确认版本，不允许短期策略直接覆盖长期能力基线，也不允许一个城市的薪资/转化结论写入另一个城市画像。

```txt
可信事实（Resume / Project / Application / FeedbackEvent）
  → 候选证据（CandidateEvidence，人工审核）
  → 长期能力基线（CapabilityBaselineVersion）
  → 城市市场画像（MarketPositionProfileVersion + EvidenceSufficiency）
  → 阶段策略提案（StrategyProposal）
  → 用户决议
  → 7–14 天正式策略（StrategyWindow）
```

## 3. 统一事实与候选边界

### 3.1 正式事实源

- Profile、ResumeVersion 与项目经历：用户维护或确认的候选人资料。
- Job：岗位与 JD 事实，不代表已投递。
- Application：一次独立投递/招聘接触。
- FeedbackEvent：不可原地覆盖的过程事实。
- 用户确认的城市偏好和求职硬约束。
- 已经用户接受的能力基线、市场画像和策略版本。

AI 原文、模型抽取、启发式匹配和自由文本解析均不是正式事实。它们只能进入候选或提案层，必须保留来源、运行信息、输入版本与用户决议。

### 3.2 共同版本规则

- 已激活/已确认版本不可原地修改；变更生成新版本。
- 新版本保存其输入版本引用、证据快照、算法/提示版本和生成时间。
- 正式读取只引用明确激活或用户确认版本。
- supersedes 只表达版本替代，不删除历史。
- 所有用户决议均保留时间、动作和可选原因。

## 4. R1：历史补录与基础漏斗

R1 是动态画像的输入质量前置条件，不实现画像结论。

### 4.1 两层补录

第一层“最小历史基线”只收集用户能可靠回忆的聚合事实，例如时间段、城市、岗位族、渠道、投递量区间、明确回复/面试/Offer 数量。它必须标记为回忆或近似来源，不能伪造成逐条精确事件。

第二层“详细事件补录”允许用户为重要流程建立 Application 并逐条确认 FeedbackEvent。每条事实沿用 Job Memory v2 的时间精度、来源可信度和证据强度规则。

### 4.2 基础漏斗

基础漏斗至少支持按城市、岗位族、渠道、简历版本和时间窗分组，展示：

- 已确认投递/招聘接触流程数；
- 有效回复数；
- 筛选/面试/Offer 推进数；
- 招聘方拒绝、用户退出、岗位关闭分别计数；
- 数据来源与回忆数据占比；
- 同源岗位与独立雇主去重口径。

未投递 Job 不进入分母；用户主动退出不算招聘方拒绝；岗位关闭不评价候选人能力；回忆聚合不能拆成伪造的逐条强证据。

### 4.3 R1 Gate

- 历史基线和详细事件入口清晰分开。
- 所有写入先预览、再确认。
- 漏斗能解释分母、排除项和可信度。
- R1 完成后仍不生成正式 CapabilityBaseline 或 MarketPositionProfile。

## 5. R2：CandidateEvidence 与 CapabilityBaseline

### 5.1 CandidateEvidence

`CandidateEvidence` 表达一个待确认或已确认的能力相关证据，而不是对候选人的最终评价。建议字段：

```ts
interface CandidateEvidence {
  id: string
  subject: 'skill' | 'delivery' | 'architecture' | 'collaboration' | 'domain' | 'education_constraint'
  capabilityKey: string
  statement: string
  polarity: 'support' | 'counter' | 'neutral'
  validationState: 'candidate' | 'confirmed' | 'rejected' | 'superseded'
  sourceType: 'profile' | 'resume_version' | 'project' | 'job_description' | 'feedback_event' | 'interview_feedback' | 'user_input' | 'system_import'
  sourceRecordType: string
  sourceRecordId: string | null
  sourceSnapshot: unknown
  sourceConfidence: 'exact' | 'approximate' | 'recalled' | 'inferred'
  evidenceLevel: 'strong' | 'medium' | 'weak'
  applicableRoleFamilies: string[]
  observedAt: number | null
  createdAt: number
  confirmedAt: number | null
  userDecisionNote: string | null
  aiRunId: string | null
}
```

AI 只能创建 `candidate`；只有用户确认后才能进入正式基线输入。JD 只能说明岗位要求，不能单独证明候选人具备或不具备该能力。无回复、未读、岗位关闭或来源不明的拒绝，不能自动生成能力反证。

### 5.2 CapabilityBaselineVersion

能力基线按版本保存，建议包含：

- 版本号、状态、有效起止时间和 supersedes；
- 稳定能力（stableCapabilities）；
- 已验证能力（validatedCapabilities）；
- 未验证能力（unverifiedCapabilities）；
- 支撑证据引用（supportEvidenceIds）；
- 反证引用（counterEvidenceIds）；
- 适用岗位族（roleFamilies）；
- 硬约束与学历事实，但不得把硬约束直接当作能力高低；
- 置信度与证据缺口；
- 输入 ResumeVersion/Profile 版本；
- 用户决议与确认时间。

同一时间只有一个正式生效的能力基线版本。修改已生效基线必须新建候选版本并重新确认。

### 5.3 稳定性规则

- 单次无回复、短期低转化或单一渠道波动不得降低长期能力基线。
- 能力下调需要直接、可归因、跨来源或重复出现的反证，并通过用户审核。
- 新技能仅因简历自述时可以是“未验证”，不能直接升级为“已验证”。
- 城市市场表现影响 MarketPositionProfile，不自动回写 CapabilityBaseline。
- 用户拒绝某项候选证据后，除非出现重大新证据，否则相同指纹候选进入冷却。

### 5.4 R2 Gate

- 支撑证据、反证和未验证项可同时展示。
- 证据可跳回真实来源。
- AI 候选不能绕过用户确认。
- 短期非回复不触发能力下调。
- 版本切换与历史决议可追溯。

## 6. R3：MarketPositionProfile 与 EvidenceSufficiency

### 6.1 市场画像上下文

市场画像不是只有 city 的静态标签。每个版本至少固定：

```ts
interface MarketProfileContext {
  city: 'suzhou' | 'wuxi' | 'shanghai' | 'hangzhou'
  roleFamily: string
  salaryContext: string | null
  companySizeContext: string[]
  companyTypeContext: string[]
  educationContext: string | null
  employmentContext: string | null
  industryContext: string[]
  resumeVersionIds: string[]
  observedFrom: number | null
  observedTo: number | null
}
```

同一城市可按上下文生成多个历史版本，但一个完整上下文只能有一个当前激活版本。若页面提供“城市当前画像”，必须明确其岗位族和上下文，不能把不同岗位族强行压成一个无条件结论。

### 6.2 三档市场区间

用户页面统一使用“冲刺 / 主攻 / 稳妥”，每档至少保存：

- 角色/岗位族；
- 薪资区间；
- 公司规模与类型；
- 行业偏好；
- 学历/用工硬约束；
- 技术栈定位；
- 支撑证据和反证；
- 风险与不确定性；
- 置信度；
- 当前推荐优先级。

画像版本还应保存市场摘要、搜索关键词、沟通策略、迁移门槛、输入能力基线版本、充分性快照和生成/确认时间。

### 6.3 EvidenceSufficiency

充分性不是单一投递次数。建议按维度计算并保存可解释结果：

- 有效 Application 数；
- 独立雇主数；
- 同源去重后的岗位数；
- 可归因反馈事件强度；
- 时间跨度与新鲜度；
- ResumeVersion 覆盖；
- 岗位族一致性；
- 城市一致性；
- 渠道代表性，防止只用单一平台推断整体市场；
- 直接证据/回忆数据/推断数据占比；
- 正反证覆盖与冲突程度。

充分性输出至少包括：

```ts
type SufficiencyGrade = 'insufficient' | 'exploratory' | 'actionable'

interface EvidenceSufficiency {
  grade: SufficiencyGrade
  confidence: number
  dimensions: Array<{ key: string; score: number; explanation: string }>
  missingEvidence: string[]
  allowedConclusions: string[]
  blockedConclusions: string[]
  evaluatedAt: number
}
```

门禁规则：

- `insufficient`：只能描述观察与缺口，不得给正式降薪、降级或转岗建议。
- `exploratory`：可以提出小比例实验，但必须标注不确定性，不能改正式主攻区间。
- `actionable`：可以生成正式市场画像提案，但仍须用户确认。

### 6.4 四城市隔离与借用规则

首批城市稳定 code：`suzhou`、`wuxi`、`shanghai`、`hangzhou`；页面分别显示苏州、无锡、上海、杭州。

- 跨城市可复用：已确认能力证据、项目交付事实、技术栈事实。
- 禁止直接混算：薪资、回复/面试转化、岗位供给、学历门槛、公司规模偏好和渠道表现。
- 相邻城市也不自动等同。苏州/无锡的地理接近不能把二者视为一个样本池。
- 借用参考必须保存来源城市、借用原因、降权系数、适用范围与“不适用”条件。
- 借用参考只能补充解释，不能绕过目标城市充分性门禁。

示例：上海的 Vue 平台交付证据可以支持“能力可迁移”；上海 30K 薪资不能作为苏州目标薪资的直接证据。杭州迁移门槛不能复制到无锡。

### 6.5 机会雷达接入边界

现有机会雷达继续负责单个 Job 的匹配分析，不重建第二套单岗位分析。未来只增加：

- 使用的 MarketPositionProfileVersion；
- 使用的 ResumeVersion；
- 城市画像契合度；
- 跳转城市完整画像。

匹配必须按 Job.city 选择同城、同岗位族的 active 画像。没有 active 画像时明确显示“该城市尚无已激活岗位画像”，不得静默使用其他城市画像。

### 6.6 R3 Gate

- 四城数据完全隔离。
- 三档结论均可追溯到能力版本、市场证据和充分性快照。
- 不足样本明确拒绝高影响判断。
- 借用参考保存来源、原因、降权和不适用条件。
- 画像版本切换不会改写历史机会分析引用。

## 7. R4：Proposal Review 与 StrategyWindow

### 7.1 StrategyProposal

策略提案不是正式策略，建议包含：

- proposalId、fingerprint、状态和生成时间；
- 输入 CapabilityBaselineVersion、MarketPositionProfileVersion 与 EvidenceSufficiency；
- 支撑证据、反证和不确定性；
- 提案原因与预期观察；
- 建议 7–14 天分配；
- 失效时间（expiresAt）；
- 冷却截止时间（coolingUntil）；
- supersedesProposalId；
- AI/规则运行信息；
- 用户决议、决议原因与决议时间。

### 7.2 Proposal Review 状态机

正式状态：

```ts
type ProposalReviewStatus =
  | 'proposed'
  | 'accepted'
  | 'modified_and_accepted'
  | 'rejected'
  | 'deferred'
  | 'expired'
```

- `proposed`：仅候选，不影响正式策略。
- `accepted`：原提案被用户接受，生成 StrategyWindow。
- `modified_and_accepted`：保存用户修改后的正式输入和差异，再生成 StrategyWindow。
- `rejected`：不生成策略；记录原因并启动同指纹冷却。
- `deferred`：不生成策略；到指定时间后才允许提醒。
- `expired`：输入版本变化或超过有效期，不得再接受。

### 7.3 指纹、冷却与重大新证据

fingerprint 至少包含目标城市、岗位族、关键策略分配、输入版本和主要证据集合。相同或实质等价提案被拒绝后，在冷却期内不得重复弹出。

只有重大新证据才允许提前重启，例如：

- 新的强面试反馈直接改变能力判断；
- 新增独立雇主反馈使充分性跨级；
- 用户主动修改城市、薪资或硬约束；
- 能力基线/市场画像正式版本发生实质变化。

普通时间流逝、同源重复岗位或模型措辞变化不算重大新证据。

### 7.4 StrategyWindow

正式 StrategyWindow 有效期 7–14 天，至少包含：

- 城市分配；
- 岗位族与冲刺/主攻/稳妥分配；
- 渠道分配；
- ResumeVersion 实验；
- 薪资/公司类型边界；
- 待验证假设与不确定性；
- 证据收集目标；
- 复盘时间；
- 来源提案和用户决议。

策略窗口只能建议用户执行，不能自动投递、发消息、切换沟通状态或修改正式画像。策略结果进入下一轮证据评估，但不能直接重写 CapabilityBaseline。

### 7.5 R4 Gate

- 五种用户决议和 expired 均有测试。
- 未确认提案不影响任何正式策略或决策。
- 修改后接受保存原提案与用户差异。
- 拒绝/稍后处理具备冷却与反骚扰。
- 新证据重启必须可解释、可审计。
- StrategyWindow 不自动执行外部动作。

## 8. 页面与路由建议

R1–R4 的页面应独立于单个 Job 的 Application 流程：

- `/history-import`：两层历史补录；
- `/market-funnel`：基础漏斗；
- `/capability-baseline`：能力证据与基线；
- `/market-profiles`：城市画像总览与四城对比；
- `/market-profiles/:city`：城市画像版本；
- `/strategy`：当前 7–14 天策略与 Proposal Review。

Job 详情保持信息层级：岗位事实 → 单岗位机会雷达 → 推荐动作/话术 → 求职流程 → 反馈事实时间线 → 折叠技术信息。城市画像不混入某个 Application 的事实时间线。

## 9. API 与写入原则

- 查询可返回正式版本、候选版本和充分性说明，但必须有明确状态。
- 创建候选、用户决议、激活版本分别使用明确命令，不提供“生成并自动激活”。
- 写入使用幂等键与乐观并发；网络结果不明先读回核对。
- 已生效版本不 PATCH 内容；修改通过新版本和 supersedes。
- API 保留稳定英文 code；用户主界面使用集中中文映射。
- AIRun 保存可审计输入引用和输出原文，但不得包含密钥。

## 10. 测试与 Eval

### 10.1 领域测试

- CandidateEvidence 候选/确认/拒绝与来源完整性；
- CapabilityBaseline 版本切换、支持/反证、短期非回复稳定性；
- 四城市隔离、跨城能力复用和市场证据禁混；
- EvidenceSufficiency 多维门禁、同源去重、时间衰减、渠道代表性；
- Proposal Review 状态机、指纹、冷却、失效和重大新证据；
- StrategyWindow 7–14 天约束与不回写能力基线。

### 10.2 页面测试

- 默认中文、未知 code 降级、技术信息默认关闭；
- 证据不足页面拒绝高影响建议；
- 四城切换不串数据；
- 历史版本不可直接修改；
- Proposal 必须人工接受或修改后接受才生成正式策略。

### 10.3 业务 Eval

至少覆盖：单一 Boss 渠道、同一雇主重复岗位、未投递收藏、用户主动退出、岗位关闭、回忆补录、上海强样本/苏州弱样本、能力可迁移但薪资不可借用、学历硬约束、拒绝同一策略后模型换措辞重提等场景。

## 11. 数据安全与 Human-in-the-loop

- 不爬 Boss，不自动投递，不自动发消息或模拟点击。
- 不因 AI 结论自动改变正式事实、画像或策略。
- 不从 OCR/自由文本直接写正式 FeedbackEvent/CandidateEvidence。
- 不混淆 JD 导入 Review 与 Proposal Review。
- 不删除 AI 原文、用户决议、历史版本或反证来“清理”结果。
- R1–R4 每轮涉及 schema/migration 前必须单独设计、备份、验证和获得任务授权。

## 12. R1–R5 交付顺序

1. **R1 历史补录与基础漏斗**：补齐真实市场样本输入，不生成画像。
2. **R2 CandidateEvidence / CapabilityBaseline**：建立长期能力事实和版本。
3. **R3 MarketPositionProfile / EvidenceSufficiency**：建立四城画像与拒绝越权门禁。
4. **R4 Proposal Review / StrategyWindow**：建立可拒绝、可冷却的阶段策略。
5. **R5 产品验收与发布准备**：按发布契约逐项签收测试和截图；不自动授权发布。

任何阶段不得以“下一阶段以后再做”为理由把未完成结果标记为已交付。R5 之前统一状态保持“v0.7 产品实施中，禁止发布”。
