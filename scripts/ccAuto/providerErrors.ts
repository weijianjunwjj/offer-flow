/** cc-auto v0.2.0 Slice 1C — Provider 错误类型。
 *
 * 集中定义所有 Adapter、Executor 和测试共用的错误类。
 * 不在 adapter.ts 和 openaiChatAdapter.ts 之间形成循环依赖。
 *
 * Executor 通过 instanceof 稳定判断错误类别，不使用字符串 message 匹配。
 */

/** Provider 调用超时——由 AbortController 触发，非网络错误 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Provider 网络/传输层错误——DNS、TLS、socket、fetch rejection、redirect rejection。
 *
 * transient 用于标记已知瞬时网络失败（ECONNRESET、ETIMEDOUT、EAI_AGAIN 等），
 * 由 Tool Loop 据此决定是否有限重试。默认 false（fail closed）。 */
export class TransportError extends Error {
  /** true 表示该传输错误被识别为瞬时失败，可有限重试 */
  readonly transient?: boolean;

  constructor(message: string, opts?: { transient?: boolean }) {
    super(message);
    this.name = 'TransportError';
    this.transient = opts?.transient;
  }
}

/** Provider 协议层错误——2xx 但 JSON 无法解析、Schema 不匹配、Usage 不一致 */
export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderProtocolError';
  }
}
