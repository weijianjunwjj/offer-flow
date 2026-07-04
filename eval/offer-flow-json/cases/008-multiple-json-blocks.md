# Case 008：多个 json 代码块

模拟模型先展示一个无关 schema 示例，最后才给真正的 `OFFER_FLOW_JSON`。没有 START/END 标记时，parser 应选择最后一个 json 代码块。

先给一个错误示例，不要解析这个：

```json
{
  "demo": true,
  "message": "这个不是 OfferFlow 协议"
}
```

最终结构化结果如下：

```json
{
  "version": "0.2.0",
  "matchScore": 77,
  "companyAssessment": {
    "sizeTier": "medium",
    "staffRange": "300-800人",
    "companyType": "数据中台团队",
    "financingStage": "未明确",
    "stabilityLevel": "medium",
    "growthPotential": "medium",
    "summary": "某数据中台团队，岗位与 Vue、配置化和可视化相关。",
    "confidence": "medium"
  },
  "opportunityAnalysis": {
    "opportunityScore": 74,
    "opportunityRadar": {
      "salaryScore": 76,
      "stabilityScore": 72,
      "growthScore": 75,
      "matchScore": 77,
      "commuteScore": 70,
      "riskControlScore": 73
    },
    "applyAdvice": "ok",
    "riskLevel": "medium",
    "decisionSummary": "值得沟通，重点确认业务稳定性。",
    "interviewFocus": ["准备配置化页面案例", "准备数据可视化案例"],
    "bossGreeting": "你好，我有 Vue/TS 中后台、配置化和可视化经验，想了解这个岗位的前端职责。"
  }
}
```