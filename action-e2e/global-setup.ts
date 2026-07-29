import { startActionE2E } from './harness';

/** Playwright globalSetup：返回的函数被当作 globalTeardown（关闭全部服务并清理临时库）。 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  return startActionE2E();
}
