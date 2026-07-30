/** 从 RunState 渲染 report.md：状态、费用、改动文件、失败与仲裁记录。 */
import type { RunState } from './store';
import { summarizeUsage, opusShare } from './budget';

export function renderReport(state: RunState): string {
  const totals = summarizeUsage(state.calls);
  const share = opusShare(totals);
  const lines: string[] = [];

  lines.push(`# cc-auto 运行报告：${state.runId}`);
  lines.push('');
  lines.push(`- 任务：${state.taskDescription}`);
  lines.push(`- 创建时间：${state.createdAt}`);
  lines.push(`- 最终阶段：${state.currentPhase}`);
  lines.push(`- 是否完成：${state.done ? '是' : '否'}`);
  if (state.stopReason) {
    lines.push(`- 停止原因：${state.stopReason}${state.stopDetail ? ` — ${state.stopDetail}` : ''}`);
  }
  if (state.classification) {
    lines.push(`- 任务分类：${state.classification.complexity}（风险分 ${state.classification.riskScore}/10）`);
  }
  lines.push('');

  lines.push('## 费用估算（人民币，非账单）');
  lines.push('');
  lines.push('预算止损只依据第三方渠道估算费用，与 pricingMode 无关；官方参考费用仅供对照。');
  const lowerBoundSuffix = totals.hasUnpriced ? '（下限，含 UNPRICED 调用未计入）' : '';
  lines.push(`- 第三方渠道估算合计：约 ${totals.totalRmbCustom.toFixed(2)} 元（预算止损依据此口径）${lowerBoundSuffix}`);
  lines.push(`- Claude CLI 官方参考合计：约 ${totals.totalRmbOfficial.toFixed(2)} 元（仅供对照，不参与止损）`);
  lines.push(`- scout（探路）：约 ${totals.byModel.scout.toFixed(2)} 元`);
  lines.push(`- builder（构建）：约 ${totals.byModel.builder.toFixed(2)} 元`);
  lines.push(`- arbiter（仲裁）：约 ${totals.byModel.arbiter.toFixed(2)} 元（占比 ${(share * 100).toFixed(1)}%）`);
  if (totals.hasUnpriced) {
    lines.push('');
    lines.push(`> 存在 ${totals.unpricedCount} 次无法定价（UNPRICED）的调用：其实际模型 ID 不在渠道价格表中。`);
    lines.push('> 这些调用已计入下方调用数、Token 与官方参考费用，但**未**计入上面的已知渠道人民币合计——');
    lines.push('> 因此「第三方渠道估算合计」只是**费用下限**，真实渠道花费高于该数值。');
  }
  lines.push('');

  lines.push('## 改动文件');
  lines.push('');
  if (state.changedFiles.length === 0) {
    lines.push('（无）');
  } else {
    for (const file of state.changedFiles) lines.push(`- ${file}`);
  }
  lines.push('');

  lines.push('## 调用记录');
  lines.push('');
  lines.push('| 角色 | 模型 | 输入 tokens | 输出 tokens | 耗时(ms) | 渠道估算(元) | CLI官方参考(元) | 定价状态 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const call of state.calls) {
    // UNPRICED 调用 costRmbCustom 为 null：显示「未定价」，绝不 null.toFixed / 写成 0。
    const customCell = call.costRmbCustom === null ? '未定价' : call.costRmbCustom.toFixed(3);
    lines.push(`| ${call.model} | ${call.modelId} | ${call.inputTokens} | ${call.outputTokens} | ${call.durationMs} | ${customCell} | ${call.costRmbOfficial.toFixed(3)} | ${call.pricingStatus} |`);
  }
  lines.push('');

  const unpricedCalls = state.calls.filter((c) => c.pricingStatus === 'UNPRICED');
  if (unpricedCalls.length > 0) {
    lines.push('## 未定价调用（UNPRICED）');
    lines.push('');
    lines.push('以下调用已真实发生但实际模型 ID 不在渠道价格表中，无法换算渠道人民币费用（不猜测默认价格）：');
    for (const call of unpricedCalls) {
      const totalTokens = call.inputTokens + call.outputTokens + call.cacheCreationInputTokens + call.cacheReadInputTokens;
      lines.push(`- [${call.model}] 模型 ${call.modelId}：共 ${totalTokens} tokens（输入 ${call.inputTokens} / 输出 ${call.outputTokens} / 缓存写 ${call.cacheCreationInputTokens} / 缓存读 ${call.cacheReadInputTokens}），官方参考约 ${call.costRmbOfficial.toFixed(3)} 元，耗时 ${call.durationMs}ms，轮次 ${call.numTurns}`);
    }
    lines.push('');
  }

  if (state.failures.length > 0) {
    lines.push('## 失败记录');
    lines.push('');
    for (const failure of state.failures) {
      lines.push(`- [${failure.phase}] fingerprint=${failure.fingerprint}：${failure.summary}`);
    }
    lines.push('');
  }

  lines.push('## 人工确认');
  lines.push('');
  lines.push('本报告仅为技术执行记录，不代表产品验收。合并、推送、Tag、Release 等高风险动作均未自动执行，需用户单独确认。');
  lines.push('');

  return lines.join('\n');
}
