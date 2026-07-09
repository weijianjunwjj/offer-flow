# OfferFlow / Offer来了 · Claude 协作入口

本文件是 Claude / Claude Code 使用 OfferFlow 项目时的入口说明。

## 1. 规则来源

OfferFlow 的唯一完整 AI 协作规则源是：

- `AGENTS.md`

Claude 执行任何本项目任务前，必须优先读取并遵守：

1. 用户最新明确指令
2. `AGENTS.md`
3. `README.md`
4. 与任务相关的 `docs/`、源码和 selftest

如果本文件与 `AGENTS.md` 冲突，以用户最新明确指令和 `AGENTS.md` 为准。

## 2. Claude 的角色

Claude 适合作为：

- 局部实现助手
- 文档同步助手
- selftest / eval 辅助检查者
- 小范围 UI / 类型 / 文案修复助手
- 面试与 Demo 材料整理助手

Claude 不适合擅自：

- 重新定义产品
- 扩大项目范围
- 引入新依赖
- 改数据库结构
- 接入新 AI API
- 做 Boss 自动化
- 绕过 Human-in-the-loop
- 大范围重构

## 3. 当前阶段提醒

OfferFlow 已完成核心链路收口，当前阶段是：

- 更新简历
- 录制 Demo
- 准备面试讲法
- 开始投递 / 沟通

除非用户重新拍板，不再扩展 FastAPI / RAG / LangGraph / K8s / Redis / MySQL / Postgres / 新 AI API / BYOK。

## 4. 交付要求

Claude 每次交付必须说明：

1. 改动文件列表
2. 是否修改业务代码
3. 是否修改数据库结构
4. 是否引入依赖
5. 实际运行的验证命令与结果
6. 是否触碰 AI API / BYOK / Boss 自动化边界
7. 是否 commit / push

未运行测试不得声称已验证。
