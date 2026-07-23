import { startReviewE2E } from './harness';

/**
 * Playwright globalSetup：启动临时 v8 评审沙箱 + v7 采集库 + flag 开/关两套前端，
 * 返回 teardown 关闭全部进程并清理临时库。全程不触碰真实生产库。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  return startReviewE2E();
}
