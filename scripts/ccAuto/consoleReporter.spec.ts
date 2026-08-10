/** consoleReporter.spec.ts — 终端预算提示与成本复盘 Reporter 测试 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConsoleRoutedExecutionReporter,
  redactForTerminal,
  formatSoftLimitMessage,
  formatHardLimitMessage,
  formatOpusArbitrationMessage,
  type LineWriter,
} from './consoleReporter';
import type {
  TaskBudgetEstimate,
  TaskCostSummary,
  RunningCostSnapshot,
  ModelSelection,
  ExecutionModelRole,
  BudgetMode,
  CostByRoleEntry,
  EstimateComparison,
  RoutingEffect,
  RoutedToolLoopObservation,
} from './types';
import { resetEstimateSequence } from './taskBudget';

// ============================================================================
// LineWriter spy
// ============================================================================

class SpyWriter implements LineWriter {
  lines: string[] = [];
  writeLine(text: string): void {
    this.lines.push(text);
  }
  fullText(): string {
    return this.lines.join('\n');
  }
  contains(sub: string): boolean {
    return this.lines.some((l) => l.includes(sub));
  }
  countMatching(pattern: RegExp): number {
    return this.lines.filter((l) => pattern.test(l)).length;
  }
}

// ============================================================================
// Fixtures
// ============================================================================

function makeSelection(overrides: Partial<ModelSelection> = {}): ModelSelection {
  return {
    role: 'FAST_EXECUTOR',
    provider: 'deepseek',
    profileId: 'ds-flash',
    modelLogicalName: 'deepseek-flash',
    source: 'POLICY',
    reasonCodes: ['DEFAULT_FLASH'] as ModelSelection['reasonCodes'],
    policyVersion: 'cc-auto-model-routing-v1',
    ...overrides,
  };
}

function makeBudgetEstimate(
  opts: {
    role?: ExecutionModelRole;
    reasonCodes?: string[];
    expectedCost?: number | null;
    minCost?: number | null;
    maxCost?: number | null;
    hasOpusCall?: boolean;
    budgetMode?: BudgetMode;
  } = {},
): TaskBudgetEstimate {
  const flashCall = {
    role: 'FAST_EXECUTOR' as ExecutionModelRole,
    provider: 'deepseek',
    modelLogicalName: 'deepseek-flash',
    minCalls: 0,
    expectedCalls: opts.role === 'FAST_EXECUTOR' ? 1 : 0,
    maxCalls: 1,
    estimatedInputTokens: { min: 0, expected: 1000, max: 4000 },
    estimatedOutputTokens: { min: 0, expected: 500, max: 2000 },
    estimatedCostRmb: { min: null, expected: null, max: null },
  };
  const proCall = {
    role: 'STRONG_EXECUTOR' as ExecutionModelRole,
    provider: 'deepseek',
    modelLogicalName: 'deepseek-pro',
    minCalls: 0,
    expectedCalls: opts.role === 'STRONG_EXECUTOR' ? 1 : 0,
    maxCalls: 1,
    estimatedInputTokens: { min: 0, expected: 2000, max: 8000 },
    estimatedOutputTokens: { min: 0, expected: 1000, max: 4000 },
    estimatedCostRmb: { min: null, expected: null, max: null },
  };
  const opusCall = {
    role: 'ARBITER' as ExecutionModelRole,
    provider: 'anthropic',
    modelLogicalName: 'opus-5',
    minCalls: 0,
    expectedCalls: 0,
    maxCalls: opts.hasOpusCall ? 1 : 0,
    estimatedInputTokens: { min: 0, expected: 0, max: 10000 },
    estimatedOutputTokens: { min: 0, expected: 0, max: 4000 },
    estimatedCostRmb: { min: null, expected: null, max: null },
  };

  return {
    estimateId: 'est-1',
    runId: 'run-test',
    taskId: 'task-test',
    routingPolicyVersion: 'cc-auto-model-routing-v1',
    initialSelection: makeSelection({
      role: opts.role ?? 'FAST_EXECUTOR',
      reasonCodes: (opts.reasonCodes ?? ['DEFAULT_FLASH']) as ModelSelection['reasonCodes'],
    }),
    currency: 'CNY',
    estimatedCalls: [flashCall, proCall, opusCall].filter(
      (c) => c.role === (opts.role ?? 'FAST_EXECUTOR') || c.role === 'ARBITER' || (opts.role === 'STRONG_EXECUTOR' && c.role === 'STRONG_EXECUTOR'),
    ),
    totalEstimatedCostRmb: {
      min: 'minCost' in opts ? opts.minCost! : null,
      expected: 'expectedCost' in opts ? opts.expectedCost! : 0.0020,
      max: 'maxCost' in opts ? opts.maxCost! : 0.0050,
    },
    assumptions: ['基于 1 次调用估算'],
    createdAt: new Date().toISOString(),
  };
}

function makeCostSummary(opts: {
  completed?: boolean;
  actualCostRmb?: number | null;
  totalCalls?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  byRole?: CostByRoleEntry[];
  comparison?: Partial<EstimateComparison>;
  effect?: Partial<RoutingEffect>;
  expectedCost?: number | null;
  maxCost?: number | null;
} = {}): TaskCostSummary {
  const estimate = makeBudgetEstimate({
    expectedCost: opts.expectedCost ?? 0.0020,
    maxCost: opts.maxCost ?? 0.0050,
  });

  return {
    runId: 'run-test',
    taskId: 'task-test',
    currency: 'CNY',
    estimate,
    actual: {
      totalCalls: opts.totalCalls ?? 1,
      inputTokens: opts.inputTokens ?? 1500,
      outputTokens: opts.outputTokens ?? 800,
      cachedTokens: opts.cachedTokens ?? 200,
      totalTokens: (opts.inputTokens ?? 1500) + (opts.outputTokens ?? 800) + (opts.cachedTokens ?? 200),
      costRmb: opts.actualCostRmb ?? 0.0018,
    },
    byRole: opts.byRole ?? [
      {
        role: 'FAST_EXECUTOR',
        provider: 'deepseek',
        modelLogicalName: 'deepseek-flash',
        calls: 1,
        inputTokens: 1500,
        outputTokens: 800,
        cachedTokens: 200,
        totalTokens: 2500,
        costRmb: 0.0018,
        tokenShare: 1.0,
        costShare: 1.0,
      },
    ],
    estimateComparison: {
      actualVsExpectedRatio: opts.comparison?.actualVsExpectedRatio ?? 0.90,
      actualVsMaximumRatio: opts.comparison?.actualVsMaximumRatio ?? 0.36,
      absoluteVarianceRmb: opts.comparison?.absoluteVarianceRmb ?? 0.0002,
      variancePercent: opts.comparison?.variancePercent ?? 10.0,
    },
    routingEffect: {
      flashCallShare: opts.effect?.flashCallShare ?? 1.0,
      proCallShare: opts.effect?.proCallShare ?? 0,
      opusCallShare: opts.effect?.opusCallShare ?? 0,
      flashCostShare: opts.effect?.flashCostShare ?? 1.0,
      proCostShare: opts.effect?.proCostShare ?? 0,
      opusCostShare: opts.effect?.opusCostShare ?? 0,
      escalationCount: opts.effect?.escalationCount ?? 0,
      escalationCostRmb: opts.effect?.escalationCostRmb ?? 0,
      hypotheticalAllProCostRmb: opts.effect?.hypotheticalAllProCostRmb ?? 0.0036,
      savedVsAllProRmb: opts.effect?.savedVsAllProRmb ?? 0.0018,
      savedVsAllProPercent: opts.effect?.savedVsAllProPercent ?? 0.50,
    },
    completed: opts.completed ?? true,
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createConsoleRoutedExecutionReporter', () => {
  let writer: SpyWriter;
  let reporter: ReturnType<typeof createConsoleRoutedExecutionReporter>;

  beforeEach(() => {
    writer = new SpyWriter();
    reporter = createConsoleRoutedExecutionReporter(writer);
    resetEstimateSequence();
  });

  // === 预算 ===

  describe('onBudgetEstimate', () => {
    it('1. Flash 预算', async () => {
      const estimate = makeBudgetEstimate({ role: 'FAST_EXECUTOR', expectedCost: 0.0020, maxCost: 0.0050 });
      await reporter.onBudgetEstimate(estimate, '分界线测试用');

      expect(writer.contains('cc-auto 任务预算')).toBe(true);
      expect(writer.contains('V4 Flash')).toBe(true);
      expect(writer.contains('¥0.0020')).toBe(true);
    });

    it('2. Pro 预算', async () => {
      const estimate = makeBudgetEstimate({
        role: 'STRONG_EXECUTOR',
        reasonCodes: ['ARCHITECTURE_TASK'],
        expectedCost: 0.0080,
        maxCost: 0.0200,
      });
      await reporter.onBudgetEstimate(estimate, '');

      expect(writer.contains('cc-auto 任务预算')).toBe(true);
      expect(writer.contains('V4 Pro')).toBe(true);
    });

    it('3. Fast override 被拒绝', async () => {
      const estimate = makeBudgetEstimate({
        role: 'STRONG_EXECUTOR',
        reasonCodes: ['USER_FAST_OVERRIDE_REJECTED', 'PROVIDER_LIFECYCLE'],
        expectedCost: 0.0080,
        maxCost: 0.0200,
      });
      await reporter.onBudgetEstimate(estimate, '');

      expect(writer.contains('用户请求：V4 Flash')).toBe(true);
      expect(writer.contains('实际选择：V4 Pro')).toBe(true);
      expect(writer.contains('质量保护边界')).toBe(true);
    });

    it('4. 成本未知', async () => {
      // P7 语义变更：null 成本必须带 explicit reason，禁止裸"不可核验"
      // 旧契约：expect '人民币成本暂不可核验'
      // 新契约：expect '无法计算' + 原因说明
      const estimate = makeBudgetEstimate({
        role: 'FAST_EXECUTOR',
        expectedCost: null,
        maxCost: null,
        minCost: null,
      });
      await reporter.onBudgetEstimate(estimate, '');

      expect(writer.contains('无法计算')).toBe(true);
      // 不得显示 ¥0.00
      expect(writer.lines.some((l) => l.includes('¥0.0000') || l.includes('¥0.00'))).toBe(false);
    });

    it('5. 预算模式显示', async () => {
      const estimate = makeBudgetEstimate({ role: 'FAST_EXECUTOR' });
      await reporter.onBudgetEstimate(estimate, '');

      expect(writer.contains('ECONOMY')).toBe(true);
    });

    it('6. Pro 预算含 Opus 升级说明', async () => {
      const estimate = makeBudgetEstimate({
        role: 'FAST_EXECUTOR',
        hasOpusCall: true,
        expectedCost: 0.0050,
        maxCost: 0.0500,
      });
      await reporter.onBudgetEstimate(estimate, '');

      // Opus should be mentioned in estimated calls
      expect(writer.contains('Opus 5')).toBe(true);
    });
  });

  // === 成本复盘 ===

  describe('onCostSummary', () => {
    it('7. 成功总结', async () => {
      const summary = makeCostSummary({ completed: true });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('cc-auto 模型成本复盘')).toBe(true);
      expect(writer.contains('任务结果：完成')).toBe(true);
      expect(writer.contains('¥0.0018')).toBe(true);
    });

    it('8. 失败总结', async () => {
      const summary = makeCostSummary({ completed: false });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('任务结果：失败')).toBe(true);
    });

    it('9. 含升级总结（Flash→Pro）', async () => {
      const summary = makeCostSummary({
        completed: true,
        byRole: [
          {
            role: 'FAST_EXECUTOR', provider: 'deepseek', modelLogicalName: 'deepseek-flash',
            calls: 1, inputTokens: 1000, outputTokens: 500, cachedTokens: 0,
            totalTokens: 1500, costRmb: 0.0010, tokenShare: 40, costShare: 35.7,
          },
          {
            role: 'STRONG_EXECUTOR', provider: 'deepseek', modelLogicalName: 'deepseek-pro',
            calls: 1, inputTokens: 2000, outputTokens: 800, cachedTokens: 0,
            totalTokens: 2800, costRmb: 0.0056, tokenShare: 60, costShare: 64.3,
          },
        ],
        effect: { escalationCount: 1 },
      });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('V4 Flash')).toBe(true);
      expect(writer.contains('V4 Pro')).toBe(true);
      expect(writer.contains('Flash → Pro：1')).toBe(true);
    });

    it('10. Opus 仲裁总结（无 Opus Provider）', async () => {
      const summary = makeCostSummary({
        completed: false,
        byRole: [
          {
            role: 'STRONG_EXECUTOR', provider: 'deepseek', modelLogicalName: 'deepseek-pro',
            calls: 1, inputTokens: 4000, outputTokens: 2000, cachedTokens: 0,
            totalTokens: 6000, costRmb: 0.0160, tokenShare: 1.0, costShare: 1.0,
          },
        ],
        effect: { escalationCount: 2 },
      });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('Opus 5')).toBe(true);
      expect(writer.contains('自动调用次数：0')).toBe(true);
      expect(writer.contains('未产生')).toBe(true);
    });

    it('11. Token 占比显示', async () => {
      const summary = makeCostSummary({
        byRole: [
          {
            role: 'FAST_EXECUTOR', provider: 'deepseek', modelLogicalName: 'deepseek-flash',
            calls: 2, inputTokens: 3000, outputTokens: 1600, cachedTokens: 400,
            totalTokens: 5000, costRmb: 0.0036, tokenShare: 1.0, costShare: 1.0,
          },
        ],
      });
      await reporter.onCostSummary(summary, '');

      const full = writer.fullText();
      // Per-role model distribution section
      expect(full).toContain('调用次数：2');
      // Actual consumption section (summary.actual, not byRole)
      expect(full).toContain('输入 Token');
      expect(full).toContain('输出 Token');
    });

    it('12. 成本占比显示', async () => {
      const summary = makeCostSummary({
        byRole: [
          {
            role: 'FAST_EXECUTOR', provider: 'deepseek', modelLogicalName: 'deepseek-flash',
            calls: 1, inputTokens: 1500, outputTokens: 800, cachedTokens: 200,
            totalTokens: 2500, costRmb: 0.0018, tokenShare: 1.0, costShare: 1.0,
          },
        ],
      });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('成本占比：100.0%')).toBe(true);
    });

    it('13. actual vs expected 比率', async () => {
      const summary = makeCostSummary({
        comparison: { actualVsExpectedRatio: 0.855 },
      });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('85.5%')).toBe(true);
    });

    it('14. actual vs max 比率', async () => {
      const summary = makeCostSummary({
        comparison: { actualVsMaximumRatio: 0.20 },
      });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('20.0%')).toBe(true);
    });

    it('15. 全 Pro 基准', async () => {
      const summary = makeCostSummary({
        effect: { hypotheticalAllProCostRmb: 0.0050, savedVsAllProRmb: 0.0020, savedVsAllProPercent: 0.40 },
      });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('同 Token 全程使用 Pro')).toBe(true);
      expect(writer.contains('¥0.0050')).toBe(true);
    });

    it('16. 节省金额', async () => {
      const summary = makeCostSummary({
        effect: { savedVsAllProRmb: 0.0032 },
      });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('实际节省：¥0.0032')).toBe(true);
    });

    it('17. 节省比例', async () => {
      const summary = makeCostSummary({
        effect: { savedVsAllProPercent: 0.643 },
      });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('64.3%')).toBe(true);
    });

    it('18. 升级浪费成本', async () => {
      const summary = makeCostSummary({
        effect: { escalationCount: 2, escalationCostRmb: 0.0040 },
      });
      await reporter.onCostSummary(summary, '');

      expect(writer.contains('无贡献失败调用成本：¥0.0040')).toBe(true);
    });

    it('19. 不输出 NaN/Infinity', async () => {
      const summary = makeCostSummary({
        actualCostRmb: NaN,
        inputTokens: NaN as any,
        comparison: { actualVsExpectedRatio: Infinity as any, actualVsMaximumRatio: NaN as any },
        effect: { hypotheticalAllProCostRmb: Infinity as any, savedVsAllProRmb: NaN as any, savedVsAllProPercent: Infinity as any },
      });
      await reporter.onCostSummary(summary, '');

      const full = writer.fullText();
      expect(full).not.toMatch(/\bNaN\b/);
      expect(full).not.toMatch(/\bInfinity\b/);
    });

    it('20. API Key 脱敏', async () => {
      // 通过 redactForTerminal 独立验证
      const text = 'Authorization: Bearer sk-test-secret-123 and key=sk-test-secret-123';
      const result = redactForTerminal(text);
      expect(result).not.toContain('sk-test-secret-123');
    });

    it('21. 绝对路径脱敏', async () => {
      const text = 'Loaded from C:\\Users\\Administrator\\OfferFlow\\config.json';
      const result = redactForTerminal(text, 'C:\\Users\\Administrator\\OfferFlow');
      // Should not contain the full absolute path
      expect(result).not.toContain('C:\\Users\\Administrator\\OfferFlow');
    });

    it('22. 不输出完整 RunState', async () => {
      const summary = makeCostSummary();
      await reporter.onCostSummary(summary, '');

      const full = writer.fullText();
      // Should not contain any internal store paths
      expect(full).not.toContain('RunState');
      expect(full).not.toContain('.cc-auto');
      expect(full).not.toContain('state.json');
    });
  });

  // === 运行中成本 ===

  describe('onRunningCost', () => {
    it('成本已知时输出单行', async () => {
      const snapshot: RunningCostSnapshot = {
        runId: 'r', taskId: 't',
        completedCallCount: 2,
        actualInputTokens: 3000,
        actualOutputTokens: 1600,
        actualCachedTokens: 400,
        actualCostRmb: 0.1842,
        expectedBudgetUsedRatio: 0.439,
        maximumBudgetUsedRatio: 0.1,
        costByRole: {},
        updatedAt: new Date().toISOString(),
      };
      await reporter.onRunningCost!(snapshot, '');

      expect(writer.contains('0.1842')).toBe(true);
      expect(writer.contains('43.9%')).toBe(true);
    });

    it('成本未知时输出可核验提示', async () => {
      // P7 语义变更：必须带原因说明
      // 旧契约：expect '实际成本暂不可核验'（裸文案）
      // 新契约：expect '实际成本暂不可核验（存在 UNPRICED 调用）'（含原因）
      const snapshot: RunningCostSnapshot = {
        runId: 'r', taskId: 't',
        completedCallCount: 1,
        actualInputTokens: 1000,
        actualOutputTokens: 500,
        actualCachedTokens: 0,
        actualCostRmb: null,
        expectedBudgetUsedRatio: null,
        maximumBudgetUsedRatio: null,
        costByRole: {},
        updatedAt: new Date().toISOString(),
      };
      await reporter.onRunningCost!(snapshot, '');

      expect(writer.contains('实际成本暂不可核验（存在 UNPRICED 调用）')).toBe(true);
    });
  });

  // === P10: Partial Progress Tool Loop Observation ===

  describe('onToolLoopObservation', () => {
    function makeObservation(overrides: Partial<RoutedToolLoopObservation> = {}): RoutedToolLoopObservation {
      return {
        role: 'STRONG_EXECUTOR',
        modelLogicalName: 'deepseek-v4-pro',
        turns: 3,
        totalToolCalls: 4,
        auditTrail: [
          { turn: 1, toolName: 'read_file', toolCallId: 'c1', ok: true, errorCode: null },
          { turn: 2, toolName: 'edit_file', toolCallId: 'c2', ok: true, errorCode: null },
          { turn: 3, toolName: 'edit_file', toolCallId: 'c3', ok: false, errorCode: 'EDIT_TARGET_NOT_FOUND' },
        ],
        terminationReason: 'TOOL_EXECUTION_FAILED',
        changedFiles: ['scripts/ccAuto/__fixtures__/demoRun.ts'],
        writeToolCalls: 2,
        ...overrides,
      };
    }

    it('P10: partialProgress=true → displays Partial progress instead of No-effect reason', async () => {
      const obs = makeObservation({
        partialProgress: true,
        failureReason: 'OLD_TEXT_MISMATCH',
        nextAction: 'VERIFY',
        noEffectReason: null,
        changedFiles: ['scripts/ccAuto/__fixtures__/demoRun.ts'],
      });
      await reporter.onToolLoopObservation!(obs);

      expect(writer.contains('Partial progress: yes')).toBe(true);
      expect(writer.contains('Tool failure reason: OLD_TEXT_MISMATCH')).toBe(true);
      expect(writer.contains('Next action: VERIFY')).toBe(true);
      expect(writer.contains('Changed files: scripts/ccAuto/__fixtures__/demoRun.ts')).toBe(true);
      // Must NOT display no-effect reason when changedFiles > 0
      expect(writer.lines.some((l) => l.startsWith('Result:') && !l.includes('No-effect'))).toBe(false);
      // Check "No-effect reason" doesn't appear
      const full = writer.fullText();
      expect(full).not.toContain('No-effect reason');
    });

    it('P10: noEffect with changedFiles=0 → displays Result: noEffectReason (unchanged)', async () => {
      const obs = makeObservation({
        noEffectReason: 'OLD_TEXT_MISMATCH',
        changedFiles: [],
        writeToolCalls: 1,
      });
      await reporter.onToolLoopObservation!(obs);

      expect(writer.contains('Result: OLD_TEXT_MISMATCH')).toBe(true);
      expect(writer.contains('Changed files: （无）')).toBe(true);
      expect(writer.contains('Partial progress: yes')).toBe(false);
    });

    it('P10: partialProgress=true → shows termination + next action', async () => {
      const obs = makeObservation({
        partialProgress: true,
        failureReason: 'TOOL_EXECUTION_FAILED',
        nextAction: 'VERIFY',
        noEffectReason: null,
        terminationReason: 'TOOL_EXECUTION_FAILED',
      });
      await reporter.onToolLoopObservation!(obs);

      expect(writer.contains('Termination: TOOL_EXECUTION_FAILED')).toBe(true);
      expect(writer.contains('Next action: VERIFY')).toBe(true);
    });

    it('P10: completed Tool Loop → no partialProgress fields (unchanged)', async () => {
      const obs = makeObservation({
        noEffectReason: null,
        terminationReason: null,
        writeToolCalls: 3,
        auditTrail: [
          { turn: 1, toolName: 'read_file', toolCallId: 'c1', ok: true, errorCode: null },
          { turn: 2, toolName: 'edit_file', toolCallId: 'c2', ok: true, errorCode: null },
        ],
      });
      await reporter.onToolLoopObservation!(obs);

      const full = writer.fullText();
      expect(full).not.toContain('Partial progress: yes');
      expect(full).not.toContain('Tool failure reason:');
      expect(full).not.toContain('Next action:');
    });

    it('P10: partialProgress with empty audit trail → shows partial progress context', async () => {
      const obs = makeObservation({
        partialProgress: true,
        failureReason: 'TOOL_EXECUTION_FAILED',
        nextAction: 'VERIFY',
        noEffectReason: null,
        totalToolCalls: 0,
        auditTrail: [],
        changedFiles: ['a.ts'],
      });
      await reporter.onToolLoopObservation!(obs);

      expect(writer.contains('Partial progress: yes')).toBe(true);
      expect(writer.contains('Tool failure reason: TOOL_EXECUTION_FAILED')).toBe(true);
    });
  });
});

// ============================================================================
// 阻断消息格式
// ============================================================================

describe('阻断消息', () => {
  it('5. Soft limit 消息', () => {
    const msg = formatSoftLimitMessage();
    expect(msg).toContain('任务尚未开始');
    expect(msg).toContain('软预算上限');
    expect(msg).toContain('未产生 Provider 调用');
  });

  it('6. Hard limit 消息', () => {
    const msg = formatHardLimitMessage();
    expect(msg).toContain('已被预算硬上限阻止');
    expect(msg).toContain('未创建 PendingCall');
    expect(msg).toContain('未调用 Provider');
    expect(msg).toContain('未产生模型 Token 消费');
  });

  it('13. Opus arbitration 消息', () => {
    const msg = formatOpusArbitrationMessage('cap-123', '.cc-auto/runs/run-1/capsule.json');
    expect(msg).toContain('Opus 5 裁决 Capsule');
    expect(msg).toContain('cap-123');
    expect(msg).toContain('.cc-auto/runs/run-1/capsule.json');
    expect(msg).toContain('Opus 自动调用次数：0');
    expect(msg).toContain('未产生');
  });

  it('Opus arbitration 消息不含绝对路径', () => {
    const msg = formatOpusArbitrationMessage('cap-1', undefined);
    expect(msg).not.toContain('C:\\');
  });
});

// ============================================================================
// 脱敏
// ============================================================================

describe('redactForTerminal', () => {
  it('屏蔽 sk- 前缀密钥', () => {
    const input = '使用密钥 sk-test-secret-123 调用 API';
    const result = redactForTerminal(input);
    expect(result).not.toContain('sk-test-secret-123');
  });

  it('屏蔽 Bearer token', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw';
    const result = redactForTerminal(input);
    expect(result).not.toContain('eyJhbGci');
  });

  it('屏蔽绝对用户路径', () => {
    const input = 'Error at C:\\Users\\Administrator\\OfferFlow\\scripts\\ccAuto\\cli.ts:42';
    const result = redactForTerminal(input, 'C:\\Users\\Administrator\\OfferFlow');
    expect(result).not.toContain('C:\\Users\\Administrator\\OfferFlow');
  });

  it('保留正常文本', () => {
    const input = '模型调用成功，成本 ¥0.0018';
    const result = redactForTerminal(input);
    expect(result).toContain('模型调用成功');
    expect(result).toContain('¥0.0018');
  });
});
