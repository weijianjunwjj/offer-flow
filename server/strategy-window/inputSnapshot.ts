import { STRATEGY_RULE_VERSION, type StrategyInputSnapshot } from '../../src/domain/strategy-window';
import type { SqliteDatabase } from '../db';
import { CapabilityBaselineRepository } from '../capability-baseline/repository';
import { MarketPositionRepository } from '../market-position/repository';
import { buildMarketPositionInputSnapshot } from '../market-position/inputSnapshot';
import { ProfileRepository } from '../repositories/profileRepository';
import { sha256RequestHash } from '../job-memory/requestHash';

export interface StrategyInputSnapshotOptions {
  now?: () => number;
}

export type StrategyInputSnapshotResult = StrategyInputSnapshot;

/**
 * 构建 G5 策略窗口输入快照：只读取 G1 active 岗位匹配版本 id、G2 active 能力基线版本 id +
 * 已接受证据 id、G4 active 市场位置版本（提供 evidenceLevel / decisionGate 状态 /
 * allowed-blockedClaims）、以及 G3 漏斗指纹（复用 G4 的 buildMarketPositionInputSnapshot，
 * 不重造漏斗）。G4 尚无 active 版本时返回 null（输入未就绪）。
 * 从不读取外部网站、Boss 自动化、临时聊天草稿、被拒/稍后处理的提案或 G6 发布状态。
 */
export function buildStrategyInputSnapshot(
  db: SqliteDatabase,
  options: StrategyInputSnapshotOptions = {},
): StrategyInputSnapshotResult | null {
  const now = (options.now ?? Date.now)();

  const profile = new ProfileRepository(db).get();
  const jobMatchProfileVersionId = profile?.jobMatchProfile?.activeVersionId ?? null;

  const capabilityState = new CapabilityBaselineRepository(db).getState();
  const capabilityBaselineVersionId = capabilityState.activeVersionId;
  const acceptedEvidenceIds = capabilityState.evidence
    .filter((item) => item.status === 'accepted' || item.status === 'modified_and_accepted')
    .map((item) => item.id)
    .sort();

  const marketState = new MarketPositionRepository(db).getState();
  const marketActive = marketState.activeVersionId === null
    ? null
    : marketState.versions.find((version) => version.id === marketState.activeVersionId) ?? null;
  if (marketActive === null) return null;

  const global = marketActive.global;
  const evidenceLevel = global.evidenceSufficiency.evidenceLevel;
  const decisionGateStatuses = global.decisionGates.map((gate) => ({
    gateType: gate.gateType,
    status: gate.status,
  }));
  const allowedClaims = [...global.evidenceSufficiency.allowedClaims];
  const blockedClaims = [...global.evidenceSufficiency.blockedClaims];

  const marketSnapshot = buildMarketPositionInputSnapshot(db, {
    jobMatchProfileVersionId,
    capabilityBaselineVersionId,
    acceptedEvidenceIds,
  }, { now: () => now });

  const funnelQueryFingerprint = marketSnapshot.funnelQueryFingerprint;
  const funnelCutoffAt = marketSnapshot.funnelCutoffAt;

  const inputHash = sha256RequestHash({
    jobMatchProfileVersionId,
    capabilityBaselineVersionId,
    marketPositionVersionId: marketActive.id,
    acceptedEvidenceIds,
    funnelQueryFingerprint,
    evidenceLevel,
    decisionGateStatuses,
    ruleVersion: STRATEGY_RULE_VERSION,
  });

  return {
    jobMatchProfileVersionId,
    capabilityBaselineVersionId,
    marketPositionVersionId: marketActive.id,
    acceptedEvidenceIds,
    funnelCutoffAt,
    funnelQueryFingerprint,
    evidenceLevel,
    decisionGateStatuses,
    allowedClaims,
    blockedClaims,
    inputHash,
    capturedAt: now,
  };
}
