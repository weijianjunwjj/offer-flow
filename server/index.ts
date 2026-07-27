import { loadProjectEnv } from './config/loadEnv';
loadProjectEnv();

import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { getDbPath, openDb, type SqliteDatabase } from './db';
import type { JobMemoryServiceDeps } from './job-memory/jobMemoryService';
import type { JobMatchProfileServiceDeps } from './job-match-profile/service';
import type { CapabilityBaselineServiceDeps } from './capability-baseline/service';
import type { HistoryImportServiceDeps } from './history-import/service';
import type { MarketPositionServiceDeps } from './market-position/service';
import type { StrategyServiceDeps } from './strategy-window/service';
import { registerJobMatchProfileRoutes } from './job-match-profile/routes';
import { registerCapabilityBaselineRoutes } from './capability-baseline/routes';
import { registerHistoryImportRoutes } from './history-import/routes';
import { registerFunnelRoutes } from './funnel/routes';
import { registerMarketPositionRoutes } from './market-position/routes';
import { registerStrategyWindowRoutes } from './strategy-window/routes';
import { registerJobMemoryRoutes } from './job-memory/routes';
import {
  CAPABILITY_BASELINE_SCHEMA_VERSION,
  getDatabaseSchemaVersion,
  HISTORY_IMPORT_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
  MARKET_POSITION_SCHEMA_VERSION,
  PRODUCTION_SCHEMA_VERSION,
  RADAR_DOMAIN_SCHEMA_VERSION,
  STRATEGY_WINDOW_SCHEMA_VERSION,
} from './migrations';
import { registerRadarCaptureRoutes, type RadarCaptureServiceDeps } from './radar/routes';
import type { AnalysisRouteDeps as RadarAnalysisRouteDeps } from './radar/analysis/analysisRoutes';
import type { RecommendationRouteDeps as RadarRecommendationRouteDeps } from './radar/recommendation/recommendationRoutes';
import type { PromotionRouteDeps as RadarPromotionRouteDeps } from './radar/promotion/promotionRoutes';
import { planSchemaStartup, schemaRefusalMessage } from './schemaStartup';
import { initSchema } from './schema';
import { registerProfileRoutes } from './routes/profile';
import { registerJobRoutes } from './routes/jobs';
import { registerImportRoutes } from './routes/import';
import { registerSyncRoutes } from './routes/sync';
import { registerLlmRoutes } from './routes/llm';
import { createShutdownSnapshotExporter, runStartupSync } from './sync/bootstrap';

declare module 'fastify' {
  interface FastifyInstance {
    db: SqliteDatabase;
  }
}

export interface JobMemoryV2Capability {
  enabled: boolean;
  serviceDeps?: JobMemoryServiceDeps;
}

export interface CapabilityBaselineCapability {
  enabled?: boolean;
  serviceDeps?: CapabilityBaselineServiceDeps;
}

export interface HistoryImportCapability {
  enabled?: boolean;
  serviceDeps?: HistoryImportServiceDeps;
}

export interface FunnelCapability {
  enabled?: boolean;
}

export interface MarketPositionCapability {
  enabled?: boolean;
  serviceDeps?: MarketPositionServiceDeps;
}

export interface StrategyWindowCapability {
  enabled?: boolean;
  serviceDeps?: StrategyServiceDeps;
}

export interface RadarCapability {
  enabled?: boolean;
  serviceDeps?: RadarCaptureServiceDeps;
  /** V8-4 单岗位分析 API 门禁：默认关闭，仅显式开启时才注册分析路由（需 radar 已启用 + schema ≥ v7）。 */
  analysisEnabled?: boolean;
  analysisDeps?: RadarAnalysisRouteDeps;
  /** V8-5 推荐批次 API 注入依赖（随 analysisEnabled 同门禁开启）。 */
  recommendationDeps?: RadarRecommendationRouteDeps;
  /** V8-6 正式晋升 API 注入依赖（门禁为 schema ≥ v8，与 analysisEnabled 无关）。 */
  promotionDeps?: RadarPromotionRouteDeps;
}

export interface BuildServerOptions {
  dbPath?: string;
  db?: SqliteDatabase;
  jobMemoryV2?: JobMemoryV2Capability;
  jobMatchProfile?: JobMatchProfileServiceDeps;
  capabilityBaseline?: CapabilityBaselineCapability;
  historyImport?: HistoryImportCapability;
  funnel?: FunnelCapability;
  marketPosition?: MarketPositionCapability;
  strategyWindow?: StrategyWindowCapability;
  radar?: RadarCapability;
}

function normalizeBuildOptions(input: string | BuildServerOptions): BuildServerOptions {
  return typeof input === 'string' ? { dbPath: input } : input;
}

export function buildServer(
  input: string | BuildServerOptions = {},
): ReturnType<typeof Fastify> {
  const options = normalizeBuildOptions(input);
  const dbPath = options.dbPath ?? (options.db === undefined ? getDbPath() : ':injected:');
  const jobMemoryV2 = options.jobMemoryV2 ?? { enabled: true };
  // 能力基线（G2）默认关闭：可信求职记忆生产/恢复/快照底座固定在 schema v2；
  // 仅在真实服务入口与能力基线自身测试中显式开启，届时才把库升级到 v3。
  const capabilityBaselineEnabled = options.capabilityBaseline?.enabled ?? false;
  // 历史补录（G3 第二层，详细事件补录写入）默认关闭：需要 schema v4 的补录会话/草稿表，
  // 仅显式开启时才把库升级到 v4（v4 是纯新增表，向下兼容 v3）。
  const historyImportEnabled = options.historyImport?.enabled ?? false;
  // 基础漏斗默认开启：只读聚合正式 applications / feedback_events（schema v2 起已存在），
  // 不需要任何额外迁移，因此可以安全在真实入口默认开启。
  const funnelEnabled = options.funnel?.enabled ?? true;
  // 市场位置画像（G4）默认关闭：需要 schema v5 的沙箱专用表，且真实生产入口
  // 明确不启用 G4，仅在沙箱脚本与自身测试中显式开启，届时才把库升级到 v5。
  const marketPositionEnabled = options.marketPosition?.enabled ?? false;
  // 求职策略窗口（G5）默认关闭：需要 schema v6 的沙箱专用表，且真实生产入口
  // 明确不启用 G5，仅在沙箱脚本与自身测试中显式开启，届时才把库升级到 v6。
  // G5 依赖 G4 的 active 市场位置版本，因此开启 G5 时必然一并开启 G4。
  const strategyWindowEnabled = options.strategyWindow?.enabled ?? false;
  // 岗位雷达（V8-2 当前页采集桥）默认关闭：需要 schema v7 的雷达领域表，且真实生产入口
  // 明确不启用（前后端 flag 默认 false），仅在显式注入 v7 库的开发/测试场景中开启，
  // 届时才把库升级到 v7；真实库升级与真实入口启用均需用户另行明确授权。
  const radarEnabled = options.radar?.enabled ?? false;
  const shouldRunLifecycleSync = options.db === undefined && dbPath === getDbPath();
  if (shouldRunLifecycleSync) {
    const bootstrap = runStartupSync(dbPath);
    if (bootstrap.warnings.length > 0) {
      console.warn('[sync] startup warnings:', bootstrap.warnings.join('; '));
    }
  }

  const app = Fastify({ logger: false });
  const db = options.db ?? openDb(dbPath);
  const ownsDb = options.db === undefined;
  if (jobMemoryV2.enabled) {
    // 每个能力只升级到自己需要的最低 schema 版本，不因为 v4 存在就顺带把只开了
    // 能力基线（G2）的场景也拉到 v4——两者的 requiredVersion 相互独立。
    const requiredVersion = radarEnabled
      ? RADAR_DOMAIN_SCHEMA_VERSION
      : strategyWindowEnabled
        ? STRATEGY_WINDOW_SCHEMA_VERSION
        : marketPositionEnabled
          ? MARKET_POSITION_SCHEMA_VERSION
          : historyImportEnabled
            ? HISTORY_IMPORT_SCHEMA_VERSION
            : capabilityBaselineEnabled
              ? CAPABILITY_BASELINE_SCHEMA_VERSION
              : PRODUCTION_SCHEMA_VERSION;
    // 真实生产库（data/offerflow.sqlite3）禁止在服务启动时自动迁移；
    // 仅临时文件库 / 注入的测试库 / 内存库允许自动初始化到所需 schema。
    const isRealProductionDb = ownsDb && dbPath === getDbPath();
    const allowAutoMigrate = !isRealProductionDb;
    let schemaVersion = getDatabaseSchemaVersion(db);
    const plan = planSchemaStartup({
      currentVersion: schemaVersion,
      requiredVersion,
      latestVersion: LATEST_SCHEMA_VERSION,
      productionVersion: PRODUCTION_SCHEMA_VERSION,
      allowAutoMigrate,
    });
    if (plan.kind === 'migrate') {
      initSchema(db, { targetVersion: plan.targetVersion });
      schemaVersion = getDatabaseSchemaVersion(db);
    } else if (plan.kind === 'refuse') {
      if (ownsDb) db.close();
      throw new Error(schemaRefusalMessage(plan.reason, schemaVersion, requiredVersion, LATEST_SCHEMA_VERSION));
    }
  } else {
    const schemaVersion = getDatabaseSchemaVersion(db);
    if (schemaVersion === 0) initSchema(db, { targetVersion: 1 });
  }
  app.decorate('db', db);
  const exportOnClose = createShutdownSnapshotExporter(dbPath);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type,x-offerflow-capture-client');
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
    return undefined;
  });

  app.addHook('onClose', async () => {
    if (shouldRunLifecycleSync) {
      exportOnClose();
    }
  });

  app.addHook('onClose', async () => {
    if (ownsDb) db.close();
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/meta/db-path', async () => ({ path: dbPath }));
  registerProfileRoutes(app);
  const legacyCommunicationWriteDisabled = jobMemoryV2.enabled;
  registerJobRoutes(app, { legacyCommunicationWriteDisabled });
  registerImportRoutes(app, { legacyCommunicationWriteDisabled });
  registerSyncRoutes(app, dbPath);
  registerLlmRoutes(app);
  if (jobMemoryV2.enabled) {
    registerJobMemoryRoutes(app, { serviceDeps: jobMemoryV2.serviceDeps });
    registerJobMatchProfileRoutes(app, options.jobMatchProfile);
    if (capabilityBaselineEnabled) {
      registerCapabilityBaselineRoutes(app, options.capabilityBaseline?.serviceDeps);
    }
    if (historyImportEnabled) {
      registerHistoryImportRoutes(app, { serviceDeps: options.historyImport?.serviceDeps });
    }
    if (funnelEnabled) {
      registerFunnelRoutes(app);
    }
    if (marketPositionEnabled) {
      registerMarketPositionRoutes(app, options.marketPosition?.serviceDeps);
    }
    if (strategyWindowEnabled) {
      registerStrategyWindowRoutes(app, options.strategyWindow?.serviceDeps);
    }
    if (radarEnabled) {
      registerRadarCaptureRoutes(app, {
        serviceDeps: options.radar?.serviceDeps,
        analysisEnabled: options.radar?.analysisEnabled ?? false,
        analysisDeps: options.radar?.analysisDeps,
        recommendationDeps: options.radar?.recommendationDeps,
        promotionDeps: options.radar?.promotionDeps,
      });
    }
  }
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 真实服务入口显式开启 G2 能力基线（schema v3）、基础漏斗（无需迁移）、G3 历史补录（schema v4）。
  // G6-B 生产切换：真实生产库已通过显式授权命令（db:upgrade-real --confirm）升级到 schema v6
  // 并导入 G4/G5 正式版本晋升包，现正式在真实入口开启 G4 市场位置画像（需 schema v5）与
  // G5 求职策略（需 schema v6）；服务启动仍不会自动迁移真实库，schema 低于所需版本或高于本代码
  // 支持版本时均会按 schemaStartup 的拒绝逻辑直接报错退出（启动门禁为固定能力版本，不依赖浮动 LATEST）。
  const app = buildServer({
    capabilityBaseline: { enabled: true },
    historyImport: { enabled: true },
    marketPosition: { enabled: true },
    strategyWindow: { enabled: true },
  });
  let isClosing = false;
  const closeAndExit = (signal: NodeJS.Signals): void => {
    if (isClosing) {
      return;
    }
    isClosing = true;
    app
      .close()
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
  app.listen({ host: '127.0.0.1', port: 17365 }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
