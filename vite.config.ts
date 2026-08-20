import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// OfferFlow v0.1 — Vite config. Local-first, no backend, no API.
// vite.config.ts
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:17365',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
})