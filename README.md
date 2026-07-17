# OfferFlow | AI 求职决策与机会管理系统

OfferFlow 将分散的岗位信息、个人履历、能力证据、求职反馈和阶段策略，整理成一个可追踪、可复盘、可人工确认的决策系统。

它不会替用户自动投递、联系招聘方或做最终选择。AI 负责分析、归纳和生成候选叙事，正式记录与现实行动始终由用户确认。

## 当前版本

**v0.7.0 已正式发布。**

- 产品与生产验收已完成
- 真实运行库已升级至 **schema v6**
- 岗位匹配画像、能力基线、历史补录、市场位置和求职策略等正式能力已开放
- 全量测试 **635 / 635** 通过
- 采用经过验证的 SQLite 一致性备份与恢复方案

## 当前状态

- 已发布：v0.7.0
- 规划中：v0.8.0 —— 可解释岗位雷达与 JD 采集桥
- 当前阶段：V8-0 文档审阅与冻结
- v0.8 实施状态：尚未开始

v0.8 权威文档：

- [docs/prd/offerflow-v0.8.md](docs/prd/offerflow-v0.8.md)
- [docs/product/offerflow-v0.8-release-contract.md](docs/product/offerflow-v0.8-release-contract.md)
- [docs/technical/offerflow-v0.8-technical-design.md](docs/technical/offerflow-v0.8-technical-design.md)
- [docs/product/offerflow-v0.8-traceability.md](docs/product/offerflow-v0.8-traceability.md)

请不要把规划中的 v0.8 能力当作已经实现的能力；以下内容仍然是 v0.7.0 当前已发布的真实能力。

## 核心产品闭环

```txt
个人资料与履历
+ 岗位台账与求职反馈
+ 历史数据与能力证据
        ↓
全局岗位匹配画像
        ↓
候选人能力基线
        ↓
历史漏斗与市场证据
        ↓
市场位置画像
        ↓
求职策略窗口
        ↓
用户确认后的行动与复盘
```

单个岗位仍可通过 LLM 分析支线获得结构化结果：

```txt
JD / 岗位信息
→ LLM 分析与 SSE 渐进返回
→ Markdown 原文 + OFFER_FLOW_JSON
→ 用户检查并确认保存
→ 状态流转与后续决策建议
```

## v0.7.0 核心能力

### 岗位与机会台账

- `Job` 与 `Application` 分离，避免把岗位事实和求职流程混为一体
- 记录沟通反馈、流程状态和事件时间线
- 支持 JD 录入、截图粘贴、OCR adapter 和岗位补充信息
- 支持 DeepSeek LLM 分析与 SSE 渐进返回
- AI 原文和结构化结果只有在用户确认后才进入正式记录

### 全局岗位匹配画像

- 建立长期、全局的岗位匹配定位，而不是只针对单条 JD 临时打分
- 提供苏州、无锡、上海、杭州等城市视图
- 支持版本化、来源追踪和人工确认
- 将岗位方向、技术能力、城市策略和现实约束统一到同一画像中

### 候选人能力基线

- 基于真实履历、项目经历、岗位记录和求职反馈形成能力判断
- 区分已验证能力、证据不足项和待补强项
- 支持候选提案、人工确认和正式版本沉淀
- 避免把“会使用 AI 工具”直接等同于已经被市场验证的能力

### 历史补录与基础漏斗

- 保守导入历史岗位、流程与反馈记录
- 草稿必须经过人工确认后才进入正式数据
- 形成基础投递、回复和流程漏斗
- 未获得回复的投递不会自动被视为拒绝，也不会污染正式机会样本

### 市场位置画像

- 综合岗位匹配画像、能力基线和市场证据
- 展示市场位置、证据充分性与决策门状态
- AI 只能生成候选叙事，不能覆盖确定性判断和门禁结果
- 正式版本需要用户主动接受

### 求职策略窗口

- 根据当前证据确定阶段策略
- 支持证据收集、受控实验和有限优化等策略窗口
- 输出行动清单、实验计划、边界与版本历史
- 不自动投递、不自动联系、不自动降低预期，也不会擅自改变城市战略

## 决策边界

OfferFlow 采用分层自主权：

1. **看清自己与辅助决策**是默认能力
2. **替用户决策**只能作为用户主动开启的可选层
3. **代替用户行动**必须有透明理由、明确边界、人工确认和可撤销机制

当前版本明确不做：

- 不爬取招聘平台
- 不自动打招呼或投递
- 不让 AI 绕过人工确认
- 不把模型建议直接变成现实动作
- 不把派生策略伪装成已经发生的事实
- 不替用户做最终职业决定
- 不构建复杂的全自动多 Agent 平台

## 技术架构

### 前端

- Vue 3
- TypeScript
- Vite
- Vue Router
- Naive UI
- vue-page-scope / vue-page-runtime

### 后端

- Node.js
- Fastify
- SQLite / better-sqlite3
- Zod
- DeepSeek Chat Completions 兼容接口
- SSE 流式响应

### 工程治理

- 显式 SQLite migration
- schema 启动门禁
- Human-in-the-loop 状态约束
- 版本化画像与策略
- Vitest、selftest、migration selftest 和 router smoke
- AI Coding 规则与 Spec Guard

## 快速开始

要求 Node.js 18+。

```bash
npm install
npm run dev
```

默认同时启动 Fastify 后端与 Vite 前端。

### 常用命令

```bash
# 开发
npm run dev
npm run server
npm run web

# 质量验证
npm run typecheck
npm run test
npm run build
npm run selftest
npm run migration:selftest
npm run test:router

# 数据库检查与备份
npm run db:doctor
npm run db:backup
```

Windows PowerShell 可能拦截 `npm.ps1`，可改用 `npm.cmd`：

```bash
npm.cmd run test
npm.cmd run selftest
```

## 本地数据与恢复策略

OfferFlow 采用本地数据优先：

- `data/offerflow.sqlite3`：本地真实运行库，不进入 Git
- `backups/`：本地一致性数据库备份目录，不进入 Git
- 当前生产 schema：**v6**

v0.7.0 正式恢复机制采用 Snapshot 方案 B：

- SQLite 一致性备份
- SHA-256 文件指纹
- `PRAGMA integrity_check`
- `PRAGMA foreign_key_check`
- 实际恢复演练

旧 JSON Snapshot 契约只支持 schema 2。schema v6 下旧 Snapshot 发布会被明确拒绝，它不再是当前版本的生产恢复机制。

## 工程质量

v0.7.0 发布前完成：

- TypeScript 类型检查
- 73 个测试文件
- 635 个测试用例全部通过
- 生产构建
- storage / decision / review / migration / sync selftest
- migration 自测
- router smoke
- 真实 schema v4 → v6 迁移演练与生产切换
- G4 / G5 正式版本晋升、幂等验证和用户生产验收

## 版本记录

### v0.7.0

- 建立可信求职记忆底座：`ResumeVersion`、`Job`、`Application`、`FeedbackEvent`
- 增加全局岗位匹配画像和城市视图
- 增加候选人能力基线
- 增加历史补录与基础求职漏斗
- 增加市场位置画像、`EvidenceSufficiency` 和 `DecisionGate`
- 增加求职策略窗口、行动清单和受控实验
- 数据库升级至 schema v6
- 完成 G4 / G5 正式生产晋升
- 正式采用 SQLite 一致性备份恢复方案
- 完成 635 项测试和用户生产验收

### 历史版本

- **v0.6.2**：建立 SQLite migration baseline，完成旧版本一致性与文档边界收口
- **v0.6.1**：增加 DeepSeek LLM SSE 流式分析体验
- **v0.6.0**：接入 DeepSeek LLM，复用 `OFFER_FLOW_JSON` 与人工确认链路
- **v0.5.x**：完善 Spec Guard、JD 截图输入和 OCR adapter
- **v0.4.x**：引入 Fastify、SQLite 与本地后端
- **v0.3.0**：增加沟通状态与派生决策
- **v0.2.0**：建立 One-Shot Prompt、`OFFER_FLOW_JSON` 和机会雷达
- **v0.1.0**：验证本地求职台账与 AI 原文承接

## 后续方向

- 提升候选人证据采集和质量判断
- 丰富岗位、城市与市场观察
- 改进策略实验的复盘能力
- 支持更多模型 Provider 与 BYOK
- 建立更成熟的部署和跨设备能力
