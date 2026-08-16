/**
 * Provider-neutral Writer profile qualification evidence.
 *
 * This module deliberately stops at measurement/governance. It does not grant
 * workspace write permission and is not consulted by runtime model routing.
 */
import type {
  WriterDecisionActionClass,
  WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';
import type { WriterBenchmarkVerdict } from './writerModelProfileBenchmark';
import { reclassifyWriterBenchmarkSample } from './writerModelProfileBenchmark.run';
import type { PersistedWriterBenchmarkSample } from './writerModelProfileBenchmarkStore';
import type { ExecutionModelRole } from './types';

export type WriterQualificationStatus =
  | 'QUALIFIED'
  | 'NOT_QUALIFIED'
  | 'INSUFFICIENT_EVIDENCE';

export type WriterQualificationReasonCode =
  | 'QUALIFICATION_POLICY_NOT_ESTABLISHED'
  | 'FIXTURE_COVERAGE_INCOMPLETE'
  | 'PROVIDER_UNAVAILABLE_OBSERVED'
  | 'OUTPUT_TRUNCATION_OBSERVED'
  | 'PROTOCOL_INVALID_OBSERVED'
  | 'WRITE_TRANSITION_WEAKNESS_OBSERVED'
  | 'EXPLORATION_REDUNDANCY_OBSERVED'
  | 'PREMATURE_WRITE_OBSERVED'
  | 'NO_PROGRESS_OBSERVED';

export type WriterBenchmarkVerdictCounts = Record<WriterBenchmarkVerdict, number>;

export interface WriterFixtureQualificationEvidence {
  expectedActionClass: WriterExpectedActionClass;
  sampleIds: string[];
  capabilitySampleIds: string[];
  unavailableSampleIds: string[];
  protocolInvalidSampleIds: string[];
  truncatedSampleIds: string[];
  observedActionClasses: WriterDecisionActionClass[];
  verdictCounts: WriterBenchmarkVerdictCounts;
  expectedBehaviorObserved: boolean;
  redundancyObserved: boolean;
  wrongActionObserved: boolean;
  prematureWriteObserved: boolean;
  noProgressObserved: boolean;
}

export interface WriterQualificationEvidence {
  fixtureCoverage: Record<WriterExpectedActionClass, WriterFixtureQualificationEvidence>;
  sampleIds: string[];
  sourceExecutionRoles: ExecutionModelRole[];
  totalSamples: number;
  capabilitySamples: number;
  unavailableSamples: number;
  protocolInvalidSamples: number;
  truncatedSamples: number;
}

export interface WriterProfileQualificationResult {
  profileId: string;
  executionRole: 'WRITER';
  status: WriterQualificationStatus;
  reasonCodes: WriterQualificationReasonCode[];
  evidence: WriterQualificationEvidence;
}

const EXPECTED_ACTIONS: readonly WriterExpectedActionClass[] = ['SEARCH', 'READ', 'WRITE'];
const ACTION_ORDER: readonly WriterDecisionActionClass[] = ['SEARCH', 'READ', 'WRITE', 'FINAL', 'INVALID'];
const VERDICT_ORDER: readonly WriterBenchmarkVerdict[] = [
  'PASS_STRICT',
  'PASS_WITH_REDUNDANCY',
  'FAIL_WRONG_ACTION',
  'FAIL_PREMATURE_WRITE',
  'FAIL_NO_PROGRESS',
  'OUTPUT_TRUNCATED_NO_ACTION',
  'NO_ACTION_RETURNED',
  'INVALID_PROTOCOL',
  'BENCHMARK_UNAVAILABLE',
];
const REASON_ORDER: readonly WriterQualificationReasonCode[] = [
  'QUALIFICATION_POLICY_NOT_ESTABLISHED',
  'FIXTURE_COVERAGE_INCOMPLETE',
  'PROVIDER_UNAVAILABLE_OBSERVED',
  'OUTPUT_TRUNCATION_OBSERVED',
  'PROTOCOL_INVALID_OBSERVED',
  'WRITE_TRANSITION_WEAKNESS_OBSERVED',
  'EXPLORATION_REDUNDANCY_OBSERVED',
  'PREMATURE_WRITE_OBSERVED',
  'NO_PROGRESS_OBSERVED',
];

/**
 * Keep only the newest safe persisted sample for each profile/fixture cell.
 * Selection uses audit timestamps and sample ids, never Provider identity.
 */
export function selectLatestWriterBenchmarkSamplesByCell(
  samples: readonly PersistedWriterBenchmarkSample[],
): PersistedWriterBenchmarkSample[] {
  const latest = new Map<string, PersistedWriterBenchmarkSample>();
  for (const sample of samples) {
    const key = `${sample.profileId}\u0000${sample.fixtureId}`;
    const current = latest.get(key);
    if (!current || compareSampleRecency(current, sample) < 0) latest.set(key, sample);
  }
  return [...latest.values()].sort(compareSamples);
}

/** Aggregate benchmark evidence for one profile without applying a numeric threshold. */
export function evaluateWriterProfileQualification(
  profileId: string,
  samples: readonly PersistedWriterBenchmarkSample[],
): WriterProfileQualificationResult {
  const profileSamples = samples
    .filter(sample => sample.profileId === profileId)
    .map(reclassifyWriterBenchmarkSample)
    .sort(compareSamples);

  const fixtureCoverage = Object.fromEntries(
    EXPECTED_ACTIONS.map(expected => [expected, aggregateFixture(expected, profileSamples)]),
  ) as WriterQualificationEvidence['fixtureCoverage'];
  const fixtureEvidence = EXPECTED_ACTIONS.map(expected => fixtureCoverage[expected]);
  const reasonSet = new Set<WriterQualificationReasonCode>([
    'QUALIFICATION_POLICY_NOT_ESTABLISHED',
  ]);

  if (fixtureEvidence.some(evidence => evidence.capabilitySampleIds.length === 0)) {
    reasonSet.add('FIXTURE_COVERAGE_INCOMPLETE');
  }
  if (fixtureEvidence.some(evidence => evidence.unavailableSampleIds.length > 0)) {
    reasonSet.add('PROVIDER_UNAVAILABLE_OBSERVED');
  }
  if (fixtureEvidence.some(evidence => evidence.truncatedSampleIds.length > 0)) {
    reasonSet.add('OUTPUT_TRUNCATION_OBSERVED');
  }
  if (fixtureEvidence.some(evidence => evidence.protocolInvalidSampleIds.length > 0)) {
    reasonSet.add('PROTOCOL_INVALID_OBSERVED');
  }
  if (fixtureCoverage.WRITE.wrongActionObserved) {
    reasonSet.add('WRITE_TRANSITION_WEAKNESS_OBSERVED');
  }
  if (fixtureEvidence.some(evidence => evidence.redundancyObserved)) {
    reasonSet.add('EXPLORATION_REDUNDANCY_OBSERVED');
  }
  if (fixtureEvidence.some(evidence => evidence.prematureWriteObserved)) {
    reasonSet.add('PREMATURE_WRITE_OBSERVED');
  }
  if (fixtureEvidence.some(evidence => evidence.noProgressObserved)) {
    reasonSet.add('NO_PROGRESS_OBSERVED');
  }

  const unavailableSamples = fixtureEvidence.reduce(
    (total, evidence) => total + evidence.unavailableSampleIds.length,
    0,
  );
  const protocolInvalidSamples = fixtureEvidence.reduce(
    (total, evidence) => total + evidence.protocolInvalidSampleIds.length,
    0,
  );
  const truncatedSamples = fixtureEvidence.reduce(
    (total, evidence) => total + evidence.truncatedSampleIds.length,
    0,
  );
  const capabilitySamples = fixtureEvidence.reduce(
    (total, evidence) => total + evidence.capabilitySampleIds.length,
    0,
  );

  return {
    profileId,
    executionRole: 'WRITER',
    // Current evidence volume does not justify a certification threshold. The
    // two terminal statuses remain part of the contract for a future policy.
    status: 'INSUFFICIENT_EVIDENCE',
    reasonCodes: REASON_ORDER.filter(reason => reasonSet.has(reason)),
    evidence: {
      fixtureCoverage,
      sampleIds: profileSamples.map(sample => sample.benchmarkSampleId),
      sourceExecutionRoles: uniqueSorted(profileSamples.map(sample => sample.executionRole)),
      totalSamples: profileSamples.length,
      capabilitySamples,
      unavailableSamples,
      protocolInvalidSamples,
      truncatedSamples,
    },
  };
}

export function evaluateWriterProfileQualifications(
  samples: readonly PersistedWriterBenchmarkSample[],
): WriterProfileQualificationResult[] {
  return uniqueSorted(samples.map(sample => sample.profileId))
    .map(profileId => evaluateWriterProfileQualification(profileId, samples));
}

function aggregateFixture(
  expected: WriterExpectedActionClass,
  samples: readonly PersistedWriterBenchmarkSample[],
): WriterFixtureQualificationEvidence {
  const fixtureSamples = samples.filter(sample => sample.expectedActionClass === expected);
  const unavailable = fixtureSamples.filter(isUnavailableSample);
  const protocolInvalid = fixtureSamples.filter(sample => sample.verdict === 'INVALID_PROTOCOL');
  const truncated = fixtureSamples.filter(sample => sample.verdict === 'OUTPUT_TRUNCATED_NO_ACTION');
  const capability = fixtureSamples.filter(sample => (
    !isUnavailableSample(sample)
    && sample.verdict !== 'INVALID_PROTOCOL'
    && sample.verdict !== 'OUTPUT_TRUNCATED_NO_ACTION'
  ));
  const observedActions = new Set(fixtureSamples.flatMap(sample => sample.actionClasses));

  return {
    expectedActionClass: expected,
    sampleIds: fixtureSamples.map(sample => sample.benchmarkSampleId),
    capabilitySampleIds: capability.map(sample => sample.benchmarkSampleId),
    unavailableSampleIds: unavailable.map(sample => sample.benchmarkSampleId),
    protocolInvalidSampleIds: protocolInvalid.map(sample => sample.benchmarkSampleId),
    truncatedSampleIds: truncated.map(sample => sample.benchmarkSampleId),
    observedActionClasses: ACTION_ORDER.filter(action => observedActions.has(action)),
    verdictCounts: countVerdicts(fixtureSamples),
    expectedBehaviorObserved: fixtureSamples.some(sample => (
      sample.verdict === 'PASS_STRICT' || sample.verdict === 'PASS_WITH_REDUNDANCY'
    )),
    redundancyObserved: fixtureSamples.some(sample => sample.verdict === 'PASS_WITH_REDUNDANCY'),
    wrongActionObserved: fixtureSamples.some(sample => sample.verdict === 'FAIL_WRONG_ACTION'),
    prematureWriteObserved: fixtureSamples.some(sample => sample.verdict === 'FAIL_PREMATURE_WRITE'),
    noProgressObserved: fixtureSamples.some(sample => (
      sample.verdict === 'FAIL_NO_PROGRESS' || sample.verdict === 'NO_ACTION_RETURNED'
    )),
  };
}

function countVerdicts(
  samples: readonly PersistedWriterBenchmarkSample[],
): WriterBenchmarkVerdictCounts {
  const counts = Object.fromEntries(
    VERDICT_ORDER.map(verdict => [verdict, 0]),
  ) as WriterBenchmarkVerdictCounts;
  for (const sample of samples) counts[sample.verdict] += 1;
  return counts;
}

function isUnavailableSample(sample: PersistedWriterBenchmarkSample): boolean {
  return sample.verdict === 'BENCHMARK_UNAVAILABLE'
    || sample.providerErrorCategory !== null
    || sample.providerErrorCode !== null;
}

function compareSampleRecency(
  left: PersistedWriterBenchmarkSample,
  right: PersistedWriterBenchmarkSample,
): number {
  return left.completedAt.localeCompare(right.completedAt)
    || left.benchmarkSampleId.localeCompare(right.benchmarkSampleId);
}

function compareSamples(
  left: PersistedWriterBenchmarkSample,
  right: PersistedWriterBenchmarkSample,
): number {
  return left.profileId.localeCompare(right.profileId)
    || left.expectedActionClass.localeCompare(right.expectedActionClass)
    || left.completedAt.localeCompare(right.completedAt)
    || left.benchmarkSampleId.localeCompare(right.benchmarkSampleId);
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
