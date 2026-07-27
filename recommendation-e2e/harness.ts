/**
 * V8-5 岗位建议批次「生成 / 展示 / 加载最新」正式 E2E harness（进程内，动态端口，自动清理）。
 *
 * 复用 analysis:review E2E 沙箱骨架：临时 v8 库 + 确定性 seed + 动态 loopback 端口 + 自动清理。
 * - 后端：analysisEnabled=true @ schema v8（推荐路由门禁），绝不连真实生产库；
 * - 前端 flag：radar + recommendations 开启，**analysis 关闭**（证明推荐面板独立于 V8-4 前端门禁）；
 * - seed：评审 fixture（含疑似/复核关系）+ 正式简历/画像；疑似关系两侧 seed current 分析（UI 生成 2 条）；
 *   另 seed 8 条可推荐 + 2 条硬约束命中候选（wide scope，供 API 直建后「加载最新」展示 1–8 + blocked）;
 * - 绝不写 Job/Application/FeedbackEvent（推荐服务只读），seed 完成即快照零污染基线。
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
import { RUNTIME_DIR, RUNTIME_FILE, tableSignature, type RecommendationE2ERuntime } from './runtime';
import {
  countRow, insertCurrentRecord, insertHardConstraintHit, relationScope, seedCandidate,
} from './seedHelpers';

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
      // radar + recommendations 开启；analysis **关闭**：推荐面板须独立于 V8-4 前端门禁渲染。
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

export async function startRecommendationE2E(): Promise<() => Promise<void>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-recommendation-e2e-'));
  const dbPath = path.join(tempDir, 'recommendation-v8.sqlite3');

  // 确定性依赖：seed 与断言共享，避免 ID 抖动。
  let clk = 5_000_000;
  let counter = 0;
  const deps = { now: () => (clk += 1000), createId: () => `rece2e-${(counter += 1)}` };

  // 1) seed：v8 评审 fixture（疑似/复核关系可经列表打开）+ 正式简历/画像（分析上下文对照面）。
  const seedDb = openDb(dbPath);
  initSchema(seedDb, { targetVersion: 8 });
  const fixture = seedReviewFixture(seedDb, deps);
  seedActiveResumeAndProfile(seedDb, deps.now());

  // 2) 疑似关系两侧 seed current 分析（apply_now / stretch）→ UI 生成展示 2 条、按优先级排序。
  const suspected = relationScope(seedDb, fixture.suspectedRelationId);
  insertCurrentRecord(seedDb, suspected.low, { recommendation: 'apply_now', confidence: 'high', tag: 'susp-low', createdAt: deps.now() });
  insertCurrentRecord(seedDb, suspected.high, { recommendation: 'stretch', confidence: 'medium', tag: 'susp-high', createdAt: deps.now() });

  // 3) wide scope：8 条可推荐（apply_now）+ 2 条硬约束命中（blocked）；供 API 直建批次后「加载最新」展示。
  const wideScope: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const c = seedCandidate(seedDb, `wide${i}`, deps);
    insertCurrentRecord(seedDb, c, { recommendation: 'apply_now', confidence: 'high', tag: `wide${i}`, createdAt: deps.now() });
    wideScope.push(c.versionId);
  }
  for (let i = 0; i < 2; i += 1) {
    const c = seedCandidate(seedDb, `hc${i}`, deps);
    insertCurrentRecord(seedDb, c, { recommendation: 'apply_now', confidence: 'high', ruleVersion: 'rules-v1', tag: `hc${i}`, createdAt: deps.now() });
    insertHardConstraintHit(seedDb, c, `hc${i}`, deps.now());
    wideScope.push(c.versionId);
  }

  // 零污染基线（seed 完成即快照：数量 + 关键表签名）。
  const baseline = {
    jobs: countRow(seedDb, 'jobs'),
    applications: countRow(seedDb, 'applications'),
    feedbackEvents: countRow(seedDb, 'feedback_events'),
    candidateVersionsSig: tableSignature(seedDb, 'radar_candidate_versions'),
    ruleAssessmentsSig: tableSignature(seedDb, 'radar_rule_assessments'),
    analysisRecordsSig: tableSignature(seedDb, 'job_match_analysis_records'),
  };
  seedDb.close();

  // 4) 后端：注入已 seed 的 v8 库 + 单调时钟/确定性批次 id（analysisEnabled 开启推荐门禁）。
  const db = openDb(dbPath);
  let batchSeq = 0;
  let batchClock = 6_000_000;
  const app = buildServer({
    db,
    radar: {
      enabled: true,
      analysisEnabled: true,
      recommendationDeps: { now: () => (batchClock += 1), createBatchId: () => `rece2e-batch-${(batchSeq += 1)}` },
    },
  });
  const apiPort = await reservePort();
  const apiUrl = await app.listen({ host: HOST, port: apiPort });

  // 5) 前端：radar + recommendations 开启、analysis 关闭，代理到 v8 后端。
  const webPort = await reservePort();
  const vite = await createViteServer(viteConfig(webPort, apiUrl));
  await vite.listen();

  handles = { vite, app, db, tempDir };

  const runtime: RecommendationE2ERuntime = {
    webUrl: `http://${HOST}:${webPort}`, apiUrl, dbPath,
    suspectedRelationId: fixture.suspectedRelationId,
    recheckRelationId: fixture.recheckRelationId,
    wideScope, baseline,
  };
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), 'utf8');
  return stopRecommendationE2E;
}

async function stopRecommendationE2E(): Promise<void> {
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
