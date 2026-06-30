# OfferFlow 规格化编码实验样本

OfferFlow 规格化编码实验样本是一个独立实验目录，用真实 `deriveDecision` 规则验证最小“规格到代码”流水线。

它现在的定位已经收口为：

```txt
高风险规则保险箱样本
```

它不是 OfferFlow 的日常开发入口，也不是要把 OfferFlow 改造成完整 Spec Coding 平台。

日常开发继续以 Vibe Coding 为主。只有核心规则、数据迁移、状态流转、AI 输出解析等高风险场景，才先写中文规则卡；必要时再由 AI 转成 YAML、测试或门禁。

```txt
规则变更
-> YAML 规格
-> 生成实现
-> 差分门禁：未声明差异 = 0
-> 留痕：人工审查已批准
```

这不是 AI 乱写代码，而是一次受规格、测试、门禁和人工确认约束的业务规则演进样本。

完整的轻量定位说明见：

```txt
../docs/v0.5/spec-guard.md
../docs/v0.5/rule-cards/
```

## 为什么做

OfferFlow 已经有真实业务上下文：沟通状态、跟进次数、冷却时间、高价值机会、止损纪律。v0.5.0 不新增主应用功能，而是把其中一条规则抽出来，证明 AI 生成代码可以被工程流程约束。

但本次实验也确认了一点：完整 YAML / gate / trace 流程不适合作为个人日常开发流程。后续只把它作为高风险规则的样本和保险箱。

## 随性编码的问题

只让 AI 直接写代码，容易出现需求漂移、隐性扩大范围、测试缺口和无法复盘。尤其是业务规则演进，最危险的不是代码写不出来，而是改动范围不清楚。

## 规格化编码的价值

本实验把业务变更先写进基于示例的 YAML，再用生成实现、一致性测试、差分门禁和运行留痕形成闭环。旧实现是行为基线，YAML 示例是人工确认的规则真理来源，差分门禁负责确认新旧差异只发生在声明范围内。

后续 OfferFlow 不要求每次开发都这样做。更轻的方式是先写中文规则卡，让用户确认 A/B/C 情况，再按风险决定是否进入测试、YAML 或门禁。

## 流水线

```txt
业务规则需求
-> 基于示例的 YAML 规格
-> 提示词模板
-> 手动模式生成代码/测试
-> 一致性测试
-> 差分门禁
-> 人工审查
-> 留痕 JSON
-> README 展示
```

## deriveDecision 背景

`deriveDecision` 根据岗位沟通状态、跟进次数、最近动作时间、高价值信号和报告评分，派生策略、下一步动作、止损判断和话术场景。它是纯函数，适合做规则实验。

## v0.5.0 规则变更

旧规则：

```txt
communicationStatus = greeted_read_no_reply
followupCount = 0
scenario = follow_up_with_new_angle
```

新规则：

```txt
communicationStatus = greeted_read_no_reply
followupCount = 0
highValueSignal = true
scenario = follow_up_with_value_angle
```

这只改变 `scenario`，不改变 `MAX_FOLLOWUPS = 2`，不鼓励多追一次。

## YAML 规格示例

```yaml
rule: deriveDecision
version: v0.5.0
constants:
  FOLLOWUP_COOLDOWN_DAYS: 3
  MAX_FOLLOWUPS: 2

cases:
  - id: read-no-reply-high-value-followup
    when:
      communicationStatus: greeted_read_no_reply
      followupCount: 0
      highValueSignal: true
      reportScore: high
      now: 2026-06-30T10:00:00+08:00
    then:
      strategy: main_attack
      nextAction: follow_up_with_new_angle
      stopLoss: continue
      scenario: follow_up_with_value_angle
```

完整规格在 `spec/derive-decision.yaml`，共 14 个示例。

## 生成产物

- `generated/deriveDecision.generated.ts`：手动模式生成实现，文件头标记为生成文件。
- `generated/deriveDecision.generated.spec.ts`：手动模式生成测试样本。
- 生成代码不导入主应用，不使用 `Date.now()`，不从运行环境读取当前时间。

## 一致性测试

命令：

```bash
pnpm test:conformance
```

结果要求：

```txt
passed = true
casesChecked = 14
failed = 0
```

## 差分门禁

命令：

```bash
pnpm gate:diff
```

结果要求：

```txt
passed = true
unexpectedMismatches.length = 0
declaredChangesConfirmed = true
```

只允许以下输入出现行为基线与生成实现的差异：

```txt
communicationStatus === greeted_read_no_reply
followupCount === 0
highValueSignal === true
```

## 留痕示例

留痕文件：

```txt
traces/2026-06-30-derive-decision-001.json
```

关键字段：

```json
{
  "target": "deriveDecision",
  "mode": "manual",
  "qualityGate": {
    "conformance": { "passed": true },
    "differential": {
      "passed": true,
      "declaredChangesConfirmed": true,
      "unexpectedMismatches": []
    }
  },
  "humanReview": {
    "decision": "approved",
    "reviewer": "wjj"
  },
  "promotion": {
    "promoted": false
  },
  "finalStatus": "passed"
}
```

本次 v0.1 验收使用固定 trace 文件名，重跑 `trace:write` 会覆盖该文件。真实规则演进时应新增不可变 trace。

## 为什么 v0.1 不接 LLM API

本实验验证的是规格、测试、门禁、人工确认和留痕的工程链路，不验证模型调用能力。接入真实大模型接口会引入密钥、费用、稳定性和权限问题，反而模糊本次目标。

## 为什么 v0.1 不接入主应用

`spec-lab/` 是独立实验层，不是 OfferFlow 主应用功能。生成实现不会替换 `src/decision/deriveDecision.ts`，留痕也不会写数据库。这样可以避免实验污染 v0.4 主线。

## 为什么不继续扩展成平台

本目录已经证明规则级 Spec 可以工作，但继续增加 CLI、通用 DSL、Trace Viewer 或自动生成链路，会让个人项目的认知成本过高。

OfferFlow 后续采用更轻的 Spec Guard：

```txt
Vibe Coding 负责快，Spec Guard 负责稳。
```

`spec-lab/` 保留，但不继续扩展工具链。

## 运行

```bash
cd spec-lab
pnpm verify
```

`verify` 会依次运行：

```txt
spec:validate
test:conformance
gate:diff
trace:write
```

## 未来演进

- 日常功能继续 Vibe Coding。
- 高风险规则先写中文规则卡。
- 只有确实需要防止规则漂移时，才参考本目录加测试、YAML 或差分门禁。
- 不继续扩展复杂 CLI、通用 DSL 或完整 Spec Coding 平台。
