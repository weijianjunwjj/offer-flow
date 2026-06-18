# OfferFlow / Offer来了 v0.2.0 需求文档

> One-Shot Opportunity Radar / 一次分析 · 机会雷达版

## 0. 文档用途与定位

本文档是 OfferFlow v0.2.0 的需求与边界唯一信源。

- 产品定位 / 目标用户 / v0.1 边界仍以 docs/v0.1/product.md 为准，本文档只在其上做 v0.2.0 增量。
- v0.2.0 涉及的两项边界放开，已分别拍板为 DEC-016（固定 JSON 解析）与 DEC-017（引入 Naive UI），见 docs/v0.1/decision-log.md。
- 任务拆分与逐卡执行见 §11；当前进度见 docs/v0.1/progress.md。

如本文档与 decision-log / progress 冲突，按 CLAUDE.md §4 的冲突处理顺序处理，不得自行猜测。

---

## 1. 一句话目标

用户只需要：

1. 在 OfferFlow 填写岗位、公司、通勤等信息；
2. 复制一次 One-Shot Prompt 给外部 AI；
3. 把 AI 返回的完整内容粘贴回 OfferFlow。

系统即自动解析并生成：综合匹配度、公司规模 / 公司画像、机会分、6 维机会雷达、风险等级、投递建议、面试关注点、Boss 打招呼话术，以及列表页筛选排序字段。

v0.2.0 不接 API，但要消灭反复复制粘贴。

---

## 2. 版本边界

### 2.1 本版明确要做

- One-Shot Prompt 升级
- AI 返回固定 OFFER_FLOW_JSON 协议
- JSON 自动解析（尽力解析、失败不阻断、不丢原文）
- 公司画像字段
- 机会雷达字段
- 机会分计算 / 展示
- 自研 SVG 雷达图
- 岗位列表新增机会分 / 公司规模
- 列表筛选排序
- 引入 Naive UI 做视觉升级（浅色高级科技感机会决策工作台）
- 更新 docs / decision-log / progress / release note

### 2.2 本版明确不做

- 不接 OpenAI / Claude / Gemini API（延续 DEC-001）
- 不做 BYOK
- 不做后端
- 不做登录
- 不做云同步
- 不爬 Boss、不联网查公司、不做公司数据库
- 不做多简历版本
- 不做状态变更历史、不做多次分析历史
- 不引入 vue-router
- 不引入 Pinia / Vuex
- 不引入 ECharts / Chart.js（雷达图用自研 SVG）
- 不引入额外图标库
- 不引入测试框架
- 不做全量重构

---

## 3. 关联决策

| 决策 | 内容 | 状态 |
|---|---|---|
| DEC-001 | v0.1 起采用 Manual Mode，不接 API；v0.2.0 延续 | 已拍板 |
| DEC-014 | v0.1.1 单字段「尽力」提取综合匹配度 | 已拍板 |
| DEC-016 | v0.2.0 允许解析固定 OFFER_FLOW_JSON 数据块（仍不接 API） | 已拍板 |
| DEC-017 | v0.2.0 允许引入 Naive UI 作为唯一 UI 组件库 | 已拍板 |

---

## 4. 数据模型增量

不新增独立 CompanyRecord / OpportunityRecord / AnalysisHistory 实体。全部字段挂在既有 JobRecord 上。旧数据读取时自动补默认值，不允许报错。

### 4.1 新增枚举

```ts
export type CompanySizeTier =
  | 'giant'    // 大厂：10000+
  | 'large'    // 大中厂：1000-9999
  | 'medium'   // 中厂：100-999
  | 'small'    // 小厂：20-99
  | 'micro'    // 微厂：0-20
  | 'unknown'

export type StabilityLevel = 'high' | 'medium' | 'low' | 'unknown'
export type GrowthPotential = 'high' | 'medium' | 'low' | 'unknown'
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown'
```

### 4.2 CompanyInput（用户填写）

```ts
export interface CompanyInput {
  sizeTier: CompanySizeTier
  staffRange: string
  companyType: string
  financingStage: string
  commuteTime: string
  commuteWay: string
  companyNote: string
  opportunityNote: string
}
```

### 4.3 CompanyAssessment（AI 解析）

```ts
export interface CompanyAssessment {
  sizeTier: CompanySizeTier
  staffRange: string
  companyType: string
  financingStage: string
  stabilityLevel: StabilityLevel
  growthPotential: GrowthPotential
  summary: string
  confidence: 'high' | 'medium' | 'low'
}
```

### 4.4 OpportunityRadar（6 维，0-100）

```ts
export interface OpportunityRadar {
  salaryScore: number       // 薪资
  stabilityScore: number    // 稳定
  growthScore: number       // 成长
  matchScore: number        // 匹配
  commuteScore: number      // 通勤
  riskControlScore: number  // 风险可控
}
```

### 4.5 OpportunityAnalysis（AI 解析）

```ts
export interface OpportunityAnalysis {
  opportunityScore: number
  opportunityRadar: OpportunityRadar
  applyAdvice: ApplyAdvice | ''
  riskLevel: RiskLevel
  decisionSummary: string
  interviewFocus: string[]
  bossGreeting: string
}
```

### 4.6 JobRecord 新增字段

```ts
companyInput: CompanyInput
companyAssessment: CompanyAssessment | null
opportunityAnalysis: OpportunityAnalysis | null
```

旧岗位读取时：companyInput 补空默认值，companyAssessment / opportunityAnalysis 补 null，不报错。

---

## 5. One-Shot JSON 协议（DEC-016）

AI 返回结果应包含标记包裹的 JSON 数据块（不含注释）：

```text
---OFFER_FLOW_JSON_START---
{
  "version": "0.2.0",
  "matchScore": 82,
  "companyAssessment": {
    "sizeTier": "medium",
    "staffRange": "100-499人",
    "companyType": "自研业务",
    "financingStage": "未明确",
    "stabilityLevel": "medium",
    "growthPotential": "medium",
    "summary": "该公司规模中等，业务稳定性尚可，适合作为复杂中后台经验延展机会。",
    "confidence": "medium"
  },
  "opportunityAnalysis": {
    "opportunityScore": 78,
    "opportunityRadar": {
      "salaryScore": 80,
      "stabilityScore": 72,
      "growthScore": 86,
      "matchScore": 82,
      "commuteScore": 70,
      "riskControlScore": 75
    },
    "applyAdvice": "ok",
    "riskLevel": "medium",
    "decisionSummary": "可以重点沟通，但需要确认团队稳定性、加班强度和岗位核心程度。",
    "interviewFocus": [
      "准备复杂中后台治理案例",
      "强调 Vue3 + TypeScript 项目经验",
      "确认团队规模、业务稳定性和加班情况"
    ],
    "bossGreeting": "你好，我有 7 年 Vue 前端开发经验……（话术）"
  }
}
---OFFER_FLOW_JSON_END---
```

解析规则（硬约束）：

1. 优先解析 `---OFFER_FLOW_JSON_START---` 到 `---OFFER_FLOW_JSON_END---` 之间的内容；
2. 找不到标记时，尝试解析最后一个 ```json 代码块；
3. 解析失败仍完整保存 AI 原文；
4. 解析失败 / 未找到不得清空已有结构化字段（no-clobber）；
5. 解析成功后写入 companyAssessment、opportunityAnalysis，并同步写入旧字段 `matchScore: "82%"` 与 `report.greetingMessage`；
6. 数字字段归一到 0-100；
7. 枚举不合法时写 unknown 或空值；
8. `bossGreeting` 为空时不得覆盖已有话术。

解析状态枚举（对用户可见）：

```ts
type OfferFlowJsonParseStatus = 'success' | 'not_found' | 'invalid_json' | 'partial'
```

对应文案：已解析机会雷达 / JSON 未找到（已保存原文）/ JSON 解析失败（已保存原文）/ 字段不完整（已部分解析）。

---

## 6. 机会分规则

6 维固定：薪资 salaryScore、稳定 stabilityScore、成长 growthScore、匹配 matchScore、通勤 commuteScore、风险可控 riskControlScore。

机会分计算：

```ts
opportunityScore =
  salaryScore * 0.20 +
  stabilityScore * 0.20 +
  growthScore * 0.20 +
  matchScore * 0.20 +
  commuteScore * 0.10 +
  riskControlScore * 0.10
```

- 若 AI 给了 opportunityScore，使用 AI 值，但归一化到 0-100；
- 若 AI 未给，则按上述公式计算。

分数解释：

| 区间 | 含义 |
|---|---|
| 85-100 | 高价值机会 |
| 75-84 | 优质机会 |
| 65-74 | 可观察机会 |
| 50-64 | 谨慎机会 |
| 0-49 | 低价值机会 |

---

## 7. 页面需求

### 7.1 UI 风格（DEC-017）

浅色高级科技感、卡片式布局、机会决策工作台；干净、高级，类 Linear / Vercel / 飞书多维表格的清爽感；信息密度高但不乱；机会分大数字突出；公司规模 / 风险 / 状态用标签展示；雷达图作为视觉核心。不做暗黑驾驶舱，也不做普通灰白后台。

Naive UI 允许使用范围：`n-config-provider`、`n-message-provider`、`n-layout`、`n-card`、`n-space`、`n-grid`、`n-form`、`n-form-item`、`n-input`、`n-select`、`n-input-number`、`n-button`、`n-tag`、`n-alert`、`n-result`、`n-data-table`（或普通表格二选一）、`n-popconfirm` / `n-modal`。不引入额外图标库。

### 7.2 BattlefieldPage（主战场，拆成卡片）

1. 岗位基础信息卡：公司、岗位、城市、薪资、JD（保留原字段）。
2. 公司与机会补充卡：公司规模、人员规模原文、公司类型、融资阶段、通勤时间、通勤方式、公司备注、机会备注。
3. One-Shot Prompt 卡：生成一次性机会分析 Prompt、复制 Prompt；说明文案明确「复制一次给外部 AI，粘贴回来后系统自动生成机会雷达」。
4. AI 结果承接卡：保留 AI 原文 textarea；按钮「保存并解析 AI 结果」；展示 §5 解析状态。
5. 机会雷达卡：解析成功后显示机会分 xx/100、综合匹配度 xx%、公司规模、公司类型、风险等级、投递建议、SVG 雷达图、决策摘要、面试关注点、可编辑可复制的 Boss 话术；无数据时显示空状态「还没有机会雷达。粘贴 AI 分析结果后，这里会亮起来。」

### 7.3 JobListPage（列表）

字段升级为：公司、岗位、城市、薪资、公司规模、匹配度、机会分、状态、更新时间。

新增筛选：城市、公司规模、沟通状态、机会分下限（如 70+）；排序：更新时间 / 机会分 / 匹配度。

旧岗位没有机会分时显示 `-`。筛选 / 排序不改持久化数据。

---

## 8. 新增组件与工具文件（建议，可按现有结构微调）

```text
src/app/companyLabels.ts          # 公司规模 / 风险 / 稳定性 / 成长性中文标签
src/app/opportunityScore.ts       # normalizeScore / calculateOpportunityScore / getOpportunityScoreLevel
src/app/offerFlowJson.ts          # extractOfferFlowJson / parseOfferFlowJson
src/components/OpportunityRadarChart.vue  # 原生 SVG，6 维，0-100，空数据不报错
```

offerFlowJson.ts 类型：

```ts
interface ParsedOfferFlowResult {
  status: OfferFlowJsonParseStatus
  matchScore: string
  companyAssessment: CompanyAssessment | null
  opportunityAnalysis: OpportunityAnalysis | null
  warnings: string[]
}
```

---

## 9. 最终验收标准

v0.2.0 完成时，必须满足：

> 用户可以创建一个 Boss 前端岗位，填写岗位信息、公司规模、通勤和备注，生成一次性 Prompt，复制给外部 AI，将 AI 返回的完整内容粘贴回 OfferFlow，系统自动解析出：综合匹配度、公司规模、公司画像、机会分、6 维机会雷达、风险等级、投递建议、面试关注点、Boss 打招呼话术。列表页可以按机会分、公司规模、城市、沟通状态筛选排序。整个流程不接 API、不需要后端、不丢 AI 原文。UI 使用 Naive UI 完成基础视觉升级，整体呈现为浅色高级科技感的求职机会决策工作台。

文档层面验收（Task 1）：

- 文档明确 v0.2.0 不接 API；
- 文档明确允许固定 JSON 解析（DEC-016）；
- 文档明确允许 Naive UI（DEC-017）；
- 文档明确不引入后端 / router / 状态管理 / 图表库。

---

## 10. 执行纪律

- 一次只做一张任务卡，完成即停，等待用户确认；
- 不顺手做 P1/P2、不顺手重构、不修改无关文件；
- 不引入未批准依赖（v0.2.0 仅批准 naive-ui）；
- 不改变 storage 架构、不改变路由方案；
- 不接 API、不做后端、不丢原文、不让解析失败阻断保存。

每张任务卡完成后报告：完成内容、修改文件、验证命令与结果、风险 / 遗留问题、下一张建议任务卡。commit message 用中文描述（DEC-011），type 可英文。

---

## 11. 任务拆分

| Task | 目标 | 主要产物 |
|---|---|---|
| Task 0 | 确认并收口 v0.1.1 / 同步 origin | 质量门槛通过、工作区干净（已完成） |
| Task 1 | 新增 DEC-016 / DEC-017 + v0.2.0 需求文档 | 本文档、decision-log、progress（仅文档） |
| Task 2 | 引入 Naive UI 基础壳 | naive-ui、n-config-provider、n-message-provider、浅色高级科技感基础布局 |
| Task 3 | 扩展数据类型与默认值 | types.ts 新增 4 结构 + JobRecord 字段、旧数据兼容 |
| Task 4 | 公司与机会补充表单 | BattlefieldPage 公司 / 通勤 / 备注字段 |
| Task 5 | One-Shot Prompt 升级 | buildAnalysisPrompt 输出 Markdown + OFFER_FLOW_JSON |
| Task 6 | OFFER_FLOW_JSON 解析器 | offerFlowJson.ts + opportunityScore.ts |
| Task 7 | AI 原文保存时自动解析 | 保存即解析回填、失败不清空 |
| Task 8 | 机会雷达卡 + SVG 组件 | OpportunityRadarChart.vue + 雷达卡 |
| Task 9 | 列表页升级与筛选排序 | 机会分 / 公司规模列 + 筛选排序 |
| Task 10 | 文档与 release note | README、release note、progress |

> 说明：原始开工指令将两项新决策标注为 DEC-015 / DEC-016，但 DEC-015 已被「品牌重命名」占用，故本版顺延为 DEC-016（JSON 解析）/ DEC-017（Naive UI）。
