# Desktop Budget Gateway —— 实验终止归档

> **状态**：终止 / 不继续开发
> **归档日期**：2026-08-04
> **关联**：[总体架构书 §15](../../architecture/dual-model-relay-architecture.md#15-已废弃-gateway-路线)
> **原始归档**：[scripts/ccAuto/experiments/desktop-budget-gateway-abandoned/ABANDONED.md](../../../scripts/ccAuto/experiments/desktop-budget-gateway-abandoned/ABANDONED.md)

---

## 1. 概述

Desktop Budget Gateway 是一个已终止的实验，目标是为 Claude Desktop 用户提供可感知的 Token 费用与预算控制。该实验在 Claude Desktop 与上游服务之间插入 HTTP 代理，通过 SSE 流解析和 content block 注入来展示费用信息。

**该路线已于 2026-08-04 正式终止。**

---

## 2. 原始目标

- 实时 Token 用量统计
- 人民币费用计算（按模型定价表）
- 任务级 + 每日预算门闸
- 模型费用占比报告
- 双模型（scout/builder）任务分工与费用预测

---

## 3. 实验拓扑

实验期间尝试过多种链路拓扑，不只一种。最终桌面链路至少包括：

### 拓扑 A：单层代理 + 真实上游

```
Claude Desktop → Gateway(:15722) → CC Switch(:15721) → 上游 API
```

### 拓扑 B：双层代理 + Mock 上游

```
Claude Desktop → Gateway(:15722) → CC Switch(:15721) → Mock Upstream → Mock SSE Response
```

### 拓扑 C：CC Switch 旁路（短暂探索）

```
Claude Desktop → Gateway(:15722) → Mock / Provider（绕过 CC Switch）
```

Gateway 在以上拓扑中：
1. 解析 SSE 流，提取 `message_start` / `message_delta` 中的 usage 信息；
2. 按定价表计算费用；
3. 尝试向 SSE 流中注入 content block 显示费用信息；
4. 维护 session 级别的 turn 追踪和费用累计。

---

## 4. 终止原因

**维护成本、协议不确定性和收益不匹配。**

### 已确认

1. **Gateway 路线复杂度高**：多层代理（Claude Desktop → Gateway → CC Switch → 上游）引入了多个故障点。
2. **SSE 索引曾存在错误**：`content_block_stop` 的 index 序号在特定情况下与模型实际输出冲突。
3. **Desktop 实际未显示费用行**：注入的 content block 在 Claude Desktop UI 中不可见或被静默丢弃。
4. **多轮修复后收益仍低于维护成本**：经过多次迭代，费用显示的用户体验始终无法达到产品标准。
5. **项目已正式终止**：不再继续开发。

### 未完全确认

以下为实验期间观察到但未被事件级证据最终证实的问题——不将其作为确定根因写入终止理由：

1. **费用 content block 最终在哪一层被丢弃**——可能是 Claude Desktop、CC Switch 或两者的组合。未逐层独立复现。
2. **CC Switch 是否重组了 SSE 事件**——可能导致 Gateway 注入的 content block 被覆盖或移除。未在 CC Switch 版本级别上验证。
3. **Claude Desktop 对新增 content block 的完整内部规则**——桌面客户端对不同 content block 类型的处理无公开文档，实验只能通过黑箱观察推断。

---

## 5. 可复用模块

以下代码和设计思路在 v0.1 中已被吸收，并在 v0.2.0 Dual Model Relay 中延续使用：

| 原始模块 | 原始文件 | v0.2.0 对应 | 说明 |
|----------|----------|-------------|------|
| Token 用量统计 | `sessionTracker.ts` | `UsageRecord` | turn 级别 usage 追踪与累计 |
| 人民币费用计算 | `costLedger.ts` | `budget.ts`（已有） | 按模型定价表的 Token → RMB 计算 |
| 预算门闸 | `server.ts`（`checkBudgetGate`） | `budget.ts`（已有） | 任务级 + 每日预算检查 |
| 模型费用占比报告 | `sessionTracker.ts`（`getModelCostBreakdown`） | `report.ts`（已有） | 按模型维度汇总费用 |
| 本地任务状态 | `types.ts`（`BudgetTurn`） | `RunState`（已有） | turn 生命周期追踪 |
| 接力上下文打包 | `types.ts` | `EvidenceBundle + DecisionCapsule`（新） | 任务交接时的上下文打包思路 |
| 双模型分工 | `estimator.ts` + `server.ts` | LaunchStrategy + ProviderProfile（新） | 按任务复杂度分配模型的思路 |
| 费用预测 | `estimator.ts` | budgetGate 预估（已有） | 调用前的费用预估 |

---

## 6. 禁止重新启用的部分

以下实现方式已被证明不可行，**禁止**在 Dual Model Relay 或任何后续版本中复用：

| 废弃项 | 原因 |
|--------|------|
| Claude Desktop SSE 内容注入 | 无稳定契约，版本升级即可破坏 |
| CC Switch 下游透明代理 | 耦合脆弱，维护成本高 |
| 通过新增 content block 显示费用 | 用户体验差，桌面客户端处理不一致 |
| 自动修改 Claude Desktop profile | 风险高，可能与版本升级冲突 |
| 依赖桌面客户端内部 SSE 行为的实现 | 无文档、无保障、不可测试 |
| `streamTransformer.ts` 的 SSE 事件重写逻辑 | 直接依赖上述废弃项 |

**Dual Model Relay 的设计严格要求**：
- 不依赖 Claude Desktop 重启；
- 不读取或修改 CC Switch 数据库；
- 不做 SSE 内容注入；
- Dual Relay 由 cc-auto 独立承载。

---

## 7. 历史记录

原始实验代码保留在 `scripts/ccAuto/experiments/desktop-budget-gateway-abandoned/` 下，包括：

- 源代码：`server.ts`、`streamTransformer.ts`、`sessionTracker.ts`、`costLedger.ts`、`estimator.ts`、`gatewayConfig.ts`、`upstream.ts`、`types.ts`、`trace.ts`、`mockServer.ts`、`mockUpstream.ts`
- 测试：`*.spec.ts`（各模块单元测试）
- 脚本：`start.ts`、`startLayer2.ts`、`stopLayer2.ts`、`firstLayerE2E.ts`、`rollback.js`
- 归档说明：`ABANDONED.md`

这些文件仅供未来参考（如需要回顾原始 SSE 解析逻辑），不得被任何新功能引用或修改。

---

## 8. 相关记忆

- [[gateway-is-main-double-start]] — Gateway 启动时的双实例抢端口问题（已修复）
