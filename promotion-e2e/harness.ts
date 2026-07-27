/**
 * V8-6 正式晋升 E2E harness（进程内，动态端口，自动清理）。
 *
 * 复用 recommendation-e2e/seedHelpers 的 seed 构造（不复制第二份），仅按晋升需要调整门禁与服务：
 * - 后端：radar + analysisEnabled + schema v8（建议面板与晋升路由同时可用），绝不连真实生产库；
 * - 前端：radar + recommendations 开启（晋升 UI 随建议门禁，见第三波裁决：不新增生产开关）；
 * - seed：评审 fixture（疑似关系两侧 seed current 分析 → UI 出 2 条建议、可点晋升）
 *   + 正式简历/画像 + 5 个独立候选供 API 用例（link / 钳制 / no_response / 幂等 / 原子性）；
 * - **第二个后端（atomicApiUrl）**：与主后端共库，但注入每第 4 次调用返回固定值的 createId。
 *   feedback 深度晋升恰好消耗 4 次 createId（Job/Application/Event/Promotion），故第 4 次即
 *   Promotion 主键——第二次晋升必撞主键失败，用于验证已写对象整体回滚。
 *
 * seed 阶段绝不写 jobs/applications/feedback_events/radar_promotions：基线为 0，
 * 之后任何非零都只能由晋升产生，便于归因。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import type { FastifyInstance } from 'fastify';
import { openDb, type SqliteDatabase } from '../server/db';
import { buildServer } from '../server/index';
import { initSchema } from '../server/schema';
import { seedReviewFixture } from '../server/radar/reviewFixture';
import { seedActiveResumeAndProfile } from '../server/radar/analysis/analysisInputFixture';
import {
  countRow, insertCurrentRecord, relationScope, seedCandidate,
} from '../recommendation-e2e/seedHelpers';
import { RUNTIME_DIR, RUNTIME_FILE, type PromotionE2ERuntime } from './runtime';

const HOST = '127.0.0.1';

/** 原子性后端固定返回的 Promotion 主键：第二次晋升撞它必失败。 */
const COLLIDING_ID = 'promo-e2e-collide';

interface Handles {
  vite: ViteDevServer;
  app: FastifyInstance;
  atomicApp: FastifyInstance;
  db: SqliteDatabase;
  atomicDb: SqliteDatabase;
  tempDir: string;
}
let handles: Handles | null = null;

async function reservePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(0, HOST, () => resolve()); });
  const address = srv.address();
  if (address === null || typeof address === 'string') { srv.close(); throw new Error('无法预留 loopback 端口'); }
  const { port } = address;
  await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  return port;
}

function viteConfig(webPort: number, apiTarget: string): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      // 晋升 UI 随 recommendations 门禁（第三波裁决：不新增生产开关）。
      'import.meta.env.VITE_OFFERFLOW_RADAR': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_RADAR_ANALYSIS': JSON.stringify('false'),
      'import.meta.env.VITE_OFFERFLOW_RADAR_RECOMMENDATIONS': JSON.stringify('true'),
      'import.meta.env.VITE_OFFERFLOW_API_BASE': JSON.stringify(`http://${HOST}:${webPort}`),
    },
    server: {
      host: HOST, port: webPort, strictPort: true,
      proxy: {
        '/radar': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
        '/meta': { target: apiTarget, changeOrigin: true },
      },
    },
  };
}

export async function startPromotionE2E(): Promise<() => Promise<void>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-promotion-e2e-'));
  const dbPath = path.join(tempDir, 'promotion-v8.sqlite3');

  // 确定性依赖：seed 与断言共享，避免 ID 抖动。
  let clk = 5_000_000;
  let counter = 0;
  const deps = { now: () => (clk += 1000), createId: () => `promoe2e-${(counter += 1)}` };

  // 1) seed：v8 评审 fixture + 正式简历/画像（分析上下文对照面）。
  const seedDb = openDb(dbPath);
  initSchema(seedDb, { targetVersion: 8 });
  const fixture = seedReviewFixture(seedDb, deps);
  seedActiveResumeAndProfile(seedDb, deps.now());

  // 2) 疑似关系两侧 seed current 分析 → review 页可生成 2 条建议，每条都能点「晋升」。
  const suspected = relationScope(seedDb, fixture.suspectedRelationId);
  insertCurrentRecord(seedDb, suspected.low, {
    recommendation: 'apply_now', confidence: 'high', tag: 'susp-low',
    createdAt: deps.now(), idPrefix: 'promoe2e',
  });
  insertCurrentRecord(seedDb, suspected.high, {
    recommendation: 'stretch', confidence: 'medium', tag: 'susp-high',
    createdAt: deps.now(), idPrefix: 'promoe2e',
  });

  // 3) 5 个独立候选供 API 用例：link / 钳制 / no_response / 幂等 / 原子性各一个。
  const apiCandidateVersionIds: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const c = seedCandidate(seedDb, `api${i}`, deps);
    insertCurrentRecord(seedDb, c, {
      recommendation: 'apply_now', confidence: 'high', tag: `api${i}`,
      createdAt: deps.now(), idPrefix: 'promoe2e',
    });
    apiCandidateVersionIds.push(c.versionId);
  }

  // 零污染基线：seed 阶段绝不写正式对象，四表应全为 0。
  const baseline = {
    jobs: countRow(seedDb, 'jobs'),
    applications: countRow(seedDb, 'applications'),
    feedbackEvents: countRow(seedDb, 'feedback_events'),
    promotions: countRow(seedDb, 'radar_promotions'),
  };
  seedDb.close();

  // 4) 主后端：注入单调时钟 + 确定性 id（analysisEnabled 开启建议门禁；晋升门禁只看 schema v8）。
  const db = openDb(dbPath);
  let promoSeq = 0;
  let promoClock = 6_000_000;
  const app = buildServer({
    db,
    radar: {
      enabled: true,
      analysisEnabled: true,
      recommendationDeps: { now: () => (promoClock += 1), createBatchId: () => `promoe2e-batch-${(promoSeq += 1)}` },
      promotionDeps: { now: () => (promoClock += 1), createId: () => `promoe2e-obj-${(promoSeq += 1)}` },
    },
  });
  const apiPort = await reservePort();
  const apiUrl = await app.listen({ host: HOST, port: apiPort });

  // 5) 原子性专用后端：共库，但每第 4 次 createId 返回同一固定值。
  //    feedback 深度晋升按序消耗 Job/Application/Event/Promotion 四个 id，
  //    故第 4 次即 Promotion 主键 → 第二次晋升必撞主键，用于断言整体回滚。
  const atomicDb = openDb(dbPath);
  let atomicSeq = 0;
  let atomicClock = 7_000_000;
  const atomicApp = buildServer({
    db: atomicDb,
    radar: {
      enabled: true,
      analysisEnabled: true,
      promotionDeps: {
        now: () => (atomicClock += 1),
        createId: () => {
          atomicSeq += 1;
          return atomicSeq % 4 === 0 ? COLLIDING_ID : `promoe2e-atomic-${atomicSeq}`;
        },
      },
    },
  });
  const atomicPort = await reservePort();
  const atomicApiUrl = await atomicApp.listen({ host: HOST, port: atomicPort });

  // 6) 前端：radar + recommendations 开启，代理到主后端。
  const webPort = await reservePort();
  const vite = await createViteServer(viteConfig(webPort, apiUrl));
  await vite.listen();

  handles = { vite, app, atomicApp, db, atomicDb, tempDir };

  const runtime: PromotionE2ERuntime = {
    webUrl: `http://${HOST}:${webPort}`, apiUrl, atomicApiUrl, dbPath,
    suspectedRelationId: fixture.suspectedRelationId,
    apiCandidateVersionIds, baseline,
  };
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), 'utf8');
  return stopPromotionE2E;
}

async function stopPromotionE2E(): Promise<void> {
  if (handles === null) return;
  const { vite, app, atomicApp, db, atomicDb, tempDir } = handles;
  handles = null;
  await vite.close().catch(() => {});
  await app.close().catch(() => {});
  await atomicApp.close().catch(() => {});
  try { db.close(); } catch { /* already closed */ }
  try { atomicDb.close(); } catch { /* already closed */ }
  try { fs.rmSync(RUNTIME_FILE, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  // Windows 下 SQLite 句柄可能延迟释放：重试几轮后仍占用则留待系统临时目录清理。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); break; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
