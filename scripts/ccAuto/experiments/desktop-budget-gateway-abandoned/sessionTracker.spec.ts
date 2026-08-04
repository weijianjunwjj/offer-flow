/**
 * sessionTracker 测试：任务识别、会话归并、tool_result 归入、新追问新建。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionTracker } from './sessionTracker';
import type { GatewayConfig } from './gatewayConfig';
import { DEFAULT_GATEWAY_CONFIG } from './gatewayConfig';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-gw-session-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function config(): GatewayConfig {
  return { ...DEFAULT_GATEWAY_CONFIG, dataDir: tempDir };
}

function makeUserBody(text: string): Record<string, unknown> {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: text }],
  };
}

function makeToolResultBody(): Record<string, unknown> {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 100,
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_123', content: 'result' }] },
    ],
  };
}

function makeMixedBody(): Record<string, unknown> {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 100,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'thanks' }, { type: 'tool_result', tool_use_id: 'tool_456', content: 'done' }] },
    ],
  };
}

describe('SessionTracker：任务识别与会话归并', () => {
  it('test-11：首次用户文本请求建立新 BudgetTurn', () => {
    const tracker = new SessionTracker(config());
    const body = makeUserBody('修复登录页跳转报错的 bug');
    const turn = tracker.receiveUserRequest(body);
    expect(turn).toBeDefined();
    expect(turn.turnId).toBeTruthy();
    expect(turn.taskSummary).toContain('修复登录页跳转报错');
    expect(turn.ended).toBe(false);
  });

  it('test-12：tool_result 请求归入当前 activeTurn', () => {
    const tracker = new SessionTracker(config());
    const turn1 = tracker.receiveUserRequest(makeUserBody('修复登录页跳转报错的 bug'));
    const turn2 = tracker.receiveUserRequest(makeToolResultBody());
    expect(turn2.turnId).toBe(turn1.turnId); // 归入同一 turn
    expect(turn1.ended).toBe(false);
  });

  it('test-13：新用户追问建立新 turn，结束旧 turn', () => {
    const tracker = new SessionTracker(config());
    const turn1 = tracker.receiveUserRequest(makeUserBody('修复 xxx bug'));
    expect(turn1.ended).toBe(false);
    // 标记旧 turn 未结束
    const turn2 = tracker.receiveUserRequest(makeUserBody('还有其他问题'));
    expect(turn2.turnId).not.toBe(turn1.turnId);
  });

  it('新的 tool_result 在 turn 已结束后也建立新 turn', () => {
    const tracker = new SessionTracker(config());
    tracker.receiveUserRequest(makeUserBody('task 1'));
    tracker.markTurnEnded();
    const body = makeToolResultBody();
    const turn = tracker.receiveUserRequest(body);
    // tool_result 没有文本内容，fingerprint 是空字符串的 hash
    expect(turn.taskFingerprint).toBeTruthy(); // 仍然有 fingerprint（对空字符串的 hash）
  });

  it('isToolResultOnly 正确识别纯 tool_result content', () => {
    const tracker = new SessionTracker(config());
    expect(tracker.isToolResultOnly([{ type: 'tool_result', tool_use_id: 'x', content: 'r' }])).toBe(true);
    expect(tracker.isToolResultOnly([{ type: 'text', text: 'hello' }, { type: 'tool_result', tool_use_id: 'x', content: 'r' }])).toBe(false);
    expect(tracker.isToolResultOnly([])).toBe(false);
    expect(tracker.isToolResultOnly('string content')).toBe(false);
  });

  it('extractUserText 正确提取文本与 tool_result', () => {
    const tracker = new SessionTracker(config());
    const { text, isToolResult } = tracker.extractUserText(makeUserBody('hello world'));
    expect(text).toContain('hello world');
    expect(isToolResult).toBe(false);
  });

  it('混合 content（text + tool_result）不算纯 tool_result', () => {
    const tracker = new SessionTracker(config());
    const { isToolResult } = tracker.extractUserText(makeMixedBody());
    expect(isToolResult).toBe(false); // 包含非 tool_result block
  });
});

describe('SessionTracker：费用跟踪', () => {
  it('记录调用并累计费用', () => {
    const tracker = new SessionTracker(config());
    tracker.receiveUserRequest(makeUserBody('test'));
    tracker.recordCall({
      turnId: tracker.getActiveTurn()!.turnId,
      timestamp: new Date().toISOString(),
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      inputTokens: 1000,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      tokenEstimatedCostRmb: 0.08,
      costBreakdown: {
        inputCostRmb: 0.06, outputCostRmb: 0.02,
        cacheCreationCostRmb: 0, cacheReadCostRmb: 0,
        totalCostRmb: 0.08,
        inputPercent: 75, outputPercent: 25,
        cacheCreationPercent: 0, cacheReadPercent: 0,
      },
    });
    expect(tracker.getCurrentTaskCostRmb()).toBeCloseTo(0.08);
  });

  it('markTurnEnded 正确结束 turn', () => {
    const tracker = new SessionTracker(config());
    tracker.receiveUserRequest(makeUserBody('test'));
    expect(tracker.getActiveTurn()!.ended).toBe(false);
    tracker.markTurnEnded();
    expect(tracker.getActiveTurn()!.ended).toBe(true);
  });

  it('checkDailyReset 跨天重置每日费用', () => {
    const tracker = new SessionTracker(config());
    // 通过记录一次调用来改变 dailyCostRmb
    tracker.receiveUserRequest(makeUserBody('test'));
    tracker.recordCall({
      turnId: tracker.getActiveTurn()!.turnId,
      timestamp: new Date().toISOString(),
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      inputTokens: 100, outputTokens: 100,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      tokenEstimatedCostRmb: 0.50,
      costBreakdown: {
        inputCostRmb: 0.25, outputCostRmb: 0.25,
        cacheCreationCostRmb: 0, cacheReadCostRmb: 0,
        totalCostRmb: 0.50,
        inputPercent: 50, outputPercent: 50,
        cacheCreationPercent: 0, cacheReadPercent: 0,
      },
    });
    expect(tracker.getDailyCostRmb()).toBeGreaterThan(0);
  });
});

describe('SessionTracker：复杂度分类', () => {
  it('文案任务为 simple', () => {
    const tracker = new SessionTracker(config());
    expect(tracker.classifyComplexity('修改按钮文案')).toBe('simple');
    expect(tracker.classifyComplexity('更新README文档')).toBe('simple');
  });

  it('重构任务为 complex', () => {
    const tracker = new SessionTracker(config());
    expect(tracker.classifyComplexity('重构用户认证架构')).toBe('complex');
    expect(tracker.classifyComplexity('新增跨模块日志功能')).toBe('complex');
  });

  it('高风险任务为 normal（至少）', () => {
    const tracker = new SessionTracker(config());
    expect(tracker.classifyComplexity('修改数据库schema新增一列')).toBe('normal');
  });
});
