/**
 * RC-10 雷达动作 E2E harness（进程内，动态端口，自动清理）。
 *
 * 复用 recommendation-e2e/seedHelpers 的 seed 构造（不复制第二份），按动作验收需要组织门禁与 seed：
 * - 后端：radar + analysisEnabled + schema v8（动作路由随 v8 门禁、建议路由随 analysisEnabled）；绝不连真实生产库；
 * - 前端：radar + recommendations 开启（动作栏随评审工作台渲染；用于验证动作变化让旧推荐失效）；
 * - seed：评审 fixture（疑似关系两侧 seed current 分析 → UI 每侧一个动作栏、可生成 2 条建议）
 *   + 正式简历/画像 + **1 个已晋升候选**（seed 阶段用 PromotionService 写入正式对象）
 *   + 3 个独立候选供 API 用例（历史 append-only / 幂等 / no_response）。
 *
 * 基线在晋升**之后**拍摄：此后任何动作与撤销都不得改动 jobs/applications/feedback_events/
 * radar_promotions（formalSig 逐字节比对）。
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
import { PromotionService } from '../server/radar/promotion/promotionService';
import {
  countRow, insertCurrentRecord, relationScope, seedCandidate,
} from '../recommendation-e2e/seedHelpers';
import { RUNTIME_DIR, RUNTIME_FILE, formalSignature, type ActionE2ERuntime } from './runtime';

const HOST = '127.0.0.1';

interface Handles { vite: ViteDevServer; app: FastifyInstance; db: SqliteDatabase; tempDir: string; }
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
      // 动作栏随评审工作台渲染；recommendations 开启用于验证动作变化让旧推荐失效。
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

export async function startActionE2E(): Promise<() => Promise<void>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-action-e2e-'));
  const dbPath = path.join(tempDir, 'action-v8.sqlite3');

  // 确定性依赖：seed 与断言共享，避免 ID 抖动。
  let clk = 5_000_000;
  let counter = 0;
  const deps = { now: () => (clk += 1000), createId: () => `acte2e-${(counter += 1)}` };

  // 1) seed：v8 评审 fixture（疑似关系可经列表打开）+ 正式简历/画像（分析上下文对照面）。
  const seedDb = openDb(dbPath);
  initSchema(seedDb, { targetVersion: 8 });
  const fixture = seedReviewFixture(seedDb, deps);
  seedActiveResumeAndProfile(seedDb, deps.now());

  // 2) 疑似关系两侧 seed current 分析（apply_now / stretch）→ UI 每侧一个动作栏、可生成 2 条建议。
  const suspected = relationScope(seedDb, fixture.suspectedRelationId);
  insertCurrentRecord(seedDb, suspected.low, { recommendation: 'apply_now', confidence: 'high', tag: 'susp-low', createdAt: deps.now(), idPrefix: 'acte2e' });
  insertCurrentRecord(seedDb, suspected.high, { recommendation: 'stretch', confidence: 'medium', tag: 'susp-high', createdAt: deps.now(), idPrefix: 'acte2e' });

  // 3) 已晋升候选：seed 阶段用 PromotionService 写入 1 份 Job/Application/FeedbackEvent/Promotion。
  //    之后对它执行/撤销动作，正式对象必须逐字节不变。
  const promoted = seedCandidate(seedDb, 'promoted', deps);
  insertCurrentRecord(seedDb, promoted, { recommendation: 'apply_now', confidence: 'high', tag: 'promoted', createdAt: deps.now(), idPrefix: 'acte2e' });
  const promotionService = new PromotionService({ db: seedDb, now: deps.now, createId: deps.createId });
  promotionService.promote(promoted.versionId, { trigger: 'hr_replied', requestedDepth: 'feedback' });

  // 4) 3 个独立候选供 API 用例：历史 append-only / 幂等 / no_response(applied_pending) 各一个。
  const apiCandidateIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const c = seedCandidate(seedDb, `api${i}`, deps);
    insertCurrentRecord(seedDb, c, { recommendation: 'apply_now', confidence: 'high', tag: `api${i}`, createdAt: deps.now(), idPrefix: 'acte2e' });
    apiCandidateIds.push(c.candidateId);
  }

  // 基线在晋升之后拍摄：已含 1 份正式对象；此后动作与撤销必须保持 formalSig 不变。
  const baseline = {
    jobs: countRow(seedDb, 'jobs'),
    applications: countRow(seedDb, 'applications'),
    feedbackEvents: countRow(seedDb, 'feedback_events'),
    promotions: countRow(seedDb, 'radar_promotions'),
    formalSig: formalSignature(seedDb as unknown as import('./runtime').SqlLike),
  };
  seedDb.close();

  // 5) 后端：注入已 seed 的 v8 库 + 单调时钟/确定性 id（analysisEnabled 开启建议门禁；动作门禁只看 schema v8）。
  const db = openDb(dbPath);
  let apiSeq = 0;
  let apiClock = 6_000_000;
  const app = buildServer({
    db,
    radar: {
      enabled: true,
      analysisEnabled: true,
      serviceDeps: { now: () => (apiClock += 1), createId: () => `acte2e-act-${(apiSeq += 1)}` },
      recommendationDeps: { now: () => (apiClock += 1), createBatchId: () => `acte2e-batch-${(apiSeq += 1)}` },
    },
  });
  const apiPort = await reservePort();
  const apiUrl = await app.listen({ host: HOST, port: apiPort });

  // 6) 前端：radar + recommendations 开启，代理到 v8 后端。
  const webPort = await reservePort();
  const vite = await createViteServer(viteConfig(webPort, apiUrl));
  await vite.listen();

  handles = { vite, app, db, tempDir };

  const runtime: ActionE2ERuntime = {
    webUrl: `http://${HOST}:${webPort}`, apiUrl, dbPath,
    suspectedRelationId: fixture.suspectedRelationId,
    suspectedLowCandidateId: suspected.low.candidateId,
    suspectedHighCandidateId: suspected.high.candidateId,
    suspectedScope: [suspected.low.versionId, suspected.high.versionId],
    promotedCandidateId: promoted.candidateId,
    apiCandidateIds, baseline,
  };
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), 'utf8');
  return stopActionE2E;
}

async function stopActionE2E(): Promise<void> {
  if (handles === null) return;
  const { vite, app, db, tempDir } = handles;
  handles = null;
  await vite.close().catch(() => {});
  await app.close().catch(() => {});
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(RUNTIME_FILE, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  // Windows 下 SQLite 句柄可能延迟释放：重试几轮后仍占用则留待系统临时目录清理。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); break; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
