# 提示词：从规格生成类型

读取 `spec/derive-decision.yaml`，为 v0.5.0 `deriveDecision` 规则生成 TypeScript 类型。

约束：

- 以基于示例的 YAML 作为用例来源。
- 输入形状只保留 PRD 指定字段。
- 输出字段只保留 `strategy`、`nextAction`、`stopLoss`、`scenario` 和可选 `companyWarning`。
- 不导入 OfferFlow 主应用。
- 不引入 OpenAPI、Gherkin、Cucumber 或通用 DSL。

期望类型：

```ts
CommunicationStatus
ReportScore
DeriveDecisionInput
DeriveDecisionOutput
```
