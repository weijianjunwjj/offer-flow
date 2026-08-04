import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    clearMocks: true,
    restoreMocks: true,
    include: ['src/**/*.spec.ts', 'server/**/*.spec.ts', 'browser-extension/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    exclude: ['browser-extension/e2e/**', 'scripts/ccAuto/experiments/desktop-budget-gateway-abandoned/**'],
  },
});
