# 提示词：从规格生成测试

为 `generated/deriveDecision.generated.ts` 生成一致性测试。

测试要求：

- 覆盖 `spec/derive-decision.yaml` 中的每一个用例。
- 将完整输出对象与每个用例的 `then` 比较。
- 覆盖高价值已读未回的声明变更。
- 增加源码守卫，确认生成源码不包含 `Date.now()` 或当前时间构造。
- 不调用 OfferFlow 主应用。
- 不导入存储、SQLite、Tauri 或界面代码。
