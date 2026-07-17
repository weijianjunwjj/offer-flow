import { DECISION_GATE_TYPES, type DecisionGateStatus } from '../market-position';
import { computeStrategyWindow } from './strategyWindow';
import type {
  EvidenceLevel,
  StrategyDecisionGateSnapshotEntry,
  StrategyInputSnapshot,
  StrategyWindow,
} from './types';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const HIGH_STAKES = new Set(['abandon_direction', 'relocation_decision']);

/** 复用 G4 的确定性映射：标准门随证据等级三级映射，高风险门最高只能 observe_only。 */
export function gateStatusesForLevel(level: EvidenceLevel): StrategyDecisionGateSnapshotEntry[] {
  return DECISION_GATE_TYPES.map((gateType) => {
    let status: DecisionGateStatus;
    if (HIGH_STAKES.has(gateType)) {
      status = level === 'supported' ? 'observe_only' : 'blocked';
    } else if (level === 'insufficient') {
      status = 'blocked';
    } else if (level === 'directional') {
      status = 'observe_only';
    } else {
      status = 'decision_ready';
    }
    return { gateType, status };
  });
}

export function makeStrategyInputSnapshot(
  level: EvidenceLevel,
  overrides: Partial<StrategyInputSnapshot> = {},
): StrategyInputSnapshot {
  return {
    jobMatchProfileVersionId: 'jmp-1',
    capabilityBaselineVersionId: 'cb-1',
    marketPositionVersionId: 'mp-1',
    acceptedEvidenceIds: ['ev-1', 'ev-2'],
    funnelCutoffAt: 10_000,
    funnelQueryFingerprint: HASH_B,
    evidenceLevel: level,
    decisionGateStatuses: gateStatusesForLevel(level),
    allowedClaims: ['fact_count_statement', 'missing_evidence_statement'],
    blockedClaims: ['offer_probability_claim', 'direction_abandonment_directive', 'relocation_directive'],
    inputHash: HASH_A,
    capturedAt: 10_000,
    ...overrides,
  };
}

export function makeStrategyWindow(
  level: EvidenceLevel,
  now = 100_000,
): StrategyWindow {
  const snapshot = makeStrategyInputSnapshot(level);
  return computeStrategyWindow({
    sourceVersionIds: {
      jobMatchProfileVersionId: snapshot.jobMatchProfileVersionId,
      capabilityBaselineVersionId: snapshot.capabilityBaselineVersionId,
      marketPositionVersionId: snapshot.marketPositionVersionId,
    },
    inputHash: snapshot.inputHash,
    dataCutoffAt: snapshot.funnelCutoffAt,
    evidenceLevel: snapshot.evidenceLevel,
    decisionGateStatuses: snapshot.decisionGateStatuses,
    allowedClaims: snapshot.allowedClaims,
    blockedClaims: snapshot.blockedClaims,
  }, { now: () => now, createId: () => 'window-fixture' });
}
