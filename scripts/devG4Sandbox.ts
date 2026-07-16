import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { buildServer } from '../server/index';
import { G4_SANDBOX_DB_PATH, prepareG4Sandbox } from './g4SandboxPrepare';

const DEV_HOST = '127.0.0.1';
const DEV_API_PORT = Number(process.env.OFFERFLOW_G4_SANDBOX_API_PORT ?? 17465);
const DEV_WEB_PORT = Number(process.env.OFFERFLOW_G4_SANDBOX_WEB_PORT ?? 5174);

function g4SandboxViteConfig(apiUrl: string): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      'import.meta.env.VITE_OFFERFLOW_HISTORY_IMPORT': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_G4_SANDBOX': JSON.stringify('true'),
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
  const report = prepareG4Sandbox();
  console.log('[G4 沙箱验收] 已从真实数据库创建独立测试副本（不修改真实数据库）：');
  console.log(`[G4 沙箱验收]   真实数据库: ${report.sourceDatabasePath}`);
  console.log(`[G4 沙箱验收]   沙箱副本:   ${report.sandboxDatabasePath}`);
  console.log(`[G4 沙箱验收]   真实库哈希（前/后一致): ${report.sourceUnchanged}`);
  console.log(`[G4 沙箱验收]   沙箱 schema 版本: ${report.sandboxSchemaVersionAfter}`);

  const app = buildServer({
    dbPath: G4_SANDBOX_DB_PATH,
    capabilityBaseline: { enabled: true },
    historyImport: { enabled: true },
    marketPosition: { enabled: true },
  });

  let closing = false;
  let vite: ViteDevServer | null = null;
  const closeAndExit = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    Promise.resolve()
      .then(() => vite?.close())
      .then(() => app.close())
      .then(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      })
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => closeAndExit('SIGINT'));
  process.once('SIGTERM', () => closeAndExit('SIGTERM'));

  const apiUrl = await app.listen({ host: DEV_HOST, port: DEV_API_PORT });
  console.log(`[G4 沙箱验收] API: ${apiUrl}`);

  vite = await createViteServer(g4SandboxViteConfig(apiUrl));
  await vite.listen();
  console.log(`[G4 沙箱验收] Web: http://${DEV_HOST}:${DEV_WEB_PORT}/#/market-position`);
  console.log('[G4 沙箱验收] 页面顶部会显示隔离验收环境横幅；所有提案/版本写入只影响沙箱副本。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
