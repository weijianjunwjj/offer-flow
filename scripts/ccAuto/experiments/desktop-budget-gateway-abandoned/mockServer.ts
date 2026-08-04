/**
 * 第二层零费用测试专用 mock upstream（独立进程）。
 *
 * 只监听 127.0.0.1；不访问公网。
 * 不记录 Authorization 值、不记录完整 Prompt（仅记录"是否有认证头"布尔）。
 * 请求模型从请求 body 回显；正文固定 MOCK_OK；返回完整 usage；
 * 最终发送 message_delta(stop_reason=end_turn) + message_stop。
 *
 * 环境变量：
 *   MOCK_PORT      监听端口（缺省 0 = 自动分配）
 *   MOCK_INFO_FILE 写入 { pid, port } 的 JSON 文件（缺省不写）
 */
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { buildSse } from './mockUpstream';
import { traceMock, generateTraceId, isTraceEnabled } from './trace';

const MOCK_PORT = parseInt(process.env.MOCK_PORT || '0', 10);
const INFO_FILE = process.env.MOCK_INFO_FILE || '';

let messagesCount = 0;
let authHeaderSeen = false;

function sendJson(res: http.ServerResponse, statusCode: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(body);
}

/** 解析 SSE 字符串为非敏感事件列表（用于 trace）。 */
function describeSseEvents(sse: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const blocks = sse.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    let evtName = '';
    let dataStr = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event: ')) evtName = trimmed.slice(7);
      else if (trimmed.startsWith('event:')) evtName = trimmed.slice(6);
      else if (trimmed.startsWith('data: ')) dataStr = trimmed.slice(6);
      else if (trimmed.startsWith('data:')) dataStr = trimmed.slice(5);
    }
    if (!evtName || !dataStr) continue;
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(dataStr); } catch { continue; }
    const desc: Record<string, unknown> = { sseEvent: evtName };
    if (parsed.index !== undefined) desc.index = parsed.index;
    if (evtName === 'content_block_start' || evtName === 'content_block_delta') {
      if (parsed.content_block && typeof parsed.content_block === 'object') {
        desc.blockType = (parsed.content_block as Record<string, unknown>).type;
      }
      if (parsed.delta && typeof parsed.delta === 'object') {
        desc.deltaType = (parsed.delta as Record<string, unknown>).type;
      }
    }
    if (evtName === 'message_delta') {
      if (parsed.delta && typeof parsed.delta === 'object') {
        desc.stopReason = (parsed.delta as Record<string, unknown>).stop_reason;
      }
      desc.hasUsage = parsed.usage !== undefined;
    }
    if (evtName === 'message_stop') desc.isMessageStop = true;
    events.push(desc);
  }
  return events;
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  // 状态接口：用于验收时查询计数（不暴露任何敏感信息）
  if (url === '/__mock_stats') {
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      port: (server.address() as net.AddressInfo).port,
      messagesCount,
      authHeaderSeen,
    });
    return;
  }

  // /v1/messages：返回合法 SSE（回显请求模型 + MOCK_OK + 完整 usage + message_stop）
  if (url.endsWith('/v1/messages') && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      messagesCount += 1;
      if (req.headers['authorization'] !== undefined || req.headers['x-api-key'] !== undefined) {
        authHeaderSeen = true;
      }
      let model = 'deepseek-v4-flash';
      let stream: boolean | undefined = undefined;
      let traceId = '';
      let bodyStr = '';
      try {
        bodyStr = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(bodyStr);
        if (parsed && typeof parsed.model === 'string') model = parsed.model;
        if (parsed && 'stream' in parsed) stream = parsed.stream === true;
      } catch {
        /* 不记录请求体 */
      }

      // 从 Gateway 转发的 x-trace-id 中获取 traceId
      const incomingTraceId = req.headers['x-trace-id'];
      traceId = typeof incomingTraceId === 'string'
        ? incomingTraceId
        : (isTraceEnabled() ? generateTraceId() : '');

      const responseStartTime = new Date().toISOString();

      const sse = buildSse({
        model,
        stopReason: 'end_turn',
        text: 'MOCK_OK',
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      });

      if (isTraceEnabled()) {
        traceMock(traceId, {
          event: 'mock_request_received',
          pathname: url,
          stream,
          model,
          messagesCount,
          responseStartTime,
        });
        traceMock(traceId, {
          event: 'mock_sse_events',
          sequence: describeSseEvents(sse),
        });
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse);

      // 确认 response.end 已执行，记录 socket 状态
      if (isTraceEnabled()) {
        traceMock(traceId, {
          event: 'mock_response_sent',
          responseEndCalled: true,
          socketDestroyed: req.socket?.destroyed,
          writableEnded: res.writableEnded,
        });
      }

      req.on('close', () => {
        if (isTraceEnabled()) {
          traceMock(traceId, { event: 'mock_socket_close', aborted: false });
        }
      });
      req.on('aborted', () => {
        if (isTraceEnabled()) {
          traceMock(traceId, { event: 'mock_socket_aborted' });
        }
      });
      res.on('close', () => {
        if (isTraceEnabled()) {
          traceMock(traceId, { event: 'mock_response_close' });
        }
      });
    });
    return;
  }

  // 其余路径（/v1/models、GET / 等）无害返回 200
  sendJson(res, 200, { ok: true, path: url });
});

server.listen(MOCK_PORT, '127.0.0.1', () => {
  const addr = server.address() as net.AddressInfo;
  const info = { pid: process.pid, port: addr.port };
  console.log(`MOCK_UPSTREAM_READY ${JSON.stringify(info)}`);
  if (INFO_FILE) {
    fs.writeFileSync(INFO_FILE, JSON.stringify(info, null, 2), 'utf8');
  }
});
