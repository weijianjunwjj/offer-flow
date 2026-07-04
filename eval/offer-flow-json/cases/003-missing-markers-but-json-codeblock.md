# Case 003：缺少 START/END 标记，但有 json 代码块

模拟模型忘记输出 `OFFER_FLOW_JSON_START/END`，但最后给了一个合法 `json` 代码块。

我先给结论：这是一个可以低成本试探的岗位，适合验证对方是否真的需要复杂前端能力。

```json
{
  "version": "0.2.0",
  "matchScore": 69,
  "companyAssessment": {
    "sizeTier": "medium",
    "staffRange": "200-500人",
    "companyType": "企业服务",
    "financingStage": "B轮",
    "stabilityLevel": "medium",
    "growthPotential": "medium",
    "summary": "某企业服务团队，岗位有中后台信号，但 AI 方向真实性需要确认。",
    "confidence": "medium"
  },
  "opportunityAnalysis": {
    "opportunityScore": 66,
    "opportunityRadar": {
      "salaryScore": 68,
      "stabilityScore": 70,
      "growthScore": 64,
      "matchScore": 69,
      "commuteScore": 60,
      "riskControlScore": 65
    },
    "applyAdvice": "cautious",
    "riskLevel": "medium",
    "decisionSummary": "可低成本沟通，避免投入过深。",
    "interviewFocus": ["确认 AI 真实性", "确认前端职责边界"],
    "bossGreeting": "你好，我有 Vue/TS 中后台经验，想了解这个岗位前端职责和 AI 相关工作的实际占比。"
  }
}
```