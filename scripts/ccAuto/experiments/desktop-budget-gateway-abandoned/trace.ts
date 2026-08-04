/**
 * cc-auto 诊断跟踪模块（CC_AUTO_GATEWAY_TRACE=1）。
 *
 * 只记录非敏感字段：事件类型、index、stop_reason、usage 布尔、分支路径。
 * 禁止记录 Prompt、Authorization、system 内容、tool 参数正文。
 *
 * JSONL 输出到 %LOCALAPPDATA%/cc-auto-gateway/traces/trace.jsonl。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TRACE_ENABLED = process.env.CC_AUTO_GATEWAY_TRACE === '1';

const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'cc-auto-gateway');
const TRACE_FILE = path.join(DATA_DIR, 'traces', 'trace.jsonl');

let _initialized = false;

function ensureDir(): void {
  if (!_initialized) {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    _initialized = true;
  }
}

function emit(entry: Record<string, unknown>): void {
  ensureDir();
  const line = JSON.stringify(entry);
  fs.appendFileSync(TRACE_FILE, line + '\n', 'utf8');
}

// ======== 公开 API ========

export function isTraceEnabled(): boolean {
  return TRACE_ENABLED;
}

export function generateTraceId(): string {
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Gateway 端 trace 入口。 */
export function traceGateway(traceId: string, event: Record<string, unknown>): void {
  if (!TRACE_ENABLED || !traceId) return;
  emit({ traceId, ts: new Date().toISOString(), pid: process.pid, role: 'gateway', ...event });
}

/** Mock 端 trace 入口。 */
export function traceMock(traceId: string, event: Record<string, unknown>): void {
  if (!TRACE_ENABLED || !traceId) return;
  emit({ traceId, ts: new Date().toISOString(), pid: process.pid, role: 'mock', ...event });
}

// ======== 请求级 traceId 存储 ========

/** 按 IncomingMessage 弱关联 traceId（避免修改方法签名）。 */
const _traceMap = new WeakMap<object, string>();

export function setRequestTraceId(req: object, traceId: string): void {
  _traceMap.set(req, traceId);
}

export function getRequestTraceId(req: object): string {
  return _traceMap.get(req) || '';
}

export function clearRequestTraceId(req: object): void {
  _traceMap.delete(req);
}

// ======== 字段采集辅助 ========

/** 从请求 body 中安全提取最后一个 user block 类型（不记录文本内容）。 */
export function classifyLastUserBlock(body: Record<string, unknown>): 'text' | 'tool_result' | 'mixed' | 'none' {
  try {
    const messages = body.messages as Array<Record<string, unknown>>;
    if (!messages || !Array.isArray(messages)) return 'none';
    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) return 'none';
    const lastUser = userMessages[userMessages.length - 1];
    const content = lastUser.content;
    if (typeof content === 'string') return 'text';
    if (Array.isArray(content)) {
      const types = new Set(content.map((b: unknown) =>
        typeof b === 'object' && b !== null ? (b as Record<string, unknown>).type : 'unknown'));
      if (types.has('tool_result') && types.size === 1) return 'tool_result';
      if (types.has('tool_result') && types.size > 1) return 'mixed';
      if (types.has('text')) return 'text';
      return 'none';
    }
    return 'none';
  } catch {
    return 'none';
  }
}

/** 从响应 SSE data 对象中提取 content_block 类型（text / tool_use / unknown）。 */
export function contentBlockType(data: Record<string, unknown>): string {
  if (data.content_block && typeof data.content_block === 'object') {
    return (data.content_block as Record<string, unknown>).type as string || 'unknown';
  }
  if (data.delta && typeof data.delta === 'object') {
    return (data.delta as Record<string, unknown>).type as string || 'unknown';
  }
  return 'unknown';
}

// ======== 本地目标判断 ========

/**
 * 判断目标 URL 是否为回环地址。
 * 仅 127.0.0.1、localhost、::1、[::1] 返回 true；
 * 公网地址、其他域名、非法 URL 一律返回 false。
 */
export function isLoopbackTarget(upstreamUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(upstreamUrl).hostname;
  } catch {
    return false;
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}
