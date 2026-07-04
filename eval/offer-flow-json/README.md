# OFFER_FLOW_JSON Eval

## 1. Eval 目标

验证 `OFFER_FLOW_JSON` 结构化输出协议在真实 AI 返回噪音中的解析稳定性。

这些样本是工程化评估样本，不代表真实招聘数据；公司和岗位均使用匿名或合成描述。

## 2. 为什么需要 Eval

AI 输出不可完全信任。即使 Prompt 已约束模型输出固定 JSON，真实返回仍可能出现 Markdown 解释文字、代码块、多个 JSON 块、字段缺失、枚举异常、分数越界、非法 JSON 或完全无结构化数据。

Eval 用样本集验证：

- 是否可解析。
- 是否能识别缺失。
- 是否能降级为 `partial`、`invalid_json` 或 `not_found`。
- 是否能避免坏输出覆盖旧数据。
- 是否能为 Prompt 迭代提供依据。

## 3. 覆盖场景表

| caseId | 场景 | 预期状态 | 风险类型 | 面试表达价值 |
|---|---|---|---|---|
| 001-happy-path | 标准 Markdown + START/END 标记 + 完整 JSON | success | 基线能力 | 证明标准协议可稳定解析 |
| 002-markdown-with-json-block | 大量 Markdown 分析后输出标记包裹 JSON | success | AI 文本噪音 | 证明真实报告式输出不影响解析 |
| 003-missing-markers-but-json-codeblock | 无 START/END，但最后一个 json 代码块合法 | success | 标记缺失 | 证明代码块兜底策略有效 |
| 004-invalid-json | 有标记但 JSON 语法错误 | invalid_json | 语法错误 | 证明坏 JSON 不会被包装成成功 |
| 005-partial-required-fields | JSON 合法但缺少 `companyAssessment` | partial | 字段缺失 | 证明缺关键对象会降级并保留可用部分 |
| 006-score-out-of-range | 维度分数出现 120、-5、字符串百分比 | success | 分数越界/类型变化 | 证明分数归一与 warning 行为 |
| 007-invalid-enum-values | 枚举值超出协议 | partial | 枚举漂移 | 证明非法枚举会归一并降级 |
| 008-multiple-json-blocks | 多个 json 代码块，最后一个才是协议输出 | success | 多 JSON 噪音 | 证明 parser 按最后一个 json 代码块兜底 |
| 009-no-structured-json | 纯自然语言，没有 JSON | not_found | 无结构化输出 | 证明系统能识别不可解析输出 |
| 010-realistic-noisy-ai-response | 长回复、有说明、有最终合法 JSON | success | 真实 AI 噪音 | 证明接近真实使用形态可解析 |

## 4. 运行方式

```bash
npm.cmd run eval:offerflow-json
```

## 5. 和 selftest 的区别

- selftest 偏 parser 规则正确性，直接验证函数行为和边界条件。
- eval 偏真实 AI 输出形态覆盖，样本是完整 Markdown/自然语言/代码块混合返回。
- 两者共同证明 AI 输出协议不是只靠人工感觉，而是有工程质量闸门。

## 6. 面试表达

我没有只做 Prompt，而是给 AI 输出协议补了 Eval 样本。因为真实模型返回经常带 Markdown、解释文字、错误枚举、缺字段或多个 JSON 块，所以我用 10 个样本覆盖 `success`、`partial`、`invalid_json`、`not_found` 等路径，确保系统能稳定解析、降级和保留原文，避免坏输出直接污染业务数据。