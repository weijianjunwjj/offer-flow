# OfferFlow | AI 求职决策与机会管理系统

OfferFlow 将分散的岗位信息、个人履历、能力证据、求职反馈和阶段策略，整理成一个可追踪、可复盘、可人工确认的决策系统。

它不会替用户自动投递、联系招聘方或做最终选择。AI 负责分析、归纳和生成候选叙事，正式记录与现实行动始终由用户确认。

## 当前版本

**v0.8.0 GA（正式发布，发布日期 2026-07-30）。**

- 经项目负责人完成核心主流程人工冒烟并明确批准发布
- 真实运行库已受控升级至 **schema v8**（migration 1..8）
- 可解释岗位雷达、当前页采集桥、单岗位分析、推荐批次、雷达动作与正式晋升等能力**随 v0.8.0 发布但默认关闭**，按功能开关启用（见下方「功能开关」）
- 部分原 GA 前置项（RC-09、RC-12、30 条真实评测、核心页面真实截图与产品文案验收）**未完成，经负责人明确豁免、接受风险后发布并转入 v0.9**，不得标记为已完成（见 [Release Notes §0](docs/release/v0.8.0.md)）
- 遗留验证与体验优化转入 v0.9；发布后新发现的阻断问题走 v0.8.x 补丁

正式发布说明见 [docs/release/v0.8.0.md](docs/release/v0.8.0.md)。

v0.8 权威文档：

- [docs/release/v0.8.0.md](docs/release/v0.8.0.md)
- [docs/prd/offerflow-v0.8.md](docs/prd/offerflow-v0.8.md)
- [docs/product/offerflow-v0.8-release-contract.md](docs/product/offerflow-v0.8-release-contract.md)
- [docs/technical/offerflow-v0.8-technical-design.md](docs/technical/offerflow-v0.8-technical-design.md)
- [docs/product/offerflow-v0.8-traceability.md](docs/product/offerflow-v0.8-traceability.md)

以下「核心能力」章节描述的是 v0.7 起已开放的正式能力；v0.8 新增的雷达类能力默认关闭、按开关启用，不要当作默认开放能力。

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

## 核心能力（v0.7 起已开放）

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

### 本地地址

- 本地前端：http://localhost:5173
- 本地 API：http://127.0.0.1:17365

## 岗位雷达功能开关（随 v0.8.0 发布，默认关闭）

岗位雷达、单岗位分析、推荐批次、雷达动作与正式晋升等 v0.8 能力**随 v0.8.0 一起发布，但默认关闭**，需要显式开关启用。前端为构建期开关，后端为运行期环境变量，两侧需成对开启，否则会出现「前端有入口、后端 404」。

| 能力 | 前端（构建期） | 后端（运行期） | 默认 |
|---|---|---|---|
| 岗位雷达采集桥 | `VITE_OFFERFLOW_RADAR` | `OFFERFLOW_RADAR` | 关闭 |
| 单岗位分析 | `VITE_OFFERFLOW_RADAR_ANALYSIS` | `OFFERFLOW_RADAR_ANALYSIS` | 关闭 |
| 推荐批次面板 | `VITE_OFFERFLOW_RADAR_RECOMMENDATIONS` | —（随雷达网关自动接线） | 关闭 |
| NovaWing 分析上下文预接入 | —（无 UI） | `OFFERFLOW_NOVA_WING_ANALYSIS_CONTEXT` | 关闭 |

- 后端启用 `OFFERFLOW_RADAR=true` 时，真实库 schema 必须 ≥ v8，否则服务**拒绝启动**并提示先经授权升级。
- `OFFERFLOW_RADAR_ANALYSIS` 依赖 `OFFERFLOW_RADAR`；单独开启分析而未开雷达时，分析路由不注册。
- NovaWing 上下文开关只控制分析快照与 stale 语义；OfferFlow 不动态加载真实 adapter，未注入时创建任务返回稳定错误。
- 推荐 / 动作 / 晋升 / 追踪不新增开关，沿用雷达路由内既有 schema / analysis 门禁自动接线。

## 浏览器扩展

当前页采集桥为独立的浏览器扩展（`browser-extension/`，自身版本 `0.1.0`，与应用版本独立）。改动后需**重新构建并在 Chrome 中重新加载**：

```bash
npm run extension:typecheck
npm run extension:build
```

然后在 `chrome://extensions` 打开「开发者模式」→「加载已解压的扩展程序」选择 `browser-extension/` 目录（已加载过则点「重新加载」）。详见 [browser-extension/README.md](browser-extension/README.md)。

## 本地数据与恢复策略

OfferFlow 采用本地数据优先：

- `data/offerflow.sqlite3`：本地真实运行库，不进入 Git
- `backups/`：本地一致性数据库备份目录，不进入 Git
- 当前生产 schema：**v8**（migration 1..8）
- 从任何旧版本升级前**必须**先创建一致性备份（`npm run db:backup`），并在真实库副本上演练迁移

v0.7.0 正式恢复机制采用 Snapshot 方案 B：

- SQLite 一致性备份
- SHA-256 文件指纹
- `PRAGMA integrity_check`
- `PRAGMA foreign_key_check`
- 实际恢复演练

旧 JSON Snapshot 契约只支持 schema 2。schema v6 下旧 Snapshot 发布会被明确拒绝，它不再是当前版本的生产恢复机制。

## 工程质量

### v0.8.0（当前发布状态）

- `vue-tsc --noEmit` 类型检查通过
- `npm run test`（全量 vitest）1506/1506 通过
- 生产构建通过
- `npm run db:doctor` integrity ok、0 外键违规、schema=v8
- 生产库已受控升级至 schema v8（migration 1..8）
- 30 条真实岗位评测、核心页面真实截图与产品文案人工验收**未完成**，经负责人明确豁免后发布并转入 v0.9（详见 [Release Notes §0](docs/release/v0.8.0.md)）

### v0.7.0（历史质量成果）

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

### v0.8.0

- 主题：可解释岗位雷达与 JD 采集桥
- 新增浏览器扩展当前页采集桥（BOSS 定向字段 + 通用可见文本降级），统一预览、纠错和确认写入
- 新增可解释单岗位分析：四档建议、匹配维度、证据、反证、缺口、风险与不确定性
- 新增推荐批次（0～8 条重点机会）、雷达动作（收藏/忽略/重点/已投待反馈）与正式晋升
- 数据库升级至 schema v8（migration 1..8）
- 岗位雷达类能力（采集桥、单岗位分析、推荐批次）随本版本发布但**默认关闭**，按功能开关启用
- 30 条真实评测、核心页面真实截图与产品文案验收等原 GA 前置项**未完成**，经负责人明确豁免、接受风险后发布，转入 v0.9（详见 [Release Notes §0](docs/release/v0.8.0.md)）

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

v0.9 计划推进（须复用 v0.8 已有快照、来源记录、候选版本、规则、分析、推荐批次、动作与晋升关系，不建立平行体系）：

- 完整来源配置（`SourceConfig`）、增量扫描与自动翻页
- 持续推荐收件箱
- 从正式求职反馈自动提取能力证据，推动候选人能力基线与市场位置画像演进
- 字段级画像 Diff

以上方向未开始实施，具体范围以 [PRD v2.1 §6.3](docs/prd/offerflow-v0.8.md) 为准，可能随实际情况调整。
