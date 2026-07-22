import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { buildServer } from '../server/index';
import { getDatabaseSchemaVersion } from '../server/migrations';
import { openDb } from '../server/db';

/**
 * V8-2 岗位雷达当前页采集桥 —— 真实浏览器 + 临时 v7 数据库验收沙箱。
 *
 * 严格边界：
 * - 使用系统临时目录中的独立 SQLite 库，绝不指向真实生产库（data/offerflow.sqlite3）；
 * - 每次启动重建为全新空库并自动迁移到 schema v7；
 * - 后端显式开启 Radar capability，前端显式开启 Radar feature；
 * - 全部监听 127.0.0.1；
 * - Web 端口固定 17365，与浏览器扩展 manifest 中 host_permissions/buildPreviewUrl 对齐，
 *   并把 /radar、/health、/meta 反向代理到后端，使真实扩展能端到端打通；
 * - 不修改真实数据库、不启用真实入口 Radar、不触碰任何正式求职记忆。
 */

function argPort(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? undefined : hit.slice(flag.length + 1);
}

const DEV_HOST = '127.0.0.1';
// Web 默认 17365：扩展 manifest host_permissions 与 buildPreviewUrl 都硬编码该端口。
// 真实浏览器扩展验收必须用 17365；若该端口被真实服务占用，可用 --web-port= 改到空闲端口做非扩展验收。
const DEV_WEB_PORT = Number(argPort('--web-port') ?? process.env.OFFERFLOW_RADAR_SANDBOX_WEB_PORT ?? 17365);
// 后端 API 放在另一个 loopback 端口，由 Vite 代理转发。
const DEV_API_PORT = Number(argPort('--api-port') ?? process.env.OFFERFLOW_RADAR_SANDBOX_API_PORT ?? 17366);

const SANDBOX_DIR = path.join(os.tmpdir(), 'offerflow-radar-sandbox');
// 每次启动使用带时间戳的独立库文件：避免删除仍被上一进程占用的库文件（Windows 上会 EPERM），
// 同时保证每次都是全新空库。
const SANDBOX_DB_PATH = path.join(SANDBOX_DIR, `radar-sandbox-${Date.now()}.sqlite3`);

/** 准备沙箱目录，并尽力清理上一轮遗留的库文件（占用中的文件忽略，不阻塞启动）。 */
function prepareSandboxDir(): void {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  for (const name of fs.readdirSync(SANDBOX_DIR)) {
    try {
      fs.rmSync(path.join(SANDBOX_DIR, name), { force: true });
    } catch {
      // 仍被占用的旧库文件保留即可，本轮使用带时间戳的新文件。
    }
  }
}

function radarSandboxViteConfig(apiTarget: string): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      'import.meta.env.VITE_OFFERFLOW_RADAR': JSON.stringify('true'),
      // API base 指向同源 Web 端口，请求经 Vite 代理转发到后端；扩展也走同一入口。
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

async function main(): Promise<void> {
  if (SANDBOX_DB_PATH === '') throw new Error('沙箱库路径为空');
  prepareSandboxDir();

  // 先用后端自身的迁移逻辑把全新库升到 v7（radar 开启时 requiredVersion=v7，临时库允许自动迁移）。
  const app = buildServer({ dbPath: SANDBOX_DB_PATH, radar: { enabled: true } });

  const probe = openDb(SANDBOX_DB_PATH);
  const schemaVersion = getDatabaseSchemaVersion(probe);
  probe.close();
  console.log('[Radar 沙箱] 独立临时 v7 库（非真实生产库）：');
  console.log(`[Radar 沙箱]   库文件:      ${SANDBOX_DB_PATH}`);
  console.log(`[Radar 沙箱]   schema 版本: ${schemaVersion}`);

  let closing = false;
  let vite: ViteDevServer | null = null;
  const teardown = (exitCode: number): void => {
    if (closing) return;
    closing = true;
    Promise.resolve()
      .then(() => vite?.close())
      .then(() => app.close())
      .then(() => process.exit(exitCode))
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => teardown(130));
  process.once('SIGTERM', () => teardown(143));

  let apiUrl: string;
  try {
    apiUrl = await app.listen({ host: DEV_HOST, port: DEV_API_PORT });
  } catch (error) {
    console.error('[Radar 沙箱] 后端 API 启动失败，前端不会启动：', error);
    throw error;
  }
  console.log(`[Radar 沙箱] API（内部，经 Vite 代理）: ${apiUrl}`);
  app.server.on('close', () => {
    if (closing) return;
    console.error('[Radar 沙箱] 后端进程意外退出，正在关闭前端 Vite...');
    teardown(1);
  });

  try {
    vite = await createViteServer(radarSandboxViteConfig(apiUrl));
    await vite.listen();
  } catch (error) {
    console.error('[Radar 沙箱] 前端 Vite 启动失败，正在关闭后端 API...', error);
    await app.close();
    throw error;
  }
  vite.httpServer?.on('close', () => {
    if (closing) return;
    console.error('[Radar 沙箱] 前端 Vite 意外退出，正在关闭后端 API...');
    teardown(1);
  });

  console.log(`[Radar 沙箱] Web:       http://${DEV_HOST}:${DEV_WEB_PORT}/#/radar/import`);
  console.log('[Radar 沙箱] 浏览器扩展应指向同一 http://127.0.0.1:17365；采集后会跳转到上面的预览页。');
  console.log('[Radar 沙箱] 该环境不连接真实数据库，所有写入只影响上面的临时库文件。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { SANDBOX_DB_PATH };
