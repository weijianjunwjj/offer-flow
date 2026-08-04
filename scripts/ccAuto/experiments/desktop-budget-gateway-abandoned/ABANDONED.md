# Desktop Budget Gateway — 实验终止归档

**状态：终止 / 不继续开发**
**归档日期：2026-08-04**

## 目标

为 Claude Desktop 用户提供可感知的 Token 费用与预算控制，包括：
- 实时 Token 用量统计
- 人民币费用计算（按模型定价表）
- 任务级 + 每日预算门闸
- 模型费用占比报告
- 双模型（scout/builder）任务分工与费用预测

## 已尝试架构

### Layer 1: CC Switch 下游透明代理

在 Claude Desktop 与 CC Switch 之间插入一个 HTTP 代理（localhost:15722），拦截所有 `/claude-desktop/v1/messages` 请求。

流程：
```
Claude Desktop → Gateway(:15722) → CC Switch(:15721) → 上游 API
```

Gateway 在此架构中：
1. 解析 SSE 流，提取 `message_start` / `message_delta` 中的 usage 信息
2. 按定价表计算费用
3. 尝试向 SSE 流中注入一个 `content_block_start/delta/stop` 块，显示费用信息
4. 维护 session 级别的 turn 追踪和费用累计

相关文件：
- `server.ts` — 主网关服务器（HTTP 代理 + SSE 解析 + 费用注入）
- `streamTransformer.ts` — SSE 事件级变换器，负责注入费用 content block
- `sessionTracker.ts` — session 级别的 turn 追踪与费用累计
- `costLedger.ts` — Token → 人民币费用计算
- `estimator.ts` — 冷启动费用预测
- `types.ts` — 共享类型定义
- `gatewayConfig.ts` — 配置与定价表
- `upstream.ts` — 上游请求转发逻辑

### Layer 2: Mock 上游 + E2E 测试

为了在不影响真实 CC Switch 的情况下测试，建立第二层代理：

```
Gateway(:15722) → CC Switch(:15721) → Mock Upstream → Mock SSE Response
```

相关文件：
- `startLayer2.ts` / `stopLayer2.ts` — 启动/停止 Layer 2 mock 环境
- `mockServer.ts` — mock CC Switch 服务器
- `mockUpstream.ts` — mock 上游 API 服务器
- `firstLayerE2E.ts` — 端到端测试脚本
- `rollback.js` — 回滚脚本

## 已确认的问题

1. **SSE content block 注入不稳定**
   - Claude Desktop 对不同 content block 类型的处理不一致
   - 新增的 `content_block_start` 事件在部分情况下被桌面客户端忽略或导致解析错误
   - `content_block_stop` 的 index 序号与模型实际输出冲突

2. **CC Switch 下游代理耦合脆弱**
   - 依赖 CC Switch 的内部路由格式（`/claude-desktop/v1/messages`）
   - CC Switch 升级可能破坏路径匹配
   - 代理引入额外延迟（~10-50ms per request）

3. **Claude Desktop SSE 行为无文档**
   - 桌面客户端对 SSE 事件的消费逻辑未公开
   - 不同版本行为可能变化
   - `message_stop` 后的额外 content block 被静默丢弃

4. **费用显示位置不可控**
   - 注入的 content block 出现在模型回复末尾，用户体验差
   - 无法在 Claude Desktop UI 中创建专门的费用面板

5. **双模型（scout/builder）任务分工**
   - cc-auto 的双模型分流逻辑在 orchestrator 层，Gateway 只能看到单次 API 调用
   - 无法在 Gateway 层感知 scout → builder handoff

6. **自动修改 Claude Desktop profile 的风险**
   - 修改 `inferenceGatewayBaseUrl` 可能与其他配置冲突
   - Claude Desktop 版本升级可能改变配置结构

## 最终终止原因

**Claude Desktop + CC Switch 链路中的 SSE 重写兼容性与维护成本超过收益。**

具体而言：
- 通过代理层注入 content block 的方式本质上是对 Claude Desktop 内部实现的 hack
- 桌面客户端无稳定的 SSE 消费契约，任何版本升级都可能破坏注入逻辑
- 费用显示的用户体验无法达到产品标准
- 维护这套代理 + 注入 + 测试基础设施的成本，远高于其提供的费用可见性收益

## 可复用模块

以下代码和思路具有独立价值，可在未来其他场景中复用：

| 模块 | 文件 | 说明 |
|------|------|------|
| Token 用量统计 | `sessionTracker.ts` | turn 级别的 usage 追踪与累计 |
| 人民币费用计算 | `costLedger.ts` | 按模型定价表的 Token → RMB 计算 |
| 预算门闸 | `server.ts` (`checkBudgetGate`) | 任务级 + 每日预算检查逻辑 |
| 模型费用占比报告 | `sessionTracker.ts` (`getModelCostBreakdown`) | 按模型维度汇总费用占比 |
| 本地任务状态 | `types.ts` (`BudgetTurn`) | turn 生命周期与费用追踪数据结构 |
| Handoff Packet | `types.ts` | 任务交接时的上下文打包思路 |
| 双模型任务分工 | `estimator.ts` + `server.ts` | 按任务复杂度分配 scout/builder 的思路 |
| 费用预测 | `estimator.ts` | 基于冷启动估计 + 历史均值的费用预测 |

## 禁止重新启用的部分

以下实现方式已被证明不可行，**禁止在新的实现中复用**：

| 废弃项 | 原因 |
|--------|------|
| Claude Desktop SSE 内容注入 | 无稳定契约，版本升级即可破坏 |
| CC Switch 下游透明代理 | 耦合脆弱，维护成本高 |
| 通过新增 content block 显示费用 | 用户体验差，桌面客户端处理不一致 |
| 自动修改 Claude Desktop profile | 风险高，可能与版本升级冲突 |
| 依赖桌面客户端内部 SSE 行为的实现 | 无文档、无保障、不可测试 |
| `streamTransformer.ts` 的 SSE 事件重写逻辑 | 直接依赖上述废弃项 |

## 历史调查记录

未删除，保留在本归档目录中，供未来参考：
- `server.spec.ts` — Gateway 集成测试
- `streamTransformer.spec.ts` — SSE 变换单元测试
- `gatewayConfig.spec.ts` — 配置加载测试
- `sessionTracker.spec.ts` — Session 追踪测试
- `costLedger.spec.ts` — 费用计算测试
- `upstream.spec.ts` — 上游路由测试
- `firstLayerE2E.ts` — Layer 2 E2E 测试脚本
- `rollback.js` — 回滚步骤记录

## 相关记忆

- [[gateway-is-main-double-start]] — Gateway 启动时的双实例抢端口问题（已修复）
