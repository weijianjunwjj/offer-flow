# Case 005：合法 JSON，但缺少关键对象

模拟模型只给了机会分析，漏掉 `companyAssessment`。这类输出不应失败，但应降级为 `partial`。

外部 AI 判断：岗位有一定机会，但公司信息不足。

---OFFER_FLOW_JSON_START---
{
  "version": "0.2.0",
  "matchScore": 71,
  "opportunityAnalysis": {
    "opportunityScore": 68,
    "opportunityRadar": {
      "salaryScore": 72,
      "stabilityScore": 60,
      "growthScore": 66,
      "matchScore": 71,
      "commuteScore": 64,
      "riskControlScore": 62
    },
    "applyAdvice": "cautious",
    "riskLevel": "medium",
    "decisionSummary": "公司画像缺失，建议只做低成本确认。",
    "interviewFocus": ["补充公司规模", "确认团队稳定性"],
    "bossGreeting": "你好，我对这个前端岗位感兴趣，想了解一下团队和业务情况。"
  }
}
---OFFER_FLOW_JSON_END---