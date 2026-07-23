import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { buildServer } from '../server/index';
import { openDb } from '../server/db';
import { initSchema } from '../server/schema';
import { seedReviewFixture, type ReviewFixtureResult } from '../server/radar/reviewFixture';

/**
 * V8-3 人工评审工作台 —— 真实浏览器 + 临时 v8 数据库验收沙箱。
 *
 * 严格边界（与 devRadarSandbox 一致，仅 schema 目标与种子不同）：
 * - 使用系统临时目录中的独立 SQLite 库，绝不指向真实生产库（data/offerflow.sqlite3）；
 * - 每次启动重建为全新空库并迁移到 schema v8（relations + evidence_json）；
 * - 经真实 service 落库 12 类确定性 fixture（疑似重复/confirmed_distinct/needs_recheck/
 *   identity_conflict/regression/ambiguous/material + structured/legacy/corrupt 证据 +
 *   已覆盖/未覆盖规则）；
 * - 后端开启 Radar capability，前端开启 Radar feature，全部监听 127.0.0.1；
 * - Web 端口固定 17365，/radar、/health、/meta 反代到后端；
 * - 绝不修改真实数据库、不触碰任何正式求职记忆。
 */

function argValue(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? undefined : hit.slice(flag.length + 1);
}

const DEV_HOST = '127.0.0.1';
const DEV_WEB_PORT = Number(argValue('--web-port') ?? process.env.OFFERFLOW_RADAR_REVIEW_WEB_PORT ?? 17365);
const DEV_API_PORT = Number(argValue('--api-port') ?? process.env.OFFERFLOW_RADAR_REVIEW_API_PORT ?? 17366);

const SANDBOX_DIR = path.join(os.tmpdir(), 'offerflow-radar-review-sandbox');
const SANDBOX_DB_PATH = path.join(SANDBOX_DIR, `radar-review-${Date.now()}.sqlite3`);

function prepareSandboxDir(): void {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  for (const name of fs.readdirSync(SANDBOX_DIR)) {
    try {
      fs.rmSync(path.join(SANDBOX_DIR, name), { force: true });
    } catch {
      // 仍被占用的旧库文件保留，本轮使用带时间戳的新文件。
    }
  }
}

function reviewSandboxViteConfig(apiTarget: string): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      'import.meta.env.VITE_OFFERFLOW_RADAR': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_API_BASE': JSON.stringify(`http://${DEV_HOST}:${DEV_WEB_PORT}`),
    },
    server: {
      host: DEV_HOST,
      port: DEV_WEB_PORT,
      strictPort: true,
      proxy: {
        '/radar': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
        '/meta': { target: apiTarget, changeOrigin: true },
      },
    },
  };
}

/** 用确定性 deps（可复现 ID/时间）建 v8 库并注入 fixture，返回关键 ID 供输出与 E2E 使用。 */
function seedSandboxDatabase(): ReviewFixtureResult {
  const db = openDb(SANDBOX_DB_PATH);
  initSchema(db, { targetVersion: 8 });
  let counter = 0;
  let now = 3_000_000;
  const result = seedReviewFixture(db, { now: () => (now += 1000), createId: () => `rvsb-${(counter += 1)}` });
  db.close();
  return result;
}

async function main(): Promise<void> {
  if (SANDBOX_DB_PATH === '') throw new Error('沙箱库路径为空');
  prepareSandboxDir();
  const fixture = seedSandboxDatabase();

  // 注入已 seed 的 v8 库；requiredVersion=v8 与库版本一致，不触发迁移，也绝不指向真实生产库。
  const injected = openDb(SANDBOX_DB_PATH);
  const app = buildServer({ db: injected, radar: { enabled: true } });

  console.log('[评审沙箱] 独立临时 v8 库（非真实生产库）：');
  console.log(`[评审沙箱]   库文件: ${SANDBOX_DB_PATH}`);
  console.log('[评审沙箱]   fixture 关键 ID：', JSON.stringify(fixture, null, 2));

  let closing = false;
  let vite: ViteDevServer | null = null;
  const teardown = (exitCode: number): void => {
    if (closing) return;
    closing = true;
    Promise.resolve()
      .then(() => vite?.close())
      .then(() => app.close())
      .then(() => process.exit(exitCode))
      .catch((error: unknown) => { console.error(error); process.exit(1); });
  };
  process.once('SIGINT', () => teardown(130));
  process.once('SIGTERM', () => teardown(143));

  let apiUrl: string;
  try {
    apiUrl = await app.listen({ host: DEV_HOST, port: DEV_API_PORT });
  } catch (error) {
    console.error('[评审沙箱] 后端 API 启动失败，前端不会启动：', error);
    throw error;
  }
  console.log(`[评审沙箱] API（内部，经 Vite 代理）: ${apiUrl}`);
  app.server.on('close', () => {
    if (closing) return;
    console.error('[评审沙箱] 后端进程意外退出，正在关闭前端 Vite...');
    teardown(1);
  });

  try {
    vite = await createViteServer(reviewSandboxViteConfig(apiUrl));
    await vite.listen();
  } catch (error) {
    console.error('[评审沙箱] 前端 Vite 启动失败，正在关闭后端 API...', error);
    await app.close();
    throw error;
  }
  vite.httpServer?.on('close', () => {
    if (closing) return;
    console.error('[评审沙箱] 前端 Vite 意外退出，正在关闭后端 API...');
    teardown(1);
  });

  console.log(`[评审沙箱] Web: http://${DEV_HOST}:${DEV_WEB_PORT}/#/radar/review`);
  console.log('[评审沙箱] 该环境不连接真实数据库，所有写入只影响上面的临时库文件。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { SANDBOX_DB_PATH, seedSandboxDatabase };
