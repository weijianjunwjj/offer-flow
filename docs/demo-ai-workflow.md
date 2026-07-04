# OfferFlow Demo：AI Workflow 工程化闭环

## 1. Demo 目标

这个 Demo 用来证明 OfferFlow 不是普通岗位台账，而是一个 AI Workflow 工程化样板。

演示重点不是“调用了哪个模型”，而是：

- 如何把 JD 分析拆成结构化输入。
- 如何约束外部 AI 输出 Markdown + `OFFER_FLOW_JSON`。
- 如何保存 AI 原文并做结构化解析。
- 如何在解析失败时保留旧数据和人工判断空间。
- 如何让用户确认状态和动作。
- 如何用 `deriveDecision` 派生下一步跟进建议。
- 如何用 selftest / Spec Guard 证明规则没有随意漂移。

## 2. Demo 链路

```txt
JD 输入
-> Prompt 生成
-> 外部 AI 分析
-> AI 原文粘贴
-> OFFER_FLOW_JSON 解析
-> 人工确认
-> communicationStatus 状态流转
-> deriveDecision 派生建议
-> selftest 验证
```

推荐演示步骤：

1. 启动项目：`npm run dev`。
2. 在岗位列表中新建或选择一个岗位。
3. 填入 JD、公司规模、公司类型、融资阶段、通勤、机会备注。
4. 在详情页生成 One-Shot Prompt。
5. 复制 Prompt 到外部 AI。
6. 要求外部 AI 返回 Markdown 报告和 `---OFFER_FLOW_JSON_START--- ... ---OFFER_FLOW_JSON_END---`。
7. 将完整返回粘贴回“外部 AI 结果原文”区域。
8. 保存 AI 原文。
9. 查看解析状态、机会雷达、匹配度、风险等级、面试关注点和 Boss 话术。
10. 在跟进决策面板查看 `deriveDecision` 输出的策略、下一步动作、话术场景和止损提示。
11. 修改 `communicationStatus`，观察下一步建议变化。
12. 运行 `npm.cmd run selftest`，验证存储、解析、评分和决策规则。

## 3. Demo 检查清单

- [ ] 是否能生成 One-Shot Prompt。
- [ ] 是否能保存 AI 原文。
- [ ] 是否能解析 `OFFER_FLOW_JSON`。
- [ ] 是否解析失败不覆盖旧数据。
- [ ] 是否能显示机会雷达。
- [ ] 是否能显示匹配度、风险点和面试关注点。
- [ ] 是否能显示跟进建议。
- [ ] 是否能修改 `communicationStatus`。
- [ ] 是否修改状态后 `deriveDecision` 输出会变化。
- [ ] 是否能运行 `npm.cmd run selftest`。

## 4. 面试官可能追问

### 1. 为什么不接 AI API？

当前目标是验证 AI 输出的结构化承接、解析、校验、人工确认和状态流转。先不接 API 可以避开 Key、费用、网络、模型差异和权限问题，把工程重点放在 Workflow 稳定性上。

### 2. 为什么不做全自动 Agent？

求职沟通是高影响动作，不能让 AI 直接替用户发送、投递或止损。OfferFlow 让 AI 做分析和初稿，系统做解析和建议，最终动作由人确认。

### 3. 怎么保证 AI 输出可靠？

Prompt 要求固定 `OFFER_FLOW_JSON` 协议；解析器做标记提取、json 代码块兜底、枚举归一、分数归一和 warnings；关键规则有 selftest 和 Spec Guard。

### 4. 解析失败怎么办？

保存 AI 原文不受影响。解析失败返回状态和 warning，不阻断保存，也不清空已有结构化字段。用户可以重新粘贴、手动判断或保留原文复盘。

### 5. 为什么要保留 AI 原文？

原文是审计和复盘依据。结构化字段可能解析失败或不完整，但原文可以保证后续重新解析、人工校对和面试讲解时有来源。

### 6. 状态机有什么价值？

`communicationStatus` 把“未沟通、已读未回、已回复、面试中、已结束”等事实状态收敛成有限集合，`deriveDecision` 可以基于这些事实稳定派生下一步动作，避免临时拍脑袋。

### 7. 这个项目和普通 CRUD 有什么区别？

普通 CRUD 只是保存岗位。OfferFlow 额外包含结构化 Prompt、AI 输出协议、原文兜底、JSON 解析、Human-in-the-loop、状态流转、派生决策和规则自测。

### 8. 后续怎么扩展到团队内部提效工具？

可以把“输入模板 -> AI 输出协议 -> 原文保存 -> 结构化解析 -> 人工确认 -> 状态流转 -> 规则自测”复用到需求评审、客服质检、销售线索分析、工单分流等内部场景。
