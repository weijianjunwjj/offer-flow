/** cc-auto v0.2.0 Slice 1C — 生产 Provider Adapter Registry。
 *
 * 只注册 OpenAIChatAdapter。
 * 不注册 MockProviderAdapter。
 * 未实现 transport（anthropic-messages / claude-cli）返回 null → TRANSPORT_NOT_IMPLEMENTED。
 */
import { AdapterRegistry } from './adapter';
import { OpenAIChatAdapter, type FetchLike } from './openaiChatAdapter';

/**
 * 创建生产 Registry。
 *
 * @param options.fetchImpl 可注入的 fetch 实现——仅用于测试注入；生产默认 globalThis.fetch。
 */
export function createProductionAdapterRegistry(
  options?: {
    fetchImpl?: FetchLike;
  },
): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new OpenAIChatAdapter(options?.fetchImpl));
  return registry;
}
