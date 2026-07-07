---
alwaysApply: true
---
# OfferFlow Project Rules

你正在协助开发 OfferFlow。

## 项目定位

OfferFlow 是一个本地优先的求职机会管理工具，用于岗位分析、机会管理、沟通跟进、面试准备和求职复盘。

当前技术栈：
- 前端：Vue / Vite / TypeScript
- 后端：Node / Fastify
- 数据库：SQLite / better-sqlite3
- 数据文件：data/offerflow.sqlite3

## 当前核心目标

本阶段目标是接入第一条 LLM 调用链路，让 OfferFlow 可以通过后端调用 LLM，对岗位 JD 做结构化分析，并返回可被现有流程消费的 JSON 结果。

## 严格边界

你必须遵守以下限制：

1. 不接 Boss。
2. 不爬虫。
3. 不自动投递。
4. 不自动发消息。
5. 不自动联系 HR。
6. 不做完整 AI Chat。
7. 不做多 Agent 系统。
8. 不引入复杂队列。
9. 不破坏现有 SQLite 数据。
10. 不删除现有功能。
11. 不自动 commit。
12. 不自动 push。
13. 不安装大而重的新框架。
14. 不重构无关模块。
15. 不把 AI 输出直接作为最终决策。

## LLM 接入原则

本次只做最小闭环：

1. 后端新增 LLM Provider 抽象。
2. 优先实现 OpenAI-compatible Provider。
3. 通过环境变量配置：
   - OFFERFLOW_LLM_BASE_URL
   - OFFERFLOW_LLM_API_KEY
   - OFFERFLOW_LLM_MODEL
4. 新增 JD 分析 Prompt Contract。
5. 新增后端 API，例如：
   - POST /api/llm/analyze-job
6. 返回 AI 原文、解析结果、解析状态、错误信息、模型名和创建时间。
7. 如果 API Key 未配置，返回明确错误，不允许服务崩溃。
8. AI 分析结果默认只作为草稿或建议展示，不能自动覆盖关键状态。

## 前端原则

前端只增加最小入口，例如：

- 在机会详情页或 JD 分析页面增加「AI 分析 JD」按钮。
- 点击后调用后端接口。
- 展示 loading。
- 展示 AI 原文。
- 展示解析后的结构化结果。
- 失败时展示明确错误。

不要新造复杂页面，不要扩大成聊天系统。

## 输出要求

每次完成后，请说明：

1. 修改了哪些文件。
2. 新增了哪些接口。
3. 新增了哪些环境变量。
4. 如何本地验证。
5. 哪些地方保持了人工确认边界。
6. 有哪些未完成事项。
7. 明确说明没有 commit / 没有 push。