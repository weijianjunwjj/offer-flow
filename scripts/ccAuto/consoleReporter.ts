/** cc-auto v0.2.0 Slice R0 — 终端预算提示与成本复盘 Reporter。
 *
 * 实现 RoutedExecutionReporter，供 executeWithModelRouting() 注入，
 * 在 Provider 调用前输出预算、调用后输出成本复盘。
 *
 * 当前状态：可注入的终端展示组件，尚未接入正式 cc:auto run。
 * 正式 CLI 当前仍走 Claude CLI 路径（orchestrator → runClaude）。
 *
 * 安全边界：
 * - 不输出 API Key / 凭证
 * - 不输出完整 Prompt / 工具历史 / RunState
 * - 不输出绝对用户路径
 * - output 默认为 process.stdout（可在测试中注入 writeLine）
 */

import type {
  RoutedExecutionReporter,
  TaskBudgetEstimate,
  RunningCostSnapshot,
  TaskCostSummary,
  BudgetMode,
  ExecutionModelRole,
} from './types';
import { redactSecretLiterals } from './redact';

// ============================================================================
// 格式化
// ============================================================================

const SEP = '────────────────────────────────';

function roleLabel(role: ExecutionModelRole): string {
  switch (role) {
    case 'FAST_EXECUTOR': return 'V4 Flash';
    case 'STRONG_EXECUTOR': return 'V4 Pro';
    case 'ARBITER': return 'Opus 5';
  }
}

function budgetModeLabel(mode: BudgetMode): string {
  switch (mode) {
    case 'ECONOMY': return 'ECONOMY';
    case 'BALANCED': return 'BALANCED';
    case 'QUALITY': return 'QUALITY';
  }
}

function fmtRmb(v: number | null): string {
  if (v === null || v === undefined) return '(不可核验)';
  if (!Number.isFinite(v)) return '(不可核验)';
  return `¥${v.toFixed(4)}`;
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return 'N/A';
  if (!Number.isFinite(v)) return 'N/A';
  return `${v.toFixed(1)}%`;
}

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return '(不可核验)';
  if (!Number.isFinite(v)) return '(不可核验)';
  return String(v);
}

function safeCost(v: number | null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '(不可核验)';
  if (v === 0 && v !== null) {
    // Zero cost is valid if there were truly no calls (e.g. budget blocked)
    return '¥0.0000';
  }
  return `¥${v.toFixed(4)}`;
}

// ============================================================================
// 行输出收集器 —— 注入依赖，便于测试
// ============================================================================

export interface LineWriter {
  writeLine(text: string): void;
}

export function stdoutWriter(): LineWriter {
  return {
    writeLine(text: string) {
      process.stdout.write(text + '\n');
    },
  };
}

// ============================================================================
// Factory
// ============================================================================

export function createConsoleRoutedExecutionReporter(
  output?: LineWriter,
): RoutedExecutionReporter {
  const writer: LineWriter = output ?? stdoutWriter();
  const write = (text: string) => writer.writeLine(text);

  return {
    async onBudgetEstimate(estimate: TaskBudgetEstimate, _formatted: string): Promise<void> {
      const primary = estimate.estimatedCalls[0];
      const primaryRole = primary?.role ?? 'FAST_EXECUTOR';
      const primaryLabel = roleLabel(primaryRole);
      const reasons = estimate.initialSelection.reasonCodes;
      let reasonText: string;

      if (reasons.includes('USER_FAST_OVERRIDE_REJECTED')) {
        const actualSelection = estimate.initialSelection.role;
        const actualLabel = roleLabel(actualSelection);
        const rejectionReasons = reasons
          .filter((r) => r !== 'USER_FAST_OVERRIDE_REJECTED')
          .slice(0, 3);
        reasonText = [
          `用户请求：V4 Flash`,
          `实际选择：${actualLabel}`,
          `原因：任务命中质量保护边界（${rejectionReasons.join('、')}）`,
        ].join('\n');
      } else if (reasons.includes('USER_OVERRIDE')) {
        reasonText = '用户指定';
      } else {
        // 构建一个友好的原因说明
        const friendly = reasons.map((r) => {
          switch (r) {
            case 'DEFAULT_FLASH': return '明确、小范围、低风险';
            case 'MULTI_FILE_CHANGE': return '涉及多文件修改';
            case 'AMBIGUOUS_SPEC': return '规格存在歧义';
            case 'ARCHITECTURE_TASK': return '架构或高风险任务';
            case 'SECURITY_BOUNDARY': return '涉及安全边界';
            case 'PROVIDER_LIFECYCLE': return '涉及 Provider 生命周期';
            case 'PENDING_CALL_OR_USAGE': return '涉及 PendingCall 或 Usage';
            case 'DATABASE_SCHEMA': return '涉及数据库 Schema';
            case 'TRANSACTION_OR_CONCURRENCY': return '涉及事务或并发';
            case 'STATE_MACHINE': return '涉及状态机';
            case 'FINAL_REVIEW': return '终审阶段';
            default: return r;
          }
        });
        reasonText = friendly.join('、') || '默认策略';
      }

      const exp = estimate.totalEstimatedCostRmb;

      write('');
      write(SEP);
      write('cc-auto 任务预算');
      write(SEP);
      write('');
      write(`首选模型：${primaryLabel}`);
      write(`选择原因：${reasonText}`);
      write('');

      // 预计调用分布
      write('预计调用：');
      for (const c of estimate.estimatedCalls) {
        const name = roleLabel(c.role);
        if (c.minCalls === 0 && c.expectedCalls === 0 && c.maxCalls === 1) {
          write(`${name}：正常 0 次，升级时最多 1 次`);
        } else if (c.maxCalls > 0) {
          write(`${name}：预计 ${c.expectedCalls} 次，最多 ${c.maxCalls} 次`);
        } else {
          write(`${name}：当前不自动调用`);
        }
      }

      // Opus 说明
      const hasOpusEstimate = estimate.estimatedCalls.some((c) => c.role === 'ARBITER' && c.maxCalls > 0);
      if (!hasOpusEstimate) {
        write('Opus 5：当前不自动调用');
      }

      write('');

      // Token 预估
      const totalMinInput = estimate.estimatedCalls.reduce((s, c) => s + c.estimatedInputTokens.min, 0);
      const totalMaxInput = estimate.estimatedCalls.reduce((s, c) => s + c.estimatedInputTokens.max, 0);
      const totalMinOutput = estimate.estimatedCalls.reduce((s, c) => s + c.estimatedOutputTokens.min, 0);
      const totalMaxOutput = estimate.estimatedCalls.reduce((s, c) => s + c.estimatedOutputTokens.max, 0);
      write('预计 Token：');
      write(`输入：${totalMinInput}～${totalMaxInput}`);
      write(`输出：${totalMinOutput}～${totalMaxOutput}`);
      write('');

      // 成本
      write('预计成本：');
      if (exp.expected !== null && Number.isFinite(exp.expected)) {
        write(`常规预计：${fmtRmb(exp.expected)}`);
        write(`合理区间：${fmtRmb(exp.min)}～${fmtRmb(exp.max)}`);
      } else {
        write('常规预计：人民币成本暂不可核验');
      }
      write(`最坏上限：${exp.max !== null && Number.isFinite(exp.max) ? fmtRmb(exp.max) : '人民币成本暂不可核验'}`);

      write('');

      // 预算模式
      write(`预算模式：${budgetModeLabel(estimate.initialSelection.role === 'FAST_EXECUTOR' ? 'ECONOMY' : estimate.initialSelection.role === 'STRONG_EXECUTOR' ? 'BALANCED' : 'QUALITY')}`);

      // 假设说明
      for (const a of estimate.assumptions) {
        write(`注意：${a}`);
      }

      write(SEP);
      write('');
    },

    async onRunningCost(snapshot: RunningCostSnapshot, _formatted: string): Promise<void> {
      if (snapshot.actualCostRmb !== null && Number.isFinite(snapshot.actualCostRmb)) {
        const ratio = snapshot.expectedBudgetUsedRatio !== null && Number.isFinite(snapshot.expectedBudgetUsedRatio)
          ? `，使用常规预算 ${fmtPct(snapshot.expectedBudgetUsedRatio * 100)}`
          : '';
        write(`[cc-auto 成本] 已完成 ${snapshot.completedCallCount} 次调用，当前实际 ${fmtRmb(snapshot.actualCostRmb)}${ratio}`);
      } else {
        write(`[cc-auto 成本] 已完成 ${snapshot.completedCallCount} 次调用，实际成本暂不可核验`);
      }
    },

    async onCostSummary(summary: TaskCostSummary, _formatted: string): Promise<void> {
      write('');
      write(SEP);
      write('cc-auto 模型成本复盘');
      write(SEP);
      write('');

      // 任务结果
      let resultText: string;
      if (summary.completed) {
        resultText = '完成';
      } else {
        const opusRequired = summary.byRole.some((e) => e.role === 'ARBITER');
        resultText = opusRequired ? '需要 Opus 5 裁决' : '失败';
      }
      write(`任务结果：${resultText}`);
      write('');

      // 任务前预计
      const est = summary.estimate.totalEstimatedCostRmb;
      write('任务前预计：');
      write(`常规预计：${est.expected !== null && Number.isFinite(est.expected) ? fmtRmb(est.expected) : '(不可核验)'}`);
      write(`最坏上限：${est.max !== null && Number.isFinite(est.max) ? fmtRmb(est.max) : '(不可核验)'}`);
      write('');

      // 实际消耗
      write('实际消耗：');
      write(`总调用次数：${fmtNum(summary.actual.totalCalls)}`);
      write(`输入 Token：${fmtNum(summary.actual.inputTokens)}`);
      write(`输出 Token：${fmtNum(summary.actual.outputTokens)}`);
      write(`缓存 Token：${fmtNum(summary.actual.cachedTokens)}`);
      write(`实际成本：${safeCost(summary.actual.costRmb)}`);
      write('');

      // 预算偏差
      write('预算偏差：');
      write(`实际 / 常规预计：${fmtPct(summary.estimateComparison.actualVsExpectedRatio)}`);
      write(`实际 / 最坏上限：${fmtPct(summary.estimateComparison.actualVsMaximumRatio)}`);
      write('');

      // 模型分布
      write('模型分布：');
      write('');
      for (const entry of summary.byRole) {
        const name = roleLabel(entry.role);
        write(`${name}`);
        write(`调用次数：${fmtNum(entry.calls)}`);
        write(`Token：${fmtNum(entry.totalTokens)}`);
        write(`成本：${safeCost(entry.costRmb)}`);
        write(`成本占比：${fmtPct(entry.costShare)}`);
        write('');
      }

      // Opus 现状
      const opusEntry = summary.byRole.find((e) => e.role === 'ARBITER');
      if (!opusEntry || opusEntry.calls === 0) {
        write(`Opus 5`);
        write(`自动调用次数：0`);
        write(`实际成本：未产生`);
        write('');
      }

      // 升级情况
      const re = summary.routingEffect;
      write('升级情况：');
      write(`Flash → Pro：${fmtNum(re.escalationCount)} 次`);
      if (re.escalationCostRmb !== null && Number.isFinite(re.escalationCostRmb) && re.escalationCostRmb > 0) {
        write(`无贡献失败调用成本：${fmtRmb(re.escalationCostRmb)}`);
      } else if (re.escalationCostRmb === null) {
        write(`无贡献失败调用成本：(不可核验)`);
      } else {
        write(`无贡献失败调用成本：¥0.0000`);
      }
      write('');

      // 节省效果
      write('节省效果：');
      if (re.hypotheticalAllProCostRmb !== null && Number.isFinite(re.hypotheticalAllProCostRmb)) {
        write(`同 Token 全程使用 Pro：${fmtRmb(re.hypotheticalAllProCostRmb)}`);
        write(`实际节省：${safeCost(re.savedVsAllProRmb)}`);
        write(`节省比例：${fmtPct(re.savedVsAllProPercent)}`);
      } else {
        write('同 Token 全程使用 Pro：(不可核验)');
      }
      write(SEP);
      write('');
    },
  };
}

// ============================================================================
// 脱敏版格式化（供外部使用）
// ============================================================================

/**
 * 脱敏用户文本——移除 API Key 和绝对路径。
 * 供 executeWithModelRouting 在格式化前调用。
 */
export function redactForTerminal(text: string, cwd?: string): string {
  let result = redactSecretLiterals(text);
  // 截除可能的 sk- 模式以外的敏感文本
  result = result.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '<redacted-key>');
  result = result.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, 'Bearer <redacted-token>');

  // 移除绝对路径中的用户目录前缀——兼容反斜杠和正斜杠
  if (cwd) {
    const normalizedCwd = cwd.replace(/\\/g, '/');
    const normalizedHome = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/');

    // 将文本中的反斜杠统一为正斜杠以便匹配
    const normalizedText = result.replace(/\\/g, '/');

    // 用相对路径表示 cwd
    const escapedCwd = normalizedCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = normalizedText.replace(new RegExp(escapedCwd + '/?', 'g'), './');

    // 移除 HOME 路径
    if (normalizedHome) {
      const escapedHome = normalizedHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escapedHome + '/', 'g'), '~/');
    }
  }

  return result;
}

// ============================================================================
// 预算阻断格式化
// ============================================================================

export function formatSoftLimitMessage(): string {
  return [
    '',
    SEP,
    '任务尚未开始。',
    '',
    '常规预计成本超过软预算上限。',
    '未产生 Provider 调用或模型 Token 消费。',
    SEP,
    '',
  ].join('\n');
}

export function formatHardLimitMessage(): string {
  return [
    '',
    SEP,
    '任务已被预算硬上限阻止。',
    '',
    '未创建 PendingCall。',
    '未调用 Provider。',
    '未产生模型 Token 消费。',
    SEP,
    '',
  ].join('\n');
}

export function formatOpusArbitrationMessage(
  capsuleId?: string,
  capsulePath?: string,
): string {
  const lines = [
    '',
    SEP,
    'V4 Pro 未能完成可靠收口。',
    '',
    'cc-auto 已生成 Opus 5 裁决 Capsule。',
    '当前没有自动调用 Opus 5，因此：',
    '',
    'Opus 自动调用次数：0',
    'Opus 实际成本：未产生',
    '',
  ];

  if (capsuleId) {
    lines.push(`Capsule 记录 ID：${capsuleId}`);
  }
  if (capsulePath) {
    lines.push(`Capsule 存储位置：${capsulePath}`);
  }

  lines.push(SEP);
  lines.push('');

  return lines.join('\n');
}
