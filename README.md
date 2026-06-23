# OfferFlow / Offer来了

Offer来了（OfferFlow）是面向 Boss 直聘求职场景的本地优先 AI 求职手账。

它不接 API，不做自动投递，不做爬虫，不做后端。它帮助求职者把“看岗位、补充公司与机会信息、生成一次性分析 Prompt、承接外部 AI 结果、自动解析机会雷达、维护跟进事实、派生下一步动作、复制推荐话术、保存岗位台账”整理成一条稳定流程。

当前版本：**v0.3.0 · Semi-manual Follow-up Decision Desk / 半自动求职跟进决策台**。

## 项目定位

OfferFlow 不是 AI 自动分析器，而是：

> 本地优先的 AI 求职工作流容器 + 机会决策工作台。

真正的模型推理由用户自带的外部 AI（ChatGPT / Claude / Gemini）完成。工具负责输入标准化、One-Shot Prompt 生成、结果承接与解析、台账沉淀与机会可视化。

## 当前模式：Manual / Semi-manual Mode（不接 AI API）

- 工具本身**不接入** OpenAI / Claude / Gemini 等任何 AI API，也**不做 BYOK、不做后端、不爬 Boss、不联网查公司**。
- 分析能力来自你自己选择的外部 AI：工具生成一份 One-Shot Prompt，你**复制一次**给外部 AI，再把返回的完整内容**粘贴回工具一次**。
- v0.2.0 相比 v0.1 的关键变化：Prompt 要求外部 AI 在报告末尾附带一段固定的 `OFFER_FLOW_JSON` 数据块；工具会**尽力解析**它，自动生成机会雷达。这仍然是手动复制粘贴，不是自动调用 AI。
- v0.3.0 在机会雷达之上增加半自动跟进决策：用户手动维护沟通与跟进事实，工具通过纯函数实时派生策略建议、下一步动作、推荐话术场景、止损判断和同公司只读预警。
- 解析失败、未找到 JSON、字段不完整都不会阻断保存，也不会清空已有数据（原文永远优先落盘）。

## 核心闭环

```
简历/偏好配置  →  录入岗位 JD + 公司与机会补充  →  生成 One-Shot Prompt  →  复制给外部 AI
      →  把 AI 完整结果（Markdown + OFFER_FLOW_JSON）粘贴回岗位  →  自动解析机会雷达 / 公司画像 / 话术
      →  维护 8 态沟通状态与跟进事实  →  派生策略建议 / 下一步动作 / 推荐话术 / 止损判断
      →  在详情页和列表决策台筛选排序，回看完整岗位
```

## v0.3.0 新增能力

1. **8 态沟通状态**：`communicationStatus` 替换旧 `contactStatus`，覆盖未沟通、已打招呼（未读）、已读未回、已回复、面试推进中、暂停观察、已结束、已拒绝。
2. **跟进事实字段**：新增并只保存 `lastGreetedAt`、`followupCount`、`lastFollowupAt`、`lastCommunicationNote`、`highValueSignal`、`strategyOverride`、`draftMessageText`。
3. **只存事实，不存决策**：`strategy`、`nextAction`、`stopLoss`、`scenario`、`companyWarning` 均实时派生，不写入 `JobRecord` 或 localStorage。
4. **决策纯函数**：`deriveDecision(record, allJobs?)` 派生策略建议、下一步动作、止损判断、话术场景和公司级只读预警。
5. **详情页跟进决策面板**：展示派生结果，允许维护影响决策的事实字段，刷新后重新计算。
6. **推荐话术模板与复制**：覆盖 6 类 `MessageScenario`，支持安全变量填充、一键复制、填入草稿和保存草稿。
7. **列表页决策台模式**：列表行展示策略 / 下一步动作 / 止损提示，支持待打招呼、可跟进、待止损、等回复筛选和决策优先级排序。
8. **公司级只读预警**：仅从现有 `JobRecord[]` 派生同公司预警，不新增 Company 实体，不写入公司聚合数据。

## v0.2.0 新增能力

1. **公司与机会补充**：公司规模、人员规模、公司类型、融资阶段、通勤时间/方式、公司备注、机会备注，随岗位保存。
2. **One-Shot Prompt**：把简历/偏好、岗位、公司补充一次性拼成 Prompt，要求外部 AI 输出 Markdown 报告 + 固定 `OFFER_FLOW_JSON` 数据块。
3. **OFFER_FLOW_JSON 自动解析**：保存 AI 原文时尽力解析，回填综合匹配度、公司画像、机会分、6 维机会雷达、风险等级、投递建议、面试关注点、Boss 话术；失败 / 部分缺失按 no-clobber 处理，并给出解析状态反馈。
4. **机会雷达卡**：主战场展示机会分、综合匹配度、公司画像标签、风险/投递建议、决策摘要、面试关注点，以及自研 SVG 6 维机会雷达图（不引入图表库）。
5. **列表升级**：新增公司规模、机会分列；支持按城市 / 公司规模 / 沟通状态 / 机会分下限筛选，按更新时间 / 机会分 / 匹配度排序（仅前端展示，不改持久化）。
6. **浅色高级科技感视觉**：引入 Naive UI 作为唯一 UI 组件库，并折入真实页面 —— 列表为「机会资产池」卡片、主战场为「单岗位机会简报」（机会雷达主视觉）、表单卡片化，整体类 Linear / Vercel / 飞书多维表格的清爽感；不引入图标库 / 路由 / 状态管理 / 图表库。

## 本地运行

要求 Node 18+。

```bash
# 安装依赖
npm install

# 启动开发服务器（默认 http://localhost:5173）
npm run dev

# TypeScript 类型检查（strict，期望 0 error）
npm run typecheck

# 自测（存储层 + OFFER_FLOW_JSON 解析器；期望全部通过）
npm run selftest

# 生产构建
npm run build
```

所有数据保存在浏览器 localStorage，本地优先、刷新不丢，无需登录、无需后端。旧版本（v0.1）岗位数据读取时会自动补默认值，兼容打开。

## 功能清单（v0.3.0 累计）

1. 简历 / 偏好全局配置（覆盖式保存，刷新回显）
2. 岗位台账列表：公司规模、匹配度、机会分、策略、下一步动作等列，城市 / 公司规模 / 沟通状态 / 机会分 / 决策 chips 筛选与排序
3. 岗位主战场基础信息录入与保存（新建 / 编辑）
4. 公司与机会补充表单（8 字段，随岗位保存、回显、旧岗位兼容）
5. One-Shot 分析 Prompt 生成 + 一键复制
6. 外部 AI 结果原文承接（原文必存、粘贴时间、解析状态）
7. OFFER_FLOW_JSON 自动解析与回填（综合匹配度 / 公司画像 / 机会雷达 / 话术；失败不清空）
8. 机会雷达卡 + 自研 SVG 6 维雷达图 + 空状态
9. 分析报告原文展示 + Boss 打招呼话术编辑 / 保存 / 复制
10. 沟通状态流转（8 态 `communicationStatus`）
11. 跟进决策面板：策略建议 + 下一步动作 + 推荐话术 + 止损判断
12. 推荐话术模板：6 类场景，支持复制、填入草稿、编辑和保存
13. 列表决策台：行动徽章、决策 chips、决策优先级排序
14. 公司级只读预警：基于同公司其他岗位派生，不新增公司实体
15. 列表 ↔ 详情回看闭环，全字段回显
16. 全本地存储（localStorage），刷新不丢

## 当前能力边界（v0.3.0 不做）

1. 不接 OpenAI / Claude / Gemini API，也不接任何后端 API
2. 不做 BYOK
3. 不做后端，不做后端 SaaS
4. 不做登录注册
5. 不爬 Boss，不自动检测 Boss 已读 / 未读
6. 不自动发送消息，不定时发送，不做模拟点击
7. 不自动投递
8. 不做 Boss 自动化工具
9. 不做 CRM，不做联系人管理，不做多渠道聚合
10. 不做提醒系统
11. 不做完整 AI Chat
12. 不做完整沟通日志，不做 append-only message log
13. 不做批量操作
14. 不做漏斗转化率大看板，不做用户自定义规则引擎
15. 不联网查公司，不做公司数据库
16. 不做浏览器插件
17. 不做 PDF / Word 简历解析
18. 不做云端同步
19. 不新增 Company / Contact / Message / JobStatusLog / FollowupLog / Reminder 实体
20. 不持久化 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning`

> v0.3.0 是半自动求职跟进决策台：会基于用户手动维护的事实给出策略建议、下一步动作、推荐话术和止损判断，但绝不自动调用 AI、自动操作 Boss 或替用户发送消息。

## 版本路线

- v0.1：Manual Mode，不接 API，验证求职工作流（已封版 v0.1.0）
- v0.2：One-Shot Opportunity Radar，固定 JSON 解析 + 机会雷达 + Naive UI 浅色壳（已封版 v0.2.0，仍不接 API）
- v0.3：Semi-manual Follow-up Decision Desk，半自动求职跟进决策台（当前 v0.3.0，仍不接 API、不自动操作 Boss、不做 CRM）
- 后续：是否进入 BYOK / 正式 AI Adapter 必须由用户另行明确拍板，不属于 v0.3 待办项

## Release Notes

- v0.3.0：半自动求职跟进决策台。详见 [docs/release/v0.3.0.md](docs/release/v0.3.0.md)。
- v0.2.0：One-Shot Opportunity Radar。详见 [docs/release/v0.2.0.md](docs/release/v0.2.0.md)。
- v0.1.0：P0 manual-mode 闭环完成。详见 [docs/release/v0.1.0.md](docs/release/v0.1.0.md)。

## 开发纪律

> 配置存一份，岗位分条存，原文先落盘；先建能存能列，再做进料回流，最后收状态与认知。P0 之外，一个都不碰。
