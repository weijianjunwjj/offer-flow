import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    clearMocks: true,
    restoreMocks: true,
    // 多套集成/快照测试会 spawn 真实 git 子进程或做整库 restore/copy，实测在全量并行下
    // 间歇性超过默认 5000ms（例如 scripts/ccAuto/cli-routed-architecture-gate.spec.ts、
    // scripts/ccAuto/*.integration.spec.ts、server/snapshot/v3/residueInspection.spec.ts 等）。
    // 这类重测试正常就要 5~20s，统一放宽到 30s 仍能捕获真实挂起，同时消除资源竞争 flaky。
    testTimeout: 30_000,
    include: ['src/**/*.spec.ts', 'server/**/*.spec.ts', 'browser-extension/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    exclude: ['browser-extension/e2e/**', 'scripts/ccAuto/experiments/desktop-budget-gateway-abandoned/**'],
  },
});
