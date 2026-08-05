import { describe, expect, it } from 'vitest';
import { AnalysisContractError } from './contractErrors';
import {
  dedupeSourceSnapshotIds,
  parseJobMatchAnalysisInputSnapshot,
  serializeJobMatchAnalysisInputSnapshot,
  SNAPSHOT_MAX_BYTES,
} from './contracts';
import { validSnapshot } from './contractFixtures';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected AnalysisContractError');
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisContractError);
    expect((error as AnalysisContractError).code).toBe(code);
  }
}

describe('JobMatchAnalysisInputSnapshotV1', () => {
  it('accepts a full valid snapshot', () => {
    expect(parseJobMatchAnalysisInputSnapshot(validSnapshot()).contractVersion).toBe(1);
  });

  it('accepts null optional contexts', () => {
    const snap = validSnapshot({ capabilityBaseline: null, marketPosition: null, strategy: null });
    expect(parseJobMatchAnalysisInputSnapshot(snap).strategy).toBeNull();
  });

  it('rejects over-long strings', () => {
    const snap = validSnapshot();
    snap.candidate.normalizedFacts.company = 'x'.repeat(1_000);
    expectCode(() => parseJobMatchAnalysisInputSnapshot(snap), 'SNAPSHOT_INVALID');
  });

  it('rejects over-count arrays', () => {
    const snap = validSnapshot();
    snap.candidate.normalizedFacts.responsibilities = Array.from({ length: 200 }, (_, i) => `r${i}`);
    expectCode(() => parseJobMatchAnalysisInputSnapshot(snap), 'SNAPSHOT_INVALID');
  });

  it('dedupes and bounds sourceSnapshotIds via helper', () => {
    expect(dedupeSourceSnapshotIds(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(dedupeSourceSnapshotIds(Array.from({ length: 200 }, () => 'same'))).toEqual(['same']);
  });

  it('rejects unknown keys (strictObject)', () => {
    const snap = { ...validSnapshot(), unexpected: true };
    expectCode(() => parseJobMatchAnalysisInputSnapshot(snap), 'SNAPSHOT_INVALID');
  });

  it('rejects arbitrary z.unknown-style payloads in safeSnapshot', () => {
    const snap = validSnapshot();
    // 试图塞入完整原始对象（未定义字段）→ strictObject 拒绝。
    (snap.resume.safeSnapshot as Record<string, unknown>).rawResume = { everything: 'here' };
    expectCode(() => parseJobMatchAnalysisInputSnapshot(snap), 'SNAPSHOT_INVALID');
  });

  it('rejects total JSON over the size limit (schema-valid but too large)', () => {
    // 每个数组元素合法（≤500）、数量合法（≤60），但多个满额数组累计 > 128KB。
    const big = () => Array.from({ length: 60 }, () => 'x'.repeat(500)); // 每数组约 30KB
    const snap = validSnapshot();
    snap.candidate.normalizedFacts.responsibilities = big();
    snap.candidate.normalizedFacts.requirements = big();
    snap.resume.safeSnapshot.resumeText = 'x'.repeat(8_000);
    snap.resume.safeSnapshot.projectExperience = 'x'.repeat(8_000);
    snap.jobMatchProfile.safeSnapshot.coreCapabilities = big();
    snap.jobMatchProfile.safeSnapshot.constraints = big();
    snap.jobMatchProfile.safeSnapshot.preferences = big();
    // 约 7 * 30KB = 210KB，远超 128KB，确定性触发。
    expect(Buffer.byteLength(JSON.stringify(snap), 'utf8')).toBeGreaterThan(SNAPSHOT_MAX_BYTES);
    expectCode(() => parseJobMatchAnalysisInputSnapshot(snap), 'SNAPSHOT_TOO_LARGE');
  });

  it('rejects Cookie / Token / securityId content', () => {
    for (const bad of ['Set-Cookie: sid=1', 'Authorization: Bearer abc.def', 'securityId=xyz']) {
      const snap = validSnapshot();
      snap.candidate.normalizedFacts.rawDescription = bad;
      expectCode(() => parseJobMatchAnalysisInputSnapshot(snap), 'SNAPSHOT_INVALID');
    }
  });

  it('rejects HTML content', () => {
    const snap = validSnapshot();
    snap.candidate.normalizedFacts.rawDescription = '<div>岗位</div>';
    expectCode(() => parseJobMatchAnalysisInputSnapshot(snap), 'SNAPSHOT_INVALID');
  });

  it('rejects local absolute paths', () => {
    const snap = validSnapshot();
    snap.candidate.normalizedFacts.rawDescription = '见 C:\\Users\\me\\jd.txt';
    expectCode(() => parseJobMatchAnalysisInputSnapshot(snap), 'SNAPSHOT_INVALID');
  });

  it('serialize produces canonical JSON and validates', () => {
    const a = serializeJobMatchAnalysisInputSnapshot(validSnapshot());
    const b = serializeJobMatchAnalysisInputSnapshot(validSnapshot());
    expect(a).toBe(b);
  });
});

describe('JobMatchAnalysisInputSnapshotV2', () => {
  const v2 = () => ({
    ...validSnapshot(),
    contractVersion: 2 as const,
    novaWingContext: {
      coreRevision: 3,
      scopes: ['global', 'career'] as ['global', 'career'],
      entries: [{ scope: 'global' as const, key: 'global.summary', value: { safe: true } }],
    },
  });

  it('accepts the explicit V2 context while continuing to parse old V1 snapshots', () => {
    const parsed = parseJobMatchAnalysisInputSnapshot(v2());
    expect(parsed.contractVersion).toBe(2);
    if (parsed.contractVersion === 2) expect(parsed.novaWingContext.coreRevision).toBe(3);
    expect(parseJobMatchAnalysisInputSnapshot(validSnapshot()).contractVersion).toBe(1);
  });

  it('does not silently change V1 or accept a V2 snapshot without context', () => {
    expectCode(() => parseJobMatchAnalysisInputSnapshot({
      ...validSnapshot(), novaWingContext: v2().novaWingContext,
    }), 'SNAPSHOT_INVALID');
    const { novaWingContext: _removed, ...missing } = v2();
    expectCode(() => parseJobMatchAnalysisInputSnapshot(missing), 'SNAPSHOT_INVALID');
  });
});
