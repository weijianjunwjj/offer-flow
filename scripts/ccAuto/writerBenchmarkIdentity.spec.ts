import { describe, expect, it } from 'vitest';
import {
  WRITER_DECISION_FIXTURES,
  type WriterDecisionFixture,
} from './__fixtures__/writerDecisionFixture';
import type {
  ProviderAdapterQualificationContract,
  ProviderProfile,
  ProviderToolDefinition,
} from './types';
import {
  buildWriterQualificationIdentitySnapshot,
  canonicalSerialize,
  fingerprintProviderProfileForQualification,
} from './writerBenchmarkIdentity';
import { WRITER_QUALIFICATION_POLICY_VERSION } from './writerQualificationPolicyContract';

const PROFILE: ProviderProfile = {
  id: 'profile-a',
  displayName: 'Display metadata A',
  vendor: 'third-party',
  transport: 'openai-chat',
  apiBaseUrl: 'https://provider.invalid/v1',
  credentialEnvVars: ['BENCHMARK_API_KEY'],
  runtimeEnvAllowlist: ['PATH', 'LANG'],
  staticEnv: { FEATURE_MODE: 'stable' },
  defaultModelId: 'logical-a',
  models: [{
    logicalName: 'logical-a',
    requestedModelId: 'model-a-v1',
    acceptedReportedModelIds: ['model-a-v1'],
    displayName: 'Model display A',
  }],
  pricing: {
    'model-a-v1': {
      inputPerMTokens: 1,
      outputPerMTokens: 2,
      cacheCreationPerMTokens: 0,
      cacheReadPerMTokens: 0,
      currency: 'CNY',
      source: 'test-a',
      updatedAt: '2026-08-16T00:00:00.000Z',
    },
  },
};

const ADAPTER_CONTRACT: ProviderAdapterQualificationContract = {
  adapterId: 'mock-provider-neutral-adapter',
  adapterContractVersion: 'mock-provider-neutral-adapter-v1',
  toolCallTranslationVersion: 'mock-tool-call-translation-v1',
};

const TOOLS: ProviderToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read one approved UTF-8 file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
  },
}];

function build(overrides: Partial<{
  profile: ProviderProfile;
  fixtures: readonly WriterDecisionFixture[];
  adapterContract: ProviderAdapterQualificationContract;
  tools: ProviderToolDefinition[];
  systemContract: string;
  maxOutputTokens: number;
  qualificationPolicyVersion: string;
}> = {}) {
  return buildWriterQualificationIdentitySnapshot({
    profile: overrides.profile ?? PROFILE,
    logicalModelName: 'logical-a',
    qualificationFixtures: overrides.fixtures ?? WRITER_DECISION_FIXTURES,
    adapterContract: overrides.adapterContract ?? ADAPTER_CONTRACT,
    tools: overrides.tools ?? TOOLS,
    toolMode: 'enabled',
    writerSystemContract: overrides.systemContract ?? 'stable writer system contract v1',
    maxOutputTokens: overrides.maxOutputTokens ?? 4_096,
    qualificationPolicyVersion: overrides.qualificationPolicyVersion
      ?? WRITER_QUALIFICATION_POLICY_VERSION,
  });
}

describe('Writer benchmark qualification identity snapshot v3', () => {
  it('changes identity when the actual requested model identifier changes', () => {
    const changed: ProviderProfile = {
      ...PROFILE,
      models: PROFILE.models.map(model => ({
        ...model,
        requestedModelId: 'model-a-v2',
        acceptedReportedModelIds: ['model-a-v2'],
      })),
      pricing: {
        'model-a-v2': { ...PROFILE.pricing['model-a-v1'] },
      },
    };

    expect(build({ profile: changed }).qualificationIdentityFingerprint)
      .not.toBe(build().qualificationIdentityFingerprint);
    expect(build({ profile: changed }).modelIdentifier).toBe('model-a-v2');
  });

  it('changes identity when qualification-relevant Provider config changes', () => {
    const changedEndpoint: ProviderProfile = {
      ...PROFILE,
      apiBaseUrl: 'https://provider.invalid/v2',
    };
    const changedCredentialRequirement: ProviderProfile = {
      ...PROFILE,
      credentialEnvVars: ['ROTATED_BENCHMARK_API_KEY_NAME'],
    };
    const baseline = build().qualificationIdentityFingerprint;

    expect(build({ profile: changedEndpoint }).qualificationIdentityFingerprint)
      .not.toBe(baseline);
    expect(build({ profile: changedCredentialRequirement }).qualificationIdentityFingerprint)
      .not.toBe(baseline);
  });

  it('invalidates on inference, Writer system, tool schema, Adapter, fixture, and Policy changes', () => {
    const baseline = build().qualificationIdentityFingerprint;
    const changedFixture = WRITER_DECISION_FIXTURES.map((fixture, index) => (
      index === 0 ? { ...fixture, version: 'v2' } : fixture
    ));
    const cases = [
      build({ maxOutputTokens: 8_192 }),
      build({ systemContract: 'stable writer system contract v2' }),
      build({
        tools: [{
          ...TOOLS[0],
          function: {
            ...TOOLS[0].function,
            parameters: {
              ...TOOLS[0].function.parameters,
              required: ['path', 'encoding'],
            },
          },
        }],
      }),
      build({
        adapterContract: {
          ...ADAPTER_CONTRACT,
          toolCallTranslationVersion: 'mock-tool-call-translation-v2',
        },
      }),
      build({ fixtures: changedFixture }),
      build({ qualificationPolicyVersion: 'writer-qualification-policy-v2' }),
    ];

    for (const changed of cases) {
      expect(changed.qualificationIdentityFingerprint).not.toBe(baseline);
    }
  });

  it('ignores pricing, Provider display metadata, model display metadata, and env values', () => {
    const metadataOnly: ProviderProfile = {
      ...PROFILE,
      displayName: 'Renamed Provider Profile',
      staticEnv: { FEATURE_MODE: 'rotated-runtime-value' },
      models: PROFILE.models.map(model => ({ ...model, displayName: 'Renamed Model' })),
      pricing: {
        'model-a-v1': {
          pricingType: 'context-tiered',
          thresholdBasis: 'REQUEST_CONTEXT_TOKENS',
          tiers: [{
            id: 'base',
            fromInclusive: 0,
            upToInclusive: 100,
            rates: {
              inputPerMTokens: 999,
              outputPerMTokens: 999,
              cacheCreationPerMTokens: 0,
              cacheReadPerMTokens: 0,
            },
          }, {
            id: 'high',
            fromInclusive: 101,
            upToInclusive: null,
            rates: {
              inputPerMTokens: 1_999,
              outputPerMTokens: 1_999,
              cacheCreationPerMTokens: 0,
              cacheReadPerMTokens: 0,
            },
          }],
          currency: 'CNY',
          source: 'new-price-source',
          updatedAt: '2027-01-01T00:00:00.000Z',
        },
      },
    };

    expect(fingerprintProviderProfileForQualification(metadataOnly, 'logical-a'))
      .toBe(fingerprintProviderProfileForQualification(PROFILE, 'logical-a'));
    expect(build({ profile: metadataOnly }).qualificationIdentityFingerprint)
      .toBe(build().qualificationIdentityFingerprint);
  });

  it('is Provider-neutral when vendor branding changes but execution semantics do not', () => {
    const branded: ProviderProfile = { ...PROFILE, vendor: 'deepseek' };
    expect(build({ profile: branded }).qualificationIdentityFingerprint)
      .toBe(build().qualificationIdentityFingerprint);
  });

  it('canonicalizes object key order while preserving array order semantics', () => {
    expect(canonicalSerialize({ b: 2, a: { d: 4, c: 3 }, omitted: undefined }))
      .toBe(canonicalSerialize({ a: { c: 3, d: 4 }, b: 2 }));
    expect(canonicalSerialize({ values: ['a', 'b'] }))
      .not.toBe(canonicalSerialize({ values: ['b', 'a'] }));
    expect(canonicalSerialize({ value: null })).toBe('{"value":null}');
  });

  it('rejects credential-bearing endpoint syntax without echoing the secret', () => {
    const secret = 'endpoint-sensitive-value-must-not-leak';
    const unsafe: ProviderProfile = {
      ...PROFILE,
      apiBaseUrl: `https://provider.invalid/v1?token=${secret}`,
    };
    let message = '';
    try {
      build({ profile: unsafe });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('UNSAFE_PROVIDER_ENDPOINT');
    expect(message).not.toContain(secret);
    expect(JSON.stringify(build())).not.toContain(secret);
  });
});
