import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { buildServer } from '../server/index';
import { G6_CANDIDATE_DB, prepareReleaseCandidate } from '../server/release-promotion/rehearsal';

const DEV_HOST = '127.0.0.1';
const DEV_API_PORT = Number(process.env.OFFERFLOW_G6_REHEARSAL_API_PORT ?? 17485);
const DEV_WEB_PORT = Number(process.env.OFFERFLOW_G6_REHEARSAL_WEB_PORT ?? 5195);

function g6RehearsalViteConfig(apiUrl: string): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      // G6 演练环境正式启用 G1~G5 路由，但只显示一条 G6 横幅（不显示 G4/G5 沙箱双横幅）。
      'import.meta.env.VITE_OFFERFLOW_HISTORY_IMPORT': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_G6_REHEARSAL': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_API_BASE': JSON.stringify(apiUrl),
    },
    server: { host: DEV_HOST, port: DEV_WEB_PORT, strictPort: true },
  };
}

async function main(): Promise<void> {
  const report = prepareReleaseCandidate();
  console.log('[G6 演练] 已从真实库副本升级出 release candidate 并导入已验收 G4/G5 晋升包（不修改真实库）：');
  console.log(`[G6 演练]   候选库:            ${report.candidatePath}`);
  console.log(`[G6 演练]   候选 schema:        v${report.candidateSchemaVersion}`);
  console.log(`[G6 演练]   真实库哈希前后一致: ${report.realDbUnchanged}`);
  console.log(`[G6 演练]   晋升校验通过:        ${report.promotionVerified}`);

  const app = buildServer({
    dbPath: G6_CANDIDATE_DB,
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
      .then(() => { process.exit(exitCode); })
      .catch((error: unknown) => { console.error(error); process.exit(1); });
  };
  process.once('SIGINT', () => teardown(130));
  process.once('SIGTERM', () => teardown(143));

  let apiUrl: string;
  try {
    apiUrl = await app.listen({ host: DEV_HOST, port: DEV_API_PORT });
  } catch (error) {
    console.error('[G6 演练] 后端 API 启动失败，前端不会启动：', error);
    throw error;
  }
  console.log(`[G6 演练] API: ${apiUrl}`);
  app.server.on('close', () => {
    if (closing) return;
    console.error('[G6 演练] 后端进程意外退出，正在关闭前端 Vite 并终止整个演练进程...');
    teardown(1);
  });

  try {
    vite = await createViteServer(g6RehearsalViteConfig(apiUrl));
    await vite.listen();
  } catch (error) {
    console.error('[G6 演练] 前端 Vite 启动失败，正在关闭后端 API...', error);
    await app.close();
    throw error;
  }
  vite.httpServer?.on('close', () => {
    if (closing) return;
    console.error('[G6 演练] 前端 Vite 意外退出，正在关闭后端 API 并终止整个演练进程...');
    teardown(1);
  });
  console.log(`[G6 演练] Web: http://${DEV_HOST}:${DEV_WEB_PORT}/#/strategy-window`);
  console.log('[G6 演练] 页面顶部显示 G6 生产迁移演练横幅；数据来自真实库副本与已验收 G4/G5 晋升包，不修改真实求职数据。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
