# OfferFlow v0.5：轻量 Spec Guard

## 1. 最终定位

> Vibe Coding 负责快，Spec Guard 负责稳。OfferFlow 不把 Spec Coding 作为日常开发流程，只把它用于核心规则、数据迁移、状态流转、AI 输出解析等高风险场景。

v0.5 不继续扩展重型 Spec-Coding Lab 工具链。

`spec-lab/` 保留为一次实验样本：它证明 `deriveDecision` 这类规则可以被 YAML、测试、差分门禁和 trace 约束。但它不是后续日常开发入口，也不是要把 OfferFlow 改造成完整 Spec Coding 平台。

## 2. 为什么从 Spec-Coding Lab 降级为 Spec Guard

这次实验暴露了一个真实问题：

```txt
目录、YAML、gate、trace 对个人项目日常开发来说认知负担过高。
```

OfferFlow 当前更需要保持开发速度，而不是把每个功能都纳入重流程。

所以 v0.5 的合理收口不是继续加 CLI、DSL 或平台化能力，而是沉淀一套轻量规则卡：

```txt
情况 A 怎么处理
情况 B 怎么处理
情况 C 怎么处理
哪些情况绝对不允许发生
```

用户只审中文规则卡。AI 负责把规则卡转成测试、YAML、门禁或代码。

## 3. 日常开发模式

### 继续 Vibe Coding 的场景

这些场景继续直接开发，不需要规则卡：

- 页面样式
- 布局调整
- 普通交互
- 展示文案微调
- 小范围 UI bug
- 一次性内部脚本
- 不影响历史数据和核心业务判断的改动

### 需要 Spec Guard 的场景

这些场景先写中文规则卡，再开发：

- 核心决策规则，例如 `deriveDecision`
- AI 输出解析，例如 `OFFER_FLOW_JSON`
- 数据迁移，例如 localStorage 导入 SQLite
- 状态枚举和状态流转
- 历史数据解释规则
- 统计口径和分组口径
- 出错后很难靠肉眼发现的问题

## 4. 轻量流程

```txt
1. 用户说人话需求
2. AI 产出中文规则卡
3. 用户只确认 A/B/C 情况是否符合预期
4. AI 根据风险决定是否转成测试 / YAML / gate
5. AI 写代码
6. 跑对应自测
7. 必要时记录 decision-log / progress
```

用户不需要写 YAML，不需要设计 gate，也不需要理解 trace 结构。

用户只需要回答：

```txt
这些情况是不是对？
有没有漏掉的情况？
哪些情况绝对不允许发生？
```

## 5. 本次沉淀的规则卡

| 规则卡 | 来源 | 适合原因 |
|---|---|---|
| [schemaHash 稳定性](rule-cards/01-schema-hash-stability.md) | activity-config-miniapp | 配置变更后历史数据不能串味 |
| [表单校验 reason](rule-cards/02-validation-reason.md) | activity-config-miniapp | 服务端二次校验和低基数 reason 口径清晰 |
| [OFFER_FLOW_JSON 解析兜底](rule-cards/03-offer-flow-json-fallback.md) | OfferFlow | AI 输出不稳定，需要稳住原文和解析结果 |
| [deriveDecision 核心决策规则](rule-cards/04-derive-decision.md) | OfferFlow | 核心业务决策必须限制规则漂移 |

## 6. 与 spec-lab 的关系

`spec-lab/` 仍保留。

它的定位是：

```txt
高风险规则保险箱样本
```

它不做：

- 不作为日常开发入口
- 不继续扩展复杂 CLI
- 不设计通用 DSL
- 不接主 App
- 不替换主 App 内的 `deriveDecision`
- 不要求每次开发都写 YAML

后续如果某个规则风险足够高，可以先写中文规则卡，再由 AI 判断是否值得放进类似 `spec-lab` 的门禁里。

## 7. 判断标准

一句话判断：

```txt
错了只是页面不好看：Vibe Coding。
错了会污染数据、规则、状态或统计口径：Spec Guard。
```

Spec Guard 不是为了显得流程完整，而是为了防止 AI 在关键规则上“顺手改多了”。
