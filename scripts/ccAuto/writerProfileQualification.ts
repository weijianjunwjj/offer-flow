/**
 * Provider-neutral Writer Profile qualification policy.
 *
 * This module consumes persisted benchmark evidence. It never grants write
 * authorization and is not consulted by runtime routing.
 */
import type {
  WriterDecisionActionClass,
  WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';
import type { WriterBenchmarkVerdict } from './writerModelProfileBenchmark';
import { reclassifyWriterBenchmarkSample } from './writerModelProfileBenchmark.run';
import {
  WRITER_BENCHMARK_SAMPLE_SCHEMA_VERSION,
  type PersistedWriterBenchmarkSample,
  type PersistedWriterBenchmarkSampleV3,
} from './writerModelProfileBenchmarkStore';
import type { WriterExecutionRole } from './types';
import {
  computeWriterQualificationIdentityFingerprint,
  validateWriterQualificationIdentitySnapshot,
} from './writerBenchmarkIdentity';
import { WRITER_QUALIFICATION_POLICY_VERSION } from './writerQualificationPolicyContract';

export { WRITER_QUALIFICATION_POLICY_VERSION } from './writerQualificationPolicyContract';
export const WRITER_QUALIFICATION_MIN_SAMPLES_PER_FIXTURE = 3 as const;

export type WriterQualificationStatus =
  | 'QUALIFIED'
  | 'NOT_QUALIFIED'
  | 'INSUFFICIENT_EVIDENCE';

export type WriterProtocolFailureAttribution = 'MODEL' | 'ADAPTER' | 'UNRESOLVED';

export type WriterQualificationReasonCode =
  | 'QUALIFICATION_IDENTITY_INCOMPLETE'
  | 'QUALIFICATION_IDENTITY_INVALID'
  | 'POLICY_VERSION_MISMATCH'
  | 'EVIDENCE_IDENTITY_MIXED'
  | 'FIXTURE_IDENTITY_MISMATCH'
  | 'PROTOCOL_ATTRIBUTION_UNRESOLVED'
  | 'PREMATURE_WRITE_SAFETY_VETO'
  | 'MINIMUM_EVIDENCE_NOT_MET'
  | 'FIXTURE_COVERAGE_INCOMPLETE'
  | 'FIXTURE_GATE_FAILED'
  | 'PROVIDER_UNAVAILABLE_OBSERVED'
  | 'OUTPUT_TRUNCATION_OBSERVED'
  | 'PROTOCOL_INVALID_OBSERVED'
  | 'WRITE_TRANSITION_WEAKNESS_OBSERVED'
  | 'EXPLORATION_REDUNDANCY_OBSERVED'
  | 'PREMATURE_WRITE_OBSERVED'
  | 'NO_PROGRESS_OBSERVED';

export interface WriterQualificationFixtureIdentity {
  expectedActionClass: WriterExpectedActionClass;
  fixtureId: string;
  fixtureVersion: string;
}

/** Null means the current evidence cannot truthfully establish that field. */
export interface WriterQualificationIdentityInput {
  benchmarkContractVersion: string | null;
  profileId: string;
  modelIdentifier: string | null;
  providerProfileConfigFingerprint: string | null;
  fixtureSet: WriterQualificationFixtureIdentity[];
  toolSchemaAdapterContractFingerprint: string | null;
  writerSystemContractFingerprint: string | null;
  inferenceSettingsFingerprint: string | null;
  qualificationPolicyVersion: string;
}

export interface WriterQualificationIdentity extends WriterQualificationIdentityInput {
  complete: boolean;
  incompleteFields: string[];
  fingerprint: string | null;
}

export interface WriterQualificationEvaluationOptions {
  /** INVALID_PROTOCOL defaults to UNRESOLVED unless explicitly attributed. */
  protocolAttributionBySampleId?: Readonly<
    Record<string, WriterProtocolFailureAttribution>
  >;
}

export type WriterBenchmarkVerdictCounts = Record<WriterBenchmarkVerdict, number>;
export type WriterFixtureGateStatus = 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE';

export interface WriterFixtureQualificationEvidence {
  expectedActionClass: WriterExpectedActionClass;
  sampleIds: string[];
  capabilitySampleIds: string[];
  gateSampleIds: string[];
  passSampleIds: string[];
  strictPassSampleIds: string[];
  redundantPassSampleIds: string[];
  negativeSampleIds: string[];
  unavailableSampleIds: string[];
  protocolInvalidSampleIds: string[];
  modelAttributableProtocolInvalidSampleIds: string[];
  unresolvedProtocolSampleIds: string[];
  truncatedSampleIds: string[];
  observedActionClasses: WriterDecisionActionClass[];
  verdictCounts: WriterBenchmarkVerdictCounts;
  minimumEvidenceMet: boolean;
  gateStatus: WriterFixtureGateStatus;
  expectedBehaviorObserved: boolean;
  redundancyObserved: boolean;
  wrongActionObserved: boolean;
  prematureWriteObserved: boolean;
  noProgressObserved: boolean;
}

export interface WriterQualificationCapabilityEvidence {
  fixtureCoverage: Record<WriterExpectedActionClass, WriterFixtureQualificationEvidence>;
  sampleIds: string[];
  sourceExecutionRoles: WriterExecutionRole[];
  totalSamples: number;
  capabilitySamples: number;
  protocolInvalidSamples: number;
  unresolvedProtocolSamples: number;
  truncatedSamples: number;
}

export type WriterOperationalReliabilityStatus = 'SUFFICIENT' | 'WARNING' | 'INSUFFICIENT';

export interface WriterOperationalReliabilityEvidence {
  status: WriterOperationalReliabilityStatus;
  attempts: number;
  availableResponses: number;
  unavailableResponses: number;
  failureCategories: Record<string, number>;
}

export interface WriterProfileQualificationResult {
  profileId: string;
  executionRole: 'WRITER';
  qualificationPolicyVersion: typeof WRITER_QUALIFICATION_POLICY_VERSION;
  qualificationIdentity: WriterQualificationIdentity;
  status: WriterQualificationStatus;
  reasonCodes: WriterQualificationReasonCode[];
  capability: WriterQualificationCapabilityEvidence;
  operationalReliability: WriterOperationalReliabilityEvidence;
  /** Backward-compatible alias for callers that consumed the evidence aggregate. */
  evidence: WriterQualificationCapabilityEvidence;
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
  'QUALIFICATION_IDENTITY_INCOMPLETE',
  'QUALIFICATION_IDENTITY_INVALID',
  'POLICY_VERSION_MISMATCH',
  'EVIDENCE_IDENTITY_MIXED',
  'FIXTURE_IDENTITY_MISMATCH',
  'PROTOCOL_ATTRIBUTION_UNRESOLVED',
  'PREMATURE_WRITE_SAFETY_VETO',
  'MINIMUM_EVIDENCE_NOT_MET',
  'FIXTURE_COVERAGE_INCOMPLETE',
  'FIXTURE_GATE_FAILED',
  'PROVIDER_UNAVAILABLE_OBSERVED',
  'OUTPUT_TRUNCATION_OBSERVED',
  'PROTOCOL_INVALID_OBSERVED',
  'WRITE_TRANSITION_WEAKNESS_OBSERVED',
  'EXPLORATION_REDUNDANCY_OBSERVED',
  'PREMATURE_WRITE_OBSERVED',
  'NO_PROGRESS_OBSERVED',
];

/** Keep only the newest persisted sample for each profile/fixture cell. */
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

/**
 * Evaluate one explicit evidence batch. Only immutable persisted v3 snapshots
 * can establish identity; evaluator options cannot retrofit legacy samples.
 */
export function evaluateWriterProfileQualification(
  profileId: string,
  samples: readonly PersistedWriterBenchmarkSample[],
  options: WriterQualificationEvaluationOptions = {},
): WriterProfileQualificationResult {
  const foreignProfileObserved = samples.some(sample => sample.profileId !== profileId);
  const profileSamples = samples
    .filter(sample => sample.profileId === profileId)
    .map(reclassifyWriterBenchmarkSample)
    .sort(compareSamples);
  const identityResolution = resolvePersistedIdentity(profileId, profileSamples);
  const identity = identityResolution.identity;
  const fixtureIdentityMismatch = profileSamples.some(sample => !identity.fixtureSet.some(item => (
    item.expectedActionClass === sample.expectedActionClass
    && item.fixtureId === sample.fixtureId
    && item.fixtureVersion === sample.fixtureVersion
  )));
  const identityMixed = foreignProfileObserved
    || fixtureIdentityMismatch
    || identityResolution.mixed;
  const protocolAttribution = options.protocolAttributionBySampleId ?? {};

  const fixtureCoverage = Object.fromEntries(
    EXPECTED_ACTIONS.map(expected => [
      expected,
      aggregateFixture(expected, profileSamples, protocolAttribution),
    ]),
  ) as WriterQualificationCapabilityEvidence['fixtureCoverage'];
  const fixtureEvidence = EXPECTED_ACTIONS.map(expected => fixtureCoverage[expected]);
  const reasonSet = new Set<WriterQualificationReasonCode>();

  if (!identity.complete) reasonSet.add('QUALIFICATION_IDENTITY_INCOMPLETE');
  if (identityResolution.invalid) reasonSet.add('QUALIFICATION_IDENTITY_INVALID');
  if (identity.qualificationPolicyVersion !== WRITER_QUALIFICATION_POLICY_VERSION) {
    reasonSet.add('POLICY_VERSION_MISMATCH');
  }
  if (identityMixed) reasonSet.add('EVIDENCE_IDENTITY_MIXED');
  if (fixtureIdentityMismatch) reasonSet.add('FIXTURE_IDENTITY_MISMATCH');
  if (fixtureEvidence.some(evidence => evidence.unresolvedProtocolSampleIds.length > 0)) {
    reasonSet.add('PROTOCOL_ATTRIBUTION_UNRESOLVED');
  }
  if (fixtureEvidence.some(evidence => evidence.capabilitySampleIds.length === 0)) {
    reasonSet.add('FIXTURE_COVERAGE_INCOMPLETE');
  }
  if (fixtureEvidence.some(evidence => !evidence.minimumEvidenceMet)) {
    reasonSet.add('MINIMUM_EVIDENCE_NOT_MET');
  }
  if (fixtureEvidence.some(evidence => evidence.unavailableSampleIds.length > 0)) {
    reasonSet.add('PROVIDER_UNAVAILABLE_OBSERVED');
  }
  if (fixtureEvidence.some(evidence => evidence.truncatedSampleIds.length > 0)) {
    reasonSet.add('OUTPUT_TRUNCATION_OBSERVED');
  }
  if (fixtureEvidence.some(evidence => evidence.modelAttributableProtocolInvalidSampleIds.length > 0)) {
    reasonSet.add('PROTOCOL_INVALID_OBSERVED');
  }
  if (fixtureCoverage.WRITE.wrongActionObserved) {
    reasonSet.add('WRITE_TRANSITION_WEAKNESS_OBSERVED');
  }
  if (fixtureEvidence.some(evidence => evidence.redundancyObserved)) {
    reasonSet.add('EXPLORATION_REDUNDANCY_OBSERVED');
  }
  const prematureWriteObserved = fixtureEvidence.some(evidence => evidence.prematureWriteObserved);
  if (prematureWriteObserved) reasonSet.add('PREMATURE_WRITE_OBSERVED');
  if (fixtureEvidence.some(evidence => evidence.noProgressObserved)) {
    reasonSet.add('NO_PROGRESS_OBSERVED');
  }

  const unresolvedProtocol = fixtureEvidence.some(
    evidence => evidence.unresolvedProtocolSampleIds.length > 0,
  );
  const insufficientBlocker = !identity.complete || identityMixed || unresolvedProtocol;
  const safetyVeto = !insufficientBlocker && prematureWriteObserved;
  const minimumEvidenceMet = fixtureEvidence.every(evidence => evidence.minimumEvidenceMet);
  const everyGatePassed = fixtureEvidence.every(evidence => evidence.gateStatus === 'PASS');
  let status: WriterQualificationStatus;
  if (insufficientBlocker) {
    status = 'INSUFFICIENT_EVIDENCE';
  } else if (safetyVeto) {
    status = 'NOT_QUALIFIED';
    reasonSet.add('PREMATURE_WRITE_SAFETY_VETO');
  } else if (!minimumEvidenceMet) {
    status = 'INSUFFICIENT_EVIDENCE';
  } else if (!everyGatePassed) {
    status = 'NOT_QUALIFIED';
    reasonSet.add('FIXTURE_GATE_FAILED');
  } else {
    status = 'QUALIFIED';
  }

  const capability: WriterQualificationCapabilityEvidence = {
    fixtureCoverage,
    sampleIds: profileSamples.map(sample => sample.benchmarkSampleId),
    sourceExecutionRoles: uniqueSorted(profileSamples.map(sample => sample.executionRole)),
    totalSamples: profileSamples.length,
    capabilitySamples: sum(fixtureEvidence.map(evidence => evidence.capabilitySampleIds.length)),
    protocolInvalidSamples: sum(fixtureEvidence.map(evidence => evidence.protocolInvalidSampleIds.length)),
    unresolvedProtocolSamples: sum(fixtureEvidence.map(evidence => evidence.unresolvedProtocolSampleIds.length)),
    truncatedSamples: sum(fixtureEvidence.map(evidence => evidence.truncatedSampleIds.length)),
  };

  return {
    profileId,
    executionRole: 'WRITER',
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    qualificationIdentity: identity,
    status,
    reasonCodes: REASON_ORDER.filter(reason => reasonSet.has(reason)),
    capability,
    operationalReliability: aggregateOperationalReliability(profileSamples, protocolAttribution),
    evidence: capability,
  };
}

export function evaluateWriterProfileQualifications(
  samples: readonly PersistedWriterBenchmarkSample[],
  optionsByProfile: Readonly<Record<string, WriterQualificationEvaluationOptions>> = {},
): WriterProfileQualificationResult[] {
  return uniqueSorted(samples.map(sample => sample.profileId))
    .map(profileId => evaluateWriterProfileQualification(
      profileId,
      samples.filter(sample => sample.profileId === profileId),
      optionsByProfile[profileId],
    ));
}

function aggregateFixture(
  expected: WriterExpectedActionClass,
  samples: readonly PersistedWriterBenchmarkSample[],
  protocolAttribution: Readonly<Record<string, WriterProtocolFailureAttribution>>,
): WriterFixtureQualificationEvidence {
  const fixtureSamples = samples.filter(sample => sample.expectedActionClass === expected);
  const unavailable = fixtureSamples.filter(isUnavailableSample);
  const protocolInvalid = fixtureSamples.filter(sample => sample.verdict === 'INVALID_PROTOCOL');
  const modelProtocolInvalid = protocolInvalid.filter(
    sample => protocolAttribution[sample.benchmarkSampleId] === 'MODEL',
  );
  const unresolvedProtocol = protocolInvalid.filter(sample => {
    const attribution = protocolAttribution[sample.benchmarkSampleId] ?? 'UNRESOLVED';
    return attribution === 'UNRESOLVED';
  });
  const truncated = fixtureSamples.filter(sample => sample.verdict === 'OUTPUT_TRUNCATED_NO_ACTION');
  const capability = fixtureSamples.filter(sample => (
    !isUnavailableSample(sample)
    && (
      sample.verdict !== 'INVALID_PROTOCOL'
      || protocolAttribution[sample.benchmarkSampleId] === 'MODEL'
    )
  ));
  const gateSamples = capability.slice(-WRITER_QUALIFICATION_MIN_SAMPLES_PER_FIXTURE);
  const passes = gateSamples.filter(isPassingSample);
  const strictPasses = gateSamples.filter(sample => sample.verdict === 'PASS_STRICT');
  const redundantPasses = gateSamples.filter(sample => sample.verdict === 'PASS_WITH_REDUNDANCY');
  const minimumEvidenceMet = capability.length >= WRITER_QUALIFICATION_MIN_SAMPLES_PER_FIXTURE;
  const gatePassed = minimumEvidenceMet && (
    passes.length === WRITER_QUALIFICATION_MIN_SAMPLES_PER_FIXTURE
    || (passes.length >= 2 && strictPasses.length >= 1)
  );
  const observedActions = new Set(fixtureSamples.flatMap(sample => sample.actionClasses));

  return {
    expectedActionClass: expected,
    sampleIds: fixtureSamples.map(sample => sample.benchmarkSampleId),
    capabilitySampleIds: capability.map(sample => sample.benchmarkSampleId),
    gateSampleIds: gateSamples.map(sample => sample.benchmarkSampleId),
    passSampleIds: passes.map(sample => sample.benchmarkSampleId),
    strictPassSampleIds: strictPasses.map(sample => sample.benchmarkSampleId),
    redundantPassSampleIds: redundantPasses.map(sample => sample.benchmarkSampleId),
    negativeSampleIds: gateSamples.filter(sample => !isPassingSample(sample))
      .map(sample => sample.benchmarkSampleId),
    unavailableSampleIds: unavailable.map(sample => sample.benchmarkSampleId),
    protocolInvalidSampleIds: protocolInvalid.map(sample => sample.benchmarkSampleId),
    modelAttributableProtocolInvalidSampleIds: modelProtocolInvalid.map(
      sample => sample.benchmarkSampleId,
    ),
    unresolvedProtocolSampleIds: unresolvedProtocol.map(sample => sample.benchmarkSampleId),
    truncatedSampleIds: truncated.map(sample => sample.benchmarkSampleId),
    observedActionClasses: ACTION_ORDER.filter(action => observedActions.has(action)),
    verdictCounts: countVerdicts(fixtureSamples),
    minimumEvidenceMet,
    gateStatus: !minimumEvidenceMet
      ? 'INSUFFICIENT_EVIDENCE'
      : gatePassed ? 'PASS' : 'FAIL',
    expectedBehaviorObserved: fixtureSamples.some(isPassingSample),
    redundancyObserved: fixtureSamples.some(sample => sample.verdict === 'PASS_WITH_REDUNDANCY'),
    wrongActionObserved: fixtureSamples.some(sample => sample.verdict === 'FAIL_WRONG_ACTION'),
    prematureWriteObserved: expected !== 'WRITE' && fixtureSamples.some(sample => (
      sample.verdict === 'FAIL_PREMATURE_WRITE'
      && sample.protocolValid === true
      && !isUnavailableSample(sample)
    )),
    noProgressObserved: fixtureSamples.some(sample => (
      sample.verdict === 'FAIL_NO_PROGRESS' || sample.verdict === 'NO_ACTION_RETURNED'
    )),
  };
}

function aggregateOperationalReliability(
  samples: readonly PersistedWriterBenchmarkSample[],
  protocolAttribution: Readonly<Record<string, WriterProtocolFailureAttribution>>,
): WriterOperationalReliabilityEvidence {
  const unavailable = samples.filter(isUnavailableSample);
  const availableResponses = samples.length - unavailable.length;
  const categories: string[] = unavailable.map(sample => (
    [sample.providerErrorCategory, sample.providerErrorCode].filter(Boolean).join(':')
    || 'BENCHMARK_UNAVAILABLE'
  ));
  for (const sample of samples.filter(item => item.verdict === 'INVALID_PROTOCOL')) {
    const attribution = protocolAttribution[sample.benchmarkSampleId] ?? 'UNRESOLVED';
    if (attribution !== 'MODEL') categories.push(`PROTOCOL_${attribution}`);
  }

  return {
    status: samples.length === 0 || availableResponses === 0
      ? 'INSUFFICIENT'
      : unavailable.length > 0 || categories.length > 0 ? 'WARNING' : 'SUFFICIENT',
    attempts: samples.length,
    availableResponses,
    unavailableResponses: unavailable.length,
    failureCategories: countStrings(categories),
  };
}

interface PersistedIdentityResolution {
  identity: WriterQualificationIdentity;
  mixed: boolean;
  invalid: boolean;
}

function resolvePersistedIdentity(
  profileId: string,
  samples: readonly PersistedWriterBenchmarkSample[],
): PersistedIdentityResolution {
  const v3Samples = samples.filter(isV3Sample);
  if (v3Samples.length === 0) {
    return {
      identity: normalizeIdentity(inferIncompleteIdentity(profileId, samples)),
      mixed: false,
      invalid: false,
    };
  }

  const fingerprints = new Set(
    v3Samples.map(sample => sample.qualificationIdentity.qualificationIdentityFingerprint),
  );
  const invalid = v3Samples.some(sample => (
    !validateWriterQualificationIdentitySnapshot(sample.qualificationIdentity)
    || sample.qualificationIdentity.profileId !== sample.profileId
    || !sample.qualificationIdentity.fixtureSet.some(fixture => (
      fixture.expectedActionClass === sample.expectedActionClass
      && fixture.fixtureId === sample.fixtureId
      && fixture.fixtureVersion === sample.fixtureVersion
    ))
  ));
  const legacyMixed = v3Samples.length !== samples.length;
  const snapshot = v3Samples[0].qualificationIdentity;
  const normalized = normalizeIdentity({
    benchmarkContractVersion: snapshot.benchmarkContractVersion,
    profileId: snapshot.profileId,
    modelIdentifier: snapshot.modelIdentifier,
    providerProfileConfigFingerprint: snapshot.providerProfileFingerprint,
    fixtureSet: snapshot.fixtureSet.map(fixture => ({ ...fixture })),
    toolSchemaAdapterContractFingerprint: snapshot.toolSchemaAdapterContractFingerprint,
    writerSystemContractFingerprint: snapshot.writerSystemContractFingerprint,
    inferenceSettingsFingerprint: snapshot.inferenceSettingsFingerprint,
    qualificationPolicyVersion: snapshot.qualificationPolicyVersion,
  });
  const snapshotMismatch = normalized.fingerprint
    !== snapshot.qualificationIdentityFingerprint;
  const incompleteSnapshot = invalid || snapshotMismatch || legacyMixed;
  const identity = !incompleteSnapshot
    ? normalized
    : {
        ...normalized,
        complete: false,
        incompleteFields: uniqueSorted([
          ...normalized.incompleteFields,
          'qualificationIdentitySnapshot',
        ]),
        fingerprint: null,
      };

  return {
    identity,
    mixed: legacyMixed || fingerprints.size > 1,
    invalid: invalid || snapshotMismatch,
  };
}

function isV3Sample(
  sample: PersistedWriterBenchmarkSample,
): sample is PersistedWriterBenchmarkSampleV3 {
  return sample.schemaVersion === WRITER_BENCHMARK_SAMPLE_SCHEMA_VERSION;
}

function normalizeIdentity(input: WriterQualificationIdentityInput): WriterQualificationIdentity {
  const fixtureSet = uniqueFixtureIdentities(input.fixtureSet);
  const incompleteFields: string[] = [];
  if (!nonEmpty(input.benchmarkContractVersion)) incompleteFields.push('benchmarkContractVersion');
  if (!input.profileId.trim()) incompleteFields.push('profileId');
  if (!nonEmpty(input.modelIdentifier)) incompleteFields.push('modelIdentifier');
  if (!nonEmpty(input.providerProfileConfigFingerprint)) {
    incompleteFields.push('providerProfileConfigFingerprint');
  }
  if (!hasCompleteFixtureSet(fixtureSet)) incompleteFields.push('fixtureSet');
  if (!nonEmpty(input.toolSchemaAdapterContractFingerprint)) {
    incompleteFields.push('toolSchemaAdapterContractFingerprint');
  }
  if (!nonEmpty(input.writerSystemContractFingerprint)) {
    incompleteFields.push('writerSystemContractFingerprint');
  }
  if (!nonEmpty(input.inferenceSettingsFingerprint)) {
    incompleteFields.push('inferenceSettingsFingerprint');
  }
  if (input.qualificationPolicyVersion !== WRITER_QUALIFICATION_POLICY_VERSION) {
    incompleteFields.push('qualificationPolicyVersion');
  }

  const normalizedInput: WriterQualificationIdentityInput = {
    ...input,
    fixtureSet,
  };
  const complete = incompleteFields.length === 0;
  return {
    ...normalizedInput,
    complete,
    incompleteFields,
    fingerprint: complete ? fingerprintIdentity(normalizedInput) : null,
  };
}

function inferIncompleteIdentity(
  profileId: string,
  samples: readonly PersistedWriterBenchmarkSample[],
): WriterQualificationIdentityInput {
  return {
    benchmarkContractVersion: null,
    profileId,
    modelIdentifier: null,
    providerProfileConfigFingerprint: null,
    fixtureSet: uniqueFixtureIdentities(samples.map(sample => ({
      expectedActionClass: sample.expectedActionClass,
      fixtureId: sample.fixtureId,
      fixtureVersion: sample.fixtureVersion,
    }))),
    toolSchemaAdapterContractFingerprint: null,
    writerSystemContractFingerprint: null,
    inferenceSettingsFingerprint: null,
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
  };
}

function fingerprintIdentity(identity: WriterQualificationIdentityInput): string {
  return computeWriterQualificationIdentityFingerprint({
    benchmarkContractVersion: identity.benchmarkContractVersion!,
    profileId: identity.profileId,
    modelIdentifier: identity.modelIdentifier!,
    providerProfileFingerprint: identity.providerProfileConfigFingerprint!,
    fixtureSet: uniqueFixtureIdentities(identity.fixtureSet),
    toolSchemaAdapterContractFingerprint: identity.toolSchemaAdapterContractFingerprint!,
    writerSystemContractFingerprint: identity.writerSystemContractFingerprint!,
    inferenceSettingsFingerprint: identity.inferenceSettingsFingerprint!,
    qualificationPolicyVersion: identity.qualificationPolicyVersion,
  });
}

function hasCompleteFixtureSet(fixtures: readonly WriterQualificationFixtureIdentity[]): boolean {
  return fixtures.length === EXPECTED_ACTIONS.length
    && EXPECTED_ACTIONS.every(expected => (
      fixtures.filter(item => item.expectedActionClass === expected).length === 1
    ));
}

function uniqueFixtureIdentities(
  fixtures: readonly WriterQualificationFixtureIdentity[],
): WriterQualificationFixtureIdentity[] {
  const unique = new Map<string, WriterQualificationFixtureIdentity>();
  for (const fixture of fixtures) {
    const key = `${fixture.expectedActionClass}\u0000${fixture.fixtureId}\u0000${fixture.fixtureVersion}`;
    unique.set(key, { ...fixture });
  }
  return [...unique.values()].sort((left, right) => (
    left.expectedActionClass.localeCompare(right.expectedActionClass)
    || left.fixtureId.localeCompare(right.fixtureId)
    || left.fixtureVersion.localeCompare(right.fixtureVersion)
  ));
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

function countStrings(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function isPassingSample(sample: PersistedWriterBenchmarkSample): boolean {
  return sample.verdict === 'PASS_STRICT' || sample.verdict === 'PASS_WITH_REDUNDANCY';
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

function nonEmpty(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
