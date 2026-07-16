import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { buildServer } from '../server/index';
import { G5_SANDBOX_DB_PATH, prepareG5Sandbox } from './g5SandboxPrepare';

const DEV_HOST = '127.0.0.1';
const DEV_API_PORT = Number(process.env.OFFERFLOW_G5_SANDBOX_API_PORT ?? 17475);
const DEV_WEB_PORT = Number(process.env.OFFERFLOW_G5_SANDBOX_WEB_PORT ?? 5185);

function g5SandboxViteConfig(apiUrl: string): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      'import.meta.env.VITE_OFFERFLOW_HISTORY_IMPORT': JSON.stringify('true'),
      // G5 页面需要 G4 市场位置也可见，因此同时打开 G4 与 G5 sandbox 标记。
      'import.meta.env.VITE_OFFERFLOW_G4_SANDBOX': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_G5_SANDBOX': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_API_BASE': JSON.stringify(apiUrl),
    },
    server: {
      host: DEV_HOST,
      port: DEV_WEB_PORT,
      strictPort: true,
    },
  };
}

async function main(): Promise<void> {
  const report = prepareG5Sandbox();
  console.log('[G5 沙箱验收] 已从 G4 沙箱 v5 副本创建独立测试副本（不修改真实数据库/G4 源库）：');
  console.log(`[G5 沙箱验收]   G4 源库:   ${report.sourceDatabasePath}`);
  console.log(`[G5 沙箱验收]   沙箱副本:  ${report.sandboxDatabasePath}`);
  console.log(`[G5 沙箱验收]   G4 源库哈希（前/后一致): ${report.sourceUnchanged}`);
  console.log(`[G5 沙箱验收]   真实库哈希（前/后一致): ${report.realDbUnchanged}`);
  console.log(`[G5 沙箱验收]   沙箱 schema 版本: ${report.sandboxSchemaVersionAfter}`);

  const app = buildServer({
    dbPath: G5_SANDBOX_DB_PATH,
    capabilityBaseline: { enabled: true },
    historyImport: { enabled: true },
    marketPosition: { enabled: true },
    strategyWindow: { enabled: true },
  });

  let closing = false;
  let vite: ViteDevServer | null = null;
  const teardown = (exitCode: number): void => {
    if (closing) return;
    closing = true;
    Promise.resolve()
      .then(() => vite?.close())
      .then(() => app.close())
      .then(() => {
        process.exit(exitCode);
      })
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
    console.error('[G5 沙箱验收] 后端 API 启动失败，前端不会启动：', error);
    throw error;
  }
  console.log(`[G5 沙箱验收] API: ${apiUrl}`);
  app.server.on('close', () => {
    if (closing) return;
    console.error('[G5 沙箱验收] 后端进程意外退出，正在关闭前端 Vite 并终止整个沙箱进程...');
    teardown(1);
  });

  try {
    vite = await createViteServer(g5SandboxViteConfig(apiUrl));
    await vite.listen();
  } catch (error) {
    console.error('[G5 沙箱验收] 前端 Vite 启动失败，正在关闭后端 API...', error);
    await app.close();
    throw error;
  }
  vite.httpServer?.on('close', () => {
    if (closing) return;
    console.error('[G5 沙箱验收] 前端 Vite 意外退出，正在关闭后端 API 并终止整个沙箱进程...');
    teardown(1);
  });
  console.log(`[G5 沙箱验收] Web: http://${DEV_HOST}:${DEV_WEB_PORT}/#/strategy-window`);
  console.log('[G5 沙箱验收] 页面顶部会显示隔离验收环境横幅；所有提案/版本写入只影响沙箱副本。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
