import { createHash } from 'node:crypto';
import type {
  ProviderAdapterQualificationContract,
  ProviderProfile,
  ProviderToolDefinition,
  ProviderToolMode,
} from './types';
import type {
  WriterDecisionFixture,
  WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';

export const WRITER_BENCHMARK_CONTRACT_VERSION =
  'writer-model-profile-benchmark-v3' as const;
export const WRITER_QUALIFICATION_IDENTITY_SCHEMA_VERSION =
  'writer-qualification-identity-snapshot-v1' as const;

export interface WriterQualificationFixtureSnapshot {
  expectedActionClass: WriterExpectedActionClass;
  fixtureId: string;
  fixtureVersion: string;
}

export interface WriterQualificationFingerprintInput {
  benchmarkContractVersion: string;
  profileId: string;
  modelIdentifier: string;
  fixtureSet: WriterQualificationFixtureSnapshot[];
  providerProfileFingerprint: string;
  toolSchemaAdapterContractFingerprint: string;
  writerSystemContractFingerprint: string;
  inferenceSettingsFingerprint: string;
  qualificationPolicyVersion: string;
}

/**
 * Immutable capability identity captured before a benchmark Provider call.
 * Per-sample facts such as benchmarkSampleId and the observed fixture stay on
 * the sample itself so all fixtures in one qualification batch share this
 * fingerprint.
 */
export interface WriterQualificationIdentitySnapshot
  extends WriterQualificationFingerprintInput {
  identitySchemaVersion: typeof WRITER_QUALIFICATION_IDENTITY_SCHEMA_VERSION;
  qualificationIdentityFingerprint: string;
}

export interface BuildWriterQualificationIdentitySnapshotInput {
  profile: ProviderProfile;
  logicalModelName: string;
  qualificationFixtures: readonly WriterDecisionFixture[];
  adapterContract: ProviderAdapterQualificationContract;
  tools: readonly ProviderToolDefinition[];
  toolMode: ProviderToolMode;
  writerSystemContract: string;
  maxOutputTokens: number;
  qualificationPolicyVersion: string;
  benchmarkContractVersion?: string;
}

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Deterministic JSON serialization used by every Writer benchmark fingerprint.
 * Object keys are sorted, array order is preserved, object undefined values
 * are omitted, array undefined values become null, and null stays explicit.
 */
export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value, true));
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalSerialize(value), 'utf8').digest('hex');
}

export function buildWriterQualificationIdentitySnapshot(
  input: BuildWriterQualificationIdentitySnapshotInput,
): WriterQualificationIdentitySnapshot {
  const model = input.profile.models.find(item => item.logicalName === input.logicalModelName);
  if (!model) {
    throw new Error(`MODEL_IDENTIFIER_NOT_FOUND:${input.logicalModelName}`);
  }
  assertAdapterContract(input.adapterContract);
  if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    throw new Error('INVALID_MAX_OUTPUT_TOKENS');
  }
  if (![input.profile.id, model.requestedModelId, input.writerSystemContract,
    input.qualificationPolicyVersion, input.benchmarkContractVersion
      ?? WRITER_BENCHMARK_CONTRACT_VERSION].every(nonEmpty)) {
    throw new Error('QUALIFICATION_IDENTITY_INPUT_INCOMPLETE');
  }
  if (input.tools.length === 0) throw new Error('TOOL_CONTRACT_EMPTY');

  const fixtureSet = normalizeFixtureSet(input.qualificationFixtures.map(fixture => ({
    expectedActionClass: fixture.expectedNextActionClass,
    fixtureId: fixture.id,
    fixtureVersion: fixture.version,
  })));
  if (!hasCompleteFixtureSet(fixtureSet)) {
    throw new Error('QUALIFICATION_FIXTURE_SET_INCOMPLETE');
  }
  const providerProfileFingerprint = fingerprintProviderProfileForQualification(
    input.profile,
    input.logicalModelName,
  );
  const toolSchemaAdapterContractFingerprint = sha256Canonical({
    adapter: {
      adapterId: input.adapterContract.adapterId,
      adapterContractVersion: input.adapterContract.adapterContractVersion,
      toolCallTranslationVersion: input.adapterContract.toolCallTranslationVersion,
    },
    toolMode: input.toolMode,
    tools: input.tools.map(tool => ({
      type: tool.type,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    })),
  });
  const writerSystemContractFingerprint = sha256Canonical({
    writerSystemContract: input.writerSystemContract,
  });
  const inferenceSettingsFingerprint = sha256Canonical({
    maxOutputTokens: input.maxOutputTokens,
  });
  const fingerprintInput: WriterQualificationFingerprintInput = {
    benchmarkContractVersion: input.benchmarkContractVersion
      ?? WRITER_BENCHMARK_CONTRACT_VERSION,
    profileId: input.profile.id,
    modelIdentifier: model.requestedModelId,
    fixtureSet,
    providerProfileFingerprint,
    toolSchemaAdapterContractFingerprint,
    writerSystemContractFingerprint,
    inferenceSettingsFingerprint,
    qualificationPolicyVersion: input.qualificationPolicyVersion,
  };

  return {
    identitySchemaVersion: WRITER_QUALIFICATION_IDENTITY_SCHEMA_VERSION,
    ...fingerprintInput,
    qualificationIdentityFingerprint:
      computeWriterQualificationIdentityFingerprint(fingerprintInput),
  };
}

/** Selects only non-secret fields that affect the actual execution contract. */
export function fingerprintProviderProfileForQualification(
  profile: ProviderProfile,
  logicalModelName: string,
): string {
  const model = profile.models.find(item => item.logicalName === logicalModelName);
  if (!model) throw new Error(`MODEL_IDENTIFIER_NOT_FOUND:${logicalModelName}`);

  return sha256Canonical({
    transport: profile.transport,
    endpointSemantics: normalizeEndpointSemantics(profile.apiBaseUrl),
    credentialRequirement: {
      requiredEnvVarNames: uniqueSorted(profile.credentialEnvVars),
    },
    runtimeEnvironmentContract: {
      allowedEnvVarNames: uniqueSorted(profile.runtimeEnvAllowlist),
      declaredStaticEnvVarNames: uniqueSorted(Object.keys(profile.staticEnv ?? {})),
    },
    selectedModel: {
      requestedModelId: model.requestedModelId,
      acceptedReportedModelIds: uniqueSorted(model.acceptedReportedModelIds),
    },
  });
}

export function computeWriterQualificationIdentityFingerprint(
  input: WriterQualificationFingerprintInput,
): string {
  return sha256Canonical({
    benchmarkContractVersion: input.benchmarkContractVersion,
    profileId: input.profileId,
    modelIdentifier: input.modelIdentifier,
    fixtureSet: normalizeFixtureSet(input.fixtureSet),
    providerProfileFingerprint: input.providerProfileFingerprint,
    toolSchemaAdapterContractFingerprint: input.toolSchemaAdapterContractFingerprint,
    writerSystemContractFingerprint: input.writerSystemContractFingerprint,
    inferenceSettingsFingerprint: input.inferenceSettingsFingerprint,
    qualificationPolicyVersion: input.qualificationPolicyVersion,
  });
}

export function validateWriterQualificationIdentitySnapshot(
  snapshot: WriterQualificationIdentitySnapshot,
): boolean {
  if (snapshot.identitySchemaVersion !== WRITER_QUALIFICATION_IDENTITY_SCHEMA_VERSION) return false;
  if (![
    snapshot.benchmarkContractVersion,
    snapshot.profileId,
    snapshot.modelIdentifier,
    snapshot.providerProfileFingerprint,
    snapshot.toolSchemaAdapterContractFingerprint,
    snapshot.writerSystemContractFingerprint,
    snapshot.inferenceSettingsFingerprint,
    snapshot.qualificationPolicyVersion,
  ].every(nonEmpty)) return false;
  if (!isSha256(snapshot.providerProfileFingerprint)
    || !isSha256(snapshot.toolSchemaAdapterContractFingerprint)
    || !isSha256(snapshot.writerSystemContractFingerprint)
    || !isSha256(snapshot.inferenceSettingsFingerprint)
    || !isSha256(snapshot.qualificationIdentityFingerprint)
    || !hasCompleteFixtureSet(snapshot.fixtureSet)) return false;
  return snapshot.qualificationIdentityFingerprint
    === computeWriterQualificationIdentityFingerprint(snapshot);
}

export function normalizeFixtureSet(
  fixtures: readonly WriterQualificationFixtureSnapshot[],
): WriterQualificationFixtureSnapshot[] {
  const unique = new Map<string, WriterQualificationFixtureSnapshot>();
  for (const fixture of fixtures) {
    const normalized = {
      expectedActionClass: fixture.expectedActionClass,
      fixtureId: fixture.fixtureId,
      fixtureVersion: fixture.fixtureVersion,
    };
    const key = `${normalized.expectedActionClass}\u0000${normalized.fixtureId}\u0000${normalized.fixtureVersion}`;
    unique.set(key, normalized);
  }
  return [...unique.values()].sort((left, right) => (
    left.expectedActionClass.localeCompare(right.expectedActionClass)
    || left.fixtureId.localeCompare(right.fixtureId)
    || left.fixtureVersion.localeCompare(right.fixtureVersion)
  ));
}

function normalizeEndpointSemantics(apiBaseUrl: string | undefined): CanonicalValue {
  if (apiBaseUrl === undefined || apiBaseUrl.trim().length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new Error('INVALID_PROVIDER_ENDPOINT');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('UNSAFE_PROVIDER_ENDPOINT');
  }
  return {
    protocol: parsed.protocol.toLowerCase(),
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || null,
    pathname: parsed.pathname.replace(/\/+$/, '') || '/',
  };
}

function normalizeCanonicalValue(
  value: unknown,
  _inArray: boolean,
): CanonicalValue {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical serialization requires finite numbers');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeCanonicalValue(item, true));
  }
  if (typeof value !== 'object') {
    throw new Error(`Unsupported canonical value type: ${typeof value}`);
  }
  const record = value as Record<string, unknown>;
  const normalized: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined) normalized[key] = normalizeCanonicalValue(item, false);
  }
  return normalized;
}

function assertAdapterContract(contract: ProviderAdapterQualificationContract): void {
  if (![contract.adapterId, contract.adapterContractVersion, contract.toolCallTranslationVersion]
    .every(nonEmpty)) {
    throw new Error('ADAPTER_QUALIFICATION_CONTRACT_INCOMPLETE');
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function hasCompleteFixtureSet(fixtures: readonly WriterQualificationFixtureSnapshot[]): boolean {
  const expected = ['SEARCH', 'READ', 'WRITE'] as const;
  return fixtures.length === expected.length
    && expected.every(action => fixtures.filter(
      fixture => fixture.expectedActionClass === action
        && nonEmpty(fixture.fixtureId)
        && nonEmpty(fixture.fixtureVersion),
    ).length === 1);
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
