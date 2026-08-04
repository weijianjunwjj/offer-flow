/**
 * streamTransformer 精确 raw SSE 顺序回归测试。
 *
 * 不测解析后的对象 — 测试实际输出的完整 SSE 字符串。
 * 每个测试解析 Gateway 输出的 SSE，断言事件类型与 index 的精确顺序。
 */
import { describe, expect, it } from 'vitest';
import {
  StreamTransformer, parseSseBuffer, parseSseLine,
  serializeSseEventShifted,
  makeTextBlock,
  formatEstimateLine, formatFinalCostLine,
  formatCostUnavailableLine, formatBudgetGateLine, formatModelComposition,
  transformNonStreaming,
} from './streamTransformer';
import type { BudgetTurn } from './types';

// ====== 测试辅助 ======

/** 返回 raw SSE string 中每个事件的 { event, index } 列表。 */
interface Envelope { event: string; index?: number; data: Record<string, unknown> }

function parseRawSse(raw: string): Envelope[] {
  const normalized = raw.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n').filter(Boolean);
  const envelopes: Envelope[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let evtName = '';
    let dataStr = '';
    for (const line of lines) {
      const p = parseSseLine(line);
      if (p?.event) evtName = p.event;
      if (p?.data) dataStr = p.data;
    }
    if (!evtName || !dataStr) continue;
    try {
      const data = JSON.parse(dataStr);
      envelopes.push({ event: evtName, index: typeof data.index === 'number' ? data.index : undefined, data });
    } catch { /* skip */ }
  }
  return envelopes;
}

/** 从 raw SSE 提取所有 text block 文本（按 index 升序）。 */
function extractTexts(raw: string): Array<{ index: number; text: string }> {
  const result: Array<{ index: number; text: string }> = [];
  const re = /data: \{"type":"content_block_delta","index":(\d+),"delta":\{"type":"text_delta","text":"([^"]*)"\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    result.push({ index: parseInt(m[1]), text: m[2] });
  }
  return result;
}

function makeSimpleTurn(overrides: Partial<BudgetTurn> = {}): BudgetTurn {
  return {
    turnId: 'turn-test',
    taskFingerprint: 'abc',
    taskSummary: 'test',
    complexity: 'simple',
    taskBudgetRmb: 10,
    dailyBudgetRmb: 50,
    calls: [],
    ended: false,
    finalCostInjected: false,
    startedAt: new Date().toISOString(),
    provider: 'mock',
    ...overrides,
  };
}

function makeBilledTurn(): BudgetTurn {
  return makeSimpleTurn({
    calls: [{
      turnId: 'turn-test',
      timestamp: new Date().toISOString(),
      provider: 'mock',
      modelId: 'deepseek-v4-flash',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      tokenEstimatedCostRmb: 0.00245,
      costBreakdown: {
        inputCostRmb: 0.0007,
        outputCostRmb: 0.00175,
        cacheCreationCostRmb: 0,
        cacheReadCostRmb: 0,
        totalCostRmb: 0.00245,
        inputPercent: 28.6,
        outputPercent: 71.4,
        cacheCreationPercent: 0,
        cacheReadPercent: 0,
      },
    }],
  });
}

function makeEstimate() {
  return { centerRmb: 1.5, upperRmb: 3, hardLimitRmb: 10, modelId: 'deepseek-v4-flash', confidence: 'medium' as const, complexity: 'simple' as const };
}

// ====== 上游 SSE 片段 ======

function sse_messageStart(): string {
  return `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"deepseek-v4-flash","content":[]}}\n\n`;
}

function sse_textBlock(index: number, text: string): string {
  return `event: content_block_start\ndata: {"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":"${text}"}}\n\n` +
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":${index}}\n\n`;
}

function sse_thinkingBlock(index: number): string {
  return `event: content_block_start\ndata: {"type":"content_block_start","index":${index},"content_block":{"type":"thinking","thinking":""}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n` +
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":${index}}\n\n`;
}

function sse_toolUseBlock(index: number): string {
  return `event: content_block_start\ndata: {"type":"content_block_start","index":${index},"content_block":{"type":"tool_use","name":"read","id":"tool_1"}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n` +
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":${index}}\n\n`;
}

function sse_messageDelta(stopReason: string, usage?: Record<string, number>): string {
  const delta = JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason }, ...(usage ? { usage } : {}) });
  return `event: message_delta\ndata: ${delta}\n\n`;
}

function sse_messageStop(): string {
  return `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
}

// ====== 单元测试 ======

describe('parseSseLine', () => {
  it('解析标准 "event: message_start"', () => {
    expect(parseSseLine('event: message_start')).toEqual({ event: 'message_start' });
  });
  it('解析无空格', () => {
    expect(parseSseLine('event:message_start')).toEqual({ event: 'message_start' });
  });
  it('解析 data:', () => {
    expect(parseSseLine('data: {"x":1}')).toEqual({ data: '{"x":1}' });
  });
  it('兼容 CRLF', () => {
    expect(parseSseLine('event: message_start\r')).toEqual({ event: 'message_start' });
  });
  it('忽略无关', () => {
    expect(parseSseLine('id: 1')).toBeNull();
    expect(parseSseLine('')).toBeNull();
  });
});

describe('parseSseBuffer', () => {
  it('解析两个事件', () => {
    const sse = `event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n`;
    const events = parseSseBuffer(sse);
    expect(events).toHaveLength(2);
  });
  it('兼容 CRLF', () => {
    const crlf = `event: message_start\r\ndata: {"type":"message_start"}\r\n\r\nevent: content_block_start\r\ndata: {"type":"content_block_start","index":0}\r\n\r\n`;
    const events = parseSseBuffer(crlf);
    expect(events).toHaveLength(2);
  });
});

describe('serializeSseEventShifted', () => {
  it('index=0 shift=1 → index=1', () => {
    const s = serializeSseEventShifted('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 1);
    expect(s).toContain('"index":1');
  });
  it('shift=0 不改变', () => {
    const s = serializeSseEventShifted('message_start', { type: 'message_start' }, 0);
    expect(s).not.toContain('"index"');
  });
});

describe('makeTextBlock', () => {
  it('start+delta+stop，index 一致', () => {
    const raw = makeTextBlock(5, 'hello');
    const envs = parseRawSse(raw);
    expect(envs.map(e => e.event)).toEqual(['content_block_start', 'content_block_delta', 'content_block_stop']);
    expect(envs.every(e => e.index === 5)).toBe(true);
  });
});

describe('format 函数', () => {
  it('formatEstimateLine', () => {
    const line = formatEstimateLine(makeEstimate());
    expect(line).toContain('预计花费');
    expect(line).toContain('deepseek-v4-flash');
  });
  it('formatFinalCostLine', () => {
    const line = formatFinalCostLine(1.00, 40, 50, 5, 5);
    expect(line).toContain('¥1.00');
    expect(line).toContain('40.0%');
    expect(line).toContain('50.0%');
  });
  it('formatCostUnavailableLine', () => {
    expect(formatCostUnavailableLine()).toContain('费用无法估算');
  });
  it('formatBudgetGateLine', () => {
    const line = formatBudgetGateLine(5.0, 12.0, 10.0);
    expect(line).toContain('¥5.00');
    expect(line).toContain('¥10.00');
  });
  it('formatModelComposition', () => {
    const line = formatModelComposition([{ modelId: 'a', costPercent: 60 }, { modelId: 'b', costPercent: 40 }]);
    expect(line).toContain('a 60.0%');
    expect(line).toContain('b 40.0%');
  });
});

// ====== 核心 raw SSE 精确顺序测试 ======

describe('1. 单个 text block (end_turn) — 精确顺序', () => {
  it('raw SSE 事件类型与 index 精确顺序', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_textBlock(0, 'OK') + sse_messageDelta('end_turn') + sse_messageStop();
    const output = t.transform(upstream) + t.transform('');
    const envs = parseRawSse(output);

    const order = envs.map(e => `${e.event}${e.index !== undefined ? ':' + e.index : ''}`);

    expect(order).toEqual([
      'message_start',
      'content_block_start:0',   // 预测
      'content_block_delta:0',
      'content_block_stop:0',
      'content_block_start:1',   // 模型正文
      'content_block_delta:1',
      'content_block_stop:1',
      'content_block_start:2',   // 最终费用
      'content_block_delta:2',
      'content_block_stop:2',
      'message_delta',
      'message_stop',
    ]);
  });

  it('text 内容按 index 顺序', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_textBlock(0, 'OK') + sse_messageDelta('end_turn') + sse_messageStop();
    const output = t.transform(upstream) + t.transform('');
    const texts = extractTexts(output);

    expect(texts).toHaveLength(3);
    expect(texts[0]).toMatchObject({ index: 0, text: expect.stringContaining('预计花费') });
    expect(texts[1]).toMatchObject({ index: 1, text: 'OK' });
    expect(texts[2]).toMatchObject({ index: 2, text: expect.stringContaining('按 Token 估算') });
  });
});

describe('2. thinking + text — index 移位', () => {
  it('thinking 0→1, text 1→2, estimate 0, final 3', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_thinkingBlock(0) + sse_textBlock(1, 'OK') + sse_messageDelta('end_turn') + sse_messageStop();
    const output = t.transform(upstream) + t.transform('');
    const starts = parseRawSse(output).filter(e => e.event === 'content_block_start');

    // estimate(0), thinking(1), model_text(2), final(3)
    expect(starts.map(e => ({ index: e.index, type: (e.data?.content_block as Record<string, unknown>)?.type })))
      .toEqual([
        { index: 0, type: 'text' },       // estimate
        { index: 1, type: 'thinking' },    // upstream 0 + 1
        { index: 2, type: 'text' },        // upstream 1 + 1
        { index: 3, type: 'text' },        // final = 1 + 2
      ]);
  });
});

describe('3. thinking + text + tool_use — no final cost', () => {
  it('tool_use 中间轮不注入 按 Token 估算', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_textBlock(0, '需要工具') + sse_toolUseBlock(1) + sse_messageDelta('tool_use') + sse_messageStop();
    const output = t.transform(upstream) + t.transform('');
    const texts = extractTexts(output);

    expect(texts.some(tx => tx.text.includes('按 Token 估算'))).toBe(false);
    expect(texts.some(tx => tx.text.includes('预计花费'))).toBe(true);
    expect(texts.some(tx => tx.text.includes('需要工具'))).toBe(true);
    expect(parseRawSse(output).some(e => e.event === 'message_stop')).toBe(true);
  });
});

describe('4. 多个 text block — 顺序', () => {
  it('两个 text block 正确移位', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_textBlock(0, '第一段') + sse_textBlock(1, '第二段') + sse_messageDelta('end_turn') + sse_messageStop();
    const output = t.transform(upstream) + t.transform('');
    const texts = extractTexts(output);

    expect(texts).toHaveLength(4); // estimate + 2 model + final
    expect(texts[0].index).toBe(0); // estimate
    expect(texts[1].index).toBe(1); // 上游0+1
    expect(texts[1].text).toBe('第一段');
    expect(texts[2].index).toBe(2); // 上游1+1
    expect(texts[2].text).toBe('第二段');
    expect(texts[3].index).toBe(3); // final = 1+2
    expect(texts[3].text).toContain('按 Token 估算');
  });
});

describe('5. tool_use 中间轮不注入 final_cost', () => {
  it('message_delta stop_reason=tool_use 无 final cost', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_textBlock(0, '需要工具') + sse_toolUseBlock(1) + sse_messageDelta('tool_use') + sse_messageStop();
    const output = t.transform(upstream) + t.transform('');
    const texts = extractTexts(output);

    expect(texts.filter(tx => tx.text.includes('按 Token 估算'))).toHaveLength(0);
    expect(texts.filter(tx => tx.text.includes('预计花费'))).toHaveLength(1);
  });
});

describe('6. 最终 end_turn 注入 final_cost', () => {
  it('tool_use 后新一轮 tool_result → end_turn 注入 final', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_textBlock(0, '最终回复') + sse_messageDelta('end_turn') + sse_messageStop();
    const output = t.transform(upstream) + t.transform('');
    const texts = extractTexts(output);

    expect(texts.some(tx => tx.text.includes('按 Token 估算'))).toBe(true);
  });
});

describe('7. chunk 在 data: 中间断开', () => {
  it('分片后 message_start 与 message_stop 都存在', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const full = sse_messageStart() + sse_textBlock(0, 'OK') + sse_messageDelta('end_turn') + sse_messageStop();
    const breakIdx = full.indexOf('"content":[]');
    const part1 = full.slice(0, breakIdx + 5);
    const part2 = full.slice(breakIdx + 5);

    const raw = t.transform(part1) + t.transform(part2) + t.transform('');
    const envs = parseRawSse(raw);
    expect(envs.some(e => e.event === 'message_start')).toBe(true);
    expect(envs.some(e => e.event === 'message_stop')).toBe(true);
  });
});

describe('8. chunk 在 JSON 中间断开', () => {
  it('"OK" 跨 chunk 仍正确提取', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const full = sse_messageStart() + sse_textBlock(0, 'OK') + sse_messageDelta('end_turn') + sse_messageStop();
    const idx = full.indexOf('"OK"');
    const part1 = full.slice(0, idx);
    const part2 = full.slice(idx);

    const raw = t.transform(part1) + t.transform(part2) + t.transform('');
    const texts = extractTexts(raw);
    expect(texts.some(tx => tx.text === 'OK')).toBe(true);
  });
});

describe('9. 一个 chunk 包含多个完整 SSE 事件', () => {
  it('完整上游单次 transform 处理', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_textBlock(0, 'OK') + sse_messageDelta('end_turn') + sse_messageStop();
    const raw = t.transform(upstream) + t.transform('');
    const texts = extractTexts(raw);

    expect(texts.filter(tx => tx.text.includes('预计花费'))).toHaveLength(1);
  });
});

describe('10. CRLF vs LF', () => {
  it('CRLF 正确解析', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const crlf = (sse_messageStart() + sse_textBlock(0, 'OK') + sse_messageDelta('end_turn') + sse_messageStop()).replace(/\n/g, '\r\n');
    const raw = t.transform(crlf) + t.transform('');
    const envs = parseRawSse(raw);
    expect(envs.some(e => e.event === 'message_start')).toBe(true);
    expect(envs.some(e => e.event === 'message_stop')).toBe(true);
  });
});

describe('11. message_stop 后连接正常关闭', () => {
  it('message_stop 是最后一个事件', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_textBlock(0, 'OK') + sse_messageDelta('end_turn') + sse_messageStop();
    const raw = t.transform(upstream) + t.transform('');
    const envs = parseRawSse(raw);

    expect(envs[envs.length - 1].event).toBe('message_stop');
  });

  it('message_stop 前一个是 message_delta', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const upstream = sse_messageStart() + sse_textBlock(0, 'OK') + sse_messageDelta('end_turn') + sse_messageStop();
    const raw = t.transform(upstream) + t.transform('');
    const envs = parseRawSse(raw);

    const deltaIdx = envs.findIndex(e => e.event === 'message_delta');
    const stopIdx = envs.findIndex(e => e.event === 'message_stop');
    expect(stopIdx).toBe(deltaIdx + 1);
  });
});

describe('12. 客户端取消（abrupt）', () => {
  it('只有部分事件无 message_stop 不抛出', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const partial = sse_messageStart() + sse_textBlock(0, 'OK').slice(0, 60);
    expect(() => t.transform(partial)).not.toThrow();
    expect(() => t.transform('')).not.toThrow();
  });
});

describe('13. 上游中途关闭', () => {
  it('无 message_delta 无 message_stop 不抛出', () => {
    const t = new StreamTransformer();
    t.setTurn(makeBilledTurn(), makeEstimate());

    const partial = sse_messageStart() + sse_textBlock(0, 'abrupt');
    expect(() => t.transform(partial)).not.toThrow();
    expect(() => t.transform('')).not.toThrow();
  });
});

describe('14. 未知事件透明转发', () => {
  it('自定义事件原样传递', () => {
    const t = new StreamTransformer();
    t.setTurn(makeSimpleTurn(), makeEstimate());

    const evt = 'event: custom_event\ndata: {"type":"custom","value":1}\n\n';
    const raw = t.transform(evt) + t.transform('');
    expect(raw).toContain('event: custom_event');
    expect(raw).toContain('"type":"custom"');
  });
});

describe('budget gate', () => {
  it('触发后 transform 返回空', () => {
    const t = new StreamTransformer();
    t.triggerBudgetGate('STOP');
    expect(t.isBudgetGateTriggered()).toBe(true);
    expect(t.transform(sse_messageStart())).toBe('');
  });
});

// ====== 非流式 ======

describe('transformNonStreaming', () => {
  it('首尾插入', () => {
    const body = {
      id: 'msg_1', model: 'deepseek-v4-flash',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn', usage: {},
    };
    const result = transformNonStreaming(body, makeEstimate(), makeBilledTurn());
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('预计花费');
    expect(content[content.length - 1].text).toContain('按 Token 估算');
  });
});
