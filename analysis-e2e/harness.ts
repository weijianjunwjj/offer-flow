/**
 * V8-4 单岗位分析「正常流程 + 刷新恢复」正式 E2E harness（进程内，动态端口，自动清理）。
 *
 * 镜像 review:e2e：临时 v8 库 + 确定性 seed；Radar 开启 + analysisEnabled；注入闸门式延迟成功
 * Provider（绝不读真实 key / 不访问外网）；前端 flag 全开（radar + analysis）。
 * 绝不连接真实生产库（data/offerflow.sqlite3）：仅在系统临时目录建独立库。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../server/db';
import { buildServer } from '../server/index';
import { initSchema } from '../server/schema';
import { seedReviewFixture } from '../server/radar/reviewFixture';
import { RadarCandidateRepository } from '../server/radar/candidateRepository';
import { seedActiveResumeAndProfile } from '../server/radar/analysis/analysisInputFixture';
import { createGatedSuccessProvider } from './gatedProvider';
import { RUNTIME_DIR, RUNTIME_FILE, tableSignature, type AnalysisE2ERuntime } from './runtime';

const HOST = '127.0.0.1';

interface Handles {
  vite: ViteDevServer;
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
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

function viteConfig(webPort: number, apiTarget: string): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      // radar 与 analysis 是相互独立的门禁：两者都必须显式开启面板才会渲染。
      'import.meta.env.VITE_OFFERFLOW_RADAR': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_RADAR_ANALYSIS': JSON.stringify('true'),
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

export async function startAnalysisE2E(): Promise<() => Promise<void>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-analysis-e2e-'));
  const dbPath = path.join(tempDir, 'analysis-v8.sqlite3');

  // 确定性依赖：seed 与后续断言共享，避免 ID 抖动。
  let now = 5_000_000;
  let counter = 0;
  const deps = { now: () => (now += 1000), createId: () => `ae2e-${(counter += 1)}` };

  // 1) seed：v8 评审 fixture（含 material_change 可经 feed 打开）+ 正式简历/画像（分析前置）。
  const seedDb = openDb(dbPath);
  initSchema(seedDb, { targetVersion: 8 });
  const fixture = seedReviewFixture(seedDb, deps);
  seedActiveResumeAndProfile(seedDb, deps.now());
  const materialCandidateVersionId =
    new RadarCandidateRepository(seedDb).getCandidate(fixture.materialCandidateId)!.activeVersionId!;
  // 零污染基线（seed 完成即快照）。
  const baseline = {
    jobs: countRow(seedDb, 'jobs'),
    applications: countRow(seedDb, 'applications'),
    feedbackEvents: countRow(seedDb, 'feedback_events'),
    candidateVersionsSig: tableSignature(seedDb, 'radar_candidate_versions'),
    ruleAssessmentsSig: tableSignature(seedDb, 'radar_rule_assessments'),
  };
  seedDb.close();

  // 2) 后端：注入已 seed 的 v8 库（版本匹配，不自动迁移）+ 闸门式延迟成功 Provider。
  //    注入 db 时 buildServer 不拥有连接（app.close 不关闭），harness 持句柄在 teardown 显式关闭。
  const db = openDb(dbPath);
  const gated = createGatedSuccessProvider();
  let recSeq = 0;
  let analysisClock = 6_000_000;
  const app = buildServer({
    db,
    radar: {
      enabled: true,
      analysisEnabled: true,
      analysisDeps: {
        provider: gated.provider,
        now: () => (analysisClock += 1),
        createRecordId: () => `ae2e-rec-${(recSeq += 1)}`,
      },
    },
  });

  // E2E 控制端点：释放当前分析闸门（让 running 的 generate 立即完成）。
  // 独立于 /radar 命名空间，不过安全网关；仅本进程内测试可达，绝不出现在真实入口。
  app.post('/e2e/release-analysis', async () => {
    gated.release();
    return { released: true };
  });

  const apiPort = await reservePort();
  const apiUrl = await app.listen({ host: HOST, port: apiPort });

  // 3) 前端：flag 全开，代理到 v8 后端。
  const webPort = await reservePort();
  const vite = await createViteServer(viteConfig(webPort, apiUrl));
  await vite.listen();

  handles = { vite, app, db, tempDir };

  const runtime: AnalysisE2ERuntime = {
    webUrl: `http://${HOST}:${webPort}`,
    apiUrl,
    dbPath,
    fixture,
    materialCandidateVersionId,
    baseline,
  };
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), 'utf8');

  return stopAnalysisE2E;
}

async function stopAnalysisE2E(): Promise<void> {
  if (handles === null) return;
  const { vite, app, db, tempDir } = handles;
  handles = null;
  await vite.close().catch(() => {});
  await app.close().catch(() => {});
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(RUNTIME_FILE, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  // Windows 下 SQLite 文件句柄可能延迟释放：重试几轮后仍占用则留待系统临时目录清理。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); break; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
