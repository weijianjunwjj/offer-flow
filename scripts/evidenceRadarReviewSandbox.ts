import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { buildServer } from '../server/index';
import { openDb } from '../server/db';
import { initSchema } from '../server/schema';
import { seedReviewFixture } from '../server/radar/reviewFixture';

// V8-3 证据补拍专用一次性沙箱：独立临时目录 + 退出自清理，绝不触碰验收沙箱与生产库。
const HOST = '127.0.0.1';
const WEB_PORT = Number(process.env.EVID_WEB_PORT ?? 17375);
const API_PORT = Number(process.env.EVID_API_PORT ?? 17376);
const DIR = path.join(os.tmpdir(), 'offerflow-radar-review-evidence');
const DB_PATH = path.join(DIR, 'evidence.sqlite3');

function cleanup(): void {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  cleanup();
  fs.mkdirSync(DIR, { recursive: true });
  const seedDb = openDb(DB_PATH);
  initSchema(seedDb, { targetVersion: 8 });
  let counter = 0; let now = 3_000_000;
  const fixture = seedReviewFixture(seedDb, { now: () => (now += 1000), createId: () => `rvsb-${(counter += 1)}` });
  seedDb.close();

  const app = buildServer({ db: openDb(DB_PATH), radar: { enabled: true } });
  const apiUrl = await app.listen({ host: HOST, port: API_PORT });
  const config: InlineConfig = {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      'import.meta.env.VITE_OFFERFLOW_RADAR': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_API_BASE': JSON.stringify(`http://${HOST}:${WEB_PORT}`),
    },
    server: { host: HOST, port: WEB_PORT, strictPort: true, proxy: {
      '/radar': { target: apiUrl, changeOrigin: true },
      '/health': { target: apiUrl, changeOrigin: true },
      '/meta': { target: apiUrl, changeOrigin: true },
    } },
  };
  const vite: ViteDevServer = await createViteServer(config);
  await vite.listen();
  console.log('[证据沙箱] 库文件(独立临时):', DB_PATH);
  console.log('[证据沙箱] suspectedRelationId:', fixture.suspectedRelationId);
  console.log(`[证据沙箱] Web: http://${HOST}:${WEB_PORT}/#/radar/review`);

  const teardown = (code: number): void => {
    Promise.resolve().then(() => vite.close()).then(() => app.close())
      .then(() => { cleanup(); process.exit(code); })
      .catch(() => { cleanup(); process.exit(1); });
  };
  process.once('SIGINT', () => teardown(130));
  process.once('SIGTERM', () => teardown(143));
}

main().catch((error: unknown) => { console.error(error); cleanup(); process.exit(1); });
