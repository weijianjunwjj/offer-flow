/** modelRouting.spec.ts — 三级模型路由纯函数测试 */
import { describe, it, expect } from 'vitest';
import { selectExecutionModel, shouldEscalateFlashToPro, escalateContext, markFailureContributed } from './modelRouting';
import { classifyRoutingTaskType, buildRoutingContext } from './cli';
import type { ModelRoutingContext, ModelRoutingConfig } from './types';

const FLASH_CONFIG: ModelRoutingConfig = {
  enabled: true,
  fastModel: { provider: 'deepseek', profileId: 'deepseek-v4-flash', modelLogicalName: 'deepseek-v4-flash' },
  strongModel: { provider: 'deepseek', profileId: 'deepseek-v4-pro', modelLogicalName: 'deepseek-v4-pro' },
  arbiterModel: { provider: 'anthropic', profileId: 'opus-5', modelLogicalName: 'claude-opus-5' },
  allowStrongEscalation: true,
  allowArbiterEscalation: true,
};

const DISABLED_CONFIG: ModelRoutingConfig = { ...FLASH_CONFIG, enabled: false };

function baseContext(overrides: Partial<ModelRoutingContext> = {}): ModelRoutingContext {
  return {
    taskType: 'CODE_IMPLEMENTATION',
    affectedFileCount: 1,
    specificationClear: true,
    touchesArchitecture: false,
    touchesSecurityBoundary: false,
    touchesProviderLifecycle: false,
    touchesPendingCallOrUsage: false,
    touchesDatabaseSchema: false,
    touchesTransactionOrConcurrency: false,
    touchesStateMachine: false,
    previousAttemptCount: 0,
    allowEscalation: true,
    ...overrides,
  };
}

// ============================================================================
// 路由测试
// ============================================================================

describe('selectExecutionModel — 路由规则', () => {
  // 1. 单文件明确任务 → Flash
  it('单文件明确任务 → Flash', () => {
    const sel = selectExecutionModel(baseContext({ affectedFileCount: 1, specificationClear: true }), FLASH_CONFIG);
    expect(sel.role).toBe('FAST_EXECUTOR');
    expect(sel.reasonCodes).toEqual(['DEFAULT_FLASH']);
  });

  // 2. 两文件明确任务 → Flash
  it('两文件明确任务 → Flash', () => {
    const sel = selectExecutionModel(baseContext({ affectedFileCount: 2, specificationClear: true }), FLASH_CONFIG);
    expect(sel.role).toBe('FAST_EXECUTOR');
    expect(sel.reasonCodes).toEqual(['DEFAULT_FLASH']);
  });

  // 3. 三文件任务 → Pro
  it('三文件任务 → Pro (MULTI_FILE_CHANGE)', () => {
    const sel = selectExecutionModel(baseContext({ affectedFileCount: 3 }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('MULTI_FILE_CHANGE');
  });

  // 4. 架构任务 → Pro
  it('架构任务 → Pro (ARCHITECTURE_TASK)', () => {
    const sel = selectExecutionModel(baseContext({ touchesArchitecture: true }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('ARCHITECTURE_TASK');
  });

  // 5. 安全边界 → Pro
  it('安全边界 → Pro (SECURITY_BOUNDARY)', () => {
    const sel = selectExecutionModel(baseContext({ touchesSecurityBoundary: true }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('SECURITY_BOUNDARY');
  });

  // 6. Provider 生命周期 → Pro
  it('Provider 生命周期 → Pro (PROVIDER_LIFECYCLE)', () => {
    const sel = selectExecutionModel(baseContext({ touchesProviderLifecycle: true }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('PROVIDER_LIFECYCLE');
  });

  // 7. PendingCall / Usage → Pro
  it('PendingCall / Usage → Pro (PENDING_CALL_OR_USAGE)', () => {
    const sel = selectExecutionModel(baseContext({ touchesPendingCallOrUsage: true }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('PENDING_CALL_OR_USAGE');
  });

  // 8. 数据库 Schema → Pro
  it('数据库 Schema → Pro (DATABASE_SCHEMA)', () => {
    const sel = selectExecutionModel(baseContext({ touchesDatabaseSchema: true }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('DATABASE_SCHEMA');
  });

  // 9. 事务并发 → Pro
  it('事务并发 → Pro (TRANSACTION_OR_CONCURRENCY)', () => {
    const sel = selectExecutionModel(baseContext({ touchesTransactionOrConcurrency: true }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('TRANSACTION_OR_CONCURRENCY');
  });

  // 10. 状态机 → Pro
  it('状态机 → Pro (STATE_MACHINE)', () => {
    const sel = selectExecutionModel(baseContext({ touchesStateMachine: true }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('STATE_MACHINE');
  });

  // 11. 最终审查 → Pro
  it('最终审查 → Pro (FINAL_REVIEW)', () => {
    const sel = selectExecutionModel(baseContext({ taskType: 'FINAL_REVIEW' }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('FINAL_REVIEW');
  });

  // -- 用户覆盖规则 --

  // 12. 低风险任务强制 Flash → FAST_EXECUTOR
  it('低风险任务强制 Flash 成功', () => {
    const sel = selectExecutionModel(baseContext({ requestedRole: 'FAST_EXECUTOR' }), FLASH_CONFIG);
    expect(sel.role).toBe('FAST_EXECUTOR');
    expect(sel.source).toBe('USER_OVERRIDE');
    expect(sel.reasonCodes).toEqual(['USER_OVERRIDE']);
  });

  // 13. 高风险任务强制 Flash 被拒绝 → STRONG_EXECUTOR
  it('高风险任务强制 Flash 被拒绝', () => {
    const sel = selectExecutionModel(baseContext({
      requestedRole: 'FAST_EXECUTOR',
      touchesArchitecture: true,
      touchesProviderLifecycle: true,
    }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.source).toBe('POLICY');
    expect(sel.reasonCodes).toContain('USER_FAST_OVERRIDE_REJECTED');
    expect(sel.reasonCodes).toContain('ARCHITECTURE_TASK');
    expect(sel.reasonCodes).toContain('PROVIDER_LIFECYCLE');
  });

  // 14. 用户强制 Pro 始终允许
  it('用户强制 Pro 始终允许', () => {
    const sel = selectExecutionModel(baseContext({ requestedRole: 'STRONG_EXECUTOR' }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.source).toBe('USER_OVERRIDE');
    expect(sel.reasonCodes).toEqual(['USER_OVERRIDE']);
  });

  // 15. 用户强制 Opus 进入裁决
  it('用户强制 Opus 进入裁决', () => {
    const sel = selectExecutionModel(baseContext({ requestedRole: 'ARBITER' }), FLASH_CONFIG);
    expect(sel.role).toBe('ARBITER');
    expect(sel.source).toBe('USER_OVERRIDE');
  });

  // 16. 路由关闭保持旧模型
  it('路由关闭 → FAST_EXECUTOR (DEFAULT_FLASH)', () => {
    const sel = selectExecutionModel(baseContext({ touchesArchitecture: true }), DISABLED_CONFIG);
    expect(sel.role).toBe('FAST_EXECUTOR');
    expect(sel.reasonCodes).toEqual(['DEFAULT_FLASH']);
  });

  // 17. 路由关闭时 FAST override 也不会拒绝（路由关闭语义）
  it('路由关闭时高风险 FAST override 不拒绝', () => {
    const sel = selectExecutionModel(baseContext({
      requestedRole: 'FAST_EXECUTOR',
      touchesArchitecture: true,
    }), DISABLED_CONFIG);
    // 路由关闭时 user override 走 FAST
    expect(sel.role).toBe('FAST_EXECUTOR');
    expect(sel.source).toBe('USER_OVERRIDE');
  });

  // 18. 原因码顺序稳定
  it('原因码顺序稳定（同一输入 → 同一输出）', () => {
    const ctx = baseContext({ affectedFileCount: 3, touchesArchitecture: true, taskType: 'FINAL_REVIEW' });
    const r1 = selectExecutionModel(ctx, FLASH_CONFIG);
    const r2 = selectExecutionModel(ctx, FLASH_CONFIG);
    expect(r1.reasonCodes).toEqual(r2.reasonCodes);
    expect(r1.role).toEqual(r2.role);
    expect(r1.reasonCodes).toContain('MULTI_FILE_CHANGE');
    expect(r1.reasonCodes).toContain('ARCHITECTURE_TASK');
    expect(r1.reasonCodes).toContain('FINAL_REVIEW');
  });

  // 19. 模糊需求 → Pro
  it('需求模糊 → Pro (AMBIGUOUS_SPEC)', () => {
    const sel = selectExecutionModel(baseContext({ specificationClear: false }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes).toContain('AMBIGUOUS_SPEC');
  });

  // 20. 多个 Pro 条件同时存在
  it('多个 Pro 条件同时存在时一次选择 Pro', () => {
    const sel = selectExecutionModel(baseContext({
      affectedFileCount: 5,
      touchesArchitecture: true,
      touchesSecurityBoundary: true,
      touchesStateMachine: true,
    }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes.length).toBeGreaterThanOrEqual(4);
  });

  // 21. policyVersion 固定
  it('policyVersion 固定为 v1', () => {
    const sel = selectExecutionModel(baseContext(), FLASH_CONFIG);
    expect(sel.policyVersion).toBe('cc-auto-model-routing-v1');
  });

  // 22. POLICY 来源时 source=POLICY
  it('POLICY 来源时 source=POLICY', () => {
    const sel = selectExecutionModel(baseContext({ touchesArchitecture: true }), FLASH_CONFIG);
    expect(sel.source).toBe('POLICY');
  });

  // 23. USER_FAST_OVERRIDE_REJECTED 在 Pro 多风险场景
  it('USER_FAST_OVERRIDE_REJECTED 含多个高风险原因', () => {
    const sel = selectExecutionModel(baseContext({
      requestedRole: 'FAST_EXECUTOR',
      touchesSecurityBoundary: true,
      touchesDatabaseSchema: true,
      affectedFileCount: 5,
      specificationClear: false,
    }), FLASH_CONFIG);
    expect(sel.role).toBe('STRONG_EXECUTOR');
    expect(sel.reasonCodes[0]).toBe('USER_FAST_OVERRIDE_REJECTED');
    expect(sel.reasonCodes).toContain('SECURITY_BOUNDARY');
    expect(sel.reasonCodes).toContain('DATABASE_SCHEMA');
    expect(sel.reasonCodes).toContain('MULTI_FILE_CHANGE');
    expect(sel.reasonCodes).toContain('AMBIGUOUS_SPEC');
  });
});

// ============================================================================
// 升级测试
// ============================================================================

describe('shouldEscalateFlashToPro — 升级判断', () => {
  it('Flash 质量失败 → 升级', () => {
    expect(shouldEscalateFlashToPro('MODEL_QUALITY_FAILURE', true)).toBe(true);
  });

  it('Flash Verifier 失败 → 升级', () => {
    expect(shouldEscalateFlashToPro('VERIFIER_FAILURE', true)).toBe(true);
  });

  it('Flash 协议失败 → 升级', () => {
    expect(shouldEscalateFlashToPro('MODEL_PROTOCOL_FAILURE', true)).toBe(true);
  });

  it('Flash 网络失败 → 不升级', () => {
    expect(shouldEscalateFlashToPro('TRANSPORT_FAILURE', true)).toBe(false);
  });

  it('Flash 凭证失败 → 不升级', () => {
    expect(shouldEscalateFlashToPro('CREDENTIAL_FAILURE', true)).toBe(false);
  });

  it('Flash FileScope 失败 → 不升级', () => {
    expect(shouldEscalateFlashToPro('FILE_SCOPE_FAILURE', true)).toBe(false);
  });

  it('allowEscalation=false → 不升级', () => {
    expect(shouldEscalateFlashToPro('MODEL_QUALITY_FAILURE', false)).toBe(false);
  });

  it('上下文限制 → 不升级', () => {
    expect(shouldEscalateFlashToPro('CONTEXT_LIMIT', true)).toBe(false);
  });

  it('余额不足 → 不升级', () => {
    expect(shouldEscalateFlashToPro('BALANCE_FAILURE', true)).toBe(false);
  });

  it('用户取消 → 不升级', () => {
    expect(shouldEscalateFlashToPro('USER_CANCELLED', true)).toBe(false);
  });

  it('UNKNOWN 有明确执行证据 → 升级', () => {
    expect(shouldEscalateFlashToPro('UNKNOWN', true)).toBe(true);
  });
});

// ============================================================================
// 升级上下文
// ============================================================================

describe('escalateContext — 升级后上下文构造', () => {
  it('递增 previousAttemptCount', () => {
    const ctx = baseContext({ previousAttemptCount: 0 });
    const next = escalateContext(ctx, 'FAST_EXECUTOR', 'MODEL_QUALITY_FAILURE', '模型返回非法 JSON');
    expect(next.previousAttemptCount).toBe(1);
    expect(next.previousModelRole).toBe('FAST_EXECUTOR');
    expect(next.previousFailure!.category).toBe('MODEL_QUALITY_FAILURE');
    expect(next.previousFailure!.contributedToFinalResult).toBe(false);
  });

  it('保留已有 context 字段', () => {
    const ctx = baseContext({ affectedFileCount: 5, touchesArchitecture: true });
    const next = escalateContext(ctx, 'FAST_EXECUTOR', 'MODEL_QUALITY_FAILURE', 'fail');
    expect(next.affectedFileCount).toBe(5);
    expect(next.touchesArchitecture).toBe(true);
  });
});

describe('markFailureContributed — 标记有贡献', () => {
  it('标记 contributedToFinalResult=true', () => {
    const ctx = escalateContext(baseContext(), 'FAST_EXECUTOR', 'MODEL_QUALITY_FAILURE', 'fail');
    const marked = markFailureContributed(ctx);
    expect(marked.previousFailure!.contributedToFinalResult).toBe(true);
  });

  it('无 previousFailure 时不报错', () => {
    const ctx = baseContext();
    const marked = markFailureContributed(ctx);
    expect(marked.previousFailure).toBeUndefined();
  });
});

// ============================================================================
// Opus 仲裁选择
// ============================================================================

describe('selectExecutionModel — Opus 仲裁', () => {
  it('Pro 质量失败后 → Opus 仲裁', () => {
    const ctx = baseContext({
      previousAttemptCount: 1,
      previousModelRole: 'STRONG_EXECUTOR',
      previousFailure: { category: 'MODEL_QUALITY_FAILURE', summary: 'Pro 无法产出合法结果', contributedToFinalResult: false },
      allowEscalation: true,
    });
    const sel = selectExecutionModel(ctx, FLASH_CONFIG);
    expect(sel.role).toBe('ARBITER');
    expect(sel.source).toBe('ESCALATION');
    expect(sel.reasonCodes).toContain('PRO_QUALITY_FAILURE');
    expect(sel.reasonCodes).toContain('OPUS_ARBITRATION');
  });

  it('allowArbiterEscalation=false → 不升级到 Opus', () => {
    const noArbiterConfig: ModelRoutingConfig = { ...FLASH_CONFIG, allowArbiterEscalation: false };
    const ctx = baseContext({
      previousAttemptCount: 1,
      previousModelRole: 'STRONG_EXECUTOR',
      previousFailure: { category: 'MODEL_QUALITY_FAILURE', summary: 'fail', contributedToFinalResult: false },
    });
    const sel = selectExecutionModel(ctx, noArbiterConfig);
    expect(sel.role).toBe('FAST_EXECUTOR');
  });

  it('Pro 网络失败 → 不触发 Opus', () => {
    const ctx = baseContext({
      previousAttemptCount: 1,
      previousModelRole: 'STRONG_EXECUTOR',
      previousFailure: { category: 'TRANSPORT_FAILURE', summary: 'timeout', contributedToFinalResult: false },
    });
    const sel = selectExecutionModel(ctx, FLASH_CONFIG);
    expect(sel.role).toBe('FAST_EXECUTOR');
  });
});

// ============================================================================
// 任务类型分类（纯关键词匹配，不调用 LLM）
// ============================================================================

describe('classifyRoutingTaskType — 任务分类', () => {
  it('实现类任务 → CODE_IMPLEMENTATION', () => {
    expect(classifyRoutingTaskType('实现一个新的登录页面组件')).toBe('CODE_IMPLEMENTATION');
  });

  it('Bug 修复 → BUG_FIX', () => {
    expect(classifyRoutingTaskType('修复 report 页面的一处文案错误')).toBe('BUG_FIX');
  });

  it('架构任务 → ARCHITECTURE', () => {
    expect(classifyRoutingTaskType('重构数据库迁移 schema，优化性能')).toBe('ARCHITECTURE');
  });

  it('终审任务 → FINAL_REVIEW', () => {
    expect(classifyRoutingTaskType('审核本次所有改动并提出终审意见')).toBe('FINAL_REVIEW');
  });

  it('测试修复 → TEST_REPAIR', () => {
    expect(classifyRoutingTaskType('修复 models.spec.ts 中的 flaky 测试')).toBe('TEST_REPAIR');
  });

  it('只读探索 → REPOSITORY_READ', () => {
    expect(classifyRoutingTaskType('查找所有包含 executeProviderCall 的文件')).toBe('REPOSITORY_READ');
  });

  it('文档任务 → DOCUMENTATION', () => {
    expect(classifyRoutingTaskType('更新 README 中的安装说明')).toBe('DOCUMENTATION');
  });

  it('未识别关键词默认 CODE_IMPLEMENTATION', () => {
    expect(classifyRoutingTaskType('处理一些事情')).toBe('CODE_IMPLEMENTATION');
  });
});

// ============================================================================
// 路由上下文构造（纯规则，不调用 LLM）
// ============================================================================

describe('buildRoutingContext — 上下文构造', () => {
  it('简单实现任务 → Flash 上下文', () => {
    const ctx = buildRoutingContext('修改 cli.ts 中 report 子命令的帮助文案');
    expect(ctx.taskType).toBe('CODE_IMPLEMENTATION');
    expect(ctx.touchesArchitecture).toBe(false);
    expect(ctx.affectedFileCount).toBe(1);
    expect(ctx.allowEscalation).toBe(true);
  });

  it('架构任务 → 高风险上下文', () => {
    const ctx = buildRoutingContext('重构数据库 migration 逻辑，涉及 schema 变更和 Provider 适配');
    expect(ctx.touchesArchitecture).toBe(true);
    expect(ctx.touchesDatabaseSchema).toBe(true);
    expect(ctx.touchesProviderLifecycle).toBe(true);
  });

  it('安全相关 → 触及安全边界', () => {
    const ctx = buildRoutingContext('修复 API Key 泄露问题，检查 Provider 认证边界');
    expect(ctx.touchesSecurityBoundary).toBe(true);
  });

  it('模糊需求 → specificationClear=false', () => {
    const ctx = buildRoutingContext('可能需要在某处添加一个优化，不太确定具体修改范围');
    expect(ctx.specificationClear).toBe(false);
  });

  it('requestedRole 注入', () => {
    const ctx = buildRoutingContext('修复一个简单 bug', { requestedRole: 'FAST_EXECUTOR' });
    expect(ctx.requestedRole).toBe('FAST_EXECUTOR');
  });

  it('默认不触及安全边界', () => {
    const ctx = buildRoutingContext('添加日志输出到 cli.ts');
    expect(ctx.touchesSecurityBoundary).toBe(false);
    expect(ctx.touchesStateMachine).toBe(false);
  });
});
