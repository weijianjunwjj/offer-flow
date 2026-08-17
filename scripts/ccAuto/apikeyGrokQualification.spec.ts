import { describe, expect, it } from 'vitest';
import { buildChildEnv } from './buildChildEnv';
import { computeCostRmbFromPricing, computePricingDecision } from './cost';
import { checkModelIdentity } from './modelIdentity';
import {
  OpenAIChatAdapter,
  buildChatCompletionsUrl,
  type FetchLike,
} from './openaiChatAdapter';
import { validateProviderProfile } from './provider';
import { createProductionAdapterRegistry } from './productionAdapterRegistry';
import type {
  ProviderCallRequest,
  ProviderProfile,
  ProviderToolDefinition,
} from './types';
import {
  buildWriterQualificationIdentitySnapshot,
  fingerprintProviderProfileForQualification,
  validateWriterQualificationIdentitySnapshot,
} from './writerBenchmarkIdentity';
import { WRITER_DECISION_FIXTURES } from './__fixtures__/writerDecisionFixture';
import { resolveWriterQualificationCandidate } from './writerModelProfileBenchmark.run';
import { resolveWriterQualificationIdentitySnapshot } from './writerModelProfileBenchmark';
import { WRITER_QUALIFICATION_POLICY_VERSION } from './writerQualificationPolicyContract';

const PROFILE_ID = 'apikey-grok-4-6';
const LOGICAL_MODEL_NAME = 'grok-4-6-writer';

const GROK_PROFILE: ProviderProfile = {
  id: PROFILE_ID,
  displayName: 'APIKEY.fun Grok 4.6',
  vendor: 'third-party',
  transport: 'openai-chat',
  apiBaseUrl: 'https://api.apikey.fun/v1',
  credentialEnvVars: ['APIKEY_GROK_API_KEY'],
  runtimeEnvAllowlist: ['PATH', 'HOME'],
  defaultModelId: LOGICAL_MODEL_NAME,
  models: [{
    logicalName: LOGICAL_MODEL_NAME,
    requestedModelId: 'grok-4.6',
    acceptedReportedModelIds: ['grok-4.6'],
    displayName: 'Grok 4.6',
  }],
  pricing: {
    'grok-4.6': {
      pricingType: 'context-tiered',
      thresholdBasis: 'REQUEST_CONTEXT_TOKENS',
      tiers: [{
        id: 'context-up-to-200k',
        fromInclusive: 0,
        upToInclusive: 200_000,
        rates: {
          inputPerMTokens: 2,
          outputPerMTokens: 6,
          cacheCreationPerMTokens: 0,
          cacheReadPerMTokens: 0.3,
        },
      }, {
        id: 'context-over-200k',
        fromInclusive: 200_001,
        upToInclusive: null,
        rates: {
          inputPerMTokens: 4,
          outputPerMTokens: 12,
          cacheCreationPerMTokens: 0,
          cacheReadPerMTokens: 0.6,
        },
      }],
      currency: 'CNY',
      source: 'APIKEY.fun Grok 企业版第三方价格',
      updatedAt: '2026-08-17',
    },
  },
};

function loadProfile(): ProviderProfile {
  const loaded = validateProviderProfile(PROFILE_ID, GROK_PROFILE);
  expect(loaded.ok).toBe(true);
  const profile = loaded.profile;
  expect(profile).toBeDefined();
  return profile!;
}

function request(): ProviderCallRequest {
  return {
    callId: 'apikey-grok-offline-conformance',
    providerId: PROFILE_ID,
    requestedModelId: 'grok-4.6',
    role: 'builder',
    systemPrompt: 'Writer system contract',
    userPrompt: 'Return the next tool action.',
    maxOutputTokens: 4096,
    timeoutMs: 30_000,
    toolMode: 'enabled',
    tools: TOOLS,
  };
}

const TOOLS: ProviderToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read one approved file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
  },
}, {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Edit one approved file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'oldText', 'newText'],
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
    },
  },
}];

describe('APIKEY.fun Grok 4.6 Qualification Profile offline conformance', () => {
  it('loads the exact Provider, model, credential, and two-tier context pricing contract', () => {
    const profile = loadProfile();
    expect(profile).toMatchObject({
      id: PROFILE_ID,
      displayName: 'APIKEY.fun Grok 4.6',
      vendor: 'third-party',
      transport: 'openai-chat',
      apiBaseUrl: 'https://api.apikey.fun/v1',
      credentialEnvVars: ['APIKEY_GROK_API_KEY'],
      runtimeEnvAllowlist: ['PATH', 'HOME'],
      defaultModelId: LOGICAL_MODEL_NAME,
      models: [{
        logicalName: LOGICAL_MODEL_NAME,
        requestedModelId: 'grok-4.6',
        acceptedReportedModelIds: ['grok-4.6'],
      }],
    });
    expect(profile.pricing['grok-4.6']).toMatchObject({
      pricingType: 'context-tiered',
      thresholdBasis: 'REQUEST_CONTEXT_TOKENS',
      tiers: [{
        id: 'context-up-to-200k',
        fromInclusive: 0,
        upToInclusive: 200_000,
        rates: {
          inputPerMTokens: 2,
          outputPerMTokens: 6,
          cacheCreationPerMTokens: 0,
          cacheReadPerMTokens: 0.3,
        },
      }, {
        id: 'context-over-200k',
        fromInclusive: 200_001,
        upToInclusive: null,
        rates: {
          inputPerMTokens: 4,
          outputPerMTokens: 12,
          cacheCreationPerMTokens: 0,
          cacheReadPerMTokens: 0.6,
        },
      }],
      currency: 'CNY',
      source: 'APIKEY.fun Grok 企业版第三方价格',
      updatedAt: '2026-08-17',
    });
  });

  it('resolves an independent Qualification Candidate without runtime routing', () => {
    const registry = createProductionAdapterRegistry({
      fetchImpl: async () => { throw new Error('offline test must not call fetch'); },
    });
    const resolved = resolveWriterQualificationCandidate(
      { profileId: PROFILE_ID, logicalModelName: LOGICAL_MODEL_NAME },
      { [PROFILE_ID]: loadProfile() },
      registry,
    );
    expect(resolved).toMatchObject({
      requestedModelId: 'grok-4.6',
      acceptedReportedModelIds: ['grok-4.6'],
      transport: 'openai-chat',
      adapterContract: {
        adapterId: 'openai-chat-adapter',
        adapterContractVersion: 'openai-chat-adapter-v1',
        toolCallTranslationVersion: 'openai-chat-tool-call-translation-v1',
      },
    });
  });

  it('isolates the Grok credential from Claude, DeepSeek, and Tavily credentials', () => {
    const profile = loadProfile();
    const result = buildChildEnv(profile, {
      PATH: '/usr/bin',
      HOME: '/home/test',
      APIKEY_GROK_API_KEY: 'grok-test-secret',
      ANTHROPIC_AUTH_TOKEN: 'claude-test-secret',
      DEEPSEEK_API_KEY: 'deepseek-test-secret',
      TAVILY_API_KEY: 'tavily-test-secret',
    });
    expect(Object.keys(result.childEnv).sort()).toEqual([
      'APIKEY_GROK_API_KEY', 'HOME', 'PATH',
    ]);
    expect(result.credentialVarNames).toEqual(['APIKEY_GROK_API_KEY']);
    expect(result.childEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.childEnv.DEEPSEEK_API_KEY).toBeUndefined();
    expect(result.childEnv.TAVILY_API_KEY).toBeUndefined();
  });

  it('uses the shared OpenAI Chat Adapter for URL, Bearer auth, tools, model, usage, and tool calls', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: FetchLike = async (input, init) => {
      calls.push({ url: input.toString(), init });
      return new Response(JSON.stringify({
        model: 'grok-4.6',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{
              id: 'read-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
            }, {
              id: 'edit-2',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: '{"path":"src/a.ts","oldText":"a","newText":"b"}',
              },
            }],
          },
        }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          total_tokens: 1100,
          prompt_tokens_details: { cached_tokens: 200 },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const profile = loadProfile();
    const adapter = new OpenAIChatAdapter(fakeFetch);
    const result = await adapter.execute(request(), {
      profile,
      timeoutMs: 30_000,
      childEnv: { APIKEY_GROK_API_KEY: 'offline-grok-secret' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.apikey.fun/v1/chat/completions');
    expect(new Headers(calls[0].init?.headers).get('Authorization'))
      .toBe('Bearer offline-grok-secret');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({
      model: 'grok-4.6',
      stream: false,
      tool_choice: 'auto',
    });
    expect(body.messages.map((message: { role: string }) => message.role))
      .toEqual(['system', 'user']);
    expect(body.tools).toHaveLength(2);
    expect(result).toMatchObject({
      reportedModel: 'grok-4.6',
      subtype: 'tool_calls',
      isError: false,
      usage: {
        inputTokens: 800,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 200,
      },
    });
    expect(result.toolCalls?.map(call => [call.id, call.function.name])).toEqual([
      ['read-1', 'read_file'],
      ['edit-2', 'edit_file'],
    ]);
  });

  it('validates model identity and computes the channel price without cache double counting', () => {
    const profile = loadProfile();
    expect(checkModelIdentity(profile, 'grok-4.6', 'grok-4.6').status).toBe('VERIFIED');
    expect(checkModelIdentity(profile, 'grok-4.6', 'gateway-alias').status).toBe('MISMATCH');
    expect(computeCostRmbFromPricing({
      inputTokens: 800,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 200,
    }, profile.pricing['grok-4.6'])).toBeCloseTo(0.00226, 12);
  });

  it('preserves Smoke #3 and the frozen formal batch costs under the base tier', () => {
    const pricing = loadProfile().pricing['grok-4.6'];
    const smoke = computePricingDecision({
      inputTokens: 1_139,
      outputTokens: 304,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 128,
    }, pricing);
    expect(smoke).toMatchObject({
      pricingTierId: 'context-up-to-200k',
      requestContextTokens: 1_267,
    });
    expect(smoke.cost).toBeCloseTo(0.0041404, 12);

    const formalUsages = [
      [1_011, 73, 128],
      [115, 97, 1_024],
      [115, 97, 1_024],
      [1_080, 348, 128],
      [312, 206, 896],
      [1_080, 186, 128],
      [1_139, 512, 128],
      [115, 398, 1_152],
      [115, 801, 1_152],
    ] as const;
    const formalTotal = formalUsages.reduce((total, [inputTokens, outputTokens, cacheReadInputTokens]) => {
      const cost = computeCostRmbFromPricing({
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens,
      }, pricing);
      expect(cost).not.toBeNull();
      return total + cost!;
    }, 0);
    expect(formalTotal).toBeCloseTo(0.0282000, 12);
  });

  it('keeps the frozen Qualification Identity fingerprint across the pricing-only change', () => {
    const profile = loadProfile();
    const adapter = createProductionAdapterRegistry().resolve(profile.transport);
    expect(adapter?.qualificationContract).toBeDefined();
    const identity = resolveWriterQualificationIdentitySnapshot({
      profile,
      logicalModelName: LOGICAL_MODEL_NAME,
      adapterContract: adapter!.qualificationContract!,
    });
    expect(identity.qualificationIdentityFingerprint)
      .toBe('a4b682d19a60767bcddf753e6559b92d75aaef022ab023b38f6c8220f1f7cc47');
  });

  it('freezes Gateway semantics in v3 identity without including credential values', () => {
    const profile = loadProfile();
    const adapter = createProductionAdapterRegistry().resolve('openai-chat');
    expect(adapter?.qualificationContract).toBeDefined();
    const buildIdentity = (_credentialValue: string) => buildWriterQualificationIdentitySnapshot({
      profile,
      logicalModelName: LOGICAL_MODEL_NAME,
      qualificationFixtures: WRITER_DECISION_FIXTURES,
      adapterContract: adapter!.qualificationContract!,
      tools: TOOLS,
      toolMode: 'enabled',
      writerSystemContract: 'offline writer contract',
      maxOutputTokens: 4096,
      qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
    });
    const first = buildIdentity('credential-value-a');
    const rotated = buildIdentity('credential-value-b');
    expect(validateWriterQualificationIdentitySnapshot(first)).toBe(true);
    expect(rotated.qualificationIdentityFingerprint)
      .toBe(first.qualificationIdentityFingerprint);
    expect(JSON.stringify(first)).not.toContain('credential-value-a');
    expect(first.modelIdentifier).toBe('grok-4.6');
    expect(first.profileId).toBe(PROFILE_ID);

    const otherGateway = { ...profile, apiBaseUrl: 'https://other-gateway.invalid/v1' };
    expect(fingerprintProviderProfileForQualification(otherGateway, LOGICAL_MODEL_NAME))
      .not.toBe(fingerprintProviderProfileForQualification(profile, LOGICAL_MODEL_NAME));
  });

  it('builds the exact full Chat Completions endpoint without a Provider call', () => {
    expect(buildChatCompletionsUrl(loadProfile().apiBaseUrl!).toString())
      .toBe('https://api.apikey.fun/v1/chat/completions');
  });
});
