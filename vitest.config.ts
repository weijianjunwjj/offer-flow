import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    clearMocks: true,
    restoreMocks: true,
    // cc-auto 集成测试（scripts/ccAuto/*.integration.spec.ts）会 spawn 真实 git 子进程
    // 并跑多阶段编排；在 226 个文件并行时默认 5000ms 会因资源竞争间歇性超时。
    // 统一放宽到 30s，仍能捕获真实挂起（不会掩盖回归），同时消除并行竞争 flaky。
    testTimeout: 30_000,
    include: ['src/**/*.spec.ts', 'server/**/*.spec.ts', 'browser-extension/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    exclude: ['browser-extension/e2e/**', 'scripts/ccAuto/experiments/desktop-budget-gateway-abandoned/**'],
  },
});
