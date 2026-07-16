# OfferFlow v0.7 PRD 追踪矩阵

- 日期：2026-07-14
- 上位契约：`docs/product/offerflow-v0.7-release-contract.md`
- 产品事实源：`docs/prd/offerflow-v0.7.md`
- 当前结论：v0.7 产品实施中，禁止发布；G1–G5 均已经用户验收，下一阶段 G6（v0.7 最终验收、生产切换与发布裁决）尚未开始

本矩阵用于证明“PRD 条款 → 用户产品结果 → 工程证据”的闭环。B0–B8 只映射可信求职记忆底座及其工程安全性；表中存在一个实现阶段或测试结果，不代表对应用户价值已经交付。

## 1. 产品结果追踪

| PRD 条款 | 产品结果 | 领域 | 页面 | API | 自动化测试 | 手工证据 | 实施阶段 | 状态 |
|---|---|---|---|---|---|---|---|---|
| §3.2、§14、§27 | 中文产品界面 | Presentation mapping | 岗位列表、岗位详情、求职流程、时间线、简历版本 | 沿用稳定英文 code 的现有查询 API | 穷尽映射 + 五类页面挂载测试 | 五张默认态截图 | R0 | 已实现，待用户验收 |
| §7.3、§23.1–23.2 | 同岗位多次独立求职流程 | Application | 求职流程 | Job Memory v2 application API | repository/service/API/组件测试 | 同岗位两条流程截图 | B0–B4 | 已实现 |
| §7.2、§23.3 | 简历版本与投递绑定 | ResumeVersion | 简历版本、求职流程 | resume-version API | hash、激活、归档、引用与并发测试 | 版本列表与流程引用截图 | B0–B4 | 已实现 |
| §7.4、§6.3 | 不可原地覆盖的反馈事实 | FeedbackEvent | 反馈事实时间线 | feedback-event / void API | 投影、幂等、作废、替代事件测试 | 时间线纠错截图 | B0–B5 | 已实现 |
| §19.2、§27“求职记忆” | 可信记忆生产启用与恢复 | Job Memory v2 / Snapshot v2 | 上述页面 | v2 bundle/summary + snapshot | migration、snapshot、恢复、真实数据只读验证 | B8 审计与恢复记录 | B6–B8 | 工程审计通过 |
| §6.5、§11 | 两层历史补录 | 历史基线 + 详细事件草稿 | 历史补录向导 | `server/history-import` | 最小补录、详细补录、回忆限制 | 补录预览与确认截图 | G3 | 已实现，已用户验收（真实库已升级至 v4，正式环境已开放，截图归档留待 G6） |
| §19.3、§27“历史与统计” | 基础漏斗与分组反馈 | Funnel aggregate | 基础漏斗/反馈概览 | `server/funnel` | 城市/岗位族/渠道/简历分组；零样本 | 漏斗与排除说明截图 | G3 | 已实现，已用户验收（基于真实数据验证，截图归档留待 G6） |
| §5.1、§7.5、§8.1 | 稳定能力证据与能力基线 | CandidateEvidence / CapabilityBaseline | 能力证据库、能力基线 | `server/capability-baseline` | 支撑/反证、版本、短期非回复不下调 | 截图归档留待 G6 | G2 | 已实现，已用户验收（截图归档留待 G6） |
| §5.2、§7.6、§10 | 四城市市场画像与三档岗位区间 | MarketPositionProfile | 市场位置画像（全局+苏州/无锡/上海/杭州+提案审核+版本历史） | `server/market-position` | 城市隔离（input-snapshot 计数、UI 独立展示）、Proposal/Review/版本流转、幂等与并发冲突、AI 生成提案（Fake Provider，≥16 服务端/域测试+≥10 页面测试） | G4 沙箱截图（归档留待 G6）；AI 生成提案沙箱浏览器验收（真实调用一次模型） | G4 | 已实现，已用户验收（2026-07-16，隔离沙箱 schema v5；截图归档留待 G6） |
| §6.2、§9 | 证据充分性与高影响结论门禁 | EvidenceSufficiency / DecisionGate | 市场位置画像充分性标注与决策门 | `server/market-position` | evidenceLevel 三档、7 类 DecisionGate、abandon_direction/relocation_decision 永不 decision_ready；AI 生成路径不可篡改上述计算结果（结构化输出校验+服务端重新合并） | G4 沙箱截图（归档留待 G6） | G4 | 已实现，已用户验收（2026-07-16，隔离沙箱 schema v5；截图归档留待 G6） |
| §12 | 可接受/修改/拒绝/稍后处理的提案审核 | Proposal Review | 求职策略（提案审核、版本历史） | `server/strategy-window` | 五态决议、幂等复用、stale 失效、窗口到期不可接受、edit-and-accept 重校验门禁、AI overlay 结构化输出守卫 | G5 沙箱浏览器验收（AI 生成→接受激活→正式 V1；截图归档留待 G6） | G5 | 已实现，已用户验收（2026-07-16，隔离沙箱 schema v6） |
| §5.3、§13 | 7–14 天阶段策略 | StrategyWindow | 求职策略（当前窗口、三类边界、策略总览、行动清单、实验计划） | `server/strategy-window` | 三档窗口映射、DecisionGate→动作门禁、分配比例合计 100、可逆性、单变量实验、无证据城市探索性、AI 不可篡改窗口/门禁/计数/inputHash | G5 沙箱浏览器验收（证据收集窗口、三类边界、行动清单、实验计划、版本历史；截图归档留待 G6） | G5 | 已实现，已用户验收（2026-07-16，隔离沙箱 schema v6） |
| §22、§25、§27、§29 | 产品级最终验收与发布 | Release evidence | 全部产品页 | 全部正式 API | 全量 Gate + 产品 Eval | 发布截图包与验收记录 | R5 | 未实现 |

## 2. B0–B8 边界映射

| 阶段 | 已完成事实 | 对产品结果的真实贡献 | 不得等同的结果 |
|---|---|---|---|
| B0 | Job Memory v2 领域与边界冻结 | 为可信记忆建立语义基础 | 不等于能力基线或城市画像 |
| B1 | schema/repository/投影基础 | 保存独立流程和事件事实 | 不等于历史补录产品或基础漏斗 |
| B2 | 服务端 API/capability | 提供可信记忆读写边界 | 不等于动态画像 API |
| B3 | ResumeVersion 页面/API | 固定投递所用简历证据 | 不等于 CandidateEvidence/CapabilityBaseline |
| B4 | Application 页面与摘要 | 表达同岗位多次独立流程 | 不等于城市市场样本充分性 |
| B5 | FeedbackEvent 时间线与纠错 | 提供未来统计可追溯事实 | 不等于市场结论或阶段策略 |
| B6 | 决策输入切换到流程投影 | 避免 Job 旧状态覆盖可信事实 | 不等于 Proposal Review |
| B7 | 真实数据保守升级与 Snapshot v2 | 让可信记忆底座可在生产默认启用 | 不等于 v0.7 产品完整上线 |
| B8 | 工程审计、恢复演练、只读复核 | 证明 B 底座可恢复且未污染真实数据 | 不等于产品发布验收或 Release Candidate |

## 3. 固定后续阶段

| 阶段 | 冻结目标 | 完成定义 |
|---|---|---|
| R1 | 历史补录与基础漏斗 | 用户能完成两层补录；基础统计遵守未投递、回忆数据、同源去重与分组边界。 |
| R2 | CandidateEvidence 与 CapabilityBaseline | 稳定能力事实版本化；支持证据、反证、未验证项和用户决议均可追溯。 |
| R3 | MarketPositionProfile 与 EvidenceSufficiency | 四城独立画像、三档岗位区间和多维充分性门禁可验收。 |
| R4 | Proposal Review 与 StrategyWindow | 7–14 天策略仅经用户决议成为正式策略，并具备冷却/失效/反骚扰。 |
| R5 | 最终产品验收与发布准备 | 七项发布契约全部签收，测试和截图证据齐全，才可另行申请发布授权。 |

## 4. 范围变更追踪规则

任何条目被删除、降级、替代或延后，必须新增一条范围变更记录，字段不得少于：

| 批准人/指令 | 批准日期 | 原 PRD 条款 | 原结果摘要 | 新结果/阶段 | 原因与影响 | 页面/API/测试变化 | 发布结论变化 |
|---|---|---|---|---|---|---|---|
| 尚无 | — | — | — | — | — | — | — |

没有用户明确批准与日期的变更无效。工程实现困难、某个技术切片通过、测试全绿或排期建议均不能自动改写本矩阵。

## 5. 阶段验收记录

本节记录用户对已交付阶段的验收事实，不改写第 1 节产品结果状态，也不改变发布结论。

| 阶段 | 验收人 | 验收日期 | 验收内容 | 覆盖的矩阵条目 | 发布结论变化 | 下一阶段 |
|---|---|---|---|---|---|---|
| G1 全局岗位匹配画像 MVP | 用户 | 2026-07-15 | 全局画像 + 苏州/无锡/上海/杭州四城市视图共五视图，与提案审核（手工提案、AI 提案、接受、修改后接受、拒绝、稍后处理、正式版本与版本历史）全部通过；未发现阻塞下一阶段的问题。 | 仅覆盖 §5.2/§10 城市市场画像（R3 条目）的用户可见 MVP 子集；正式 MarketPositionProfile 与 EvidenceSufficiency 仍属 R3，未验收。 | 无变化，v0.7 仍禁止发布、禁止合并 main、禁止升级版本 | G2（CandidateEvidence 与 CapabilityBaseline，对应 R2） |
| G2 CandidateEvidence 与 CapabilityBaseline | 用户 | 2026-07-15 | 候选能力证据审核、正式证据库、AI/手工能力基线提案、无正式证据时阻止生成基线、支持证据/反证/待验证项同时保留、接受/修改后接受/拒绝/稍后处理、能力基线版本历史与版本激活均已验收；截图归档留待 G6；未发现阻塞 G3 的问题。 | 覆盖 §5.1/§7.5/§8.1 长期能力基线（R2 条目）的完整产品行为；R3–R5 及 2.1/2.3/2.5/2.6/2.7 仍未完成。 | 无变化，v0.7 仍禁止发布、禁止合并 main、禁止升级版本 | G3（历史补录与基础漏斗） |
| G3 历史补录与基础漏斗 | 用户 | 2026-07-15 | 真实数据库已受控升级到 schema v4（备份、指纹、完整性、行数校验均通过）；历史补录已在正式环境（非 sandbox）开放，导航与页面可直接进入；基础漏斗已基于真实数据验证（已投递=9，与升级前一致，分组口径符合预期）；空 draft 会话（0 条基线草稿）此前无法在 UI 丢弃的缺口已由提交 `bff0043` 补齐，并在正式环境完成浏览器验证。 | 覆盖 §6.5/§11/§19.3/§27“历史与统计”两层历史补录与基础漏斗（R1 条目）的完整产品行为；R3–R5 及 2.1/2.4/2.5/2.6/2.7 仍未完成。 | 无变化，v0.7 仍禁止发布、禁止合并 main、禁止升级版本；G3 签收不代表可发布、合并 main、创建 Tag 或 Release | G4（MarketPositionProfile 与 EvidenceSufficiency，对应 R3） |
| G4 MarketPositionProfile 与 EvidenceSufficiency | 用户 | 2026-07-16 | **验收环境：G4 隔离沙箱（schema v5，`tmp/g4-sandbox`，独立于真实数据库）**。领域模型（全局+四城独立画像、EvidenceSufficiency 三档、7 类 DecisionGate）、schema v5（仅隔离沙箱，真实库保持 v4）、server 服务层（Proposal→Review→正式版本、幂等/并发/NO_EFFECTIVE_CHANGE 守卫）、前端页面（全局+四城 Tab+提案审核+版本历史）均已用户人工验收；HTTP 路由测试、页面组件测试、`migrations.selftest` v5 扩展、沙箱浏览器验证（建立提案→接受并激活→四城市证据等级独立展示）均已通过；EvidenceSufficiency 与 DecisionGate 由确定性规则锁定，AI 仅生成受约束叙事，不可篡改上述计算结果；真实生产入口默认不开启（`marketPosition.enabled=false`）。**AI 生成提案路径同样已验收**：`POST /market-position/proposals/generate`，复用 G1/G2 既有共享 LLM Provider（无新 Provider/API Key 页/BYOK），仅用户主动点击时调用；确定性计算先行、AI 仅润色中文叙述、结构化输出校验失败最多修复一次、二次失败返回稳定错误码；相同输入哈希已有未处理提案时直接复用（`reused: true`），不重复调用模型；提案元数据记录于既有 v5 payload（无新 schema v6）；≥16 服务端/域测试与 ≥10 页面测试均使用 Fake Provider；用户浏览器验收中 AI 市场位置提案真实生成成功（真实调用一次 DeepSeek 模型），其 EvidenceSufficiency/DecisionGate 与确定性计算一致，四城市叙述含上海无数据固定文案，幂等重复请求复用既有提案，拒绝流程正常，真实数据库哈希前后一致；用户已完成 AI proposal → 接受并激活 → 正式 V1 可见的完整验收链路。G4 sandbox 前后端生命周期联动与连接失败提示已由提交 `51bb7f1` 补齐。未在真实生产入口开启。 | 覆盖 §5.2/§6.4/§7.6/§10、§6.2/§9（R3 条目对应 2.5/2.6）的完整产品行为；R4–R5 及 2.1/2.4/2.7 仍未完成。 | 无变化，v0.7 仍禁止发布、禁止合并 main、禁止升级版本、禁止创建 PR/Tag/Release；G4 签收不代表可发布、合并 main、创建 Tag 或 Release；真实数据库仍为 schema v4，真实生产环境仍未开启 G4；G4 生产切换属于后续独立的受控数据库升级与发布任务 | G5（StrategyWindow 与正式策略 Proposal Review，对应 R4） |
| G5 StrategyWindow 与正式策略 Proposal Review | 用户 | 2026-07-16 | **验收环境：G5 隔离沙箱（schema v6，`tmp/g5-sandbox`，从已验收 G4 v5 沙箱副本升级，独立于真实数据库）**。当前 StrategyWindow 正确显示为“证据收集窗口”；三类边界（现在可以做 / 只能观察或实验 / 当前不能做）正确展示；StrategyWindow 三档规则（evidence_collection / controlled_experiment / limited_optimization）由确定性规则从 G4 active 市场位置版本的 evidenceLevel/DecisionGate 生成，DecisionGate→策略动作的确定性映射已验收；AI 成功生成受约束求职策略提案（以增加可靠样本、补充结果记录、城市/岗位族探索、简历与渠道 A/B、项目及面试证据优化为主，未输出直接降薪/搬迁/辞职/放弃方向/自动投递/Offer 概率预测），结构化输出经修复后成功创建 pending proposal；AI 只生成受约束叙事，不能修改 StrategyWindow/EvidenceSufficiency/DecisionGate/sourceEvidenceIds/正式计数/输入版本与 inputHash；AI 提案必须经用户人工接受才生成正式版本，用户已完成 AI 生成 → 提案审核 → 接受并激活 → 正式 V1、行动清单（目标数量/成功失败信号/停止条件/可逆性）、实验计划（简历 A/B、渠道 A/B）、版本历史，待审核提案已清空；相同输入复用已有开放提案、不重复调用模型；AI overlay 结构化输出契约已由提交 `2038e54`/`6ba6c9d` 收口；域/服务端/页面测试（含 AI 修复与守卫，均 Fake Provider）、`migrations.selftest` v5→v6、router smoke 均通过；G5 只写入 sandbox，真实数据库未升级、未修改，哈希前后一致；不会自动执行投递/联系/降薪/迁移/放弃方向；未在真实生产入口开启（`strategyWindow.enabled=false`）。 | 覆盖 §5.3/§12/§13（R4 条目对应 2.7）阶段策略与 Proposal Review 的完整产品行为；R5 及 2.1/2.4 仍未完成。 | 无变化，v0.7 仍禁止发布、禁止合并 main、禁止升级版本、禁止创建 PR/Tag/Release、禁止开启正式 G4/G5、禁止升级真实数据库、禁止发布 Snapshot；G5 签收不代表可发布 | G6（v0.7 最终验收、生产切换与发布裁决）；**G6 尚未开始** |

G1、G2、G3、G4、G5 验收均已将各自覆盖的矩阵条目标记为”已实现，已用户验收”；第 1 节 R3 对应条目已随 G4 验收更新、R4 对应条目已随本次 G5 验收更新。R5（产品级最终验收与发布）与 2.1（中文产品界面待用户验收）仍未完成并继续阻塞发布。G5 详见 `docs/product/offerflow-v0.7-g5-strategy-window.md` 与 `docs/handoffs/offerflow-v0.7-stage-handoff-2026-07-16-g5.md`。下一阶段 G6 **v0.7 最终验收、生产切换与发布裁决** 尚未开始，至少需裁决真实库 schema v4→v6 受控升级、G4/G5 生产入口开放、全链路回归与真实环境烟测、Snapshot 契约是否升级、v0.7 最终验收矩阵，以及是否允许合并 main / Tag / Release / push。

## 6. Snapshot 契约现状（2026-07-15 补充）

当前 Snapshot 契约（`server/sync/exportSnapshot.ts`、`SNAPSHOT_SCHEMA_VERSION`）仍为 Job Memory v2 设计，只支持 database schema 2；真实库当前 schema=4，导出会被直接拒绝。Snapshot v4（面向 schema v4 的导出/恢复契约升级，涵盖历史补录新表）是独立的“Snapshot 契约升级与恢复设计”基础设施任务，不是 G3 遗留缺陷，不构成 G3 验收阻塞，也不阻塞 G4 开始；但在 v0.7 最终发布前，必须由用户另行裁决其范围。禁止通过直接修改 `SNAPSHOT_SCHEMA_VERSION` 常量冒充已支持 schema v4。
