# Case 010：接近真实的长回复噪音

模拟真实 AI 长回复：先分析岗位、公司、风险和沟通策略，再输出最终结构化 JSON。最终应解析成功。

下面是我的判断。

## 1. 岗位真实画像

某 AI 平台团队的 JD 表面上写了 AI，但前端职责主要是管理后台、配置平台、模型任务看板和数据可视化。它更像“复杂中后台 + AI 业务场景加分”，不是算法岗，也不是后端主力岗。

## 2. 机会与风险

机会在于可以讲 Vue3、TypeScript、复杂表单、配置化和 AI 提效流程。风险在于 JD 可能要求一定 Node 能力，需要确认是否只是前端协作还是后端主力。

## 3. 建议动作

可以进入主攻池，但 Boss 开场不要夸大成 AI 全栈负责人，应说自己能把 AI 工具落到真实业务流程里。

补充：以下 JSON 是给系统解析的最终结构化结果。

---OFFER_FLOW_JSON_START---
{
  "version": "0.2.0",
  "matchScore": 84,
  "companyAssessment": {
    "sizeTier": "medium",
    "staffRange": "200-600人",
    "companyType": "AI 平台团队",
    "financingStage": "B轮或以上",
    "stabilityLevel": "medium",
    "growthPotential": "high",
    "summary": "某 AI 平台团队岗位偏复杂中后台和 AI 业务工具，适合用前端工程化与 AI Workflow 经验切入。",
    "confidence": "medium"
  },
  "opportunityAnalysis": {
    "opportunityScore": 82,
    "opportunityRadar": {
      "salaryScore": 82,
      "stabilityScore": 74,
      "growthScore": 88,
      "matchScore": 84,
      "commuteScore": 72,
      "riskControlScore": 78
    },
    "applyAdvice": "strongly",
    "riskLevel": "medium",
    "decisionSummary": "适合重点沟通，但必须确认后端和 LLM API 职责边界。",
    "interviewFocus": ["讲清 AI Workflow 工程化项目", "讲清 Vue3/TS 中后台经验", "说明后端边界和协作方式"],
    "bossGreeting": "你好，我有多年 Vue/TypeScript 中后台经验，也做过 AI Workflow 工程化工具。如果这个岗位偏前端平台和 AI 业务工具，我比较匹配，想进一步了解。"
  }
}
---OFFER_FLOW_JSON_END---

以上结论仍需要你结合通勤、薪资、团队规模做人工确认，不建议自动投递。