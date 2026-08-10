/** cc-auto v0.2.0 Slice 1F-RUN — 路由上下文构建工具。
 *
 * 从 cli.ts 提取，避免 orchestrator ↔ cli 循环依赖。
 * 纯函数，不调用 LLM，不访问文件系统。
 */
import type { ModelRoutingContext, RoutingTaskType } from './types';

export function classifyRoutingTaskType(taskDescription: string): RoutingTaskType {
  const lower = taskDescription.toLowerCase();
  if (/查看|查找|搜索|理解|分析|解释|定位|只读/.test(lower)) return 'REPOSITORY_READ';
  if (/review|审核|复查|终审|评判|检验/.test(lower)) return 'FINAL_REVIEW';
  if (/测试|test|spec|flaky/.test(lower)) return 'TEST_REPAIR';
  if (/fix|bug|修复|缺陷|修正|错误/.test(lower)) return 'BUG_FIX';
  if (/架构|重构|重写|推翻|设计/.test(lower)) return 'ARCHITECTURE';
  if (/数据库|schema|migration|migrate|db/.test(lower)) return 'ARCHITECTURE';
  if (/provider|密钥|api key|执行器|adapter|env/.test(lower)) return 'ARCHITECTURE';
  if (/实现|添加|新增|开发|创建|编写|修改|调整|优化/.test(lower)) return 'CODE_IMPLEMENTATION';
  if (/文档|readme|doc|帮助|help/.test(lower)) return 'DOCUMENTATION';
  return 'CODE_IMPLEMENTATION';
}

export function buildRoutingContext(
  taskDescription: string,
  overrides: Partial<ModelRoutingContext> = {},
): ModelRoutingContext {
  const lower = taskDescription.toLowerCase();

  return {
    taskType: classifyRoutingTaskType(taskDescription),
    affectedFileCount: overrides.affectedFileCount ?? 1,
    specificationClear: !(/模糊|不明|歧义|不清楚|可能/.test(lower)),
    touchesArchitecture: /架构|schema|数据库|migration|provider|重写|重构/.test(lower),
    touchesSecurityBoundary: /安全|密钥|token|api key|认证/.test(lower),
    touchesProviderLifecycle: /provider|adapter|执行器|env|api/.test(lower),
    touchesPendingCallOrUsage: /pendingcall|usage|调用记录|pending/.test(lower),
    touchesDatabaseSchema: /schema|migration|数据库|db|migrate/.test(lower),
    touchesTransactionOrConcurrency: /事务|并发|transaction|concurrency|锁/.test(lower),
    touchesStateMachine: /状态机|state machine|phase|阶段/.test(lower),
    previousAttemptCount: 0,
    allowEscalation: true,
    requestedRole: overrides.requestedRole,
  };
}
