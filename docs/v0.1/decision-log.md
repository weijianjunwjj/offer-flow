# OfferPilot / 求职作战台 v0.1 决策日志

## 1. 文档用途

本文档用于记录 OfferPilot v0.1 开发前与开发中的重要决策。

任何 AI 或开发者进入本项目时，必须阅读本文档，了解：

1. 哪些决策已经拍板
2. 谁提出了该决策
3. 谁参与了讨论
4. 谁最终拍板
5. 为什么这么决定
6. 哪些方案被否决
7. 该决策是否可以被重新打开

本文档是项目决策的唯一事实来源。

如果聊天上下文、AI 记忆、临时建议与本文档冲突，以本文档为准。

---

## 2. 决策状态说明

每条决策必须标注状态。

状态枚举：

- 已拍板：当前有效，不得随意推翻
- 可复审：后续可以在满足条件时重新讨论
- 已废弃：该决策被后续决策替代
- 待定：尚未最终拍板

---

## 3. 决策记录模板

### DEC-XXX：决策标题

- 日期：
- 状态：
- 提出者：
- 参与讨论：
- 拍板者：
- 背景：
- 决策：
- 理由：
- 被否决方案：
- 影响范围：
- 后续复审条件：
- 相关文档：

---

# 4. 已拍板决策

## DEC-001：v0.1 采用 Manual Mode，不接 API

- 日期：2026-06-11
- 状态：已拍板
- 提出者：GPT
- 参与讨论：用户、GPT、Gemini、Claude.ai
- 拍板者：用户
- 背景：
  - 用户希望做一个能帮助自己使用 Boss 直聘找工作的工具。
  - 初始方向曾考虑 AI 求职工具，但用户明确质疑：不接 API 是否还有智能分析能力。
  - 经过讨论后确认，不接 API 的版本不能宣称自动智能分析。
- 决策：
  - v0.1 采用 Manual Mode。
  - 工具不直接调用 OpenAI / Claude / Gemini API。
  - 工具负责生成 Prompt、承接外部 AI 返回结果、沉淀岗位台账。
- 理由：
  1. 降低开发成本
  2. 避免 API Key 安全问题
  3. 避免后端、限流、费用、防滥用等复杂问题
  4. 优先验证求职工作流价值，而不是模型接入能力
- 被否决方案：
  1. v0.1 直接 BYOK
  2. v0.1 自己后端代理 API
  3. v0.1 做完整 AI 自动分析器
- 影响范围：
  - 所有 v0.1 功能都必须围绕 Manual Mode 设计。
  - 所有文案不得误导用户以为工具会自动 AI 分析。
- 后续复审条件：
  - v0.1 自用完成至少 10 个岗位分析后，可复审 v0.1.5 Personal BYOK。
- 相关文档：
  - README.md
  - docs/v0.1/product.md
  - docs/v0.1/dev-plan.md

---

## DEC-002：v0.1 只服务 Boss 直聘前端求职场景，不做泛求职平台

- 日期：2026-06-11
- 状态：已拍板
- 提出者：GPT
- 参与讨论：用户、GPT、Gemini、Claude.ai
- 拍板者：用户
- 背景：
  - 曾出现另一个版本文档，将目标用户扩展为前端 / 后端 / 产品 / 运营等泛求职者。
  - GPT 判断该方向会导致 v0.1 范围膨胀。
- 决策：
  - v0.1 第一目标用户锁定为正在用 Boss 直聘找工作的前端开发者。
  - 不做泛行业、泛职业、泛平台求职系统。
- 理由：
  1. 用户本人就是前端求职者，最懂该场景
  2. Boss 直聘是聊天式求职，Boss 打招呼话术是高价值动作
  3. 聚焦窄场景更容易 5-7 天落地
  4. 避免 v0.1 变成大而全台账系统
- 被否决方案：
  1. 泛求职台账系统
  2. 支持前端 / 后端 / 产品 / 运营等全职业求职
  3. 支持所有招聘平台
- 影响范围：
  - 文案应围绕 Boss 直聘、前端岗位、简历-JD 匹配、打招呼话术。
  - 状态字段使用 Boss 聊天语境，而不是传统投递系统语境。
- 后续复审条件：
  - v0.1 跑通后，如有外部用户反馈，再考虑扩展目标人群。
- 相关文档：
  - docs/v0.1/product.md
  - docs/v0.1/task-cards.md

---

## DEC-003：沟通状态采用 Boss 聊天语境

- 日期：2026-06-11
- 状态：已拍板
- 提出者：GPT
- 参与讨论：用户、GPT
- 拍板者：用户
- 背景：
  - 另一个文档版本曾使用“待分析、待投递、已投递、已沟通、面试中、已收藏”等状态。
  - GPT 判断这套状态偏传统投递系统，不贴 Boss 直聘聊天场景。
- 决策：
  - v0.1 沟通状态采用：
    1. 未沟通
    2. 已打招呼
    3. 已回复
    4. 已约面
    5. 已拒绝
    6. 已结束
- 理由：
  1. Boss 直聘是聊天式求职
  2. “已打招呼”比“已投递”更贴真实动作
  3. 状态数量少，用户理解成本低
  4. 不需要状态日志系统
- 被否决方案：
  1. 待分析
  2. 待投递
  3. 已投递
  4. 面试中
  5. 已收藏
  6. 状态日志系统
- 影响范围：
  - JobRecord 中只保留当前沟通状态和状态更新时间。
  - 不做状态历史，不做状态日志。
- 后续复审条件：
  - v0.1 自用后发现状态不够，再考虑扩展。
- 相关文档：
  - docs/v0.1/product.md
  - docs/v0.1/dev-plan.md
  - AGENTS.md

---

## DEC-004：v0.1 不引入 PromptRecord / AIAnalysisResult / JobStatusLog 独立实体

- 日期：2026-06-11
- 状态：已拍板
- 提出者：GPT
- 参与讨论：用户、GPT
- 拍板者：用户
- 背景：
  - 另一个文档版本建议定义 UserProfile、JobRecord、PromptRecord、AIAnalysisResult、JobStatusLog。
  - GPT 判断这会让 Step 0 从存储底座膨胀为小型业务系统。
- 决策：
  - v0.1 只需要：
    1. 全局配置
    2. 岗位记录
    3. AI 原文
    4. 报告字段
    5. Boss 话术字段
    6. 沟通状态
  - 不拆 PromptRecord、AIAnalysisResult、JobStatusLog 独立实体。
- 理由：
  1. v0.1 目标是快速跑通工作流
  2. 独立实体会增加存储和状态管理复杂度
  3. Prompt 可按需重生成，不必独立建表
  4. AI 结果原文与报告可作为 JobRecord 的一部分
  5. 沟通状态只保留当前状态，不做日志
- 被否决方案：
  1. PromptRecord 独立实体
  2. AIAnalysisResult 独立实体
  3. JobStatusLog 独立实体
- 影响范围：
  - Step 0 存储层必须保持轻量。
  - 如候选代码中出现上述实体，需审查是否越界。
- 后续复审条件：
  - v0.2 做正式 AI Adapter 或多次分析历史时，可重新讨论。
- 相关文档：
  - docs/v0.1/dev-plan.md
  - CLAUDE.md
  - AGENTS.md

---

## DEC-005：Claude.ai 已产出的 Step 0 可以使用，但必须进入本地仓库验证

- 日期：2026-06-11
- 状态：已拍板
- 提出者：用户
- 参与讨论：用户、GPT、Claude.ai
- 拍板者：用户
- 背景：
  - Claude.ai 已经产出 Step 0 存储层候选代码，并声称自测 30 项断言通过、typecheck 通过。
  - 但当时本地仓库尚未正式初始化，代码不在正式项目上下文中。
- 决策：
  - Claude.ai 产出的 Step 0 可以使用。
  - 但不得盲用，必须由 CC 导入正式仓库、跑 selftest 和 typecheck，再由 Codex 审查。
- 理由：
  1. 代码已有价值，不必浪费
  2. 但正式仓库才是项目事实来源
  3. 必须确认没有越界
  4. 必须确认与文档一致
- 被否决方案：
  1. 完全弃用 Claude.ai 的 Step 0
  2. 原封不动盲用，不审查
  3. 继续让 Claude.ai 绕过仓库开发 Step 1
- 影响范围：
  - Task 0 的核心工作是初始化仓库 + 导入 Step 0 + 验证。
- 后续复审条件：
  - 如果 CC / Codex 发现 Step 0 代码越界或质量问题，可局部重写。
- 相关文档：
  - docs/v0.1/task-cards.md
  - docs/v0.1/acceptance.md
  - docs/v0.1/progress.md

---

## DEC-006：采用多 AI 分工协作，但以 docs 和任务卡为唯一准绳

- 日期：2026-06-11
- 状态：已拍板
- 提出者：用户
- 参与讨论：用户、GPT
- 拍板者：用户
- 背景：
  - 项目将同时使用 GPT、Claude.ai、CC、Codex。
  - 用户担心 AI 上下文断裂、token 不够、多人协作混乱。
- 决策：
  - 建立多 AI 职责分工：
    1. GPT：产品经理 / 需求负责人 / 边界裁判
    2. Claude.ai：首席架构师 / 技术顾问 / 文档顾问
    3. CC：仓库主控 / 架构守门 / 集成者 / 主执行者
    4. Codex：任务卡执行者 / 代码审查员 / 接力开发者
  - 所有 AI 必须先读 docs。
  - 所有开发必须按任务卡执行。
- 理由：
  1. 避免多头指挥
  2. 避免聊天上下文断裂
  3. 让 Codex 后续能接手
  4. 保持项目可审查、可交接
- 被否决方案：
  1. 让 Claude.ai 继续直接开发全部功能
  2. 让 CC 和 Codex 同时改同一批文件
  3. 让任意 AI 凭聊天上下文即兴开发
- 影响范围：
  - 新增 CLAUDE.md
  - 新增 AGENTS.md
  - 新增 docs/v0.1/roles-and-workflow.md
  - 新增 docs/v0.1/progress.md
  - 新增 docs/v0.1/decision-log.md
- 后续复审条件：
  - 如果某个 AI 工具明显不适合当前职责，可调整分工，但必须记录新决策。
- 相关文档：
  - CLAUDE.md
  - AGENTS.md
  - docs/v0.1/roles-and-workflow.md

---

## DEC-007：采用分域唯一信源，而不是单一 SPEC.md

- 日期：2026-06-11
- 状态：已拍板
- 提出者：用户 / GPT
- 参与讨论：用户、GPT
- 拍板者：用户
- 背景：
  - 用户参考 activity-config-miniapp 的 AI 协作经验，提出要吸收“唯一信源、handoff、决策日志、provenance、决策阈值”等治理思想。
  - OfferPilot 已经有多份 v0.1 文档，不适合再强行合并成一个 SPEC.md。
- 决策：
  - 不新增 SPEC.md。
  - 采用“分域唯一信源”：
    1. 产品事实源：docs/v0.1/product.md
    2. 开发任务源：docs/v0.1/task-cards.md
    3. 验收事实源：docs/v0.1/acceptance.md
    4. 进度事实源：docs/v0.1/progress.md
    5. 决策事实源：docs/v0.1/decision-log.md
    6. 协作规则源：docs/v0.1/roles-and-workflow.md
- 理由：
  1. 保留现有文档体系
  2. 避免一个大文档过重
  3. 每份文档职责清晰
  4. 更适合多 AI 协作接力
- 被否决方案：
  1. 新增 SPEC.md 并迁移所有事实
  2. 把所有规则都塞进 README
  3. 多份文档重复同一事实
- 影响范围：
  - CLAUDE.md、AGENTS.md、roles-and-workflow.md 必须说明分域唯一信源。
  - 如果文档冲突，AI 必须报告，不能自行猜测。
- 后续复审条件：
  - v0.2 文档体系明显失控时，可重新讨论是否引入 SPEC。
- 相关文档：
  - CLAUDE.md
  - AGENTS.md
  - docs/v0.1/roles-and-workflow.md

---

## DEC-008：开工必读 progress，收工必更 progress

- 日期：2026-06-11
- 状态：已拍板
- 提出者：用户 / GPT
- 参与讨论：用户、GPT
- 拍板者：用户
- 背景：
  - 多 AI 协作存在跨会话失忆问题。
  - 用户明确要求有文档记录开发进度，让任何 AI 都知道到了哪一步。
- 决策：
  - docs/v0.1/progress.md 作为项目 handoff 文档。
  - 任何 AI 开始任务前必须阅读 progress.md。
  - 任何任务完成后必须更新 progress.md。
  - 没有更新 progress.md，视为交付不完整。
- 理由：
  1. 对抗 AI 长期记忆缺失
  2. 避免重复开发
  3. 让 Codex / CC 可接力
  4. 保持进度事实可追溯
- 被否决方案：
  1. 只靠聊天上下文记录进度
  2. 只靠 git commit 记录进度
  3. 只在用户口头说明进度
- 影响范围：
  - CLAUDE.md 和 AGENTS.md 必须要求任务完成后更新 progress.md。
- 后续复审条件：
  - 如接入自动 issue / project board，可复审 progress.md 的粒度。
- 相关文档：
  - docs/v0.1/progress.md
  - docs/v0.1/roles-and-workflow.md

---

## DEC-009：决策与实现必须同 commit

- 日期：2026-06-11
- 状态：已拍板
- 提出者：GPT
- 参与讨论：用户、GPT
- 拍板者：用户
- 背景：
  - 用户希望详细记录开发前 / 开发中的重要决策，包括提出者、拍板者等信息。
  - 多 AI 协作中，如果先实现后补文档，很容易出现文档债和上下文断裂。
- 决策：
  - 任何带决策性质的改动，必须在同一个 commit 中更新 decision-log.md 或 progress.md。
  - 不允许先改代码、后补文档。
- 理由：
  1. 保证“为什么这么做”和“改了什么”在 git 历史中对齐
  2. 避免文档债
  3. 方便后续 AI 接手
  4. 方便复盘项目演进
- 被否决方案：
  1. 先实现，最后统一补文档
  2. 只在聊天记录里保留决策
  3. 让 AI 自己根据代码猜测决策原因
- 影响范围：
  - 改产品边界、数据结构、状态字段、存储策略、AI 分工时必须同步更新 decision-log.md。
  - 完成任务或进入下一步时必须同步更新 progress.md。
- 后续复审条件：
  - 暂无。
- 相关文档：
  - CLAUDE.md
  - AGENTS.md
  - docs/v0.1/roles-and-workflow.md

---

## DEC-010：AI 必须遵守决策权阈值与暂停清单

- 日期：2026-06-11
- 状态：已拍板
- 提出者：GPT
- 参与讨论：用户、GPT
- 拍板者：用户
- 背景：
  - AI 有两类风险：自作主张越界，或者小事频繁打断用户。
  - 需要明确哪些事可以自主处理，哪些事必须暂停问用户。
- 决策：
  - CLAUDE.md、AGENTS.md、roles-and-workflow.md 必须包含决策权阈值与暂停清单。
  - 置信度低于 80% 时必须暂停询问用户。
  - 重大争议必须输出一次性决策简报。
- 理由：
  1. 降低 AI 越界风险
  2. 降低无效打扰
  3. 让 AI 行为可预测
  4. 保持产品边界稳定
- 被否决方案：
  1. AI 自行判断所有事情
  2. AI 任何小事都问用户
  3. AI 碰到争议反复碎片化提问
- 影响范围：
  - 所有 AI 执行任务时必须遵守暂停清单。
- 后续复审条件：
  - 如果后续发现暂停清单过严或过松，可以新增决策调整。
- 相关文档：
  - CLAUDE.md
  - AGENTS.md
  - docs/v0.1/roles-and-workflow.md

---

## DEC-011：所有 commit message 必须使用中文描述

- 日期：2026-06-11
- 状态：已拍板
- 提出者：用户
- 参与讨论：用户、GPT
- 拍板者：用户
- 背景：用户希望项目提交历史保持中文可读，方便自己和后续 AI 理解。
- 决策：所有 commit message 必须使用中文描述，英文技术名词可保留。
- 理由：提高 git 历史可读性，方便用户复盘，也方便多 AI 接力时理解变更意图。
- 被否决方案：
  1. 全英文 commit message
  2. 中英混乱无规则
- 影响范围：
  - 所有后续 commit message
  - AI 建议 commit message
  - 审查输出
- 后续复审条件：暂无。
- 相关文档：
  - CLAUDE.md
  - AGENTS.md
  - docs/v0.1/roles-and-workflow.md

---

## DEC-012：Task 0 采用 Vue 3 + Vite + TypeScript 工具链并引入自测依赖

- 日期：2026-06-11
- 状态：已拍板
- 提出者：CC
- 参与讨论：CC、Codex、用户
- 拍板者：用户
- 背景：
  - Task 0 需要初始化 OfferPilot v0.1 的前端工程骨架。
  - v0.1 已确认技术方向为 Vue 3 + Vite + TypeScript。
  - Step 0 storage 需要在本地运行 typecheck 和 selftest。
  - Codex 审查指出：首次引入 Vue、Vite、TypeScript、tsx、vue-tsc 等依赖，按 AGENTS.md / CLAUDE.md 规则，属于需要记录的依赖引入决策。
- 决策：
  - Task 0 采用 Vue 3 + Vite + TypeScript 作为前端工程基础。
  - 引入 `vue` 作为运行时依赖。
  - 引入 `vite`、`typescript`、`vue-tsc`、`@vitejs/plugin-vue` 作为开发与类型检查依赖。
  - 引入 `tsx`、`@types/node` 用于运行并类型校验 `scripts/storage.selftest.ts`。
  - 暂不引入路由、状态管理库、UI 组件库、测试框架、后端依赖、AI API SDK。
- 理由：
  1. Vue 3 + Vite + TypeScript 与既定技术方向一致
  2. `vue-tsc` 可以校验 Vue + TypeScript 类型
  3. `tsx` 能以较低成本运行 TypeScript selftest
  4. 当前只需验证 storage 层，不需要完整测试框架
  5. 避免 Task 0 过度引入依赖
- 被否决方案：
  - 无明确讨论记录
- 影响范围：
  - `package.json`
  - `package-lock.json`
  - `tsconfig.json`
  - `vite.config.ts`
  - `scripts/storage.selftest.ts`
  - 后续 Task 1 可以基于 Vue 3 + Vite + TypeScript 开发页面
- 后续复审条件：
  - 进入组件化页面开发后，可复审是否引入 UI 组件库
  - 进入复杂页面状态管理后，可复审是否引入 Pinia
  - 进入正式测试体系后，可复审是否引入 Vitest
- 相关文档：
  - README.md
  - docs/v0.1/product.md
  - docs/v0.1/dev-plan.md
  - docs/v0.1/task-cards.md
  - docs/v0.1/progress.md

---

## DEC-013：Codex 默认采用“审查 + 低风险小修”模式

- 日期：2026-06-11
- 状态：已拍板
- 提出者：用户
- 参与讨论：用户、GPT、Codex
- 拍板者：用户
- 背景：
  - Task 0 审查中，Codex 发现 progress.md / decision-log.md 文档同步问题。
  - 如果每个低风险问题都由用户转给 CC，再由 CC 修改，会造成无效传话和多轮返工。
  - 用户明确希望 Codex 遇到低风险文档同步问题时可以直接修复。
- 决策：
  - Codex 默认采用“审查 + 低风险小修”模式。
  - typo、路径引用、progress.md、decision-log.md、commit message、文档同步问题可以直接修复。
  - 产品边界、数据模型、状态枚举、新依赖、大重构、删除文件、置信度低于 80% 时必须暂停并询问用户。
- 理由：
  1. 减少用户在 CC 与 Codex 之间传话
  2. 提高审查闭环效率
  3. 保留关键决策的人类拍板权
  4. 让 Codex 成为“会拿螺丝刀的验房师”，而不是只报告问题
- 被否决方案：
  1. Codex 永远只读审查，不允许修复
  2. Codex 发现任何问题都转回 CC
  3. Codex 可以无限制修改所有问题
- 影响范围：
  - AGENTS.md
  - docs/v0.1/roles-and-workflow.md
  - 后续所有 Codex 审查流程
- 后续复审条件：
  - 如果 Codex 小修越界，或误改产品边界，可收紧该模式
- 相关文档：
  - AGENTS.md
  - docs/v0.1/roles-and-workflow.md
  - docs/v0.1/progress.md

---

# 5. 待定决策

暂无。

---

# 6. 待复审决策

暂无。

---

# 7. 已废弃决策

暂无。

---

# 8. 决策更新规则

任何以下情况都必须更新本文档：

1. 改变 v0.1 范围
2. 增减 P0 功能
3. 改变技术栈
4. 改变 AI 分工
5. 启用或弃用某个候选实现
6. 调整状态字段
7. 引入新实体
8. 进入 v0.1.5 / v0.2
9. 推翻此前任何决策

每次新增决策必须包含：

1. 日期
2. 状态
3. 提出者
4. 参与讨论者
5. 拍板者
6. 背景
7. 决策
8. 理由
9. 被否决方案
10. 影响范围
11. 复审条件
12. 相关文档

---

# 9. 决策原则

优先选择：

1. 更贴近 v0.1 P0 的方案
2. 更贴近 Boss 直聘前端求职场景的方案
3. 更少引入复杂度的方案
4. 更容易 5-7 天落地的方案
5. 更容易被 CC / Codex 接手的方案
6. 更容易被用户自己真实使用的方案

拒绝：

1. 大而全
2. 泛化过早
3. 技术炫技
4. AI 自动化幻觉
5. 未验证需求先做复杂系统
