import { pathToFileURL } from 'node:url';
import { loadProjectEnv } from '../../server/config/loadEnv';
import { loadEffectiveConfig } from './config';
import { loadProviderProfiles } from './provider';
import { createProductionAdapterRegistry } from './productionAdapterRegistry';
import {
  classifyWriterDecisionAction,
  WRITER_DECISION_FIXTURES,
  type WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';
import {
  classifyWriterCapabilityActions,
  createProviderBenchmarkInvocation,
  isPassingWriterVerdict,
  runWriterModelProfileBenchmark,
} from './writerModelProfileBenchmark';
import {
  saveWriterBenchmarkSample,
  type PersistedWriterBenchmarkSample,
} from './writerModelProfileBenchmarkStore';
import type {
  ExecutionModelRole,
  ProviderAdapterQualificationContract,
  ProviderAdapterResolver,
  ProviderProfile,
  WriterExecutionRole,
} from './types';

export interface WriterQualificationCandidate {
  profileId: string;
  logicalModelName: string;
}

export interface ResolvedWriterQualificationCandidate {
  candidate: WriterQualificationCandidate;
  profile: ProviderProfile;
  requestedModelId: string;
  acceptedReportedModelIds: string[];
  transport: ProviderProfile['transport'];
  adapterContract: ProviderAdapterQualificationContract;
}

export interface WriterQualificationCandidateRunnerDeps {
  adapterRegistry?: ProviderAdapterResolver;
}

export interface WriterBenchmarkBehaviorCell {
  fixtureId: string;
  expected: PersistedWriterBenchmarkSample['expectedActionClass'];
  actual: PersistedWriterBenchmarkSample['actualActionClass'];
  toolNames: string[];
  actionClasses: PersistedWriterBenchmarkSample['actionClasses'];
  protocolValid: boolean | null;
  verdict: PersistedWriterBenchmarkSample['verdict'];
  reasonCode: string;
  passed: boolean;
  costRmb: number | null;
}

export interface WriterBenchmarkProfileSummary {
  profileId: string;
  executionRole: WriterExecutionRole;
  behavior: Record<'SEARCH' | 'READ' | 'WRITE', WriterBenchmarkBehaviorCell>;
  passedFixtures: number;
  totalFixtures: number;
  providerCallCount: number;
  totalCostRmb: number | null;
}

export interface ConfiguredWriterBenchmarkRun {
  samples: PersistedWriterBenchmarkSample[];
  sampleFiles: string[];
  summaries: WriterBenchmarkProfileSummary[];
  benchmarkInvocationCount: number;
  providerCallCount: number;
}

export interface ConfiguredWriterBenchmarkCellRun {
  sample: PersistedWriterBenchmarkSample;
  sampleFile: string;
  benchmarkInvocationCount: 1;
  providerCallCount: number;
}

export interface WriterBenchmarkProcessDeps {
  loadEnv: (rootDir?: string) => void;
  runBenchmarks: typeof runConfiguredWriterModelProfileBenchmarks;
}

export interface WriterQualificationCandidateProcessDeps {
  loadEnv: (rootDir?: string) => void;
  runBenchmarks: typeof runWriterQualificationCandidateBenchmarks;
}

export function resolveWriterQualificationCandidate(
  candidate: WriterQualificationCandidate,
  profiles: Readonly<Record<string, ProviderProfile>>,
  adapterRegistry: ProviderAdapterResolver,
): ResolvedWriterQualificationCandidate {
  if (!candidate.profileId.trim()) {
    throw new Error('QUALIFICATION_CANDIDATE_PROFILE_ID_INVALID');
  }
  if (!candidate.logicalModelName.trim()) {
    throw new Error('QUALIFICATION_CANDIDATE_LOGICAL_MODEL_NAME_INVALID');
  }

  const profile = profiles[candidate.profileId];
  if (!profile) throw new Error(`PROFILE_NOT_FOUND:${candidate.profileId}`);

  const model = profile.models.find(
    item => item.logicalName === candidate.logicalModelName,
  );
  if (!model) {
    throw new Error(
      `LOGICAL_MODEL_NOT_FOUND:${candidate.profileId}:${candidate.logicalModelName}`,
    );
  }

  const adapter = adapterRegistry.resolve(profile.transport);
  if (!adapter) throw new Error(`ADAPTER_NOT_FOUND:${profile.transport}`);
  if (!adapter.qualificationContract) {
    throw new Error(`ADAPTER_QUALIFICATION_CONTRACT_MISSING:${profile.transport}`);
  }

  return {
    candidate: { ...candidate },
    profile,
    requestedModelId: model.requestedModelId,
    acceptedReportedModelIds: [...model.acceptedReportedModelIds],
    transport: profile.transport,
    adapterContract: { ...adapter.qualificationContract },
  };
}

export async function runWriterQualificationCandidateBenchmarks(
  candidate: WriterQualificationCandidate,
  cwd: string = process.cwd(),
  parentEnv: NodeJS.ProcessEnv = process.env,
  deps: WriterQualificationCandidateRunnerDeps = {},
): Promise<ConfiguredWriterBenchmarkRun> {
  return runWriterQualificationCandidateFixtures(
    candidate,
    WRITER_DECISION_FIXTURES,
    'WRITER',
    cwd,
    parentEnv,
    deps,
  );
}

export async function runWriterQualificationCandidateBenchmarkCell(
  candidate: WriterQualificationCandidate,
  expectedActionClass: WriterExpectedActionClass,
  cwd: string = process.cwd(),
  parentEnv: NodeJS.ProcessEnv = process.env,
  deps: WriterQualificationCandidateRunnerDeps = {},
): Promise<ConfiguredWriterBenchmarkCellRun> {
  const fixture = WRITER_DECISION_FIXTURES.find(
    item => item.expectedNextActionClass === expectedActionClass,
  );
  if (!fixture) throw new Error(`FIXTURE_NOT_FOUND:${expectedActionClass}`);
  const run = await runWriterQualificationCandidateFixtures(
    candidate,
    [fixture],
    'WRITER',
    cwd,
    parentEnv,
    deps,
  );
  return {
    sample: run.samples[0],
    sampleFile: run.sampleFiles[0],
    benchmarkInvocationCount: 1,
    providerCallCount: run.providerCallCount,
  };
}

async function runWriterQualificationCandidateFixtures(
  candidate: WriterQualificationCandidate,
  fixtures: readonly (typeof WRITER_DECISION_FIXTURES)[number][],
  executionRole: WriterExecutionRole,
  cwd: string,
  parentEnv: NodeJS.ProcessEnv,
  deps: WriterQualificationCandidateRunnerDeps,
): Promise<ConfiguredWriterBenchmarkRun> {
  const configResult = loadEffectiveConfig(cwd);
  if (!configResult.ok) throw new Error(`CONFIG_${configResult.reason}`);
  const profilesResult = loadProviderProfiles(configResult.config);
  if (!profilesResult.ok || !profilesResult.profiles) {
    throw new Error(`PROFILES_${profilesResult.reason ?? 'INVALID'}`);
  }

  const adapterRegistry = deps.adapterRegistry ?? createProductionAdapterRegistry();
  const resolved = resolveWriterQualificationCandidate(
    candidate,
    profilesResult.profiles,
    adapterRegistry,
  );
  const invocation = createProviderBenchmarkInvocation({
    adapterRegistry,
    parentEnv,
    cwd,
  });

  const samples: PersistedWriterBenchmarkSample[] = [];
  const sampleFiles: string[] = [];
  for (const fixture of fixtures) {
    const result = await runWriterModelProfileBenchmark({
      fixture,
      profile: resolved.profile,
      logicalModelName: resolved.candidate.logicalModelName,
      executionRole,
      invocation,
    });
    const saved = saveWriterBenchmarkSample(cwd, result);
    samples.push(saved.sample);
    sampleFiles.push(saved.filePath);
  }

  return {
    samples,
    sampleFiles,
    summaries: summarizeWriterBenchmarkSamples(samples),
    benchmarkInvocationCount: samples.length,
    providerCallCount: samples.reduce(
      (total, sample) => total + sample.providerCallCount,
      0,
    ),
  };
}

export async function runConfiguredWriterModelProfileBenchmarks(
  cwd: string = process.cwd(),
  parentEnv: NodeJS.ProcessEnv = process.env,
  deps: WriterQualificationCandidateRunnerDeps = {},
): Promise<ConfiguredWriterBenchmarkRun> {
  const configResult = loadEffectiveConfig(cwd);
  if (!configResult.ok) {
    throw new Error(`CONFIG_${configResult.reason}`);
  }

  const routing = configResult.config.modelRouting;
  if (!routing) {
    throw new Error('MODEL_ROUTING_CONFIG_MISSING');
  }

  // The configured profile identities are read without invoking routing logic.
  const configuredProfiles: Array<{
    executionRole: WriterExecutionRole;
    profileId: string;
    logicalModelName: string;
  }> = [
    {
      executionRole: 'FAST_EXECUTOR',
      profileId: routing.fastModel.profileId,
      logicalModelName: routing.fastModel.modelLogicalName,
    },
    {
      executionRole: 'STRONG_EXECUTOR',
      profileId: routing.strongModel.profileId,
      logicalModelName: routing.strongModel.modelLogicalName,
    },
  ];
  const samples: PersistedWriterBenchmarkSample[] = [];
  const sampleFiles: string[] = [];
  for (const configured of configuredProfiles) {
    const run = await runWriterQualificationCandidateFixtures(
      {
        profileId: configured.profileId,
        logicalModelName: configured.logicalModelName,
      },
      WRITER_DECISION_FIXTURES,
      configured.executionRole,
      cwd,
      parentEnv,
      deps,
    );
    samples.push(...run.samples);
    sampleFiles.push(...run.sampleFiles);
  }

  return {
    samples,
    sampleFiles,
    summaries: summarizeWriterBenchmarkSamples(samples),
    benchmarkInvocationCount: samples.length,
    providerCallCount: samples.reduce((total, sample) => total + sample.providerCallCount, 0),
  };
}

/** Runs one explicitly selected cell; it never expands to the other profile or fixtures. */
export async function runConfiguredWriterModelProfileBenchmarkCell(
  executionRole: Extract<ExecutionModelRole, 'FAST_EXECUTOR' | 'STRONG_EXECUTOR'>,
  expectedActionClass: WriterExpectedActionClass,
  cwd: string = process.cwd(),
  parentEnv: NodeJS.ProcessEnv = process.env,
  deps: WriterQualificationCandidateRunnerDeps = {},
): Promise<ConfiguredWriterBenchmarkCellRun> {
  const configResult = loadEffectiveConfig(cwd);
  if (!configResult.ok) throw new Error(`CONFIG_${configResult.reason}`);
  const routing = configResult.config.modelRouting;
  if (!routing) throw new Error('MODEL_ROUTING_CONFIG_MISSING');

  const configured = executionRole === 'FAST_EXECUTOR'
    ? {
        profileId: routing.fastModel.profileId,
        logicalModelName: routing.fastModel.modelLogicalName,
      }
    : {
        profileId: routing.strongModel.profileId,
        logicalModelName: routing.strongModel.modelLogicalName,
      };
  const run = await runWriterQualificationCandidateFixtures(
    configured,
    WRITER_DECISION_FIXTURES.filter(
      item => item.expectedNextActionClass === expectedActionClass,
    ),
    executionRole,
    cwd,
    parentEnv,
    deps,
  );
  if (run.samples.length !== 1) {
    throw new Error(`FIXTURE_NOT_FOUND:${expectedActionClass}`);
  }
  return {
    sample: run.samples[0],
    sampleFile: run.sampleFiles[0],
    benchmarkInvocationCount: 1,
    providerCallCount: run.providerCallCount,
  };
}

/**
 * Recomputes protocol and capability fields only from the safe persisted audit
 * projection. The historical sample object is never mutated.
 */
export function reclassifyWriterBenchmarkSample(
  sample: PersistedWriterBenchmarkSample,
): PersistedWriterBenchmarkSample {
  if (
    sample.verdict === 'BENCHMARK_UNAVAILABLE'
    || sample.providerErrorCategory !== null
    || sample.providerErrorCode !== null
  ) {
    return { ...sample, protocolValid: null, passed: false };
  }

  const derivedActionClasses = sample.toolNames.map(classifyWriterDecisionAction);
  const protocolInvalid = sample.containsInvalid
    || sample.actionClasses.includes('INVALID')
    || derivedActionClasses.includes('INVALID')
    || sample.toolCallCount !== sample.toolNames.length
    || sample.actionClasses.length !== sample.toolNames.length
    || sample.actionClasses.some((action, index) => action !== derivedActionClasses[index]);
  if (protocolInvalid) {
    return {
      ...sample,
      actualActionClass: 'INVALID',
      protocolValid: false,
      verdict: 'INVALID_PROTOCOL',
      reasonCode: 'PERSISTED_TOOL_PROTOCOL_INVALID',
      passed: false,
    };
  }

  if (sample.toolCallCount === 0) {
    if (sample.outputTokenLimitHit === true || sample.finishReason === 'length') {
      return {
        ...sample,
        actualActionClass: null,
        protocolValid: true,
        verdict: 'OUTPUT_TRUNCATED_NO_ACTION',
        reasonCode: 'OUTPUT_TOKEN_LIMIT_WITHOUT_ACTION',
        passed: false,
      };
    }
    if (sample.containsFinal || sample.actionClasses.includes('FINAL')) {
      return {
        ...sample,
        actualActionClass: 'FINAL',
        protocolValid: true,
        verdict: 'FAIL_NO_PROGRESS',
        reasonCode: `EXPECTED_${sample.expectedActionClass}_GOT_FINAL`,
        passed: false,
      };
    }
    return {
      ...sample,
      actualActionClass: null,
      protocolValid: true,
      verdict: 'NO_ACTION_RETURNED',
      reasonCode: 'EMPTY_MODEL_ACTION',
      passed: false,
    };
  }

  const capability = classifyWriterCapabilityActions(
    derivedActionClasses,
    sample.expectedActionClass,
  );
  return {
    ...sample,
    actionClasses: derivedActionClasses,
    containsRead: derivedActionClasses.includes('READ'),
    containsSearch: derivedActionClasses.includes('SEARCH'),
    containsWrite: derivedActionClasses.includes('WRITE'),
    containsFinal: false,
    containsInvalid: false,
    actualActionClass: capability.actualActionClass,
    protocolValid: true,
    verdict: capability.verdict,
    reasonCode: capability.reasonCode,
    passed: isPassingWriterVerdict(capability.verdict),
  };
}

export function summarizeWriterBenchmarkSamples(
  samples: PersistedWriterBenchmarkSample[],
): WriterBenchmarkProfileSummary[] {
  const grouped = new Map<string, PersistedWriterBenchmarkSample[]>();
  for (const rawSample of samples) {
    const sample = reclassifyWriterBenchmarkSample(rawSample);
    const key = `${sample.executionRole}\u0000${sample.profileId}`;
    const current = grouped.get(key) ?? [];
    current.push(sample);
    grouped.set(key, current);
  }

  return [...grouped.values()].map((profileSamples) => {
    const first = profileSamples[0];
    const behavior = Object.fromEntries(profileSamples.map(sample => [
      sample.expectedActionClass,
      {
        fixtureId: sample.fixtureId,
        expected: sample.expectedActionClass,
        actual: sample.actualActionClass,
        toolNames: [...sample.toolNames],
        actionClasses: [...sample.actionClasses],
        protocolValid: sample.protocolValid,
        verdict: sample.verdict,
        reasonCode: sample.reasonCode,
        passed: sample.passed,
        costRmb: sample.costRmb,
      } satisfies WriterBenchmarkBehaviorCell,
    ])) as WriterBenchmarkProfileSummary['behavior'];
    const pricedCosts = profileSamples
      .map(sample => sample.costRmb)
      .filter((cost): cost is number => cost !== null);

    return {
      profileId: first.profileId,
      executionRole: first.executionRole,
      behavior,
      passedFixtures: profileSamples.filter(sample => sample.passed).length,
      totalFixtures: profileSamples.length,
      providerCallCount: profileSamples.reduce(
        (total, sample) => total + sample.providerCallCount,
        0,
      ),
      totalCostRmb: pricedCosts.length === profileSamples.length
        ? pricedCosts.reduce((total, cost) => total + cost, 0)
        : null,
    };
  });
}

/**
 * 独立 benchmark 进程复用与 cc:auto CLI 相同的项目 env contract。
 * Env bootstrap 只存在于进程入口；benchmark core 不读取 env 文件。
 */
export async function runWriterBenchmarkProcess(
  cwd: string = process.cwd(),
  deps: Partial<WriterBenchmarkProcessDeps> = {},
): Promise<ConfiguredWriterBenchmarkRun> {
  const loadEnv = deps.loadEnv ?? loadProjectEnv;
  const runBenchmarks = deps.runBenchmarks ?? runConfiguredWriterModelProfileBenchmarks;
  loadEnv(cwd);
  return runBenchmarks(cwd, process.env);
}

export async function runWriterQualificationCandidateProcess(
  candidate: WriterQualificationCandidate,
  cwd: string = process.cwd(),
  deps: Partial<WriterQualificationCandidateProcessDeps> = {},
): Promise<ConfiguredWriterBenchmarkRun> {
  const loadEnv = deps.loadEnv ?? loadProjectEnv;
  const runBenchmarks = deps.runBenchmarks
    ?? runWriterQualificationCandidateBenchmarks;
  loadEnv(cwd);
  return runBenchmarks(candidate, cwd, process.env);
}

export async function runWriterBenchmarkCellProcess(
  executionRole: Extract<ExecutionModelRole, 'FAST_EXECUTOR' | 'STRONG_EXECUTOR'>,
  expectedActionClass: WriterExpectedActionClass,
  cwd: string = process.cwd(),
): Promise<ConfiguredWriterBenchmarkCellRun> {
  loadProjectEnv(cwd);
  return runConfiguredWriterModelProfileBenchmarkCell(
    executionRole,
    expectedActionClass,
    cwd,
    process.env,
  );
}

export function parseWriterQualificationCandidateArgs(
  args: readonly string[],
): WriterQualificationCandidate | null {
  if (args.length === 0) return null;

  let profileId: string | null = null;
  let logicalModelName: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('QUALIFICATION_CANDIDATE_ARGUMENT_VALUE_MISSING');
    }
    if (flag === '--profile' && profileId === null) {
      profileId = value;
      continue;
    }
    if (flag === '--model' && logicalModelName === null) {
      logicalModelName = value;
      continue;
    }
    throw new Error('QUALIFICATION_CANDIDATE_ARGUMENTS_INVALID');
  }

  if (profileId === null || logicalModelName === null) {
    throw new Error('QUALIFICATION_CANDIDATE_ARGUMENTS_INCOMPLETE');
  }
  return { profileId, logicalModelName };
}

async function main(): Promise<void> {
  const candidate = parseWriterQualificationCandidateArgs(process.argv.slice(2));
  const results = candidate
    ? await runWriterQualificationCandidateProcess(candidate)
    : await runWriterBenchmarkProcess();
  console.log(JSON.stringify(results, null, 2));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error: unknown) => {
    const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
    console.error(JSON.stringify({ ok: false, errorClass }));
    process.exitCode = 1;
  });
}
