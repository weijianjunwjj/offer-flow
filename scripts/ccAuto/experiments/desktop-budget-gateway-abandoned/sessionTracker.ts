/**
 * 会话追踪器：任务识别、会话归并、每日费用跟踪。
 * 区分新用户任务、tool_result 后续调用、同任务修复循环和新追问。
 */

import type { BudgetTurn, TaskComplexity, GatewayCallRecord } from './types';
import type { GatewayConfig } from './gatewayConfig';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** 消息序列前缀指纹（SHA-256 前 16 位 hex）——后备方案，无稳定 session 标识时使用。 */
function hashFingerprint(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // 32-bit int
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/** 持久化的历史摘要（脱敏，不含完整对话正文）。 */
interface PersistentTurnSummary {
  turnId: string;
  taskFingerprint: string;
  taskSummary: string;
  complexity: TaskComplexity;
  provider: string;
  /** 每个 modelId 的累计 token */
  modelTokens: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalCostRmb: number;
  }>;
  callCount: number;
  totalCostRmb: number;
  startedAt: string;
  endedAt?: string;
}

interface SessionStoreData {
  activeTurnId: string | null;
  dailyCostRmb: number;
  dailyDate: string; // YYYY-MM-DD
  history: PersistentTurnSummary[];
}

export class SessionTracker {
  private activeTurn: BudgetTurn | null = null;
  private dailyCostRmb = 0;
  private dailyDate = '';
  private history: PersistentTurnSummary[] = [];
  private readonly storePath: string;

  constructor(private config: GatewayConfig) {
    this.storePath = path.join(config.dataDir, 'session-store.json');
  }

  /** 加载持久化状态。 */
  load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as SessionStoreData;
      this.dailyCostRmb = raw.dailyCostRmb;
      this.dailyDate = raw.dailyDate;
      this.history = raw.history ?? [];
      // 重新启动时没有活跃 turn
      if (this.dailyDate !== this.today()) {
        this.dailyCostRmb = 0;
        this.dailyDate = this.today();
      }
    } catch {
      this.dailyCostRmb = 0;
      this.dailyDate = this.today();
    }
  }

  /** 持久化当前状态。 */
  private save(): void {
    mkdirSync(this.config.dataDir, { recursive: true });
    const data: SessionStoreData = {
      activeTurnId: this.activeTurn?.turnId ?? null,
      dailyCostRmb: this.dailyCostRmb,
      dailyDate: this.dailyDate,
      history: this.history.slice(-50), // 最多保留 50 条
    };
    writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 检查并重置每日累计。 */
  checkDailyReset(): void {
    const t = this.today();
    if (this.dailyDate !== t) {
      this.dailyCostRmb = 0;
      this.dailyDate = t;
    }
  }

  getDailyCostRmb(): number {
    this.checkDailyReset();
    return this.dailyCostRmb;
  }

  /** 判断是否为 tool_result 仅请求。content 数组中只有一个 user block 且全部是 tool_result。 */
  isToolResultOnly(firstUserContent: unknown): boolean {
    if (!Array.isArray(firstUserContent)) return false;
    return firstUserContent.length > 0 && firstUserContent.every(
      (block: unknown) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_result',
    );
  }

  /**
   * 从请求 body 中提取第一条 user message 的文本内容（用于指纹和摘要）。
   * 如果是 tool_result，返回空字符串并归入当前 turn。
   */
  extractUserText(body: unknown): { text: string; isToolResult: boolean } {
    try {
      const b = body as Record<string, unknown>;
      const messages = b.messages as Array<Record<string, unknown>>;
      if (!messages || !Array.isArray(messages)) return { text: '', isToolResult: false };

      // 找到最后一条 user role 的 message
      const userMessages = messages.filter((m) => m.role === 'user');
      if (userMessages.length === 0) return { text: '', isToolResult: false };

      const lastUser = userMessages[userMessages.length - 1];
      const content = lastUser.content;

      // 检查是否为纯 tool_result
      if (this.isToolResultOnly(content)) {
        return { text: '', isToolResult: true };
      }

      // 提取文本内容
      if (typeof content === 'string') return { text: content, isToolResult: false };
      if (Array.isArray(content)) {
        const textParts = content
          .filter((b: unknown) => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text')
          .map((b: unknown) => (b as Record<string, unknown>).text as string || '');
        return { text: textParts.join(' '), isToolResult: false };
      }

      return { text: '', isToolResult: false };
    } catch {
      return { text: '', isToolResult: false };
    }
  }

  /**
   * 分类任务复杂度：基于用户文本的简单启发式。
   * 参考 classify.ts 但适配桌面上下文（不需要探路/仲裁的路由判断）。
   */
  classifyComplexity(text: string): TaskComplexity {
    if (!text) return 'simple';
    const simplePatterns = /^(修改|调整|更新|改)?(文案|措辞|文字|拼写|typo|错别字)|^(更新|修改)?\s*(readme|注释|comment|文档)/i;
    const complexPatterns = /重构|refactor|跨(模块|文件|层)|架构|architecture|新增(功能|模块|页面)/i;
    const highRiskPatterns = /schema|migration|迁移|数据库结构|生产(库|数据|环境)|鉴权|密钥|secret/i;

    if (simplePatterns.test(text.trim()) && !highRiskPatterns.test(text)) return 'simple';
    if (complexPatterns.test(text) || text.length > 500) return 'complex';
    if (highRiskPatterns.test(text)) return 'normal';
    return 'simple';
  }

  /**
   * 接收一个新的用户请求。
   * 如果是 tool_result → 归入当前 activeTurn。
   * 如果是新的用户文本 → 创建新的 BudgetTurn。
   */
  receiveUserRequest(body: unknown): BudgetTurn {
    this.checkDailyReset();
    const { text, isToolResult } = this.extractUserText(body);

    // tool_result：归入当前 turn
    if (isToolResult && this.activeTurn && !this.activeTurn.ended) {
      return this.activeTurn;
    }

    // 新的用户追问：结束旧 turn（如果未结束）
    if (this.activeTurn && !this.activeTurn.ended) {
      this.activeTurn.ended = true;
      this.activeTurn.endedAt = new Date().toISOString();
      this.persistTurn(this.activeTurn);
    }

    // 创建新 turn
    const fp = hashFingerprint(text);
    const summary = text.slice(0, 100).replace(/\n/g, ' ');
    const complexity = this.classifyComplexity(text);

    const turn: BudgetTurn = {
      turnId: `turn-${Date.now()}-${fp}`,
      taskFingerprint: fp,
      taskSummary: summary,
      complexity,
      taskBudgetRmb: this.defaultBudgetForComplexity(complexity),
      dailyBudgetRmb: this.config.budget.dailyMaxRmb,
      calls: [],
      ended: false,
      finalCostInjected: false,
      startedAt: new Date().toISOString(),
      provider: 'unknown',
    };

    this.activeTurn = turn;
    this.save();
    return turn;
  }

  /** 记录一次模型调用的费用。 */
  recordCall(call: GatewayCallRecord): void {
    if (!this.activeTurn) return;
    this.activeTurn.calls.push(call);
    this.activeTurn.provider = call.provider || this.activeTurn.provider;
    this.dailyCostRmb += call.tokenEstimatedCostRmb;

    // 检查是否需要结束（由上游 stop_reason 驱动，这里只做记录）
    this.save();
  }

  /** 上游 stop_reason 不再为 tool_use 时标记 turn 结束。 */
  markTurnEnded(): void {
    if (!this.activeTurn) return;
    this.activeTurn.ended = true;
    this.activeTurn.endedAt = new Date().toISOString();
    this.persistTurn(this.activeTurn);
    this.save();
  }

  /** 标记最终费用行已注入（防止重复注入）。 */
  markFinalCostInjected(): void {
    if (!this.activeTurn) return;
    this.activeTurn.finalCostInjected = true;
    this.save();
  }

  hasFinalCostInjected(): boolean {
    return this.activeTurn?.finalCostInjected ?? true;
  }

  getActiveTurn(): BudgetTurn | null {
    return this.activeTurn;
  }

  /** 获取指定模型的历史平均费用（用于估算）。 */
  getHistoricalAvgCostRmb(complexity: TaskComplexity): number | null {
    const relevant = this.history.filter((h) => h.complexity === complexity && h.callCount > 0);
    if (relevant.length === 0) return null;
    const avg = relevant.reduce((s, h) => s + h.totalCostRmb, 0) / relevant.length;
    return avg;
  }

  getCurrentTaskCostRmb(): number {
    if (!this.activeTurn) return 0;
    return this.activeTurn.calls.reduce((s, c) => s + c.tokenEstimatedCostRmb, 0);
  }

  getEstimatedNextCallCostRmb(modelId: string): number {
    const pricing = this.config.modelPricing[modelId];
    if (!pricing) return 0.5; // 保守估计
    // 典型估算：20000 input + 5000 output
    return ((20000 / 1_000_000) * pricing.inputPerMTokens) + ((5000 / 1_000_000) * pricing.outputPerMTokens);
  }

  private defaultBudgetForComplexity(complexity: TaskComplexity): number {
    switch (complexity) {
      case 'simple': return this.config.budget.simpleTaskRmb;
      case 'normal': return this.config.budget.normalTaskRmb;
      case 'complex': return this.config.budget.complexTaskRmb;
    }
  }

  private persistTurn(turn: BudgetTurn): void {
    const modelTokens: PersistentTurnSummary['modelTokens'] = {};
    let totalCostRmb = 0;
    for (const call of turn.calls) {
      if (!modelTokens[call.modelId]) {
        modelTokens[call.modelId] = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostRmb: 0 };
      }
      modelTokens[call.modelId].inputTokens += call.inputTokens;
      modelTokens[call.modelId].outputTokens += call.outputTokens;
      modelTokens[call.modelId].cacheCreationInputTokens += call.cacheCreationInputTokens;
      modelTokens[call.modelId].cacheReadInputTokens += call.cacheReadInputTokens;
      modelTokens[call.modelId].totalCostRmb += call.tokenEstimatedCostRmb;
      totalCostRmb += call.tokenEstimatedCostRmb;
    }

    this.history.push({
      turnId: turn.turnId,
      taskFingerprint: turn.taskFingerprint,
      taskSummary: turn.taskSummary,
      complexity: turn.complexity,
      provider: turn.provider,
      modelTokens,
      callCount: turn.calls.length,
      totalCostRmb,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    });
  }
}
