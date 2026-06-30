# v0.5.0 变更集：高价值已读未回跟进场景

## 声明变更

当岗位已经被读取但没有回复：

```txt
communicationStatus = greeted_read_no_reply
followupCount = 0
highValueSignal = true
```

生成实现只改变：

```txt
scenario: follow_up_with_new_angle -> follow_up_with_value_angle
```

## 不变量

- `FOLLOWUP_COOLDOWN_DAYS` 保持为 `3`。
- `MAX_FOLLOWUPS` 保持为 `2`。
- `nextAction` 保持为 `follow_up_with_new_angle`。
- 规则不鼓励多跟进一次。
- 规则只让高价值机会的跟进角度更精准。

## 差分门禁策略

允许出现差异的条件：

```ts
communicationStatus === 'greeted_read_no_reply' &&
followupCount === 0 &&
highValueSignal === true
```

其他任何行为基线与生成实现的差异都属于未声明差异，必须让门禁失败。
