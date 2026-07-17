import { aggregateFunnel, type FunnelOverview, type FunnelSourceApplication } from '../../src/domain/funnel';
import { projectApplication } from '../../src/domain/job-memory';
import type { EvidenceRawCounts, MarketPositionCityCode } from '../../src/domain/market-position';
import { MARKET_POSITION_CITY_CODES } from '../../src/domain/market-position';
import type { SqliteDatabase } from '../db';
import { ApplicationRepository } from '../job-memory/applicationRepository';
import { FeedbackEventRepository } from '../job-memory/feedbackEventRepository';
import { sha256RequestHash } from '../job-memory/requestHash';
import { normalizeJobMatchCity } from '../job-match-profile/inputSnapshot';
import { JobRepository } from '../repositories/jobRepository';

export interface MarketPositionInputSnapshotOptions {
  now?: () => number;
}

export interface MarketPositionInputSnapshotResult {
  jobMatchProfileVersionId: string | null;
  capabilityBaselineVersionId: string | null;
  acceptedEvidenceIds: string[];
  funnelCutoffAt: number;
  countsByScope: {
    global: EvidenceRawCounts;
    cities: Record<MarketPositionCityCode, EvidenceRawCounts>;
  };
  funnelQueryFingerprint: string;
  inputHash: string;
  capturedAt: number;
}

/**
 * 只依据"曾达到面试安排及以上阶段"作为面试信号计数，与漏斗阶段定义保持一致，
 * 不重新发明第二套面试判定口径。
 */
function isEffectiveSource(source: FunnelSourceApplication): boolean {
  if (source.application.voidedAt !== null) return false;
  const projection = projectApplication(source.application, source.events);
  return !projection.isVoided && projection.projectionStatus !== 'invalid';
}

function companyKeyOf(source: FunnelSourceApplication): string | null {
  const employerKey = source.application.recruitingEntity.employerGroupKey?.trim().toLowerCase();
  if (employerKey !== undefined && employerKey !== '') return employerKey;
  const company = source.job?.company.trim().toLowerCase();
  return company !== undefined && company !== '' ? company : null;
}

function countsFromSources(sources: readonly FunnelSourceApplication[]): EvidenceRawCounts {
  const effective = sources.filter(isEffectiveSource);
  const overview: FunnelOverview = aggregateFunnel(sources).overview;

  const stageCount = (stage: string): number => (
    overview.stages.find((entry) => entry.stage === stage)?.count ?? 0
  );

  const companySet = new Set<string>();
  for (const source of effective) {
    const key = companyKeyOf(source);
    if (key !== null) companySet.add(key);
  }

  const createdTimes = effective.map((source) => source.application.createdAt);
  const firstObservedAt = createdTimes.length === 0 ? null : Math.min(...createdTimes);
  const lastObservedAt = createdTimes.length === 0 ? null : Math.max(...createdTimes);

  return {
    applicationCount: effective.length,
    companyCount: companySet.size,
    validReplyCount: stageCount('valid_reply'),
    interviewCount: stageCount('interview_scheduled'),
    terminalOutcomeCount: (
      overview.statusCounts.rejected_by_recruiter
      + overview.statusCounts.user_withdrew
      + overview.statusCounts.position_closed
      + overview.statusCounts.offer_accepted
    ),
    exactCount: overview.confidence.counts.exact,
    dateLevelCount: overview.confidence.counts.date_level,
    approximateCount: overview.confidence.counts.approximate,
    recalledCount: overview.confidence.counts.recalled,
    inferredCount: overview.confidence.counts.inferred,
    firstObservedAt,
    lastObservedAt,
  };
}

/**
 * 构建 G4 输入快照：只读取 G1 正式活跃版本 id、G2 正式活跃基线版本 id + 已接受证据 id、
 * G3 漏斗聚合结果（复用 aggregateFunnel，不重新实现），从不读取外部网站、Boss 自动化、
 * 临时聊天草稿或 G5 结果。城市范围严格按 G1 的四城市口径隔离，不借用其它城市的样本。
 */
export function buildMarketPositionInputSnapshot(
  db: SqliteDatabase,
  input: {
    jobMatchProfileVersionId: string | null;
    capabilityBaselineVersionId: string | null;
    acceptedEvidenceIds: string[];
  },
  options: MarketPositionInputSnapshotOptions = {},
): MarketPositionInputSnapshotResult {
  const jobs = new JobRepository(db).list();
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const applicationRepo = new ApplicationRepository(db);
  const eventRepo = new FeedbackEventRepository(db);

  const sources: FunnelSourceApplication[] = applicationRepo.listApplications().map((application) => ({
    application,
    job: jobsById.get(application.jobId) ?? null,
    events: eventRepo.listEventsByApplication(application.id),
  }));

  const globalCounts = countsFromSources(sources);
  const cities = Object.fromEntries(MARKET_POSITION_CITY_CODES.map((city) => {
    const citySources = sources.filter((source) => {
      const resolvedCity = normalizeJobMatchCity(
        source.application.cityContext.marketCity
          ?? source.application.cityContext.jobCity
          ?? source.job?.city
          ?? null,
      );
      return resolvedCity === city;
    });
    return [city, countsFromSources(citySources)];
  })) as Record<MarketPositionCityCode, EvidenceRawCounts>;

  const now = (options.now ?? Date.now)();
  const funnelQueryFingerprint = sha256RequestHash({ global: globalCounts, cities });
  const inputHash = sha256RequestHash({
    jobMatchProfileVersionId: input.jobMatchProfileVersionId,
    capabilityBaselineVersionId: input.capabilityBaselineVersionId,
    acceptedEvidenceIds: [...input.acceptedEvidenceIds].sort(),
    funnelQueryFingerprint,
  });

  return {
    jobMatchProfileVersionId: input.jobMatchProfileVersionId,
    capabilityBaselineVersionId: input.capabilityBaselineVersionId,
    acceptedEvidenceIds: [...input.acceptedEvidenceIds].sort(),
    funnelCutoffAt: now,
    countsByScope: { global: globalCounts, cities },
    funnelQueryFingerprint,
    inputHash,
    capturedAt: now,
  };
}
