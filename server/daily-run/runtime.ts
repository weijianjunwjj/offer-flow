import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db';
import { TavilySearchProvider } from '../search-provider/tavily/TavilySearchProvider';
import { SearchEvidenceIngestionService } from '../radar/searchEvidence/SearchEvidenceIngestionService';
import { ingestDiscoveryResults } from '../radar/searchEvidence/DiscoveryIngestionBridge';
import {
  createOpenWebContentFetcher,
  nodeTransportRequest,
} from '../content-acquisition/OpenWebContentFetcher';
import { createNodeDnsResolver } from '../content-acquisition/ssrfGuard';
import { EvidenceUpgradeService } from '../radar/evidenceUpgrade/EvidenceUpgradeService';
import { AnalysisService } from '../radar/analysis/analysisService';
import { RecommendationBatchService } from '../radar/recommendation/recommendationBatchService';
import { RadarCandidateRepository } from '../radar/candidateRepository';
import { EnvSecretStore } from '../secret/EnvSecretStore';
import { DailyPipeline } from '../pipeline/DailyPipeline';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import { SourceRunRepository } from '../source-run/sourceRunRepository';
import { DailyBriefRepository } from '../daily-brief/dailyBriefRepository';
import { DailyRunCoordinator } from './DailyRunCoordinator';
import { resolveDailyBudgetOverrides } from './budgetEnv';

/**
 * DailyRun runtime composition root（T028 闭环真实依赖组装）。
 *
 * 组装真实 TavilySearchProvider / DiscoveryIngestionBridge / OpenWebContentFetcher /
 * EvidenceUpgradeService / AnalysisService / RecommendationBatchService 为一个
 * DailyRunCoordinator。禁止 Scheduler constructor 自己 new 8 个 service。
 *
 * 外部网络/LLM 边界：apiKeyResolver 与真实 provider 在此注入，测试可整体替换 fake。
 */

export interface DailyRunRuntimeDeps {
  db: SqliteDatabase;
  createId?: () => string;
  now?: () => number;
  /** Tavily API key resolver；默认从 EnvSecretStore 读 env:TAVILY_API_KEY。 */
  apiKeyResolver?: () => string;
}

export function createDailyRunCoordinator(deps: DailyRunRuntimeDeps): DailyRunCoordinator {
  const db = deps.db;
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;
  const apiKeyResolver = deps.apiKeyResolver ?? (() => new EnvSecretStore().resolve('env:TAVILY_API_KEY'));

  const candidates = new RadarCandidateRepository(db);
  const analysisService = new AnalysisService({ db });
  const recommendationService = new RecommendationBatchService({ db });
  const evidenceUpgrade = new EvidenceUpgradeService(db, { now, createId });
  const ingestion = new SearchEvidenceIngestionService(db, { now, createId });
  const fetcher = createOpenWebContentFetcher({
    resolver: createNodeDnsResolver(),
    transport: nodeTransportRequest,
  });
  const tavily = new TavilySearchProvider({ apiKeyResolver });

  const pipeline = new DailyPipeline({
    search: (request) => tavily.search(request),
    ingestDiscovery: (result) => ingestDiscoveryResults(result, ingestion),
    fetch: (request) => fetcher.fetch(request),
    upgrade: (input) => evidenceUpgrade.upgrade(input),
    getVersion: (id) => candidates.getVersion(id),
    createTask: (id) => analysisService.createTask(id),
    runTask: (id) => analysisService.runTask(id),
    createBatch: (scope) => recommendationService.createBatch(scope),
  });

  return new DailyRunCoordinator({
    planRepo: new SearchPlanRepository(db),
    sourceRunRepo: new SourceRunRepository(db),
    briefRepo: new DailyBriefRepository(db),
    pipeline,
    providerKey: tavily.providerKey,
    providerVersion: tavily.providerVersion,
    createEmptyBatch: () => recommendationService.createEmptyBatch().batch.id,
    getBatch: (id) => recommendationService.getBatch(id),
    createId,
    now,
    ...resolveDailyBudgetOverrides(process.env),
  });
}
