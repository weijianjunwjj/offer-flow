# 规则卡 03：OFFER_FLOW_JSON 解析兜底

来源项目：

```txt
<workspace>
```

参考文件：

```txt
src/app/offerFlowJson.ts
scripts/offerFlowJson.selftest.ts
docs/v0.2/requirements.md
```

## 一句话说明

外部 AI 返回内容不稳定，所以系统必须先保存原文，再尽力解析固定 JSON。解析失败不能阻断保存，也不能清空旧数据。

## 人类规则卡

| 情况 | AI 原文 / JSON | 期望结果 | 状态 |
|---|---|---|---|
| A | 存在 `OFFER_FLOW_JSON_START` 和 `OFFER_FLOW_JSON_END` | 优先解析标记之间内容 | 视解析结果而定 |
| B | 没有标记，但有多个 `json` 代码块 | 取最后一个 `json` 代码块 | 视解析结果而定 |
| C | 找不到任何 JSON | 返回空结果，不抛异常 | `not_found` |
| D | JSON 语法错误 | 返回空结果和错误提示，不抛异常 | `invalid_json` |
| E | JSON 顶层不是对象 | 返回空结果和错误提示 | `invalid_json` |
| F | 枚举值非法 | 归为 `unknown` 或空值，并记录 warning | `partial` |
| G | 分数超出 0-100 | 归一到 0-100，并记录 warning | `success` 或 `partial` |
| H | 缺少 `opportunityScore` | 用 6 维雷达加权计算，并记录 warning | 不因该项降级 |
| I | `bossGreeting` 为空 | 保持为空，不伪造话术 | 视其他字段而定 |

## AI 执行规格

```txt
规则名：OFFER_FLOW_JSON 解析兜底

输入：
- aiRawResult: string

提取规则：
1. 优先提取 START / END 标记之间的内容。
2. 如果没有标记，提取最后一个 ```json 代码块。
3. 如果都没有，返回 not_found。

解析规则：
1. 空字符串返回 not_found。
2. JSON.parse 失败返回 invalid_json。
3. 顶层不是对象返回 invalid_json。
4. 缺少核心对象或枚举非法，返回 partial。
5. 分数统一归一为 0-100 整数。
6. opportunityScore 缺失时，用 6 维雷达加权计算。
7. bossGreeting 为空时保持为空，不生成假话术。

必须满足：
- 任何输入都不能抛未捕获异常。
- 解析失败不能阻断原文保存。
- warnings 要说明缺失、非法或归一化原因。

禁止：
- 禁止因为解析失败清空已有岗位数据。
- 禁止伪造 bossGreeting。
- 禁止接真实 AI API。
- 禁止把 partial 当成完整成功。
```

## 适合 Spec Guard 的原因

AI 输出最容易漂移。这个案例把“怎么兜底”写成规则卡，既能让人审，也能让 AI 生成测试。
