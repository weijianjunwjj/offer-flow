import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server/index';
import { openDb } from '../server/db';
import { initSchema } from '../server/schema';
import { seedReviewFixture } from '../server/radar/reviewFixture';
import { RUNTIME_DIR, RUNTIME_FILE, tableSignature, type ReviewE2ERuntime } from './runtime';

/**
 * V8-3 人工评审工作台 —— 正式 Playwright E2E 编排器（自包含、无守护进程）。
 *
 * 严格边界：
 * - 临时 schema v8 库位于系统临时目录，绝不指向真实生产库 data/offerflow.sqlite3；
 * - 后端 API、前端 Vite 全部在 Playwright runner 进程内（in-process），无子进程残留；
 * - 端口全部动态分配，绝不占用人工沙箱固定的 17365 / 17366；
 * - teardown 关闭全部 server、清理临时库目录。
 */

const HOST = '127.0.0.1';

interface Handles {
  viteOn: ViteDevServer;
  viteOff: ViteDevServer;
  appV8: FastifyInstance;
  appV7: FastifyInstance;
  dbV8: ReturnType<typeof openDb>;
  dbV7: ReturnType<typeof openDb>;
  tempDir: string;
}

async function reservePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, HOST, () => resolve());
  });
  const address = srv.address();
  if (address === null || typeof address === 'string') {
    srv.close();
    throw new Error('无法预留 loopback 端口');
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  return port;
}

function viteConfig(webPort: number, apiTarget: string, radarEnabled: boolean): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      'import.meta.env.VITE_OFFERFLOW_RADAR': JSON.stringify(radarEnabled ? 'true' : 'false'),
      'import.meta.env.VITE_OFFERFLOW_API_BASE': JSON.stringify(`http://${HOST}:${webPort}`),
    },
    server: {
      host: HOST,
      port: webPort,
      strictPort: true,
      proxy: {
        '/radar': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
        '/meta': { target: apiTarget, changeOrigin: true },
      },
    },
  };
}

function countRow(db: ReturnType<typeof openDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

let handles: Handles | null = null;

/** 启动全部服务并写出 runtime 文件。返回 teardown 供 Playwright globalSetup 使用。 */
export async function startReviewE2E(): Promise<() => Promise<void>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-review-e2e-'));
  const dbPath = path.join(tempDir, 'review-v8.sqlite3');
  const dbV7Path = path.join(tempDir, 'capture-v7.sqlite3');

  // 1) 建临时 v8 库 + 确定性 seed（seed 与后端共用同一 deps，避免 ID 冲突）。
  let counter = 0;
  let now = 5_000_000;
  const deps = { now: () => (now += 1000), createId: () => `re2e-${(counter += 1)}` };
  const seedDb = openDb(dbPath);
  initSchema(seedDb, { targetVersion: 8 });
  const fixture = seedReviewFixture(seedDb, deps);
  const baseline = {
    jobs: countRow(seedDb, 'jobs'),
    applications: countRow(seedDb, 'applications'),
    feedbackEvents: countRow(seedDb, 'feedback_events'),
    candidates: countRow(seedDb, 'radar_candidates'),
    candidateVersions: countRow(seedDb, 'radar_candidate_versions'),
    ruleAssessments: countRow(seedDb, 'radar_rule_assessments'),
    // 不可变签名：裁决/覆盖只追加 radar_actions，绝不 UPDATE/DELETE 版本与评估行。
    candidateVersionsSig: tableSignature(seedDb, 'radar_candidate_versions'),
    ruleAssessmentsSig: tableSignature(seedDb, 'radar_rule_assessments'),
  };
  seedDb.close();

  // 2) 建独立 v7 库（用于 schema v7 时评审 API 为 404 的断言）。
  const seedV7 = openDb(dbV7Path);
  initSchema(seedV7, { targetVersion: 7 });
  seedV7.close();

  // 3) 后端：v8 评审（radar 开启，共用 deps）+ v7 采集桥（radar 开启）。
  // 注入 db 时 buildServer 不拥有连接（app.close 不关闭），故 harness 持有句柄在 teardown 显式关闭。
  const dbV8 = openDb(dbPath);
  const dbV7 = openDb(dbV7Path);
  const appV8 = buildServer({ db: dbV8, radar: { enabled: true, serviceDeps: deps } });
  const appV7 = buildServer({ db: dbV7, radar: { enabled: true } });
  const apiV8Port = await reservePort();
  const apiV7Port = await reservePort();
  const apiV8Url = await appV8.listen({ host: HOST, port: apiV8Port });
  const apiV7Url = await appV7.listen({ host: HOST, port: apiV7Port });

  // 4) 前端：flag 开启 + flag 关闭两套，均代理到 v8 后端。
  const webOnPort = await reservePort();
  const webOffPort = await reservePort();
  const viteOn = await createViteServer(viteConfig(webOnPort, apiV8Url, true));
  await viteOn.listen();
  const viteOff = await createViteServer(viteConfig(webOffPort, apiV8Url, false));
  await viteOff.listen();

  handles = { viteOn, viteOff, appV8, appV7, dbV8, dbV7, tempDir };

  const runtime: ReviewE2ERuntime = {
    webOnUrl: `http://${HOST}:${webOnPort}`,
    webOffUrl: `http://${HOST}:${webOffPort}`,
    apiV7Url,
    dbPath,
    fixture,
    baseline,
  };
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), 'utf8');

  return stopReviewE2E;
}

async function stopReviewE2E(): Promise<void> {
  if (handles === null) return;
  const { viteOn, viteOff, appV8, appV7, dbV8, dbV7, tempDir } = handles;
  handles = null;
  await viteOn.close().catch(() => {});
  await viteOff.close().catch(() => {});
  await appV8.close().catch(() => {});
  await appV7.close().catch(() => {});
  try { dbV8.close(); } catch { /* already closed */ }
  try { dbV7.close(); } catch { /* already closed */ }
  try { fs.rmSync(RUNTIME_FILE, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  // Windows 下 SQLite 文件句柄可能延迟释放：重试几轮后仍占用则留待系统临时目录清理。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); break; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

