/**
 * 本地 mock Anthropic 上游（测试辅助，不落库、不访问公网）。
 *
 * 只绑定 127.0.0.1；不记录 Authorization / 完整 Prompt；
 * 记录请求计数与收到的 Authorization 是否存在（仅布尔），供测试断言。
 */
import * as http from 'node:http';
import * as net from 'node:net';

export interface MockCallRecord {
  path: string;
  method: string;
  hasAuthHeader: boolean;
  /** 请求 body 中是否有 tools（用于断言 tool_use 轮） */
  isToolResultOnly: boolean;
}

export interface MockUpstreamHandle {
  server: http.Server;
  port: number;
  calls: MockCallRecord[];
  /** 收到 /v1/messages 的计数 */
  messagesCount: number;
  /** 收到的 Authorization 头（仅内存，测试内使用） */
  authHeaders: Array<string | undefined>;
  stop: () => Promise<void>;
}

export interface MockSseResponse {
  model: string;
  stopReason: 'end_turn' | 'tool_use';
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** 正文 text 内容 */
  text: string;
  /** 是否在 message_delta 之后补 message_stop */
  withMessageStop?: boolean;
}

/** 构造一段合法的 Anthropic 流式 SSE（可含 tool_use）。m.usage 未提供时整段响应不带 usage。 */
export function buildSse(m: MockSseResponse): string {
  const messageObj: Record<string, unknown> = {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: m.model,
    content: [],
  };
  if (m.usage) messageObj.usage = m.usage;
  const msgStart = JSON.stringify({ type: 'message_start', message: messageObj });
  const contentStart = JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  const contentDelta = JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: m.text },
  });
  const contentStop = JSON.stringify({ type: 'content_block_stop', index: 0 });
  const messageDeltaObj: Record<string, unknown> = {
    type: 'message_delta',
    delta: { stop_reason: m.stopReason },
  };
  if (m.usage) messageDeltaObj.usage = m.usage;
  const messageDelta = JSON.stringify(messageDeltaObj);
  const messageStop = JSON.stringify({ type: 'message_stop' });

  let sse = `event: message_start\ndata: ${msgStart}\n\n`;
  sse += `event: content_block_start\ndata: ${contentStart}\n\n`;
  sse += `event: content_block_delta\ndata: ${contentDelta}\n\n`;
  sse += `event: content_block_stop\ndata: ${contentStop}\n\n`;
  sse += `event: message_delta\ndata: ${messageDelta}\n\n`;
  if (m.withMessageStop !== false) {
    sse += `event: message_stop\ndata: ${messageStop}\n\n`;
  }
  return sse;
}

/** 构造一个非流式 JSON 响应。m.usage 未提供时响应不带 usage。 */
export function buildNonStreamingJson(m: MockSseResponse): string {
  const resp: Record<string, unknown> = {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: m.model,
    content: [{ type: 'text', text: m.text }],
    stop_reason: m.stopReason,
  };
  if (m.usage) resp.usage = m.usage;
  return JSON.stringify(resp);
}

/**
 * 启动 mock 上游。绑定到 127.0.0.1:0（随机空闲端口）。
 *
 * @param responder 根据请求路径/请求体决定返回。缺省返回 "OK" 的 SSE。
 */
export async function startMockUpstream(options?: {
  /** 默认 SSE 响应；可按 path 覆盖 */
  handler?: (req: http.IncomingMessage, body: string) => { statusCode?: number; contentType?: string; body: string };
}): Promise<MockUpstreamHandle> {
  const handle: MockUpstreamHandle = {
    server: null as unknown as http.Server,
    port: 0,
    calls: [],
    messagesCount: 0,
    authHeaders: [],
    stop: async () => { await new Promise<void>((r) => { handle.server.close(() => r()); handle.server.once('error', () => r()); }); },
  };

  handle.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const record: MockCallRecord = {
        path: req.url ?? '/',
        method: req.method ?? 'GET',
        hasAuthHeader: req.headers['authorization'] !== undefined || req.headers['x-api-key'] !== undefined,
        isToolResultOnly: body.includes('"type":"tool_result"'),
      };
      handle.calls.push(record);
      handle.authHeaders.push(req.headers['authorization'] as string | undefined);
      if ((req.url ?? '').split('?')[0].endsWith('/v1/messages')) {
        handle.messagesCount += 1;
      }

      if (options?.handler) {
        const r = options.handler(req, body);
        res.writeHead(r.statusCode ?? 200, { 'content-type': r.contentType ?? 'text/event-stream' });
        res.end(r.body);
        return;
      }

      // 缺省：返回 "OK" 的完整 SSE（end_turn + usage + message_stop）
      const sse = buildSse({ model: 'deepseek-v4-flash', stopReason: 'end_turn', text: 'OK', usage: { input_tokens: 10, output_tokens: 10 } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse);
    });
  });

  await new Promise<void>((resolve, reject) => {
    handle.server.once('error', reject);
    handle.server.listen(0, '127.0.0.1', () => {
      const addr = handle.server.address() as net.AddressInfo;
      handle.port = addr.port;
      resolve();
    });
  });

  return handle;
}
