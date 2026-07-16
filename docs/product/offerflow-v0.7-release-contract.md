# OfferFlow v0.7 产品发布契约

- 状态：已冻结，作为 v0.7 发布判断的最高优先级产品契约
- 日期：2026-07-14
- 产品依据：`docs/prd/offerflow-v0.7.md`
- 当前 App 版本：`0.6.2`
- 当前发布结论：**v0.7 产品实施中；可信求职记忆底座已完成；G1 全局岗位匹配画像 MVP、G2 CandidateEvidence 与 CapabilityBaseline、G3 历史补录与基础漏斗均已经用户验收（2026-07-15）；G4 MarketPositionProfile 与 EvidenceSufficiency（含 AI 生成提案路径）已于 2026-07-16 在隔离沙箱中经用户正式验收；G5 StrategyWindow 与正式策略 Proposal Review 已于 2026-07-16 在隔离沙箱（schema v6）经用户正式验收并封板；G6-A（发布准备与生产迁移演练）已于 2026-07-16 完成；**G6-B（真实生产切换）已于 2026-07-16 经用户授权执行：真实数据库已从 schema v4 受控升级到 schema v6，G4/G5 正式版本晋升包已导入，正式生产入口已开放 G4 市场位置画像与 G5 求职策略，Snapshot 采用方案 B（一致性备份为恢复机制）**；G6 等待用户最终生产验收；App 版本仍 `0.6.2`，仍未授权 push、合并 main、Tag、Release；禁止发布**

## 1. 契约目的

本契约把 PRD 中用户必须获得的产品结果，与页面、领域、API、自动化测试和截图证据逐项绑定。技术切片、迁移、恢复演练或单个 Gate 通过，只能证明对应工程阶段完成，不能替代产品发布验收。

只有下列七项产品结果全部达到“已验收”，并且第 3 节的全局门禁全部通过，才允许提出 v0.7 发布申请。

## 2. 七项冻结产品结果

### 2.1 中文产品界面

| 契约字段 | 冻结内容 |
|---|---|
| PRD 依据 | §3.2 用户价值、§14 页面与路由、§27 最终验收标准 |
| 用户场景 | 用户查看岗位、求职流程、反馈时间线、简历版本和决策依据时，只看到自然中文业务表达；原始枚举、UUID、payload 和并发字段不干扰判断。 |
| 页面 | 岗位列表、岗位详情/决策、求职流程、反馈事实时间线、简历版本。 |
| API / 领域 | Job Memory v2 查询结果保持稳定英文 code；前端集中式、有 TypeScript 穷尽约束的 presentation mapping 负责中文展示。 |
| 自动化测试 | 映射表覆盖全部正式枚举；真实挂载页面断言默认内容不出现原始字段名和代表性英文 code；未知服务端值安全降级。 |
| 截图验收 | 至少保存岗位列表、求职流程、反馈时间线、决策面板、简历版本五张页面截图；默认画面不得出现 camelCase、UUID、原始枚举或内容 hash；“查看技术信息”默认关闭。 |
| 当前状态 | **R0 已实现，待用户验收**：集中映射、页面挂载测试和五类默认态截图已完成。 |
| 阻塞项 | 等待用户审阅中文展示与截图；该项验收也不解除其余产品结果的发布阻塞。 |

### 2.2 可信求职记忆

| 契约字段 | 冻结内容 |
|---|---|
| PRD 依据 | §7.1–7.4、§19.2、§23、§27“求职记忆” |
| 用户场景 | 用户能区分岗位、独立求职流程、使用的简历版本与不可原地覆盖的反馈事实；同一岗位多次投递不会互相覆盖。 |
| 页面 | 简历版本、岗位详情中的求职流程、反馈事实时间线、岗位列表流程摘要。 |
| API / 领域 | ResumeVersion、Job、Application、FeedbackEvent、ApplicationProjection；Job Memory v2 API 与 Snapshot v2。 |
| 自动化测试 | 投影纯函数、同岗位多流程、幂等、乐观并发、作废审计、迁移、Snapshot、一致性与恢复测试。 |
| 截图验收 | 同一岗位至少两条独立流程；每条显示渠道、招聘主体/联系人、简历版本、阶段和时间线；作废记录保留审计。 |
| 当前状态 | **已实现，工程审计通过**。R0.1 已将 B7-B 历史升级证明与当前生产验证拆分，并把正式 Snapshot v2 同步至当前真实数据；B0–B8 的既有恢复证明继续有效。 |
| 阻塞项 | 该项单独通过不构成产品发布；必须等待其余六项。 |

### 2.3 历史补录与基础统计

| 契约字段 | 冻结内容 |
|---|---|
| PRD 依据 | §6.5、§11、§19.3、§27“历史与统计” |
| 用户场景 | 用户先录入最小历史基线，再按需补详细事件；能查看按城市、岗位族、渠道和简历版本分组的基础漏斗，同时明确回忆数据的可信限制。 |
| 页面 | 历史补录向导；基础漏斗/市场反馈概览。 |
| API / 领域 | HistoricalBaselineImport、HistoricalEventDraft（名称可在 R1 技术设计中细化，但不得改变两层补录结果）；Application/FeedbackEvent 正式写入仍需人工确认。 |
| 自动化测试 | 两层补录、回忆数据弱证据、未投递不计拒绝、去重、分组漏斗与零样本展示。 |
| 截图验收 | 最小补录、详细补录、补录预览确认和基础漏斗四类画面；必须显示数据来源、可信度与未投递排除说明。 |
| 当前状态 | **G3 已于 2026-07-15 经用户正式验收通过**。真实数据库已受控升级到 schema v4；历史补录已在正式环境（非 sandbox）开放；基础漏斗已基于真实数据验证（已投递=9，与升级前一致）；空 draft 会话丢弃交互缺口已由提交 `bff0043` 补齐并完成正式环境验证。 |
| 阻塞项 | 该项单独验收通过不构成 v0.7 发布；仍需等待其余产品结果（含 2.4/2.5/2.6/2.7）。当前 Snapshot 契约（`SNAPSHOT_SCHEMA_VERSION=2`）仍只支持 database schema 2，不支持 schema v4；Snapshot v4 是独立的“Snapshot 契约升级与恢复设计”基础设施任务，不是 G3 遗留缺陷，不阻塞 G4 开始，但在 v0.7 最终发布前必须由用户另行裁决其范围；禁止通过直接修改 `SNAPSHOT_SCHEMA_VERSION` 常量冒充已支持。 |

### 2.4 长期能力基线

| 契约字段 | 冻结内容 |
|---|---|
| PRD 依据 | §5.1、§7.5、§8.1、§24、§29 |
| 用户场景 | 用户看到由简历、项目、面试和招聘反馈支撑的稳定能力判断；短期未回复不会自动降低能力结论，反证与不确定项会被同时展示。 |
| 页面 | 能力证据库；能力基线详情与版本历史；候选证据人工审核。 |
| API / 领域 | CandidateEvidence、CapabilityBaseline、CapabilityBaselineVersion；AI 只能产出候选证据/提案。 |
| 自动化测试 | 支撑/反证并存、版本化、证据来源、用户决议、短期非回复不下调、学历硬约束与能力事实分离。 |
| 截图验收 | 能力维度、支持证据、反证、未验证项、版本与用户决议均可见；不得只显示单一分数。 |
| 当前状态 | **未实现**。 |
| 阻塞项 | R2 尚未开始；当前 Profile/ResumeVersion 不是 CapabilityBaseline。 |

### 2.5 城市岗位画像与市场定位

| 契约字段 | 冻结内容 |
|---|---|
| PRD 依据 | §5.2、§6.4、§7.6、§10、§24 |
| 用户场景 | 用户分别查看苏州、无锡、上海、杭州的冲刺/主攻/稳妥岗位区间；城市薪资、供需、学历和转化结论不混算，借用证据可追溯且降权。 |
| 页面 | 城市市场画像总览、城市详情、画像版本历史、四城对比。 |
| API / 领域 | MarketPositionProfile、MarketPositionProfileVersion、MarketBand、CityEvidenceReference。 |
| 自动化测试 | 四城隔离、跨城能力复用、市场证据禁止混算、借用来源与降权、画像版本切换。 |
| 截图验收 | 四城切换与对比画面；每城展示冲刺/主攻/稳妥、薪资和公司偏好、证据/反证、置信度与更新时间。 |
| 当前状态 | **G4 已于 2026-07-16 在隔离沙箱中经用户正式验收**。G1 全局岗位匹配画像 MVP 已实现并经用户验收（2026-07-15），提供全局画像 + 苏州/无锡/上海/杭州四城市视图 + 手工/AI 提案 + Proposal Review + 版本历史；这仅是用户可见的 MVP 子集。正式 MarketPositionProfile 与 EvidenceSufficiency（G4，对应本契约 R3）：统一 G1/G2/G3 输入的全局+四城独立画像、EvidenceSufficiency（insufficient/directional/supported）、7 类 DecisionGate（含 abandon_direction/relocation_decision 永不 decision_ready）、Proposal→Review→正式版本流程，已在隔离沙箱（schema v5，仅 tmp/g4-sandbox，真实库仍为 v4）完成自动化测试、浏览器验证与用户人工验收：用户已完成 AI proposal → 接受并激活 → 正式 V1 可见的完整验收链路。手工提案基础上新增的 AI 生成提案路径（复用 G1/G2 既有 LLM Provider，仅在用户主动点击时调用一次真实模型，确定性计算先行、AI 只润色叙述、幂等去重、失败最多一次自动修复）已在同一隔离沙箱真实生成成功并经用户验收；相同输入复用已有待审核提案，未重复调用模型。G4 沙箱前后端生命周期联动与连接失败提示已由提交 `51bb7f1` 补齐。未在真实生产入口开启。 |
| 阻塞项 | G4 已验收，但**不解除**本项 2.5 其余发布阻塞：真实生产库与生产入口均未启用 G4（真实数据库仍为 schema v4），G4 生产切换属于后续独立的受控数据库升级与发布任务，需用户另行裁决时间与方式；G1 的 MVP 视图不得冒充正式城市市场画像，现有单岗位机会雷达和静态目标画像分数亦不得冒充城市市场画像。 |

### 2.6 样本充分性与拒绝越权

| 契约字段 | 冻结内容 |
|---|---|
| PRD 依据 | §6.2、§8.3–8.4、§9、§11.3、§25“质量护栏” |
| 用户场景 | 当样本不足、来源单一或同源重复时，系统明确说“不足以判断”和需要补什么，不输出正式降薪、降级或转岗结论。 |
| 页面 | 城市画像和策略提案中的充分性卡片；证据详情；不足样本阻断提示。 |
| API / 领域 | EvidenceSufficiency、SufficiencyDimension、DecisionGate；返回充分性等级、缺口与允许/禁止的结论类型。 |
| 自动化测试 | 独立雇主数、有效流程数、事件强度、时间跨度、渠道代表性、同源去重、城市隔离、时间衰减和高影响结论阻断。 |
| 截图验收 | 至少覆盖“样本不足”“探索性结论”“可行动结论”三态；不足态必须展示置信度低、缺失证据和禁止动作。 |
| 当前状态 | **已于 2026-07-16 在隔离沙箱中经用户正式验收**。EvidenceSufficiency 基于确定性规则计算 evidenceLevel（insufficient/directional/supported），DecisionGate 覆盖角色定位/城市优先级/薪资定位/简历有效性/渠道有效性/放弃当前方向/搬迁决策 7 类，其中放弃当前方向与搬迁决策无论证据等级如何均不可达 decision_ready；EvidenceSufficiency 与 DecisionGate 均由确定性规则锁定，AI 仅生成受约束的中文叙述，不能篡改上述计算结果；已在隔离沙箱完成自动化测试、浏览器验证与用户人工验收。 |
| 阻塞项 | G4 已验收，但不得以固定投递次数替代多维充分性；不解除本项其余及其他产品结果的发布阻塞。G1 岗位匹配画像的样本不足/探索性/可行动三种置信状态只是 MVP 展示，不等同于本项已验收的 G4 EvidenceSufficiency 门禁。 |

### 2.7 阶段策略与 Proposal Review

| 契约字段 | 冻结内容 |
|---|---|
| PRD 依据 | §5.3、§6.1、§7.7–7.8、§12、§13、§29 |
| 用户场景 | 用户收到 7–14 天、带证据与不确定性的阶段策略提案，可接受、修改后接受、拒绝、稍后处理；拒绝后不会被同一提案反复打扰。 |
| 页面 | 策略窗口、提案审核、历史决议和到期/失效说明。 |
| API / 领域 | StrategyWindow、StrategyProposal、ProposalReviewDecision、AIRun；正式策略只由用户决议产生。 |
| 自动化测试 | 五种决议、指纹去重、冷却、到期、被新提案替代、重大新证据重启、拒绝防骚扰、未确认不影响正式策略。 |
| 截图验收 | 提案证据/反证/原因、7–14 天分配、四种用户动作、冷却提示、历史决议均可见；不得存在自动接受或自动执行。 |
| 当前状态 | **G5 已于 2026-07-16 在隔离沙箱（schema v6，`tmp/g5-sandbox`）经用户正式验收并封板**。StrategyWindow 完全由确定性规则从 G4 active 市场位置版本的 evidenceLevel/DecisionGate 生成，三档均已实现并验收（insufficient→证据收集 / directional→受控实验 / supported→有限优化），当前真实样本对应证据收集窗口；DecisionGate→策略动作的确定性映射已验收；AI 只在窗口边界内生成受约束叙事与既有行动（按 actionId）的润色，不可修改 StrategyWindow/EvidenceSufficiency/DecisionGate/sourceEvidenceIds/正式计数/输入版本与 inputHash，服务端对合并后草稿重新执行门禁校验；AI overlay 结构化输出契约已由 `2038e54`/`6ba6c9d` 收口（strict object、拒绝未知/确定性字段、数组须为 JSON 数组、结构化输出失败最多修复一次）；提案→审核（接受/修改后接受/拒绝/稍后处理）→正式版本流程与 G4 一致，AI 提案必须经用户人工接受才生成正式版本，接受前不改正式版本、不修改 Job/Application/FeedbackEvent、不执行任何行动；相同 inputHash 复用既有开放提案、不重复调用模型，输入变化或窗口到期使旧提案失效且不可接受。用户已完成 AI 生成 → 提案审核 → 接受并激活 → 正式 V1、行动清单、实验计划、版本历史的完整验收链路，待审核提案已清空；真实库全程 schema v4 且哈希前后一致，未在真实生产入口开启（`strategyWindow.enabled=false`）。 |
| 阻塞项 | G5 已验收，但**不解除** v0.7 发布阻塞：真实数据库仍为 schema v4，真实生产入口未开启 G4/G5；G4/G5 生产切换属于 G6 的受控数据库升级与发布裁决范围，需用户另行裁决；Snapshot 契约升级仍是独立基础设施任务。现有 JD 导入 Review 和 `deriveDecision` 不是 Proposal Review/StrategyWindow。 |

## 3. 全局发布门禁

发布申请必须同时满足：

1. 七项产品结果全部标记“已验收”，且每项有自动化测试输出和可复核截图。
2. `typecheck`、完整单元/组件测试、selftest、build、迁移与 Snapshot 一致性、真实数据只读验证全部通过；历史升级 attestation 与当前生产 verification 必须分别通过，禁止用历史固定聚合作为永久生产行数门禁。
3. Human-in-the-loop 保持：AI 只提供候选分析与提案；用户确认正式事实、能力结论与阶段策略。
4. 四城市市场证据隔离；借用只允许能力证据或显式、降权、可追溯的参考，不能混算薪资与转化。
5. 样本不足时拒绝高影响结论；未投递不构成市场拒绝；回忆数据不伪装成精确事实。
6. App 版本、PR、合并、Tag 与 Release 必须在独立发布轮中执行，本契约通过本身不自动授权这些动作。

## 4. 永久范围变更规则

任何 PRD 产品结果的删除、降级、延后或替代，都必须先取得用户明确批准，并在本契约和追踪矩阵中留下不可含糊的批准记录。批准记录至少包含：

- 批准人/用户明确指令；
- 批准日期；
- 原 PRD 条款与原产品结果摘要；
- 变更后的结果或延后阶段；
- 变更原因与用户影响；
- 受影响的页面、领域、API、测试和截图验收；
- 是否改变发布结论。

技术阶段通过、代码已存在、测试全绿、恢复演练成功、时间不足或“建议以后再做”，均不构成范围变更批准。没有完整批准记录时，原 PRD 结果继续有效，且缺失项继续阻塞发布。

## 5. 当前签收结论

R0 只纠正发布契约、中文展示与后续技术设计；R0.1 只完成生产数据基线、正式 Snapshot v2 和真实验证语义收口，均不实现 R1–R5。当前只有“可信求职记忆”具备已通过的工程证据；其余产品结果不能被 B0–B8 或 R0.1 代替。因此产品发布验收失败，禁止发布、禁止合并 main、禁止升级版本或创建 PR/Tag/Release。

G1（全局岗位匹配画像 MVP）已于 2026-07-15 经用户验收，进入 G2（CandidateEvidence 与 CapabilityBaseline）。G1 只覆盖第 2.5 项城市岗位画像的 MVP 子集，不解除其余产品结果（含 2.5 的正式 MarketPositionProfile 与 EvidenceSufficiency）的发布阻塞。

G2（CandidateEvidence 与 CapabilityBaseline）已于 2026-07-15 经用户人工测试验收：候选能力证据审核、正式证据库、AI/手工能力基线提案、无正式证据时阻止生成基线、支持证据/反证/待验证项同时保留、接受/修改后接受/拒绝/稍后处理、能力基线版本历史与版本激活均已验收；截图归档尚未完成，列为 G6 统一归档项；未发现阻塞 G3 的产品问题。G2 只覆盖第 2.4 项长期能力基线，不解除其余产品结果的发布阻塞。

G3（历史补录与基础漏斗）已于 2026-07-15 经用户正式验收通过：真实数据库已受控升级到 schema v4；历史补录已在正式环境开放（不再局限于隔离 sandbox）；基础漏斗已基于真实数据验证；空 draft 会话丢弃交互缺口已补齐。G3 只覆盖第 2.3 项历史补录与基础统计，不解除其余产品结果的发布阻塞。当前 Snapshot 契约仍为 Job Memory v2（`SNAPSHOT_SCHEMA_VERSION=2`），不支持 database schema 4；Snapshot v4 是独立的基础设施任务，不是 G3 遗留缺陷，不阻塞 G4 开始，但在 v0.7 最终发布前必须由用户另行裁决其范围。

G4（MarketPositionProfile 与 EvidenceSufficiency）**已于 2026-07-16 在隔离沙箱（schema v5，`tmp/g4-sandbox`）中经用户正式验收**：统一 G1（岗位匹配画像）/G2（能力基线）/G3（历史漏斗）输入，产出全局+苏州/无锡/上海/杭州四城独立画像；EvidenceSufficiency 限定 insufficient/directional/supported 三档，由确定性规则锁定计算；DecisionGate 覆盖 7 类，其中放弃当前方向与搬迁决策无论证据等级如何均不可达 decision_ready；AI 仅生成受确定性规则约束的中文叙述，不能篡改 EvidenceSufficiency/DecisionGate 计算结果；Proposal→Review→正式版本流程与 G1/G2 模式一致，AI 提案必须经过人工接受（接受/修改后接受）才生成正式版本，用户已完成 AI proposal → 接受并激活 → 正式 V1 可见的完整验收链路。工程与验收证据：schema v5 仅创建于隔离 sandbox（`tmp/g4-sandbox`），真实数据库全程保持 schema v4 且哈希前后一致；已完成 HTTP 路由测试、页面组件测试、迁移 selftest（v4→v5 升级与新表 CHECK/FK 约束）与沙箱浏览器验证（建立提案→接受并激活→四城市证据等级展示）；G4 沙箱前后端生命周期联动与连接失败提示已由提交 `51bb7f1` 补齐；未在真实生产入口开启（`server/index.ts` 默认 `marketPosition.enabled=false`）。

在手工提案基础上，G4 收尾新增的 AI 生成市场位置提案路径同样已经用户验收：复用 G1/G2 既有共享 LLM Provider，不新增第二套 AI Provider、不新增 API Key 页面、不引入 BYOK；仅用户主动点击时调用；服务端先以确定性规则计算 EvidenceSufficiency/DecisionGate 并冻结输入哈希，AI 只允许润色中文叙述字段，结构化输出校验失败最多自动修复一次，二次失败返回稳定错误码而非假成功；相同输入已有未处理提案时直接复用（`reused: true`），验证不重复调用模型、不产生重复提案；提案元数据记录在既有 v5 payload 内，未新增 schema v6。已在同一隔离沙箱完成 ≥16 项服务端/域测试、≥10 项页面测试（均使用 Fake Provider，测试不调用真实模型）与用户浏览器验收：AI 市场位置提案真实生成成功（真实调用一次 DeepSeek 模型），生成结果的 EvidenceSufficiency/DecisionGate 与确定性计算一致，四城市叙述含上海无数据固定文案，幂等重复请求复用既有提案，拒绝流程正常，真实数据库哈希前后一致；未在真实生产入口开启。

G3、G4 均已签收，均不代表 v0.7 可以发布、合并 main、创建 Tag 或 Release。v0.7 仍禁止发布、禁止合并 main、禁止升级版本或创建 PR/Tag/Release，App 版本继续保持 `0.6.2`；真实数据库继续保持 schema v4，真实生产入口不开启 G4；G4 生产切换（真实库受控升级到 schema v5 并在生产开放）属于后续独立的受控数据库升级与发布任务，需用户另行裁决；Snapshot 契约升级仍是独立的基础设施任务，独立于 G4 签收之外，须由用户另行裁决范围。

G5（StrategyWindow 与正式策略 Proposal Review）**已于 2026-07-16 在隔离沙箱（schema v6，`tmp/g5-sandbox`）经用户正式验收并封板**：StrategyWindow 由确定性规则从 G4 active 市场位置版本的 evidenceLevel/DecisionGate 生成三档窗口（evidence_collection 证据收集 / controlled_experiment 受控实验 / limited_optimization 有限优化，三档均已实现并验收），当前真实样本对应证据收集窗口；DecisionGate→策略动作的确定性映射已验收；三类边界（现在可以做 / 只能观察或实验 / 当前不能做）清晰。AI 复用 G4 既有共享 LLM Provider（无新 Provider/BYOK），仅用户点击时调用，只生成受约束的中文叙述与既有行动（按 actionId）润色，服务端对合并草稿重新校验门禁，绝不允许 AI 修改 StrategyWindow/EvidenceSufficiency/DecisionGate/sourceEvidenceIds/正式计数/输入版本与 inputHash，或自动激活正式版本；AI overlay 结构化输出契约已由提交 `2038e54`/`6ba6c9d` 收口（strict object、拒绝未知/确定性字段、数组须为 JSON 数组、结构化输出失败最多自动修复一次、二次失败返回稳定错误码不保存半成品）。提案→审核（接受/修改后接受/拒绝/稍后处理）→正式版本流程与 G4 一致，AI 提案必须经用户人工接受才生成正式版本；相同 inputHash 复用既有开放提案、不重复调用模型，输入变化或窗口到期使旧提案失效且不可接受。用户已完成 AI 生成 → 提案审核 → 接受并激活 → 正式 V1、行动清单（目标数量/成功失败信号/停止条件/可逆性）、实验计划（简历 A/B、渠道 A/B）与版本历史的完整验收链路，待审核提案已清空；AI 提案以增加可靠样本、补充结果记录、城市/岗位族探索、简历与渠道 A/B、项目及面试证据优化为主，未输出直接降薪、搬迁、辞职、放弃方向、自动投递或 Offer 概率预测。schema v6 仅创建于隔离沙箱（`tmp/g5-sandbox`，从已验收 G4 v5 沙箱副本升级），真实数据库全程保持 schema v4 且哈希前后一致，G5 只写入 sandbox、不修改真实求职数据；已完成域/服务端/页面自动化测试（含 AI 修复与守卫，均使用 Fake Provider）、`migrations.selftest` v5→v6 扩展、router smoke 与沙箱浏览器验收；未在真实生产入口开启（`strategyWindow.enabled=false`）。

G3、G4、G5 均已签收，均不代表 v0.7 可以发布、合并 main、创建 Tag 或 Release。v0.7 仍禁止发布、禁止合并 main、禁止升级版本或创建 PR/Tag/Release、禁止开启正式 G4/G5、禁止升级真实数据库、禁止发布 Snapshot，App 版本继续保持 `0.6.2`；真实数据库继续保持 schema v4，真实生产入口不开启 G4/G5。下一阶段为 G6 **v0.7 最终验收、生产切换与发布裁决**，至少需裁决：真实数据库 schema v4→v6 的受控升级路径、G4/G5 生产入口开放、全链路回归与真实环境烟测、Snapshot 契约是否升级、v0.7 最终验收矩阵，以及是否允许合并 main / Tag / Release / push；G4/G5 生产切换与 Snapshot 契约升级均属于 G6 裁决范围，须由用户另行拍板。

G6-A（发布准备与生产迁移演练）**已于 2026-07-16 完成，等待用户裁决**：只操作真实库一致性副本，全程未修改真实数据库（`data/offerflow.sqlite3` schema 保持 v4，SHA-256 演练前后一致）。已实证：候选副本 v4→v5→v6 连续迁移，`integrity_check=ok`、`foreign_key_check=0`，G1~G3 关键表行数与内容 hash 保持、G4/G5 新表迁移后为空；从已验收 G5 沙箱（v6）导出**最小化正式版本晋升包**（仅 active G4/G5 版本及其 accepted 来源提案，排除 pending/rejected/deferred/命令回执/沙箱与浏览器残留/Job·Application·FeedbackEvent 副本），事务性导入候选库并校验 active G4/G5、`generationMode`/`decisionDiff`、G5→G4 引用正确，Job/Application/FeedbackEvent 行数不变，相同晋升包重复导入返回 `alreadyApplied`；回滚演练在一次性副本上实证——升级前 v4 备份可精确恢复（`schema=4`、hash 与真实基线一致、`integrity_check=ok`）；候选环境（`dev:g6-rehearsal`）只读烟测通过，只显示单条 G6 演练横幅。相关实现见 `server/release-promotion/`、`scripts/g6RehearsalPrepare.ts`、`scripts/devG6Rehearsal.ts`，材料见 `offerflow-v0.7-g6-release-readiness.md`、`offerflow-v0.7-final-acceptance-matrix.md`、`docs/decisions/offerflow-v0.7-snapshot-release-decision.md`、`docs/runbooks/offerflow-v0.7-production-{rollback,cutover}.md`。**G6 尚未验收；G6-A 完成不等于授权 G6-B；v0.7 仍不可发布，仍禁止合并 main / Tag / Release / push / 升级真实库 / 开启正式 G4·G5 / 发布 Snapshot。**
