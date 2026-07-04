# OfferFlow Demo：AI Workflow 工程化闭环

## 1. Demo 目标

这个 Demo 用来证明 OfferFlow 不是普通岗位台账，而是一个 AI Workflow 工程化样板。

核心证明点：OfferFlow 能把 AI 输出从“自然语言建议”变成“可解析、可确认、可追踪、可验证”的工作流。

演示重点不是“调用了哪个模型”，而是：

- 如何把 JD 分析拆成结构化输入。
- 如何用截图粘贴和手动 OCR 入口降低 JD 录入成本，但不自动触发后续 AI Workflow。
- 如何约束外部 AI 输出 Markdown + `OFFER_FLOW_JSON`。
- 如何保存 AI 原文并做结构化解析。
- 如何在解析失败时保留旧数据和人工判断空间。
- 如何让 AI / 导入结果先进入 `pending_review`，再由用户确认、暂缓或拒绝。
- 如何用 `deriveDecision` 派生下一步跟进建议。
- 如何用 selftest / Eval / Spec Guard 证明规则没有随意漂移。

## 2. Demo 链路

```txt
JD 输入 / 截图粘贴 / 导入
-> 用户手动点击转换文字（可选）
-> Prompt 生成
-> 外部 AI 分析
-> AI 原文粘贴
-> OFFER_FLOW_JSON 解析
-> pending_review 待人工确认
-> 用户选择确认 / 暂缓 / 拒绝
-> deriveDecision 根据 reviewStatus 和 communicationStatus 派生建议
-> selftest / eval 验证
```

推荐演示步骤：

1. 启动项目：`npm run dev`。
2. 在岗位列表中新建或选择一个岗位。
3. 填入 JD、公司规模、公司类型、融资阶段、通勤、机会备注；新建岗位默认城市为苏州，公司类型为自研业务，融资阶段为未融资 / 不明确。
4. 可直接在岗位 JD 输入区粘贴一张或多张 Boss JD 截图，确认截图进入待转换列表。
5. 点击“转换文字”后才调用 OCR adapter；截图粘贴本身不会自动生成 Prompt 或分析。
6. 在详情页生成 One-Shot Prompt。
7. 复制 Prompt 到外部 AI。
8. 要求外部 AI 返回 Markdown 报告和 `---OFFER_FLOW_JSON_START--- ... ---OFFER_FLOW_JSON_END---`。
9. 将完整返回粘贴回“外部 AI 结果原文”区域。
10. 保存 AI 原文。
11. 查看 `OFFER_FLOW_JSON` 解析状态、机会雷达、匹配度、风险等级、面试关注点和 Boss 话术。
12. 查看 `pending_review` 待人工确认标识和 Review 面板。
13. 选择确认进入机会 / 暂缓观察 / 拒绝关闭。
14. 在跟进决策面板查看 `deriveDecision` 如何根据 `reviewStatus` 和 `communicationStatus` 输出策略、下一步动作、话术场景和止损提示。
15. 修改 `communicationStatus`，观察下一步建议变化。
16. 运行 `npm.cmd run selftest` 和 `npm.cmd run eval:offerflow-json`，验证存储、解析、评分、决策、Review 状态流转和 AI 输出样本稳定性。

## 3. Demo 检查清单

- [ ] 是否能生成 One-Shot Prompt。
- [ ] 新建岗位是否默认城市苏州、公司类型自研业务、融资阶段未融资 / 不明确。
- [ ] 是否能在岗位 JD 输入区粘贴多张截图并累积。
- [ ] 是否能展示待转换截图预览、大小 / 序号、状态和删除按钮。
- [ ] 是否只有点击“转换文字”后才调用 OCR adapter。
- [ ] 截图粘贴和 OCR 失败是否都不会自动生成 Prompt、自动分析或改变状态。
- [ ] 是否能保存 AI 原文。
- [ ] 是否能解析 `OFFER_FLOW_JSON`。
- [ ] 是否解析失败不覆盖旧数据。
- [ ] 是否能识别 `pending_review`。
- [ ] 是否能展示 Review 面板。
- [ ] 是否能确认进入机会。
- [ ] 是否能暂缓观察。
- [ ] 是否能拒绝关闭。
- [ ] 是否确认前不会自动建议主动跟进。
- [ ] 是否 reject 后保留 `aiRawResult` / `importedDraft` / `parseStatus`。
- [ ] 是否能显示机会雷达。
- [ ] 是否能显示匹配度、风险点和面试关注点。
- [ ] 是否能显示跟进建议。
- [ ] 是否能修改 `communicationStatus`。
- [ ] 是否修改状态后 `deriveDecision` 输出会变化。
- [ ] 是否能运行 `npm.cmd run selftest`。
- [ ] 是否 `scripts/reviewWorkflow.selftest.ts` 通过。
- [ ] 是否 `npm.cmd run eval:offerflow-json` 通过。

## 4. 面试官可能追问

### 1. 为什么不接 AI API？

当前目标是验证 AI 输出的结构化承接、解析、校验、人工确认和状态流转。先不接 API 可以避开 Key、费用、网络、模型差异和权限问题，把工程重点放在 Workflow 稳定性上。

### 2. 为什么不做全自动 Agent？

求职沟通是高影响动作，不能让 AI 直接替用户发送、投递或止损。OfferFlow 让 AI 做分析和初稿，系统做解析和建议，最终动作由人确认。

### 3. JD 截图 OCR 会不会触发 AI Workflow？

不会。截图粘贴只是录入体验增强，图片先进入当前编辑会话的待转换列表；只有用户点击“转换文字”才会调用 OCR adapter。OCR 结果也只是追加到岗位 JD 文本框，不会自动生成 Prompt、调用 AI、解析 `OFFER_FLOW_JSON` 或改变沟通状态。

### 4. 为什么 OCR 要做跨端 adapter？

OfferFlow 是本地优先工具，不能依赖 macOS Vision、Windows.Media.Ocr、AppleScript、PowerShell 或某个系统 App。页面只调用 `performJdImageOcr(file)`，后续可以替换为 Tesseract.js / PaddleOCR.js / 其他跨端方案，而不改变页面工作流。

### 5. 为什么当前不直接接入 Tesseract.js？

OCR 依赖可能带来包体积、首次加载、中文 traineddata、识别质量和跨端性能风险。v0.5.1 先打通粘贴、预览、删除、手动按钮和 adapter 边界；真正接入 OCR 引擎前需要单独评估并确认依赖。

### 6. 为什么要做 Human-in-the-loop？

AI 和导入器擅长提取信息、生成初稿和给出建议，但是否采纳、是否沟通、是否关闭机会属于高影响动作。OfferFlow 把 AI 结果先放进 `pending_review`，让用户确认、暂缓或拒绝，避免模型输出绕过人直接改变业务状态。

### 7. pending_review 为什么不能直接 send_greeting？

`pending_review` 代表这条机会还只是草稿或待确认事实。即使 AI 判断“值得主攻”，系统也只能派生 `manual_review` / 先人工确认，不能直接变成 `send_greeting`，否则就把建议变成了自动动作。

### 8. confirm / defer / reject 分别影响什么？

`confirm` 将 `reviewStatus` 置为 `confirmed`，让机会进入正常 `deriveDecision` 流程；如果导入草稿原本是 `paused`，会回到 `not_contacted`，但不会变成已打招呼。`defer` 将 `reviewStatus` 置为 `deferred` 并保持 `paused` 观察。`reject` 将 `reviewStatus` 置为 `rejected`，`communicationStatus` 进入 `rejected`，同时保留 `aiRawResult` / `importedDraft` / `parseStatus`。

### 9. 如何证明人工确认状态不会乱跳？

`src/review/reviewWorkflow.ts` 是纯函数，`scripts/reviewWorkflow.selftest.ts` 覆盖待确认识别、可用动作、确认、暂缓、拒绝、终态保护和原文保留；`scripts/decision.selftest.ts` 额外覆盖 `pending_review` 不会直接进入主动跟进。

### 10. 怎么保证 AI 输出可靠？

Prompt 要求固定 `OFFER_FLOW_JSON` 协议；解析器做标记提取、json 代码块兜底、枚举归一、分数归一和 warnings；关键规则有 selftest 和 Spec Guard。

### 11. 解析失败怎么办？

保存 AI 原文不受影响。解析失败返回状态和 warning，不阻断保存，也不清空已有结构化字段。用户可以重新粘贴、手动判断或保留原文复盘。

### 12. 为什么要保留 AI 原文？

原文是审计和复盘依据。结构化字段可能解析失败或不完整，但原文可以保证后续重新解析、人工校对和面试讲解时有来源。

### 13. 状态机有什么价值？

`communicationStatus` 把“未沟通、已读未回、已回复、面试中、已结束”等事实状态收敛成有限集合，`deriveDecision` 可以基于这些事实稳定派生下一步动作，避免临时拍脑袋。

### 14. 这个项目和普通 CRUD 有什么区别？

普通 CRUD 只是保存岗位。OfferFlow 额外包含结构化 Prompt、AI 输出协议、原文兜底、JSON 解析、Human-in-the-loop、状态流转、派生决策和规则自测。

### 15. 后续怎么扩展到团队内部提效工具？

可以把“输入模板 -> AI 输出协议 -> 原文保存 -> 结构化解析 -> 人工确认 -> 状态流转 -> 规则自测”复用到需求评审、客服质检、销售线索分析、工单分流等内部场景。
