import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * V8-3 人工评审工作台正式 E2E。与 extension E2E 独立：
 * - 单 worker 串行（裁决用例共享同一临时库，顺序敏感）；
 * - globalSetup 启动全部服务并写 runtime.json，返回的 teardown 关闭全部服务。
 */
export default defineConfig({
  testDir: here,
  testMatch: '**/*.e2e.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  globalSetup: path.join(here, 'global-setup.ts'),
  outputDir: path.resolve(here, '../test-results/review-e2e'),
  use: { headless: true },
  reporter: [['line'], ['html', { outputFolder: path.resolve(here, '../playwright-report/review-e2e'), open: 'never' }]],
});
