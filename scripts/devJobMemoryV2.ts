import { pathToFileURL } from 'node:url';
import {
  createShutdownController,
  runJobMemoryV2Smoke,
  startJobMemoryV2DevSession,
  type JobMemoryV2DevSession,
} from './jobMemoryV2DevHarness';

async function runDev(): Promise<void> {
  let session: JobMemoryV2DevSession | null = null;
  const shutdown = createShutdownController(process, async () => {
    await session?.close();
  });
  try {
    session = await startJobMemoryV2DevSession({ withVite: true });
    console.log('[B6 临时联调] 仅使用系统临时 schema v2 SQLite；退出会清理全部临时数据。');
    console.log(`[B6 临时联调] API: ${session.apiUrl}`);
    console.log(`[B6 临时联调] Web: ${session.webUrl}/#/jobs`);
    console.log(`[B6 临时联调] Temp DB: ${session.dbPath}`);
    process.exitCode = await shutdown.wait();
  } catch (error) {
    await shutdown.requestShutdown(1, error);
    process.exitCode = await shutdown.wait();
  } finally {
    shutdown.dispose();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--smoke')) {
    const report = await runJobMemoryV2Smoke();
    console.log('[B6 临时联调 smoke] PASS', JSON.stringify(report));
    return;
  }
  await runDev();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
