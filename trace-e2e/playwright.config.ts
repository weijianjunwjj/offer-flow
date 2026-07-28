import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * RC-11 反向追踪 E2E（正向来源链 + 三类正式对象反查 + link 多晋升 + 触发四态 + 批次成员推断
 * + 撤销不破坏追踪 + 无来源明确 + 刷新保持 + 正式事实零写入 + 库完整性）。
 * 单 worker 串行（共享同一临时库，顺序敏感）；globalSetup 启动服务、预建晋升 fixture 并写 runtime.json。
 */
export default defineConfig({
  testDir: here,
  testMatch: '**/*.e2e.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  globalSetup: path.join(here, 'global-setup.ts'),
  outputDir: path.resolve(here, '../test-results/trace-e2e'),
  use: { headless: true },
  reporter: [['line'], ['html', { outputFolder: path.resolve(here, '../playwright-report/trace-e2e'), open: 'never' }]],
});
