import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { WriterExpectedActionClass } from './__fixtures__/writerDecisionFixture';
import { redactForDisk } from './redact';
import { _atomicRenameWithRetry } from './store';
import {
  WRITER_BENCHMARK_SAMPLE_SCHEMA_VERSION,
  type PersistedWriterBenchmarkSample,
  type PersistedWriterBenchmarkSampleV3,
} from './writerModelProfileBenchmarkStore';
import {
  evaluateWriterProfileQualification,
  WRITER_QUALIFICATION_MIN_SAMPLES_PER_FIXTURE,
  type WriterProfileQualificationResult,
  type WriterQualificationEvaluationOptions,
  type WriterQualificationReasonCode,
  type WriterQualificationStatus,
  type WriterOperationalReliabilityStatus,
  type WriterFixtureGateStatus,
} from './writerProfileQualification';
import {
  sha256Canonical,
  validateWriterQualificationIdentitySnapshot,
  WRITER_BENCHMARK_CONTRACT_VERSION,
} from './writerBenchmarkIdentity';
import { WRITER_QUALIFICATION_POLICY_VERSION } from './writerQualificationPolicyContract';

export const WRITER_QUALIFICATION_BATCH_SCHEMA_VERSION =
  'writer-qualification-batch-v1' as const;
export const WRITER_QUALIFICATION_RESULT_SCHEMA_VERSION =
  'writer-qualification-result-v1' as const;

const EXPECTED_ACTIONS: readonly WriterExpectedActionClass[] = ['SEARCH', 'READ', 'WRITE'];
const SAFE_ID = /^[A-Za-z0-9._-]{1,256}$/;

export type WriterQualificationBatchStatus = 'COMPLETE' | 'ABORTED';
export type WriterQualificationFixtureCoverage = Record<WriterExpectedActionClass, number>;
export type WriterQualificationFormalSampleIds = Record<WriterExpectedActionClass, string[]>;

export interface WriterQualificationBatch {
  schemaVersion: typeof WRITER_QUALIFICATION_BATCH_SCHEMA_VERSION;
  batchId: string;
  qualificationIdentityFingerprint: string;
  qualificationPolicyVersion: typeof WRITER_QUALIFICATION_POLICY_VERSION;
  benchmarkContractVersion: typeof WRITER_BENCHMARK_CONTRACT_VERSION;
  profileId: string;
  startedAt: string;
  completedAt: string;
  status: WriterQualificationBatchStatus;
  formalSampleIds: WriterQualificationFormalSampleIds;
  expectedFixtureCoverage: WriterQualificationFixtureCoverage;
  actualFixtureCoverage: WriterQualificationFixtureCoverage;
}

export interface CreateWriterQualificationBatchInput {
  batchId: string;
  qualificationIdentityFingerprint: string;
  qualificationPolicyVersion: typeof WRITER_QUALIFICATION_POLICY_VERSION;
  benchmarkContractVersion: typeof WRITER_BENCHMARK_CONTRACT_VERSION;
  profileId: string;
  startedAt: string;
  completedAt: string;
  status: WriterQualificationBatchStatus;
  formalSampleIds: WriterQualificationFormalSampleIds;
  expectedFixtureCoverage?: WriterQualificationFixtureCoverage;
}

export interface WriterQualificationFixtureResultArtifact {
  expectedActionClass: WriterExpectedActionClass;
  formalSampleIds: string[];
  capabilitySampleIds: string[];
  strictPassSampleIds: string[];
  redundantPassSampleIds: string[];
  negativeSampleIds: string[];
  unavailableSampleIds: string[];
  gateStatus: WriterFixtureGateStatus;
}

export interface WriterQualificationSafetyResultArtifact {
  prematureWriteSampleIds: string[];
  safetyVeto: boolean;
}

export interface WriterQualificationFormalOperationalSummary {
  status: WriterOperationalReliabilityStatus;
  logicalInvocations: number;
  availableInvocations: number;
  unavailableInvocations: number;
  transportAttempts: number | null;
  transportRetries: number | null;
  retryRecoveries: number | null;
  failureCategories: Record<string, number>;
  totalCostRmb: number | null;
}

export interface WriterQualificationResultArtifact {
  schemaVersion: typeof WRITER_QUALIFICATION_RESULT_SCHEMA_VERSION;
  resultId: string;
  batchId: string;
  profileId: string;
  qualificationIdentityFingerprint: string;
  qualificationPolicyVersion: typeof WRITER_QUALIFICATION_POLICY_VERSION;
  benchmarkContractVersion: typeof WRITER_BENCHMARK_CONTRACT_VERSION;
  status: WriterQualificationStatus;
  reasonCodes: WriterQualificationReasonCode[];
  fixtureResults: Record<WriterExpectedActionClass, WriterQualificationFixtureResultArtifact>;
  safetyResult: WriterQualificationSafetyResultArtifact;
  formalOperationalSummary: WriterQualificationFormalOperationalSummary;
  evaluatedAt: string;
}

export interface CreateWriterQualificationResultOptions
  extends WriterQualificationEvaluationOptions {
  evaluatedAt?: string;
}

export class WriterQualificationArtifactError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WriterQualificationArtifactError';
  }
}

/**
 * Builds one explicit qualification attempt. The caller chooses membership by
 * sample ID; current directory ordering and future samples are irrelevant.
 */
export function createWriterQualificationBatch(
  input: CreateWriterQualificationBatchInput,
  samplePool: readonly PersistedWriterBenchmarkSample[],
  options: WriterQualificationEvaluationOptions = {},
): WriterQualificationBatch {
  const base: WriterQualificationBatch = {
    schemaVersion: WRITER_QUALIFICATION_BATCH_SCHEMA_VERSION,
    ...structuredClone(input),
    expectedFixtureCoverage: structuredClone(input.expectedFixtureCoverage
      ?? requiredFixtureCoverage()),
    actualFixtureCoverage: emptyFixtureCoverage(),
  };
  assertBatchMetadata(base, false);
  const selected = selectWriterQualificationBatchEvidence(base, samplePool, false);
  const evaluation = evaluateWriterProfileQualification(base.profileId, selected, options);
  const actualFixtureCoverage = coverageFromEvaluation(evaluation);
  const batch: WriterQualificationBatch = { ...base, actualFixtureCoverage };
  assertBatchMetadata(batch, true);
  if (batch.status === 'COMPLETE') assertCompleteCoverage(batch);
  return structuredClone(batch);
}

/** Selects only IDs frozen in the artifact and validates every binding. */
export function selectWriterQualificationBatchEvidence(
  batch: WriterQualificationBatch,
  samplePool: readonly PersistedWriterBenchmarkSample[],
  validateDeclaredCoverage = true,
): PersistedWriterBenchmarkSampleV3[] {
  assertBatchMetadata(batch, validateDeclaredCoverage);
  const byId = new Map<string, PersistedWriterBenchmarkSample>();
  for (const sample of samplePool) {
    if (byId.has(sample.benchmarkSampleId)) {
      throw artifactError('SAMPLE_POOL_DUPLICATE_ID');
    }
    byId.set(sample.benchmarkSampleId, sample);
  }

  const selected: PersistedWriterBenchmarkSampleV3[] = [];
  for (const expected of EXPECTED_ACTIONS) {
    for (const sampleId of batch.formalSampleIds[expected]) {
      const sample = byId.get(sampleId);
      if (!sample) throw artifactError('FORMAL_SAMPLE_NOT_FOUND');
      assertSampleBinding(batch, expected, sample);
      selected.push(structuredClone(sample));
    }
  }
  return selected;
}

/** Re-evaluates only explicit batch membership with the unchanged Policy v1 evaluator. */
export function evaluateWriterQualificationBatch(
  batch: WriterQualificationBatch,
  samplePool: readonly PersistedWriterBenchmarkSample[],
  options: WriterQualificationEvaluationOptions = {},
): WriterProfileQualificationResult {
  if (batch.status !== 'COMPLETE') throw artifactError('BATCH_NOT_COMPLETE');
  const selected = selectWriterQualificationBatchEvidence(batch, samplePool);
  const result = evaluateWriterProfileQualification(batch.profileId, selected, options);
  assertEvaluationMatchesBatch(batch, result);
  assertCompleteCoverage(batch);
  return structuredClone(result);
}

export function createWriterQualificationResultArtifact(
  batch: WriterQualificationBatch,
  samplePool: readonly PersistedWriterBenchmarkSample[],
  options: CreateWriterQualificationResultOptions = {},
): WriterQualificationResultArtifact {
  const evaluation = evaluateWriterQualificationBatch(batch, samplePool, options);
  const selected = selectWriterQualificationBatchEvidence(batch, samplePool);
  const evaluatedAt = options.evaluatedAt ?? batch.completedAt;
  assertIsoTimestamp(evaluatedAt, 'EVALUATED_AT_INVALID');
  const fixtureResults = Object.fromEntries(EXPECTED_ACTIONS.map(expected => {
    const fixture = evaluation.capability.fixtureCoverage[expected];
    return [expected, {
      expectedActionClass: expected,
      formalSampleIds: [...batch.formalSampleIds[expected]],
      capabilitySampleIds: [...fixture.capabilitySampleIds],
      strictPassSampleIds: [...fixture.strictPassSampleIds],
      redundantPassSampleIds: [...fixture.redundantPassSampleIds],
      negativeSampleIds: [...fixture.negativeSampleIds],
      unavailableSampleIds: [...fixture.unavailableSampleIds],
      gateStatus: fixture.gateStatus,
    }];
  })) as WriterQualificationResultArtifact['fixtureResults'];
  const prematureWriteSampleIds = selected
    .filter(sample => sample.verdict === 'FAIL_PREMATURE_WRITE')
    .map(sample => sample.benchmarkSampleId)
    .sort();

  return {
    schemaVersion: WRITER_QUALIFICATION_RESULT_SCHEMA_VERSION,
    resultId: deterministicResultId(batch),
    batchId: batch.batchId,
    profileId: batch.profileId,
    qualificationIdentityFingerprint: batch.qualificationIdentityFingerprint,
    qualificationPolicyVersion: batch.qualificationPolicyVersion,
    benchmarkContractVersion: batch.benchmarkContractVersion,
    status: evaluation.status,
    reasonCodes: [...evaluation.reasonCodes],
    fixtureResults,
    safetyResult: {
      prematureWriteSampleIds,
      safetyVeto: evaluation.reasonCodes.includes('PREMATURE_WRITE_SAFETY_VETO'),
    },
    formalOperationalSummary: buildFormalOperationalSummary(selected, evaluation),
    evaluatedAt,
  };
}

export function saveWriterQualificationBatch(
  cwd: string,
  batch: WriterQualificationBatch,
  samplePool: readonly PersistedWriterBenchmarkSample[],
  options: WriterQualificationEvaluationOptions = {},
): string {
  assertBatchMetadata(batch, true);
  const selected = selectWriterQualificationBatchEvidence(batch, samplePool);
  const evaluation = evaluateWriterProfileQualification(batch.profileId, selected, options);
  assertEvaluationMatchesBatch(batch, evaluation);
  return saveImmutableArtifact(cwd, batch.profileId, batch.batchId, 'batch.json', batch);
}

export function saveWriterQualificationResultArtifact(
  cwd: string,
  result: WriterQualificationResultArtifact,
  samplePool: readonly PersistedWriterBenchmarkSample[],
  options: WriterQualificationEvaluationOptions = {},
): string {
  assertResultArtifact(result);
  const batch = loadWriterQualificationBatch(cwd, result.profileId, result.batchId);
  assertResultMatchesBatch(result, batch);
  const expected = createWriterQualificationResultArtifact(batch, samplePool, {
    ...options,
    evaluatedAt: result.evaluatedAt,
  });
  if (sha256Canonical(result) !== sha256Canonical(expected)) {
    throw artifactError('RESULT_CONTENT_MISMATCH');
  }
  return saveImmutableArtifact(cwd, result.profileId, result.batchId, 'result.json', result);
}

export function loadWriterQualificationBatch(
  cwd: string,
  profileId: string,
  batchId: string,
): WriterQualificationBatch {
  const parsed = loadArtifact(cwd, profileId, batchId, 'batch.json') as WriterQualificationBatch;
  assertBatchMetadata(parsed, true);
  return parsed;
}

export function loadWriterQualificationResultArtifact(
  cwd: string,
  profileId: string,
  batchId: string,
): WriterQualificationResultArtifact {
  const parsed = loadArtifact(cwd, profileId, batchId, 'result.json') as WriterQualificationResultArtifact;
  assertResultArtifact(parsed);
  return parsed;
}

/** Loads immutable benchmark evidence without changing v1/v2/v3 sample files. */
export function loadWriterQualificationSamplePool(
  cwd: string,
): PersistedWriterBenchmarkSample[] {
  const root = path.join(cwd, '.cc-auto', 'benchmarks', 'writer-model-profile');
  if (!existsSync(root)) return [];
  const samples: PersistedWriterBenchmarkSample[] = [];
  walkJsonFiles(root, file => {
    samples.push(JSON.parse(readFileSync(file, 'utf8')) as PersistedWriterBenchmarkSample);
  });
  return samples;
}

function assertBatchMetadata(
  batch: WriterQualificationBatch,
  validateDeclaredCoverage: boolean,
): void {
  if (batch.schemaVersion !== WRITER_QUALIFICATION_BATCH_SCHEMA_VERSION) {
    throw artifactError('BATCH_SCHEMA_VERSION_INVALID');
  }
  assertSafeId(batch.batchId, 'BATCH_ID_INVALID');
  assertSafeId(batch.profileId, 'PROFILE_ID_INVALID');
  if (!/^[a-f0-9]{64}$/.test(batch.qualificationIdentityFingerprint)) {
    throw artifactError('IDENTITY_FINGERPRINT_INVALID');
  }
  if (batch.qualificationPolicyVersion !== WRITER_QUALIFICATION_POLICY_VERSION) {
    throw artifactError('POLICY_VERSION_MISMATCH');
  }
  if (batch.benchmarkContractVersion !== WRITER_BENCHMARK_CONTRACT_VERSION) {
    throw artifactError('BENCHMARK_CONTRACT_VERSION_MISMATCH');
  }
  if (batch.status !== 'COMPLETE' && batch.status !== 'ABORTED') {
    throw artifactError('BATCH_STATUS_INVALID');
  }
  assertIsoTimestamp(batch.startedAt, 'STARTED_AT_INVALID');
  assertIsoTimestamp(batch.completedAt, 'COMPLETED_AT_INVALID');
  if (batch.completedAt.localeCompare(batch.startedAt) < 0) {
    throw artifactError('BATCH_TIME_RANGE_INVALID');
  }
  assertCoverageShape(batch.expectedFixtureCoverage, 'EXPECTED_FIXTURE_COVERAGE_INVALID');
  if (EXPECTED_ACTIONS.some(expected => (
    batch.expectedFixtureCoverage[expected] !== WRITER_QUALIFICATION_MIN_SAMPLES_PER_FIXTURE
  ))) throw artifactError('EXPECTED_FIXTURE_COVERAGE_POLICY_MISMATCH');
  assertCoverageShape(batch.actualFixtureCoverage, 'ACTUAL_FIXTURE_COVERAGE_INVALID');
  assertFormalSampleIds(batch.formalSampleIds);
  if (validateDeclaredCoverage && batch.status === 'COMPLETE') assertCompleteCoverage(batch);
}

function assertFormalSampleIds(formalSampleIds: WriterQualificationFormalSampleIds): void {
  if (!formalSampleIds || typeof formalSampleIds !== 'object') {
    throw artifactError('FORMAL_SAMPLE_IDS_INVALID');
  }
  if (!hasOnlyExpectedActionKeys(formalSampleIds)) {
    throw artifactError('FORMAL_SAMPLE_IDS_INVALID');
  }
  const seen = new Set<string>();
  for (const expected of EXPECTED_ACTIONS) {
    const ids = formalSampleIds[expected];
    if (!Array.isArray(ids)) throw artifactError('FORMAL_SAMPLE_IDS_INVALID');
    for (const id of ids) {
      assertSafeId(id, 'FORMAL_SAMPLE_ID_INVALID');
      if (seen.has(id)) throw artifactError('FORMAL_SAMPLE_ID_DUPLICATE');
      seen.add(id);
    }
  }
}

function assertSampleBinding(
  batch: WriterQualificationBatch,
  expected: WriterExpectedActionClass,
  sample: PersistedWriterBenchmarkSample,
): asserts sample is PersistedWriterBenchmarkSampleV3 {
  if (sample.schemaVersion !== WRITER_BENCHMARK_SAMPLE_SCHEMA_VERSION) {
    throw artifactError('FORMAL_SAMPLE_SCHEMA_NOT_V3');
  }
  if (!validateWriterQualificationIdentitySnapshot(sample.qualificationIdentity)) {
    throw artifactError('FORMAL_SAMPLE_IDENTITY_INVALID');
  }
  if (sample.profileId !== batch.profileId
    || sample.qualificationIdentity.profileId !== batch.profileId) {
    throw artifactError('FORMAL_SAMPLE_PROFILE_MISMATCH');
  }
  if (sample.qualificationIdentity.qualificationIdentityFingerprint
    !== batch.qualificationIdentityFingerprint) {
    throw artifactError('FORMAL_SAMPLE_IDENTITY_MISMATCH');
  }
  if (sample.qualificationIdentity.qualificationPolicyVersion
    !== batch.qualificationPolicyVersion) {
    throw artifactError('FORMAL_SAMPLE_POLICY_MISMATCH');
  }
  if (sample.qualificationIdentity.benchmarkContractVersion
    !== batch.benchmarkContractVersion) {
    throw artifactError('FORMAL_SAMPLE_BENCHMARK_CONTRACT_MISMATCH');
  }
  if (sample.expectedActionClass !== expected) {
    throw artifactError('FORMAL_SAMPLE_FIXTURE_MEMBERSHIP_MISMATCH');
  }
  if (!sample.qualificationIdentity.fixtureSet.some(fixture => (
    fixture.expectedActionClass === sample.expectedActionClass
    && fixture.fixtureId === sample.fixtureId
    && fixture.fixtureVersion === sample.fixtureVersion
  ))) throw artifactError('FORMAL_SAMPLE_FIXTURE_IDENTITY_MISMATCH');
}

function assertEvaluationMatchesBatch(
  batch: WriterQualificationBatch,
  result: WriterProfileQualificationResult,
): void {
  if (!result.qualificationIdentity.complete
    || result.qualificationIdentity.fingerprint !== batch.qualificationIdentityFingerprint) {
    throw artifactError('BATCH_EVALUATION_IDENTITY_MISMATCH');
  }
  const actual = coverageFromEvaluation(result);
  for (const expected of EXPECTED_ACTIONS) {
    if (actual[expected] !== batch.actualFixtureCoverage[expected]) {
      throw artifactError('BATCH_ACTUAL_COVERAGE_MISMATCH');
    }
  }
}

function assertCompleteCoverage(batch: WriterQualificationBatch): void {
  for (const expected of EXPECTED_ACTIONS) {
    if (batch.actualFixtureCoverage[expected] !== batch.expectedFixtureCoverage[expected]) {
      throw artifactError('COMPLETE_BATCH_FIXTURE_COVERAGE_INVALID');
    }
  }
}

function buildFormalOperationalSummary(
  samples: readonly PersistedWriterBenchmarkSampleV3[],
  evaluation: WriterProfileQualificationResult,
): WriterQualificationFormalOperationalSummary {
  const hasCompleteTransportAudit = samples.every(sample => (
    typeof sample.transportAttempts === 'number'
    && typeof sample.transportRetryCount === 'number'
    && Array.isArray(sample.transportRetryReasons)
  ));
  const allCostsKnown = samples.every(sample => sample.costRmb !== null);
  const isUnavailable = (sample: PersistedWriterBenchmarkSampleV3) => (
    sample.verdict === 'BENCHMARK_UNAVAILABLE'
    || sample.providerErrorCategory !== null
    || sample.providerErrorCode !== null
  );
  return {
    status: evaluation.operationalReliability.status,
    logicalInvocations: samples.length,
    availableInvocations: evaluation.operationalReliability.availableResponses,
    unavailableInvocations: evaluation.operationalReliability.unavailableResponses,
    transportAttempts: hasCompleteTransportAudit
      ? samples.reduce((total, sample) => total + (sample.transportAttempts ?? 0), 0)
      : null,
    transportRetries: hasCompleteTransportAudit
      ? samples.reduce((total, sample) => total + (sample.transportRetryCount ?? 0), 0)
      : null,
    retryRecoveries: hasCompleteTransportAudit
      ? samples.filter(sample => (sample.transportRetryCount ?? 0) > 0 && !isUnavailable(sample)).length
      : null,
    failureCategories: { ...evaluation.operationalReliability.failureCategories },
    totalCostRmb: allCostsKnown
      ? samples.reduce((total, sample) => total + (sample.costRmb ?? 0), 0)
      : null,
  };
}

function assertResultArtifact(result: WriterQualificationResultArtifact): void {
  if (result.schemaVersion !== WRITER_QUALIFICATION_RESULT_SCHEMA_VERSION) {
    throw artifactError('RESULT_SCHEMA_VERSION_INVALID');
  }
  assertSafeId(result.resultId, 'RESULT_ID_INVALID');
  assertSafeId(result.batchId, 'BATCH_ID_INVALID');
  assertSafeId(result.profileId, 'PROFILE_ID_INVALID');
  if (!/^[a-f0-9]{64}$/.test(result.qualificationIdentityFingerprint)) {
    throw artifactError('IDENTITY_FINGERPRINT_INVALID');
  }
  if (result.qualificationPolicyVersion !== WRITER_QUALIFICATION_POLICY_VERSION) {
    throw artifactError('POLICY_VERSION_MISMATCH');
  }
  if (result.benchmarkContractVersion !== WRITER_BENCHMARK_CONTRACT_VERSION) {
    throw artifactError('BENCHMARK_CONTRACT_VERSION_MISMATCH');
  }
  if (!['QUALIFIED', 'NOT_QUALIFIED', 'INSUFFICIENT_EVIDENCE'].includes(result.status)) {
    throw artifactError('RESULT_STATUS_INVALID');
  }
  if (!Array.isArray(result.reasonCodes)) throw artifactError('RESULT_REASON_CODES_INVALID');
  assertIsoTimestamp(result.evaluatedAt, 'EVALUATED_AT_INVALID');
  if (!result.fixtureResults || !hasOnlyExpectedActionKeys(result.fixtureResults)) {
    throw artifactError('RESULT_FIXTURE_INVALID');
  }
  for (const expected of EXPECTED_ACTIONS) {
    const fixture = result.fixtureResults?.[expected];
    if (!fixture || fixture.expectedActionClass !== expected) {
      throw artifactError('RESULT_FIXTURE_INVALID');
    }
  }
}

function assertResultMatchesBatch(
  result: WriterQualificationResultArtifact,
  batch: WriterQualificationBatch,
): void {
  if (result.resultId !== deterministicResultId(batch)
    || result.batchId !== batch.batchId
    || result.profileId !== batch.profileId
    || result.qualificationIdentityFingerprint !== batch.qualificationIdentityFingerprint
    || result.qualificationPolicyVersion !== batch.qualificationPolicyVersion
    || result.benchmarkContractVersion !== batch.benchmarkContractVersion) {
    throw artifactError('RESULT_BATCH_BINDING_MISMATCH');
  }
}

function coverageFromEvaluation(
  result: WriterProfileQualificationResult,
): WriterQualificationFixtureCoverage {
  return Object.fromEntries(EXPECTED_ACTIONS.map(expected => [
    expected,
    result.capability.fixtureCoverage[expected].capabilitySampleIds.length,
  ])) as WriterQualificationFixtureCoverage;
}

function requiredFixtureCoverage(): WriterQualificationFixtureCoverage {
  return Object.fromEntries(EXPECTED_ACTIONS.map(expected => [
    expected,
    WRITER_QUALIFICATION_MIN_SAMPLES_PER_FIXTURE,
  ])) as WriterQualificationFixtureCoverage;
}

function emptyFixtureCoverage(): WriterQualificationFixtureCoverage {
  return { SEARCH: 0, READ: 0, WRITE: 0 };
}

function deterministicResultId(batch: WriterQualificationBatch): string {
  const suffix = sha256Canonical({
    batchId: batch.batchId,
    qualificationIdentityFingerprint: batch.qualificationIdentityFingerprint,
    qualificationPolicyVersion: batch.qualificationPolicyVersion,
  }).slice(0, 24);
  return `writer-qualification-result-${suffix}`;
}

function saveImmutableArtifact(
  cwd: string,
  profileId: string,
  batchId: string,
  fileName: 'batch.json' | 'result.json',
  value: unknown,
): string {
  assertSafeId(profileId, 'PROFILE_ID_INVALID');
  assertSafeId(batchId, 'BATCH_ID_INVALID');
  const directory = qualificationDirectory(cwd, profileId, batchId);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, fileName);
  if (existsSync(target)) throw artifactError('IMMUTABLE_ARTIFACT_ALREADY_EXISTS');
  const temporary = path.join(directory, `${fileName}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, redactForDisk(JSON.stringify(value, null, 2)), {
    encoding: 'utf8',
    flag: 'wx',
  });
  _atomicRenameWithRetry(temporary, target);
  return target;
}

function loadArtifact(
  cwd: string,
  profileId: string,
  batchId: string,
  fileName: 'batch.json' | 'result.json',
): unknown {
  assertSafeId(profileId, 'PROFILE_ID_INVALID');
  assertSafeId(batchId, 'BATCH_ID_INVALID');
  return JSON.parse(readFileSync(
    path.join(qualificationDirectory(cwd, profileId, batchId), fileName),
    'utf8',
  ));
}

function qualificationDirectory(cwd: string, profileId: string, batchId: string): string {
  return path.join(cwd, '.cc-auto', 'qualification', 'writer', profileId, batchId);
}

function walkJsonFiles(directory: string, visit: (file: string) => void): void {
  for (const name of readdirSync(directory)) {
    const fullPath = path.join(directory, name);
    if (statSync(fullPath).isDirectory()) walkJsonFiles(fullPath, visit);
    else if (name.endsWith('.json')) visit(fullPath);
  }
}

function assertCoverageShape(
  coverage: WriterQualificationFixtureCoverage,
  code: string,
): void {
  if (!coverage || typeof coverage !== 'object' || !hasOnlyExpectedActionKeys(coverage)
    || EXPECTED_ACTIONS.some(expected => (
    !Number.isInteger(coverage[expected]) || coverage[expected] < 0
  ))) throw artifactError(code);
}

function hasOnlyExpectedActionKeys(value: object): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === EXPECTED_ACTIONS.length
    && keys.every((key, index) => key === [...EXPECTED_ACTIONS].sort()[index]);
}

function assertSafeId(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw artifactError(code);
}

function assertIsoTimestamp(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw artifactError(code);
}

function artifactError(code: string): WriterQualificationArtifactError {
  return new WriterQualificationArtifactError(code);
}
