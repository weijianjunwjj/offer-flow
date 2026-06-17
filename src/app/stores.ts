// 浏览器端 stores 单例。延迟创建，避免在模块加载时就访问 localStorage，
// 便于在非浏览器环境（如类型检查 / 未来测试）下按需注入。
import { createBrowserStores } from '../storage';
import type { OfferFlowStores } from '../storage';

let cached: OfferFlowStores | null = null;

export function useStores(): OfferFlowStores {
  if (cached === null) {
    cached = createBrowserStores();
  }
  return cached;
}
