# Case 004：标记存在，但 JSON 语法错误

模拟模型输出了标记，但 JSON 缺逗号，应该返回 `invalid_json`。

---OFFER_FLOW_JSON_START---
{
  "version": "0.2.0",
  "matchScore": 80
  "companyAssessment": {
    "sizeTier": "medium"
  }
}
---OFFER_FLOW_JSON_END---