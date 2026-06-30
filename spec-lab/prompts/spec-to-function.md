# 提示词：从规格生成函数

根据 `spec/derive-decision.yaml` 和 `spec/changeset-v0.5.0.md` 生成 `generated/deriveDecision.generated.ts`。

硬约束：

- 添加文件头 `// GENERATED FILE - DO NOT EDIT DIRECTLY`。
- 不从 `src/`、store、SQLite、Tauri 或 OfferFlow 主应用导入。
- 不调用真实大模型接口。
- 不调用 `Date.now()`。
- 不在函数内部创建当前时间。
- 所有时间计算都使用输入字段 `now`。
- 保持 `FOLLOWUP_COOLDOWN_DAYS = 3`。
- 保持 `MAX_FOLLOWUPS = 2`。
- 只改变已声明的高价值已读未回 `scenario`。

声明变更：

```txt
greeted_read_no_reply + followupCount 0 + highValueSignal true
scenario = follow_up_with_value_angle
```
