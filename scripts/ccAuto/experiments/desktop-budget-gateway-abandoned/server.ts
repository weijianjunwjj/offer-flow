/**
 * cc-auto Desktop Budget Gateway v0.2.0 — 主服务器。
 *
 * 监听 127.0.0.1:15722，接收 CC Switch 转发的 Provider 下游请求，
 * 注入费用预测与最终费用，实现预算门闸，再转发到实际 Provider。
 *
 * 目标链路（Provider 下游模式）：
 *   Claude Desktop → CC Switch (127.0.0.1:15721/claude-desktop)
 *     → cc-auto Gateway (127.0.0.1:15722/upstream/<provider>)
 *       → 实际 Provider (api.deepseek.com / api.apikey.fun)
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { loadGatewayConfig, parseUserBudgetOverride } from './gatewayConfig';
import type { GatewayConfig } from './gatewayConfig';
import { SessionTracker } from './sessionTracker';
import { estimateCost } from './estimator';
import { computeCallCost } from './costLedger';
import { StreamTransformer, transformNonStreaming, formatBudgetGateLine } from './streamTransformer';
import type { BudgetTurn, GatewayCallRecord } from './types';
import {
  generateTraceId, setRequestTraceId, getRequestTraceId, clearRequestTraceId,
  traceGateway, classifyLastUserBlock, isTraceEnabled, isLoopbackTarget,
} from './trace';

export class BudgetGateway {
  private server: http.Server | null = null;
  private config: GatewayConfig;
  private sessionTracker: SessionTracker;

  /** 只读配置访问（启动标识等非敏感场景用）。 */
  getConfig(): GatewayConfig {
    return this.config;
  }

  constructor(configPathOrObject?: string | GatewayConfig) {
    if (configPathOrObject && typeof configPathOrObject === 'object') {
      this.config = configPathOrObject as GatewayConfig;
    } else {
      this.config = loadGatewayConfig(configPathOrObject);
    }
    this.sessionTracker = new SessionTracker(this.config);
  }

  /** 启动网关服务器。 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        reject(new Error('Gateway already running'));
        return;
      }

      // === 启动前安全检查 ===

      // 1. listenPort 与 upstreamPort 相同 → 拒绝
      if (this.config.port === this.config.upstreamPort) {
        reject(new Error(
          `SAFETY: listenPort (${this.config.port}) equals upstreamPort (${this.config.upstreamPort}). ` +
          `This would create an infinite proxy loop. Rejecting startup.`
        ));
        return;
      }

      // 2. upstream 不是 127.0.0.1 → 拒绝（除非显式允许）
      if (this.config.upstreamHost !== '127.0.0.1' && process.env.CC_AUTO_ALLOW_REMOTE_UPSTREAM !== '1') {
        reject(new Error(
          `SAFETY: upstreamHost is ${this.config.upstreamHost}, not 127.0.0.1. ` +
          `Remote upstream is disabled by default. Set CC_AUTO_ALLOW_REMOTE_UPSTREAM=1 to override.`
        ));
        return;
      }

      // 3. Provider 路由目标不得指向 Gateway 自身（防代理循环）
      for (const [routeId, route] of Object.entries(this.config.routes)) {
        let url: URL;
        try {
          url = new URL(route.upstreamUrl);
        } catch {
          continue;
        }
        const isSelf =
          url.port === String(this.config.port) &&
          (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
        if (isSelf) {
          reject(new Error(
            `SAFETY: route ${routeId} upstreamUrl (${route.upstreamUrl}) points to gateway itself. ` +
            `This would create a proxy loop. Rejecting startup.`
          ));
          return;
        }
      }

      // 4. 端口探测 + 启动
      this.sessionTracker.load();
      this.server = http.createServer((req, res) => { this.handleRequest(req, res); });
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') { reject(new Error(`EADDRINUSE: Port ${this.config.port} already in use.`)); process.exitCode = 1; }
        else { console.error(`[gateway] server error: ${err.message}`); reject(err); }
      });
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[gateway] ========================================`);
        console.log(`[gateway] cc-auto Desktop Budget Gateway v0.2.0`);
        console.log(`[gateway] Listen: ${this.config.host}:${this.config.port}`);
        console.log(`[gateway] Routes: ${Object.keys(this.config.routes).map(k => k + ' -> ' + this.config.routes[k].upstreamUrl).join(', ')}`);
        console.log(`[gateway] Pricing: ${Object.keys(this.config.modelPricing).length} models`);
        console.log(`[gateway] ========================================`);
        resolve();
      });
    });
  }

  /** 停止网关服务器。 */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => { console.log('[gateway] Server stopped'); this.server = null; resolve(); });
    });
  }

  /**
   * Provider 下游转发：从 CC Switch 收到的请求转发到实际 Provider。
   * /v1/messages 进入完整预算与响应转换管线；其余路径（/v1/models 等）透明直通。
   */
  private handleProviderDownstream(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    upstreamUrl: string,
    remainingPath: string,
    routeId: string,
    providerName: string,
  ): void {
    // 只对 /v1/messages 走完整管线（复用 handleMessagesRequest 的注入逻辑）
    const isMessages = remainingPath === '/v1/messages' || remainingPath === '/v1/messages/';
    const isStreamOrNonStream = clientReq.method === 'POST';
    const traceId = getRequestTraceId(clientReq);

    const chunks: Buffer[] = [];
    clientReq.on('data', (c) => chunks.push(c));
    clientReq.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');

      if (isMessages && isStreamOrNonStream) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body);
        } catch {
          // body 无法解析 → 透明直通，不做变换
          if (isTraceEnabled()) {
            traceGateway(traceId, {
              event: 'request_entry',
              method: clientReq.method,
              pathname: remainingPath,
              routeId,
              branch: 'pipeThroughProvider_unparseable',
              model: 'unknown',
              stream: 'unknown',
            });
          }
          this.pipeThroughProvider(clientReq, clientRes, upstreamUrl, remainingPath, body);
          return;
        }
        if (isTraceEnabled()) {
          traceGateway(traceId, {
            event: 'request_entry',
            method: clientReq.method,
            pathname: remainingPath,
            routeId,
            branch: 'handleMessagesRequest_provider',
            model: parsed.model,
            stream: parsed.stream,
            messagesCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
            toolsCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
            lastUserBlock: classifyLastUserBlock(parsed),
          });
        }
        this.handleMessagesRequest(clientReq, clientRes, parsed, body, { upstreamUrl, providerName });
        return;
      }

      if (isTraceEnabled()) {
        traceGateway(traceId, {
          event: 'request_entry',
          method: clientReq.method,
          pathname: remainingPath,
          routeId,
          branch: 'pipeThroughProvider_non_messages',
        });
      }
      this.pipeThroughProvider(clientReq, clientRes, upstreamUrl, remainingPath, body);
    });
  }

  /** Provider 下游透明直通（/v1/models、余额等非 messages 路径）。 */
  private pipeThroughProvider(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    upstreamUrl: string,
    remainingPath: string,
    body: string,
  ): void {
    const targetUrl = new URL(upstreamUrl);
    const fullPath = targetUrl.pathname + remainingPath;

    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(clientReq.headers)) {
      if (v !== undefined) fwdHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    delete fwdHeaders['host'];

    const httpMod = targetUrl.protocol === 'https:' ? https : http;
    const upstreamReq = httpMod.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: fullPath,
      method: clientReq.method,
      headers: fwdHeaders,
      timeout: 600_000,
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    });

    upstreamReq.on('error', (err) => {
      console.error(`[gateway] provider downstream error: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'application/json' });
      }
      if (!clientRes.writableEnded) {
        clientRes.end(JSON.stringify({ error: { message: 'upstream_unreachable', type: 'gateway_error' } }));
      }
    });

    if (body.length > 0) upstreamReq.write(body);
    upstreamReq.end();
  }

  private handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const method = clientReq.method ?? 'GET';
    const url = clientReq.url ?? '/';
    const traceId = isTraceEnabled() ? generateTraceId() : '';
    if (isTraceEnabled()) {
      setRequestTraceId(clientReq, traceId);
    }

    // Provider 下游模式：/upstream/<routeId>/... -> 实际 Provider
    const routeMatch = url.match(/^\/upstream\/([^/]+)(\/.*)?$/);
    if (routeMatch) {
      const routeId = routeMatch[1];
      const remainingPath = routeMatch[2] || '/';
      const route = this.config.routes[routeId];
      if (isTraceEnabled()) {
        traceGateway(traceId, {
          event: 'request_entry',
          method,
          pathname: url,
          routeId,
          remainingPath,
          branch: route ? 'handleProviderDownstream' : 'route_not_found',
        });
      }
      if (!route) {
        clientRes.writeHead(404, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ error: `unknown upstream route: ${routeId}` }));
        if (isTraceEnabled()) clearRequestTraceId(clientReq);
        return;
      }
      this.handleProviderDownstream(clientReq, clientRes, route.upstreamUrl, remainingPath, routeId, route.name);
      return;
    }

    // 旧 passthrough 模式（/v1/models 等直接转发到 CC Switch）
    if (url !== '/v1/messages' || method !== 'POST') {
      if (isTraceEnabled()) {
        traceGateway(traceId, {
          event: 'request_entry',
          method,
          pathname: url,
          routeId: 'none',
          branch: 'passthrough',
        });
      }
      this.passthrough(clientReq, clientRes);
      return;
    }

    // 收集请求 body（原始 /v1/messages passthrough 模式）
    const chunks: Buffer[] = [];
    clientReq.on('data', (chunk) => chunks.push(chunk));
    clientReq.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody);
      } catch {
        if (isTraceEnabled()) {
          traceGateway(traceId, {
            event: 'request_entry',
            method,
            pathname: url,
            routeId: 'none',
            branch: 'passthroughWithBody_unparseable',
          });
          clearRequestTraceId(clientReq);
        }
        this.passthroughWithBody(clientReq, clientRes, rawBody);
        return;
      }
      if (isTraceEnabled()) {
        traceGateway(traceId, {
          event: 'request_entry',
          method,
          pathname: url,
          routeId: 'none',
          branch: 'handleMessagesRequest_passthrough',
          model: body.model,
          stream: body.stream,
          messagesCount: Array.isArray(body.messages) ? body.messages.length : 0,
          toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
          lastUserBlock: classifyLastUserBlock(body),
        });
      }
      this.handleMessagesRequest(clientReq, clientRes, body, rawBody);
    });
  }

  /** 非 /v1/messages 的直接转发。 */
  private passthrough(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const upstreamPath = this.config.upstreamPathPrefix + (clientReq.url ?? '/');
    const upstreamHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (value !== undefined) upstreamHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    upstreamHeaders['host'] = `${this.config.upstreamHost}:${this.config.upstreamPort}`;

    const upstreamReq = http.request(
      {
        hostname: this.config.upstreamHost,
        port: this.config.upstreamPort,
        path: upstreamPath,
        method: clientReq.method,
        headers: upstreamHeaders,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );

    upstreamReq.on('error', (err) => {
      console.error(`[gateway] passthrough error: ${err.message}`);
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: { message: 'upstream_unreachable', type: 'gateway_error' } }));
    });

    clientReq.pipe(upstreamReq);
  }

  /** 原样转发已知 body 的非 messages 请求。 */
  private passthroughWithBody(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    body: string,
  ): void {
    const upstreamPath = this.config.upstreamPathPrefix + (clientReq.url ?? '/');
    const upstreamHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (value !== undefined) upstreamHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    upstreamHeaders['host'] = `${this.config.upstreamHost}:${this.config.upstreamPort}`;
    delete upstreamHeaders['content-length'];

    const upstreamReq = http.request(
      {
        hostname: this.config.upstreamHost,
        port: this.config.upstreamPort,
        path: upstreamPath,
        method: clientReq.method,
        headers: upstreamHeaders,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );

    upstreamReq.on('error', (err) => {
      console.error(`[gateway] passthroughWithBody error: ${err.message}`);
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: { message: 'upstream_unreachable', type: 'gateway_error' } }));
    });

    upstreamReq.write(body);
    upstreamReq.end();
  }

  /** 处理 /v1/messages POST 请求。 */
  private handleMessagesRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    body: Record<string, unknown>,
    rawBody: string,
    providerTarget?: { upstreamUrl: string; providerName: string },
  ): void {
    const stream = body.stream === true;

    // 任务归并：识别新任务 vs tool_result
    const turn = this.sessionTracker.receiveUserRequest(body);
    turn.provider = providerTarget?.providerName ?? turn.provider;

    // 检查用户是否写了预算覆盖
    if (!turn.userBudgetOverride) {
      const firstText = this.sessionTracker.extractUserText(body).text;
      const override = parseUserBudgetOverride(firstText);
      if (override) {
        turn.userBudgetOverride = { ...override, source: 'inline_parse' as const };
        turn.taskBudgetRmb = Math.min(override.amountRmb, this.config.budget.absoluteTaskMaxRmb);
      }
    }

    // 是否为流式请求
    if (stream) {
      this.handleStreamingRequest(clientReq, clientRes, body, rawBody, turn, providerTarget);
    } else {
      this.handleNonStreamingRequest(clientReq, clientRes, body, turn, providerTarget);
    }
  }

  /** 处理流式请求。 */
  private handleStreamingRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    body: Record<string, unknown>,
    rawBody: string,
    turn: BudgetTurn,
    providerTarget?: { upstreamUrl: string; providerName: string },
  ): void {
    // 检查 budget gate（任务级 + 每日级）
    const toolCount = Array.isArray(body.tools) ? (body.tools as unknown[]).length : 0;
    const currentTaskCost = this.sessionTracker.getCurrentTaskCostRmb();
    const currentDailyCost = this.sessionTracker.getDailyCostRmb();
    const requestModel = (body.model as string) || 'unknown';
    const traceId = getRequestTraceId(clientReq);

    if (isTraceEnabled()) {
      traceGateway(traceId, {
        event: 'handleStreamingRequest_enter',
        model: requestModel,
        stream: true,
        toolsCount: toolCount,
        currentTaskCostRmb: currentTaskCost,
        currentDailyCostRmb: currentDailyCost,
        taskBudgetRmb: turn.taskBudgetRmb,
      });
    }

    // 预算门闸检查
    if (!this.checkBudgetGate(clientRes, turn, requestModel, currentTaskCost, currentDailyCost, turn)) {
      if (isTraceEnabled()) {
        traceGateway(traceId, { event: 'budget_gate_rejected', taskBudgetRmb: turn.taskBudgetRmb });
      }
      return;
    }

    // 生成或复用费用预测
    if (!turn.estimate) {
      turn.estimate = estimateCost(rawBody, requestModel, toolCount, this.sessionTracker, this.config);
      if (isTraceEnabled()) {
        traceGateway(traceId, {
          event: 'estimate_generated',
          centerRmb: turn.estimate.centerRmb,
          hardLimitRmb: turn.estimate.hardLimitRmb,
          confidence: turn.estimate.confidence,
        });
      }
    }

    const estimate = turn.estimate;

    // 流式转换器
    const transformer = new StreamTransformer();
    transformer.setTurn(turn, estimate!);

    // 转发到上游（Provider 下游模式 → route.upstreamUrl；否则 → CC Switch passthrough）
    const target = providerTarget
      ? new URL(providerTarget.upstreamUrl)
      : new URL(`http://${this.config.upstreamHost}:${this.config.upstreamPort}`);
    const upstreamPath = providerTarget
      ? target.pathname.replace(/\/$/, '') + '/v1/messages'
      : this.config.upstreamPathPrefix + '/v1/messages';
    const upstreamHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (value !== undefined) upstreamHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    if (providerTarget) {
      delete upstreamHeaders['host'];
    } else {
      upstreamHeaders['host'] = `${this.config.upstreamHost}:${this.config.upstreamPort}`;
    }
    delete upstreamHeaders['content-length'];

    // 转发 traceId — 只允许回环目标（127.0.0.1 / localhost / ::1），公网目标必须删除
    if (isTraceEnabled() && traceId) {
      const targetUrl = providerTarget
        ? providerTarget.upstreamUrl
        : `http://${this.config.upstreamHost}:${this.config.upstreamPort}`;
      if (isLoopbackTarget(targetUrl)) {
        upstreamHeaders['x-trace-id'] = traceId;
      }
    }

    const httpMod = target.protocol === 'https:' ? https : http;
    const upstreamReq = httpMod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: upstreamPath,
        method: 'POST',
        headers: upstreamHeaders,
        timeout: 600_000,
      },
      (upstreamRes) => {
        // 检查上游错误
        if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
          const errChunks: Buffer[] = [];
          upstreamRes.on('data', (c) => errChunks.push(c));
          upstreamRes.on('end', () => {
            const errBody = Buffer.concat(errChunks).toString();
            clientRes.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
            clientRes.end(errBody);
          });
          return;
        }

        // 上游 response 生命周期 trace（独立于 stream data/end）
        upstreamRes.on('end', () => {
          if (isTraceEnabled()) {
            traceGateway(traceId, { event: 'upstream_response_end' });
          }
        });
        upstreamRes.on('close', () => {
          if (isTraceEnabled()) {
            traceGateway(traceId, { event: 'upstream_response_close', complete: upstreamRes.complete });
          }
        });

        // 客户端生命周期 trace
        clientRes.on('finish', () => {
          if (isTraceEnabled()) {
            traceGateway(traceId, { event: 'client_response_finish', writableEnded: clientRes.writableEnded, destroyed: clientRes.destroyed });
          }
        });
        clientRes.on('close', () => {
          if (isTraceEnabled()) {
            traceGateway(traceId, { event: 'client_response_close', writableEnded: clientRes.writableEnded, destroyed: clientRes.destroyed });
          }
        });
        clientReq.on('aborted', () => {
          if (isTraceEnabled()) {
            traceGateway(traceId, { event: 'client_response_aborted' });
          }
        });

        // 流式响应头
        clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);

        // 模型 ID 将从 message_start 事件中获取
        let actualModelId = requestModel;
        let stopReasonSeen = '';
        const collectedUsage: {
          inputTokens?: number;
          outputTokens?: number;
          cacheCreationInputTokens?: number;
          cacheReadInputTokens?: number;
        } = {};

        let buffer = '';
        let callProcessed = false;
        let upstreamChunkSeq = 0;

        /** 在 transform 之前完成本次调用的记账 */
        const processCallIfReady = (): void => {
          if (callProcessed) return;
          const hasAnyUsage =
            collectedUsage.inputTokens !== undefined ||
            collectedUsage.outputTokens !== undefined ||
            collectedUsage.cacheCreationInputTokens !== undefined ||
            collectedUsage.cacheReadInputTokens !== undefined;
          if (!actualModelId || !hasAnyUsage) {
            turn.costUnavailable = true;
            if (isTraceEnabled()) {
              traceGateway(traceId, { event: 'cost_unavailable', actualModelId, hasUsage: hasAnyUsage });
            }
            return;
          }
          const costResult = computeCallCost(actualModelId, {
            inputTokens: collectedUsage.inputTokens ?? 0,
            outputTokens: collectedUsage.outputTokens ?? 0,
            cacheCreationInputTokens: collectedUsage.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: collectedUsage.cacheReadInputTokens ?? 0,
          }, this.config);

          if (costResult.ok) {
            const record: GatewayCallRecord = {
              turnId: turn.turnId,
              timestamp: new Date().toISOString(),
              provider: turn.provider,
              modelId: actualModelId,
              inputTokens: collectedUsage.inputTokens ?? 0,
              outputTokens: collectedUsage.outputTokens ?? 0,
              cacheCreationInputTokens: collectedUsage.cacheCreationInputTokens ?? 0,
              cacheReadInputTokens: collectedUsage.cacheReadInputTokens ?? 0,
              tokenEstimatedCostRmb: costResult.tokenEstimatedCostRmb,
              costBreakdown: costResult.breakdown,
            };
            this.sessionTracker.recordCall(record);
            if (isTraceEnabled()) {
              traceGateway(traceId, {
                event: 'call_recorded',
                modelId: actualModelId,
                tokenEstimatedCostRmb: costResult.tokenEstimatedCostRmb,
              });
            }
          } else {
            turn.costUnavailable = true;
            console.error(`[gateway] cost compute failed: ${costResult.reason} ${costResult.detail}`);
            if (isTraceEnabled()) {
              traceGateway(traceId, { event: 'cost_compute_failed', reason: costResult.reason });
            }
          }
          callProcessed = true;
        };

        upstreamRes.on('data', (chunk: Buffer) => {
          upstreamChunkSeq++;
          const raw = chunk.toString('utf8');
          buffer += raw;

          // 提前提取 model id / usage / stop_reason（批量解析已完整的事件）
          const rawEvents = buffer.split('\n\n');
          for (let i = 0; i < rawEvents.length - 1; i++) {
            const evtBlock = rawEvents[i];
            const lines = evtBlock.split('\n');
            let evtName = '';
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) evtName = line.slice(7).trim();
              else if (line.startsWith('event:')) evtName = line.slice(6).trim();
              else if (line.startsWith('data: ')) dataStr = line.slice(6);
              else if (line.startsWith('data:')) dataStr = line.slice(5);
            }
            if (!evtName || !dataStr) continue;

            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(dataStr); } catch { continue; }

            if (evtName === 'message_start') {
              if (parsed.message && typeof parsed.message === 'object') {
                const msg = parsed.message as Record<string, unknown>;
                if (msg.model) actualModelId = msg.model as string;
                if (msg.usage) {
                  const u = msg.usage as Record<string, number>;
                  collectedUsage.inputTokens = u.input_tokens;
                  collectedUsage.outputTokens = u.output_tokens;
                  collectedUsage.cacheCreationInputTokens = u.cache_creation_input_tokens;
                  collectedUsage.cacheReadInputTokens = u.cache_read_input_tokens;
                }
              }
            }
            if (evtName === 'message_delta') {
              if (parsed.delta && typeof parsed.delta === 'object') {
                const d = parsed.delta as Record<string, unknown>;
                if (d.stop_reason) stopReasonSeen = d.stop_reason as string;
              }
              if (parsed.usage) {
                const u = parsed.usage as Record<string, number>;
                collectedUsage.inputTokens = u.input_tokens ?? collectedUsage.inputTokens;
                collectedUsage.outputTokens = u.output_tokens ?? collectedUsage.outputTokens;
                collectedUsage.cacheCreationInputTokens = u.cache_creation_input_tokens ?? collectedUsage.cacheCreationInputTokens;
                collectedUsage.cacheReadInputTokens = u.cache_read_input_tokens ?? collectedUsage.cacheReadInputTokens;
              }
            }

            // 记录上游事件（trace 开启时）
            if (isTraceEnabled()) {
              const traceEvt: Record<string, unknown> = {
                event: 'upstream_sse',
                chunkSeq: upstreamChunkSeq,
                sseEvent: evtName,
              };
              if (parsed.index !== undefined) traceEvt.index = parsed.index;
              if (parsed.content_block && typeof parsed.content_block === 'object') {
                traceEvt.contentBlockType = (parsed.content_block as Record<string, unknown>).type;
              }
              if (parsed.delta && typeof parsed.delta === 'object') {
                const d = parsed.delta as Record<string, unknown>;
                traceEvt.deltaType = d.type || d.stop_reason;
                if (d.stop_reason) traceEvt.stopReason = d.stop_reason;
              }
              traceEvt.hasUsage = parsed.usage !== undefined;
              traceGateway(traceId, traceEvt);
            }
          }

          // 保留不完整的最后一个 block
          const lastDoubleNewline = buffer.lastIndexOf('\n\n');
          if (lastDoubleNewline >= 0 && lastDoubleNewline + 2 < buffer.length) {
            buffer = buffer.slice(lastDoubleNewline + 2);
          } else if (rawEvents.length > 0) {
            buffer = '';
          }

          // message_delta（含 stop_reason）到达时，在 transform 之前完成记账
          if (stopReasonSeen) {
            processCallIfReady();
          }

          // 变换并转发
          const transformed = transformer.transform(raw);
          if (transformed.length > 0) {
            // trace 记录发出的 text block 分类（不记录原文）
            if (isTraceEnabled()) {
              // 按预测行/模型正文/费用行分类
              const textDeltas = [...transformed.matchAll(/data: \{"type":"content_block_delta","index":(\d+),"delta":\{"type":"text_delta","text":"([^"]*)"\}\}/g)];
              for (const m of textDeltas) {
                const text = m[2];
                const index = parseInt(m[1]);
                let textKind: string;
                if (text.includes('预计花费')) textKind = 'estimate';
                else if (text.includes('按 Token 估算')) textKind = 'final_cost';
                else if (text.includes('费用无法估算')) textKind = 'cost_unavailable';
                else textKind = 'model_text';
                traceGateway(traceId, { event: 'downstream_write_attempt', index, textKind, byteLength: Buffer.byteLength(transformed, 'utf8') });
              }
              // 检查是否包含 message_stop
              if (transformed.includes('"type":"message_stop"')) {
                traceGateway(traceId, { event: 'downstream_message_stop_written' });
              }
            }
            const writeOk = clientRes.write(transformed);
            if (isTraceEnabled()) {
              traceGateway(traceId, { event: 'downstream_write_result', ok: writeOk });
              if (!writeOk) {
                clientRes.once('drain', () => {
                  traceGateway(traceId, { event: 'downstream_drain' });
                });
              }
            }
          }
        });

        upstreamRes.on('end', () => {
          // 处理 buffer 中的剩余内容
          const remaining = transformer.transform('');
          if (remaining.length > 0) {
            if (isTraceEnabled()) {
              const remainingTextDeltas = [...remaining.matchAll(/data: \{"type":"content_block_delta","index":(\d+),"delta":\{"type":"text_delta","text":"([^"]*)"\}\}/g)];
              for (const m of remainingTextDeltas) {
                const text = m[2];
                const index = parseInt(m[1]);
                let textKind: string;
                if (text.includes('预计花费')) textKind = 'estimate';
                else if (text.includes('按 Token 估算')) textKind = 'final_cost';
                else if (text.includes('费用无法估算')) textKind = 'cost_unavailable';
                else textKind = 'model_text';
                traceGateway(traceId, { event: 'downstream_write_attempt', index, textKind, byteLength: Buffer.byteLength(remaining, 'utf8'), phase: 'flush' });
              }
              if (remaining.includes('"type":"message_stop"')) {
                traceGateway(traceId, { event: 'downstream_message_stop_written' });
              }
            }
            clientRes.write(remaining);
          }

          // 流提前结束（无 message_delta）：尽力记账一次
          processCallIfReady();

          // 判断任务是否结束
          if (stopReasonSeen === 'tool_use') {
            if (isTraceEnabled()) {
              traceGateway(traceId, { event: 'turn_not_ended', reason: 'tool_use' });
            }
          } else if (stopReasonSeen && !this.sessionTracker.hasFinalCostInjected()) {
            this.sessionTracker.markFinalCostInjected();
          }

          if (stopReasonSeen && stopReasonSeen !== 'tool_use') {
            this.sessionTracker.markTurnEnded();
          }

          clientRes.end();
          if (isTraceEnabled()) {
            traceGateway(traceId, { event: 'client_end_called', writableEnded: clientRes.writableEnded, destroyed: clientRes.destroyed });
          }
        });

        upstreamRes.on('error', (err) => {
          console.error(`[gateway] upstream stream error: ${err.message}`);
          if (isTraceEnabled()) {
            traceGateway(traceId, { event: 'upstream_error', message: err.message });
          }
          if (!clientRes.writableEnded) {
            clientRes.end();
          }
        });
      },
    );

    upstreamReq.on('error', (err) => {
      console.error(`[gateway] upstream request error: ${err.message}`);
      if (isTraceEnabled()) {
        traceGateway(traceId, { event: 'upstream_request_error', message: err.message });
      }
      if (!clientRes.headersSent) {
        clientRes.writeHead(502);
      }
      if (!clientRes.writableEnded) {
        clientRes.end(JSON.stringify({ error: { message: 'upstream_unreachable', type: 'gateway_error' } }));
      }
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      console.error('[gateway] upstream request timeout');
      if (isTraceEnabled()) {
        traceGateway(traceId, { event: 'upstream_request_timeout' });
      }
    });

    // 转发原始 body
    upstreamReq.write(rawBody);
    upstreamReq.end();
  }

  /** 处理非流式请求。 */
  private handleNonStreamingRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    body: Record<string, unknown>,
    turn: BudgetTurn,
    providerTarget?: { upstreamUrl: string; providerName: string },
  ): void {
    const requestModel = (body.model as string) || 'unknown';
    const currentTaskCost = this.sessionTracker.getCurrentTaskCostRmb();
    const currentDailyCost = this.sessionTracker.getDailyCostRmb();

    // 预算门闸检查
    if (!this.checkBudgetGate(clientRes, turn, requestModel, currentTaskCost, currentDailyCost, turn)) {
      return;
    }

    // 生成费用预测
    const rawBody = JSON.stringify(body);
    const toolCount = Array.isArray(body.tools) ? (body.tools as unknown[]).length : 0;
    if (!turn.estimate) {
      turn.estimate = estimateCost(rawBody, requestModel, toolCount, this.sessionTracker, this.config);
    }

    // 转发到上游
    const target = providerTarget
      ? new URL(providerTarget.upstreamUrl)
      : new URL(`http://${this.config.upstreamHost}:${this.config.upstreamPort}`);
    const upstreamPath = providerTarget
      ? target.pathname.replace(/\/$/, '') + '/v1/messages'
      : this.config.upstreamPathPrefix + '/v1/messages';
    const upstreamHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (value !== undefined) upstreamHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    if (providerTarget) {
      delete upstreamHeaders['host'];
    } else {
      upstreamHeaders['host'] = `${this.config.upstreamHost}:${this.config.upstreamPort}`;
    }
    delete upstreamHeaders['content-length'];

    const httpMod = target.protocol === 'https:' ? https : http;
    const upstreamReq = httpMod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: upstreamPath,
        method: 'POST',
        headers: upstreamHeaders,
        timeout: 600_000,
      },
      (upstreamRes) => {
        const chunks: Buffer[] = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          let responseJson: Record<string, unknown>;
          try {
            responseJson = JSON.parse(responseBody);
          } catch {
            clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
            clientRes.end(responseBody);
            return;
          }

          // 记录调用
          const actualModelId = (responseJson.model as string) || requestModel;
          const usage = responseJson.usage as Record<string, number> | undefined;
          if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
            const costResult = computeCallCost(actualModelId, {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
            }, this.config);

            if (costResult.ok) {
              const record: GatewayCallRecord = {
                turnId: turn.turnId,
                timestamp: new Date().toISOString(),
                provider: turn.provider,
                modelId: actualModelId,
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
                cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
                tokenEstimatedCostRmb: costResult.tokenEstimatedCostRmb,
                costBreakdown: costResult.breakdown,
              };
              this.sessionTracker.recordCall(record);
            } else {
              turn.costUnavailable = true;
              console.error(`[gateway] cost compute failed: ${costResult.reason} ${costResult.detail}`);
            }
          } else {
            turn.costUnavailable = true;
            console.error(`[gateway] MISSING_USAGE: 响应缺少可靠 usage`);
          }

          // 变换：头部插入预测，尾部插入费用
          const stopReason = responseJson.stop_reason as string | undefined;
          const transformed = transformNonStreaming(responseJson, turn.estimate!, turn);

          if (stopReason && stopReason !== 'tool_use') {
            this.sessionTracker.markFinalCostInjected();
            this.sessionTracker.markTurnEnded();
          }

          clientRes.writeHead(upstreamRes.statusCode ?? 200, { ...upstreamRes.headers, 'content-type': 'application/json' });
          clientRes.end(JSON.stringify(transformed));
        });
      },
    );

    upstreamReq.on('error', (err) => {
      console.error(`[gateway] upstream request error: ${err.message}`);
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: { message: 'upstream_unreachable', type: 'gateway_error' } }));
    });

    upstreamReq.write(rawBody);
    upstreamReq.end();
  }

  /** 预算门闸检查。返回 true 表示放行。 */
  private checkBudgetGate(
    clientRes: http.ServerResponse,
    _turn: BudgetTurn,
    requestModel: string,
    currentTaskCost: number,
    currentDailyCost: number,
    turnProxy: BudgetTurn,
  ): boolean {
    const estimatedNextCall = this.sessionTracker.getEstimatedNextCallCostRmb(requestModel);
    const taskBudget = turnProxy.taskBudgetRmb;
    const dailyBudget = this.config.budget.dailyMaxRmb;

    // 检查价格表
    const pricingResult = this.config.modelPricing[requestModel];
    if (!pricingResult) {
      const msg = `【预算门闸：实际模型 ${requestModel} 不在价格表中，任务已停止】`;
      console.error(`[gateway] PRICING_NOT_FOUND: ${requestModel}`);
      clientRes.writeHead(200, { 'content-type': 'text/event-stream' });
      clientRes.end(
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(msg)}}}\n\n` +
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      );
      return false;
    }

    const projectedTask = currentTaskCost + estimatedNextCall;
    const projectedDaily = currentDailyCost + estimatedNextCall;
    const taskCap = Math.min(taskBudget, this.config.budget.absoluteTaskMaxRmb);

    if (projectedTask > taskCap) {
      const msg = formatBudgetGateLine(currentTaskCost, projectedTask, taskCap);
      console.log(`[gateway] BUDGET_TASK_EXCEEDED: ${msg}`);
      clientRes.writeHead(200, { 'content-type': 'text/event-stream' });
      clientRes.end(
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(msg)}}}\n\n` +
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      );
      return false;
    }

    if (projectedDaily > dailyBudget) {
      const msg = `【预算门闸：已花 ¥${currentDailyCost.toFixed(2)}，预计下一轮后达到 ¥${projectedDaily.toFixed(2)}，超过当日限额 ¥${dailyBudget.toFixed(2)}，任务已停止】`;
      console.log(`[gateway] BUDGET_DAILY_EXCEEDED: ${msg}`);
      clientRes.writeHead(200, { 'content-type': 'text/event-stream' });
      clientRes.end(
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(msg)}}}\n\n` +
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      );
      return false;
    }

    return true;
  }
}

// 仅在直接运行时启动服务器（非 import）。
// 注意：start.ts 是正式入口，import 本文件时不得触发自启动（否则端口被抢，start.ts 反遭 EADDRINUSE）。
function isMain(): boolean {
  // ESM 下的 is-main 检测
  const entry = process.argv[1] || '';
  return entry.endsWith('server.ts') || entry.endsWith('server.js');
}

if (isMain()) {
  const port = parseInt(process.env.CC_AUTO_GATEWAY_PORT || '15722', 10);
  const configPath = process.env.CC_AUTO_GATEWAY_CONFIG;

  // 在 isMain 模式下，环境变量端口覆盖默认端口
  const finalConfig = configPath ? loadGatewayConfig(configPath) : loadGatewayConfig();
  if (process.env.CC_AUTO_GATEWAY_PORT) {
    finalConfig.port = port;
  }

  const gatewayInstance = new BudgetGateway(finalConfig);
  gatewayInstance.start().then(() => {
    console.log(`[gateway] Ready. Send Claude Desktop traffic to http://127.0.0.1:${port}`);
    console.log(`[gateway] Upstream: CC Switch http://127.0.0.1:15721/claude-desktop`);
  }).catch((err) => {
    console.error('[gateway] Failed to start:', err.message);
    process.exit(1);
  });

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('[gateway] Shutting down...');
    gatewayInstance.stop().then(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    console.log('[gateway] Shutting down...');
    gatewayInstance.stop().then(() => process.exit(0));
  });
}
