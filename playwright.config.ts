import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './.vite/playwright-test-results',
  use: { baseURL: process.env.OFFERFLOW_ROUTER_BASE_URL ?? 'http://127.0.0.1:4174' },
});
