import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * RC-10 雷达动作「收藏 / 忽略 / 标记优先 / 已投待反馈」正式 E2E。
 * 单 worker 串行（共享同一临时库，顺序敏感）；globalSetup 启动全部服务并写 runtime.json，
 * 返回的 teardown 关闭全部服务并清理临时库。
 */
export default defineConfig({
  testDir: here,
  testMatch: '**/*.e2e.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  globalSetup: path.join(here, 'global-setup.ts'),
  outputDir: path.resolve(here, '../test-results/action-e2e'),
  use: { headless: true },
  reporter: [['line'], ['html', { outputFolder: path.resolve(here, '../playwright-report/action-e2e'), open: 'never' }]],
});
