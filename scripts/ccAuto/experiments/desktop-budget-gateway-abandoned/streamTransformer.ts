/**
 * 流式响应变换器：
 * 1. 费用预测作为 index=0 的 content block 插入
 * 2. 所有上游 content block 的 index 统一 +1 移位
 * 3. 最终费用 block index = 上游最高 index + 2
 * 4. 最终费用在 message_delta 之前、message_stop 之前
 * 5. 预算门闸：拒绝后续调用
 *
 * Index 模型（单上游 text block index=0）：
 *   downstream index=0  → 预测费用
 *   downstream index=1  → 上游 index=0 移位
 *   downstream index=2  → 最终费用
 */

import type { CostEstimate, BudgetTurn } from './types';

/** 格式化费用预测行（中文，用于注入到 assistant 内容中）。 */
export function formatEstimateLine(estimate: CostEstimate): string {
  const model = estimate.modelId;
  return `【预计花费：约 ¥${estimate.centerRmb.toFixed(2)}｜合理区间 ¥${estimate.centerRmb.toFixed(2)}–${estimate.upperRmb.toFixed(2)}｜硬上限 ¥${estimate.hardLimitRmb.toFixed(2)}｜实际目标模型 ${model}】`;
}

/** 格式化最终费用行。 */
export function formatFinalCostLine(
  totalCostRmb: number,
  inputPercent: number,
  outputPercent: number,
  cacheCreationPercent: number,
  cacheReadPercent: number,
): string {
  return `【本任务按 Token 估算：¥${totalCostRmb.toFixed(2)}｜缓存读取 ${cacheReadPercent.toFixed(1)}%｜输出 ${outputPercent.toFixed(1)}%｜普通输入 ${inputPercent.toFixed(1)}%｜缓存写入 ${cacheCreationPercent.toFixed(1)}%】`;
}

/** 费用不可估算时的 fail-closed 文案（避免显示 0 元误导）。 */
export function formatCostUnavailableLine(): string {
  return '【本任务费用无法估算：缺少可靠 usage 或模型无定价，未显示费用】';
}

/** 格式化多模型构成行。 */
export function formatModelComposition(models: Array<{ modelId: string; costPercent: number }>): string {
  const parts = models.map((m) => `${m.modelId} ${m.costPercent.toFixed(1)}%`);
  return `【模型构成：${parts.join('｜')}】`;
}

/** 格式化预算门闸行。 */
export function formatBudgetGateLine(
  currentTaskCost: number,
  projectedCost: number,
  taskBudget: number,
): string {
  return `【预算门闸：已花 ¥${currentTaskCost.toFixed(2)}，预计下一轮后达到 ¥${projectedCost.toFixed(2)}，超过 ¥${taskBudget.toFixed(2)}，任务已停止】`;
}

/**
 * SSE 事件类型。
 * DeepSeek / Anthropic 兼容的流式事件。
 */
type SseEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping';

interface SseEvent {
  event: SseEventType;
  data: Record<string, unknown>;
}

/** 解析一行 SSE 文本。支持 "event: " 和 "event:" 两种写法、CRLF。 */
export function parseSseLine(line: string): { event?: string; data?: string } | null {
  const trimmed = line.trimEnd();
  if (trimmed.startsWith('event: ')) return { event: trimmed.slice(7).trim() };
  if (trimmed.startsWith('event:')) return { event: trimmed.slice(6).trim() };
  if (trimmed.startsWith('data: ')) return { data: trimmed.slice(6) };
  if (trimmed.startsWith('data:')) return { data: trimmed.slice(5) };
  return null;
}

/** 解析 SSE buffer 为事件数组。使用 \n\n 或 \r\n\r\n 作为事件边界。 */
export function parseSseBuffer(buffer: string): SseEvent[] {
  const events: SseEvent[] = [];
  // 先统一 CRLF → LF
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    let eventType = '';
    let dataStr = '';
    for (const line of lines) {
      const parsed = parseSseLine(line);
      if (parsed?.event) eventType = parsed.event;
      if (parsed?.data) dataStr = parsed.data;
    }
    if (eventType && dataStr) {
      try {
        events.push({ event: eventType as SseEventType, data: JSON.parse(dataStr) });
      } catch {
        // 忽略无法解析的 data
      }
    }
  }
  return events;
}

/** 序列化 SSE 事件为文本（不做 index 修改）。 */
export function serializeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 序列化 SSE 事件，并将 data.index 移位 shift（正值加、负值减）。 */
export function serializeSseEventShifted(event: string, data: Record<string, unknown>, shift: number): string {
  if (shift === 0) return serializeSseEvent(event, data);
  const shifted = { ...data };
  if (typeof shifted.index === 'number') shifted.index = (shifted.index as number) + shift;
  return `event: ${event}\ndata: ${JSON.stringify(shifted)}\n\n`;
}

/** 序列化 SSE ping。 */
export function serializePing(): string {
  return `event: ping\ndata: {"type":"ping"}\n\n`;
}

/**
 * 生成一个完整的 text content block（start + delta + stop），使用指定 index。
 */
export function makeTextBlock(index: number, text: string): string {
  return `event: content_block_start\ndata: {"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n` +
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":${index}}\n\n`;
}

/** 构建最终费用文案（从 turn 中提取费用数据）。 */
export function buildFinalCostLine(turn: BudgetTurn): string {
  const totalCostRmb = turn.calls.reduce((s, c) => s + c.tokenEstimatedCostRmb, 0);

  // fail closed：有调用但无费用可用（缺 usage/无定价）时，不得显示 0 元
  if (totalCostRmb <= 0 && turn.costUnavailable) {
    return formatCostUnavailableLine();
  }

  let inputCost = 0, outputCost = 0, cacheCreateCost = 0, cacheReadCost = 0;
  for (const call of turn.calls) {
    inputCost += call.costBreakdown.inputCostRmb;
    outputCost += call.costBreakdown.outputCostRmb;
    cacheCreateCost += call.costBreakdown.cacheCreationCostRmb;
    cacheReadCost += call.costBreakdown.cacheReadCostRmb;
  }

  let inputPct = 0, outputPct = 0, cacheCreatePct = 0, cacheReadPct = 0;
  if (totalCostRmb > 0) {
    inputPct = (inputCost / totalCostRmb) * 100;
    outputPct = (outputCost / totalCostRmb) * 100;
    cacheCreatePct = (cacheCreateCost / totalCostRmb) * 100;
    cacheReadPct = (cacheReadCost / totalCostRmb) * 100;
  }

  let costLine = formatFinalCostLine(totalCostRmb, inputPct, outputPct, cacheCreatePct, cacheReadPct);

  // 多模型构成
  const modelCosts = new Map<string, number>();
  for (const call of turn.calls) {
    modelCosts.set(call.modelId, (modelCosts.get(call.modelId) || 0) + call.tokenEstimatedCostRmb);
  }
  if (modelCosts.size > 1) {
    const models = Array.from(modelCosts.entries())
      .map(([m, c]) => ({ modelId: m, costPercent: totalCostRmb > 0 ? (c / totalCostRmb) * 100 : 0 }));
    costLine += '\n' + formatModelComposition(models);
  }

  return costLine;
}

/**
 * 流式转换器状态机。
 *
 * 索引重写规则：
 * - 预测费用始终在 index=0
 * - upstream index=N → downstream index=N+1（所有 content_block_start/delta/stop 同步移位）
 * - 最终费用 index = upstreamHighestIndex + 2
 */
export class StreamTransformer {
  /** 上游事件中的最高 content_block index（移位前） */
  private upstreamHighestIndex = -1;
  /** 费用预测是否已注入 */
  private estimateInjected = false;
  /** SSE 解析 buffer */
  private buffer = '';
  private turn: BudgetTurn | null = null;
  private estimate: CostEstimate | null = null;
  private budgetGateTriggered = false;

  /** 设置当前 turn 和预算信息。 */
  setTurn(turn: BudgetTurn, estimate: CostEstimate): void {
    this.turn = turn;
    this.estimate = estimate;
    this.estimateInjected = false;
    this.upstreamHighestIndex = -1;
    this.budgetGateTriggered = false;
  }

  /** 触发预算门闸（不转发后续请求）。 */
  triggerBudgetGate(_message: string): void {
    this.budgetGateTriggered = true;
  }

  isBudgetGateTriggered(): boolean {
    return this.budgetGateTriggered;
  }

  /**
   * 处理上游 SSE chunk，返回需转发到客户端的文本。
   */
  transform(chunk: string): string {
    if (this.budgetGateTriggered) {
      return '';
    }

    this.buffer += chunk;
    const events = parseSseBuffer(this.buffer);

    // 保留不完整的最后一个事件
    const normalized = this.buffer.replace(/\r\n/g, '\n');
    const lastDoubleNewline = normalized.lastIndexOf('\n\n');
    if (lastDoubleNewline >= 0 && lastDoubleNewline + 2 < normalized.length) {
      this.buffer = normalized.slice(lastDoubleNewline + 2);
    } else if (events.length > 0) {
      this.buffer = '';
    }

    let output = '';

    for (const evt of events) {
      // 跟踪上游最高 index（移位前）
      if (evt.data.index !== undefined && typeof evt.data.index === 'number') {
        this.upstreamHighestIndex = Math.max(this.upstreamHighestIndex, evt.data.index as number);
      }

      switch (evt.event) {
        case 'message_start':
          output += serializeSseEvent('message_start', evt.data);
          break;

        case 'content_block_start': {
          // 第一个 content block 之前注入估算（index=0）
          if (!this.estimateInjected && this.estimate) {
            this.estimateInjected = true;
            const estimateLine = formatEstimateLine(this.estimate);
            output += makeTextBlock(0, estimateLine);
          }
          // 上游 index 统一 +1
          output += serializeSseEventShifted('content_block_start', evt.data, 1);
          break;
        }

        case 'content_block_delta':
        case 'content_block_stop':
          // 上游 index 统一 +1
          output += serializeSseEventShifted(evt.event, evt.data, 1);
          break;

        case 'ping':
          output += serializePing();
          break;

        case 'message_delta': {
          const delta = evt.data.delta as Record<string, unknown> | undefined;
          const stopReason = delta?.stop_reason as string | undefined;

          // tool_use 时不注入最终费用
          if (stopReason === 'tool_use') {
            output += serializeSseEvent('message_delta', evt.data);
          } else if (this.turn && !this.turn.finalCostInjected) {
            // 最终费用 index = upstreamHighestIndex + 2
            const finalIndex = this.upstreamHighestIndex + 2;
            const costLine = buildFinalCostLine(this.turn);
            output += makeTextBlock(finalIndex, costLine);
            // message_delta 原样在费用 block 之后
            output += serializeSseEvent('message_delta', evt.data);
          } else {
            output += serializeSseEvent('message_delta', evt.data);
          }
          break;
        }

        case 'message_stop':
          output += serializeSseEvent('message_stop', evt.data);
          break;

        default:
          // 未知事件透明转发
          output += serializeSseEvent(evt.event, evt.data);
          break;
      }
    }

    return output;
  }

  /** 获取截止当前的上游最高 content block index（移位前）。 */
  getUpstreamHighestIndex(): number {
    return this.upstreamHighestIndex;
  }
}

/**
 * 非流式：在 content 数组头部插入预测，尾部插入费用。
 * 无需 index 管理（非流式 content 为数组），直接 unshift/push。
 */
export function transformNonStreaming(
  responseBody: Record<string, unknown>,
  estimate: CostEstimate,
  turn: BudgetTurn,
): Record<string, unknown> {
  const body = { ...responseBody };
  const content = body.content as Array<Record<string, unknown>> | undefined;
  if (!content || !Array.isArray(content)) return body;

  const newContent = [...content];

  // 头部插入预测 text block
  const estimateLine = formatEstimateLine(estimate);
  newContent.unshift({ type: 'text', text: estimateLine });

  // 如果是最终响应（stop_reason 不是 tool_use），尾部插入费用
  const stopReason = body.stop_reason as string | undefined;
  if (stopReason && stopReason !== 'tool_use' && !turn.finalCostInjected) {
    const costLine = buildFinalCostLine(turn);
    newContent.push({ type: 'text', text: costLine });
  }

  return { ...body, content: newContent };
}
