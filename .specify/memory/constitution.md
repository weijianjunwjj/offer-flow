<!--
  Sync Impact Report
  ==================
  Version change: (none) → 1.0.0
  Principles: 12 (I–XII, all new)
  Added sections:
    - Core Principles (I–XII)
    - Additional Constraints (Technology Stack & Environment)
    - Development Workflow (Spec-Driven Development)
    - Governance
  Removed sections: none
  Deferred TODOs: none — all placeholders resolved from existing project facts
    (AGENTS.md, CLAUDE.md, v0.8 Technical Design, v0.8 Release Contract, v0.9 PRD)
  Follow-up: none required — constitution is complete as of ratification
-->

# OfferFlow 项目宪法

## 核心原则

### Principle I — 冻结事实优先（Frozen Facts First）

v0.7 / v0.8 已确认的领域事实不得被新版静默反向修改或重新定义。
历史数据和领域决策必须保持可追溯、可版本化、可恢复。
新版本必须优先采用增量演进，而非覆盖旧事实。

**理由：** v0.8 的 Radar 领域模型、CandidateVersion 不可变性、
Analysis Envelope 分离等，是经过刻意架构仲裁的结果。
若静默反转这些决策，将破坏生产系统的数据完整性，
并使所有下游分析和推荐失效。

### Principle II — 单一领域，无影子模型（One Domain, No Shadow Models）

已有正式领域不得产生平行模型。以下行为明确禁止：
创建第二套 Job、Application、Opportunity、RadarCandidate、CandidateVersion、
AnalysisTask、MatchAnalysis、Recommendation 或 RuleAssessment。
当现有模型能够表达需求时，必须复用或扩展——绝不以不同名称重复创建。

**理由：** 平行模型分裂事实源，使"哪个实体代表真实状态"无法判断。
v0.8 已收敛为单一 Radar 链（Snapshot → SourceRecord → Candidate →
CandidateVersion → Analysis → Recommendation → Action → Promotion）。
v0.9 扩展此链，而非分叉它。

### Principle III — 不可变证据（Immutable Evidence）

事实版本（CandidateVersion、ResumeVersion、ProfileVersion 等）
不得通过 UPDATE 覆盖历史。发生实质性变化时，必须创建新版本。
所有分析、规则、推荐和用户判断必须绑定明确的版本 ID。
旧版本永久可读。

**理由：** 没有不可变版本，分析或判断就脱离了其所依据的事实，
使得审计、stale 检测和偏好学习不可靠。

### Principle IV — 人类权威（Human Authority）

AI 可以分析、提案、排序、解释、提取 PreferenceSignal
和生成 PreferenceRule 提案。AI 不得单方面更改正式用户事实、
能力基线、职业战略、薪资底线、城市战略或自动投递。
用户对所有正式事实拥有最终权威。

**理由：** OfferFlow 是决策辅助工具，而非自主 Agent。
Human-in-the-loop 边界是产品的安全机制，不得因便利而被绕过。

### Principle V — 可靠性优先于自动化（Reliability Before Automation）

任何自动化能力必须保证：幂等性、可追溯性、可解释性、
有限重试、显式失败和可恢复性。禁止：无限重试循环、
失败伪装成成功、空结果伪装成"无数据"、重复副作用。

**理由：** 每日自动找岗在无人值守状态下运行。
将静默失败伪装为"今天没有岗位"会直接损害用户信任和核心价值主张。
每次失败必须可见且可恢复。

### Principle VI — 本地优先（Local First）

OfferFlow 架构必须保持：Vue 3 + TypeScript + Vite（前端）、
Node.js + Fastify（后端）、SQLite + better-sqlite3（存储）、
本地优先、单用户。没有真实产品需求，不得引入：
PostgreSQL、Redis、BullMQ、Kafka、微服务、Kubernetes 或复杂 Agent Runtime。

**理由：** 本地优先的简单性是刻意为之的产品选择，
降低了运维负担，使机密信息真正保留在本地，
避免对单用户场景无意义的基础设施复杂度。

### Principle VII — 产品需求驱动基础设施（Product Need Before Infrastructure）

产品需求驱动架构；架构不驱动产品。外部框架
（Agent Framework、Memory Framework、Skill Framework、Runtime、
Checkpoint Engine）只能作为实现候选——
它们不得反向定义 OfferFlow 产品。

**理由：** 框架优先的设计导致过度工程和范围蔓延。
v0.9 使用简单、显式的 Pipeline 而非通用 Agent Runtime，
因为产品需要的是每日找岗流水线，而非通用多 Agent 平台。

### Principle VIII — 规格先于代码（Spec Before Code）

从 v0.9 开始，中大型能力必须经过：
PRD → Specification → Clarification → Plan → Tasks → Analysis → Implementation。
模糊需求不得被模型猜测后直接跨模块编码。
如果 Spec 未冻结，实现不得开始。

**理由：** Spec-Driven Development 用可验证的需求取代 vibe coding。
这防止范围漂移，确保 PRD 被忠实翻译，
并在任何业务代码编写之前使验收标准明确。

### Principle IX — 测试跟随风险（Tests Follow Risk）

以下能力必须有自动化测试或明确的验收剧本：
Migration、数据版本化、幂等性、状态机、恢复、
CandidateVersion、AnalysisTask、Recommendation、Notification Outbox、
JobJudgment、PreferenceRule。测试不是事后补救——
验证方式必须在技术计划阶段就确定。

**理由：** 高风险领域（数据完整性、通知、偏好）
不能仅靠人工检查验证。测试必须在实现之前规划，
而非在发现 bug 之后补写。

### Principle X — 仅限 Git Bash（Git Bash Only）

OfferFlow 开发环境标准为：Windows Native + Git Bash。
所有 Shell 命令必须使用 Bash。项目工具不得依赖
PowerShell、CMD 或 WSL。Spec-Kit 必须使用 `--script sh`。

**理由：** 单一、强制的 Shell 目标消除了环境特定 bug，
确保所有自动化（脚本、Hook、CI）一致运行。

### Principle XI — 成本是产品约束（Cost Is a Product Constraint）

AI 与自动任务的调用次数、Token、模型、实际成本，
在有可靠数据时必须可观察。成本优化不得牺牲
正确性、事实完整性或安全边界。当成本数据不可用时，
必须明确标记为"不可用"——绝不估算或伪造。

**理由：** 每日自动找岗消耗 AI API 调用。
用户必须知道他们在花多少钱。但成本可见性
绝不应激励在分析质量或安全上偷工减料。

### Principle XII — 第三方可替换性（Third-Party Replaceability）

外部能力（SearchProvider、AI 模型、邮件渠道、Skill）必须可替换。
业务数据和核心领域不得被第三方框架绑架。
Provider 特定逻辑必须封装在 Adapter 之后，
不得编织进领域实体。

**理由：** P0 SearchProvider 尚未冻结；AI Provider 可能更换；
邮件 Provider 可能更换。核心 Radar 和 Preference 领域
必须在任意单个 Provider 被替换后仍然健在。

## 附加约束

### 技术栈

- **前端**：Vue 3、TypeScript、Vite、Naive UI
- **后端**：Node.js、Fastify
- **存储**：SQLite（通过 better-sqlite3），本地 journal_mode=DELETE
- **AI Provider**：DeepSeek（当前）；更换 Provider 需用户明确批准
- **邮件**：QQ SMTP（v0.9 P0）；SMTP 配置通过 NotificationChannel
- **浏览器扩展**：Chrome/Edge MV3，仅 activeTab + scripting 权限

### 硬边界

- 不得将本地 OfferFlow 暴露到公网
- 不得自动投递、打招呼、上传简历或添加 HR
- 不得绕过验证码、登录校验、安全验证或频率限制
- 不得读取 Cookie、密码、Token 或浏览历史
- 不得自动修改职业战略、能力基线或薪资底线
- Secret（SMTP 授权码、API Key）不得进入 Git、明文日志或普通数据库备份

## 开发工作流

### Spec-Driven Development（v0.9+）

所有 v0.9 功能工作必须遵循 Spec-Kit 流水线：

```text
PRD（WHAT/WHY/边界）
  → Constitution（治理原则）
  → Specification（可验证的功能需求）
  → Clarification（消解歧义）
  → Plan（HOW / 技术设计）
  → Tasks（实施拆分）
  → Analyze（跨产物一致性检查）
  → Implement
```

- Spec 不得静默删除 PRD 需求、降级用户结果、扩大 PRD 范围或重新定义已冻结的业务语义。
- 如果 PRD、AGENTS.md 和 v0.8 冻结契约之间存在冲突：记录冲突、明确指出、不自裁决。
- Plan 阶段必须包含显式的 Constitution Check。
- 与 Constitution 冲突的设计不得静默进入实现。

### Git 与权限

以下动作各自需要独立的、明确的用户授权：
合并到 main、推送 main、Tag、Release。
对其中一项的授权不意味着对其他的授权。
本地 commit 遵循任务特定指示。

## 治理规则

1. 本宪法约束所有后续的 Spec、Plan、Tasks 和 Implementation。
2. Plan 阶段必须执行显式的 Constitution Check；任何违反原则的设计必须修正，
   或通过宪法修正案明确论证。
3. AGENTS.md 的权限和执行规则优先于本宪法对工具行为的描述。
4. 本宪法不得静默改变 PRD 的产品范围。
5. 修改本宪法需要：文档化的理由、按语义化版本规则的显式版本号变更、以及用户批准。
6. 宪法修正案遵循相同的 Spec-Kit 流水线：提案 → 规格化 → 澄清 → 计划 → 实现。

**版本**：1.0.0 | **批准日期**：2026-08-11 | **最后修订**：2026-08-11
