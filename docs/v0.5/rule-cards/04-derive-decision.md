# 规则卡 04：deriveDecision 核心决策规则

来源项目：

```txt
D:\VSCode\offer-pilot
```

参考文件：

```txt
src/decision/deriveDecision.ts
scripts/decision.selftest.ts
spec-lab/spec/derive-decision.yaml
```

## 一句话说明

`deriveDecision` 根据岗位事实派生策略、下一步动作、止损判断和话术场景。它是 OfferFlow 的核心规则，不应该被日常改动顺手扩大范围。

## 人类规则卡

| 情况 | 输入事实 | 期望结果 | 禁止越界 |
|---|---|---|---|
| A | 未沟通 + 高匹配报告 | 主攻，下一步打招呼，使用首次打招呼场景 | 不自动发送，不接 API |
| B | 未沟通 + 低匹配 + 高价值信号 | 低成本试探，下一步打招呼，使用高薪低匹配试探场景 | 不把低匹配强行改成主攻 |
| C | 已打招呼未读 + 未过冷却期 | 等待，不跟进 | 不绕过冷却期 |
| D | 已打招呼未读 + 过冷却期 + 跟进 0 次 | 可跟进一次 | 不超过最大跟进次数 |
| E | 已读未回 + 跟进 0 次 + 普通机会 | 换角度跟进 | 不增加跟进次数 |
| F | 已读未回 + 跟进 0 次 + 高价值机会 | 仍然换角度跟进，但话术场景改为价值角度 | 不把最大跟进次数从 2 改成 3 |
| G | 跟进次数达到 2 次 | 止损，下一步关闭机会 | 不鼓励继续追 |
| H | 已回复 | 继续沟通 | 不给止损建议 |
| I | 面试中 | 准备面试 | 不退回打招呼 |
| J | 已结束 / 已拒绝 | 无下一步 | 不再生成跟进行动 |

## AI 执行规格

```txt
规则名：deriveDecision 核心决策

输入：
- communicationStatus
- followupCount
- lastGreetedAt
- lastFollowupAt
- highValueSignal
- report / opportunityAnalysis
- allJobs 可选，用于同公司只读预警

处理：
1. 终态 closed / rejected 返回无下一步。
2. replied 返回继续沟通。
3. interviewing 返回准备面试。
4. paused 返回暂停观察。
5. not_contacted 根据报告建议和 highValueSignal 判断是否打招呼。
6. greeted_unread 受冷却期和 followupCount 约束。
7. greeted_read_no_reply + followupCount 0 可以换角度跟进。
8. followupCount >= MAX_FOLLOWUPS 时必须止损。
9. companyWarning 只从 allJobs 派生，不写入 JobRecord。

必须满足：
- FOLLOWUP_COOLDOWN_DAYS = 3。
- MAX_FOLLOWUPS = 2。
- strategy / nextAction / stopLoss / scenario / companyWarning 都是派生结果。
- 派生结果不落库。
- 纯函数不访问 storage，不发网络请求。

禁止：
- 禁止新增 Company / Contact / Message / FollowupLog 实体。
- 禁止保存派生决策字段。
- 禁止自动发送 Boss 消息。
- 禁止接 AI API / BYOK。
- 禁止把高价值机会解释成“多追一次”。
```

## 适合 Spec Guard 的原因

这是 OfferFlow 最容易规则漂移的地方。用户只要确认 A/B/C 情况表，AI 再负责实现和自测。只有当规则变更风险较高时，才需要进一步转成 YAML、差分门禁或 trace。
