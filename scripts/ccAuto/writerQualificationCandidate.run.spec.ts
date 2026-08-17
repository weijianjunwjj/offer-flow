import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterRegistry } from './adapter';
import type {
  ProviderAdapter,
  ProviderCallRequest,
  ProviderCallResponse,
  ProviderProfile,
} from './types';
import {
  parseWriterQualificationCandidateArgs,
  resolveWriterQualificationCandidate,
  runConfiguredWriterModelProfileBenchmarkCell,
  runWriterQualificationCandidateBenchmarks,
} from './writerModelProfileBenchmark.run';
import { evaluateWriterProfileQualification } from './writerProfileQualification';

const cleanupDirectories: string[] = [];
const credentialName = 'PROVIDER_A_BENCHMARK_TOKEN';

afterEach(() => {
  while (cleanupDirectories.length > 0) {
    rmSync(cleanupDirectories.pop()!, { recursive: true, force: true });
  }
});

function profile(
  id: string = 'profile-a',
  logicalModelName: string = 'logical-model-a',
  requestedModelId: string = 'requested-model-a',
): ProviderProfile {
  return {
    id,
    displayName: 'Profile A',
    vendor: 'third-party',
    transport: 'openai-chat',
    apiBaseUrl: 'https://provider-a.invalid/v1',
    credentialEnvVars: [credentialName],
    runtimeEnvAllowlist: ['PATH'],
    defaultModelId: logicalModelName,
    models: [{
      logicalName: logicalModelName,
      requestedModelId,
      acceptedReportedModelIds: [requestedModelId, `${requestedModelId}-reported`],
      displayName: 'Logical Model A',
    }],
    pricing: {
      [requestedModelId]: {
        inputPerMTokens: 1,
        outputPerMTokens: 2,
        cacheCreationPerMTokens: 1,
        cacheReadPerMTokens: 0.1,
        currency: 'CNY',
        source: 'test',
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
      [`${requestedModelId}-reported`]: {
        inputPerMTokens: 1,
        outputPerMTokens: 2,
        cacheCreationPerMTokens: 1,
        cacheReadPerMTokens: 0.1,
        currency: 'CNY',
        source: 'test',
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
    },
  };
}

function createWorkspace(options: {
  profiles?: ProviderProfile[];
  routingProfileId?: string;
  routingLogicalModelName?: string;
  strongRoutingProfileId?: string;
  strongRoutingLogicalModelName?: string;
} = {}): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'writer-qualification-candidate-'));
  cleanupDirectories.push(cwd);
  mkdirSync(path.join(cwd, '.cc-auto'), { recursive: true });
  const profiles = options.profiles ?? [profile()];
  const routingProfileId = options.routingProfileId ?? 'runtime-profile-not-under-test';
  const routingLogicalModelName = options.routingLogicalModelName ?? 'runtime-model-not-under-test';
  const strongRoutingProfileId = options.strongRoutingProfileId ?? 'runtime-profile-b';
  const strongRoutingLogicalModelName = options.strongRoutingLogicalModelName ?? 'runtime-model-b';
  writeFileSync(path.join(cwd, '.cc-auto', 'config.json'), JSON.stringify({
    modelRouting: {
      enabled: true,
      fastModel: {
        provider: 'runtime-provider-a',
        profileId: routingProfileId,
        modelLogicalName: routingLogicalModelName,
      },
      strongModel: {
        provider: 'runtime-provider-b',
        profileId: strongRoutingProfileId,
        modelLogicalName: strongRoutingLogicalModelName,
      },
    },
    providerProfiles: Object.fromEntries(profiles.map(item => [item.id, item])),
  }, null, 2), 'utf8');
  return cwd;
}

function nextToolCall(request: ProviderCallRequest) {
  const json = request.userPrompt
    .slice(request.userPrompt.indexOf('\n') + 1, request.userPrompt.lastIndexOf('\n\n'));
  const observation = JSON.parse(json) as {
    observationState: {
      discoveryRequired: boolean;
      targetContentAvailable: boolean;
    };
  };
  if (observation.observationState.discoveryRequired) {
    return { name: 'grep', arguments: { query: 'formatDisplayName', roots: ['src'] } };
  }
  if (!observation.observationState.targetContentAvailable) {
    return { name: 'read_file', arguments: { path: 'src/utils/formatDisplayName.spec.ts' } };
  }
  return {
    name: 'edit_file',
    arguments: {
      path: 'src/utils/formatDisplayName.spec.ts',
      oldText: 'existing-content',
      newText: 'updated-content',
    },
  };
}

function registeredAdapter(options: {
  qualificationContract?: boolean;
  requests?: ProviderCallRequest[];
} = {}): { registry: AdapterRegistry; adapter: ProviderAdapter } {
  const requests = options.requests ?? [];
  const adapter: ProviderAdapter = {
    transport: 'openai-chat',
    ...(options.qualificationContract === false ? {} : {
      qualificationContract: {
        adapterId: 'provider-a-adapter',
        adapterContractVersion: 'provider-a-adapter-v1',
        toolCallTranslationVersion: 'provider-a-tool-translation-v1',
      },
    }),
    async execute(request): Promise<ProviderCallResponse> {
      requests.push(structuredClone(request));
      const tool = nextToolCall(request);
      return {
        callId: request.callId,
        providerId: request.providerId,
        requestedModelId: request.requestedModelId,
        reportedModel: `${request.requestedModelId}-reported`,
        content: '',
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        durationMs: 5,
        numTurns: 1,
        subtype: 'tool_calls',
        isError: false,
        error: null,
        toolCalls: [{
          id: `tool-call-${requests.length}`,
          type: 'function',
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.arguments),
          },
        }],
      };
    },
  };
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return { registry, adapter };
}

const candidate = {
  profileId: 'profile-a',
  logicalModelName: 'logical-model-a',
} as const;

describe('Provider-neutral Writer Qualification Candidate runner', () => {
  it('runs all frozen fixtures from an explicit candidate without reading model routing', async () => {
    const cwd = createWorkspace();
    const requests: ProviderCallRequest[] = [];
    const { registry } = registeredAdapter({ requests });

    const result = await runWriterQualificationCandidateBenchmarks(
      candidate,
      cwd,
      { [credentialName]: 'test-credential' },
      { adapterRegistry: registry },
    );

    expect(result.benchmarkInvocationCount).toBe(3);
    expect(result.providerCallCount).toBe(3);
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.providerId === 'profile-a')).toBe(true);
    expect(requests.every(request => request.requestedModelId === 'requested-model-a')).toBe(true);
    expect(result.samples.map(sample => sample.expectedActionClass).sort()).toEqual([
      'READ', 'SEARCH', 'WRITE',
    ]);
    expect(result.samples.every(sample => sample.schemaVersion === 'writer-model-profile-benchmark-sample-v3')).toBe(true);
    expect(result.samples.every(sample => sample.executionRole === 'WRITER')).toBe(true);
    const v3Samples = result.samples.filter(
      sample => sample.schemaVersion === 'writer-model-profile-benchmark-sample-v3',
    );
    expect(v3Samples.every(sample => sample.qualificationIdentity.modelIdentifier === 'requested-model-a')).toBe(true);
    expect(new Set(v3Samples.map(sample => sample.qualificationIdentity.qualificationIdentityFingerprint)).size).toBe(1);
    expect(result.samples.every(sample => sample.passed)).toBe(true);

    const qualification = evaluateWriterProfileQualification('profile-a', result.samples);
    expect(qualification.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(qualification.qualificationIdentity.complete).toBe(true);
    expect(qualification.reasonCodes).not.toContain('QUALIFICATION_IDENTITY_INCOMPLETE');
    expect(qualification.reasonCodes).not.toContain('QUALIFICATION_IDENTITY_INVALID');
  });

  it('resolves requested and accepted model identities only from the configured profile', () => {
    const { registry } = registeredAdapter();
    const resolved = resolveWriterQualificationCandidate(
      candidate,
      { 'profile-a': profile() },
      registry,
    );

    expect(resolved).toMatchObject({
      candidate,
      requestedModelId: 'requested-model-a',
      acceptedReportedModelIds: [
        'requested-model-a',
        'requested-model-a-reported',
      ],
      transport: 'openai-chat',
      adapterContract: {
        adapterId: 'provider-a-adapter',
      },
    });
  });

  it('fails closed when the profile does not exist', async () => {
    const cwd = createWorkspace();
    const requests: ProviderCallRequest[] = [];
    const { registry } = registeredAdapter({ requests });

    await expect(runWriterQualificationCandidateBenchmarks(
      { profileId: 'missing-profile', logicalModelName: 'logical-model-a' },
      cwd,
      { [credentialName]: 'test-credential' },
      { adapterRegistry: registry },
    )).rejects.toThrow('PROFILE_NOT_FOUND:missing-profile');
    expect(requests).toHaveLength(0);
  });

  it('fails closed when the logical model does not belong to the profile', async () => {
    const cwd = createWorkspace();
    const requests: ProviderCallRequest[] = [];
    const { registry } = registeredAdapter({ requests });

    await expect(runWriterQualificationCandidateBenchmarks(
      { profileId: 'profile-a', logicalModelName: 'logical-model-missing' },
      cwd,
      { [credentialName]: 'test-credential' },
      { adapterRegistry: registry },
    )).rejects.toThrow('LOGICAL_MODEL_NOT_FOUND:profile-a:logical-model-missing');
    expect(requests).toHaveLength(0);
  });

  it('fails closed before a Provider call when the transport has no registered Adapter', async () => {
    const cwd = createWorkspace();

    await expect(runWriterQualificationCandidateBenchmarks(
      candidate,
      cwd,
      { [credentialName]: 'test-credential' },
      { adapterRegistry: new AdapterRegistry() },
    )).rejects.toThrow('ADAPTER_NOT_FOUND:openai-chat');
  });

  it('fails closed before a Provider call when Adapter qualification metadata is missing', async () => {
    const cwd = createWorkspace();
    const requests: ProviderCallRequest[] = [];
    const { registry } = registeredAdapter({ qualificationContract: false, requests });

    await expect(runWriterQualificationCandidateBenchmarks(
      candidate,
      cwd,
      { [credentialName]: 'test-credential' },
      { adapterRegistry: registry },
    )).rejects.toThrow('ADAPTER_QUALIFICATION_CONTRACT_MISSING:openai-chat');
    expect(requests).toHaveLength(0);
  });

  it('keeps FAST and STRONG convenience cells on the shared candidate execution path', async () => {
    const cwd = createWorkspace({
      profiles: [
        profile(),
        profile('profile-b', 'logical-model-b', 'requested-model-b'),
      ],
      routingProfileId: 'profile-a',
      routingLogicalModelName: 'logical-model-a',
      strongRoutingProfileId: 'profile-b',
      strongRoutingLogicalModelName: 'logical-model-b',
    });
    const requests: ProviderCallRequest[] = [];
    const { registry } = registeredAdapter({ requests });

    const fastResult = await runConfiguredWriterModelProfileBenchmarkCell(
      'FAST_EXECUTOR',
      'SEARCH',
      cwd,
      { [credentialName]: 'test-credential' },
      { adapterRegistry: registry },
    );
    const strongResult = await runConfiguredWriterModelProfileBenchmarkCell(
      'STRONG_EXECUTOR',
      'READ',
      cwd,
      { [credentialName]: 'test-credential' },
      { adapterRegistry: registry },
    );

    expect(fastResult.sample).toMatchObject({
      schemaVersion: 'writer-model-profile-benchmark-sample-v3',
      profileId: 'profile-a',
      executionRole: 'FAST_EXECUTOR',
      expectedActionClass: 'SEARCH',
    });
    expect(strongResult.sample).toMatchObject({
      schemaVersion: 'writer-model-profile-benchmark-sample-v3',
      profileId: 'profile-b',
      executionRole: 'STRONG_EXECUTOR',
      expectedActionClass: 'READ',
    });
    expect(requests).toHaveLength(2);
    expect(runConfiguredWriterModelProfileBenchmarkCell.toString())
      .toContain('runWriterQualificationCandidateFixtures');
  });

  it('parses only the explicit profile and logical model CLI contract', () => {
    expect(parseWriterQualificationCandidateArgs([
      '--profile', 'profile-a', '--model', 'logical-model-a',
    ])).toEqual(candidate);
    expect(parseWriterQualificationCandidateArgs([])).toBeNull();
    expect(() => parseWriterQualificationCandidateArgs([
      '--profile', 'profile-a',
    ])).toThrow('QUALIFICATION_CANDIDATE_ARGUMENTS_INCOMPLETE');
    expect(() => parseWriterQualificationCandidateArgs([
      '--profile', 'profile-a', '--priority', '1',
    ])).toThrow('QUALIFICATION_CANDIDATE_ARGUMENTS_INVALID');
  });

  it('keeps the candidate entry surface free of Provider brand branches', () => {
    const candidateSurface = [
      parseWriterQualificationCandidateArgs,
      resolveWriterQualificationCandidate,
      runWriterQualificationCandidateBenchmarks,
    ].map(value => value.toString().toLowerCase()).join('\n');

    for (const brand of ['deepseek', 'gpt', 'grok', 'claude', 'openai', 'anthropic', 'xai']) {
      expect(candidateSurface).not.toContain(brand);
    }
  });
});
