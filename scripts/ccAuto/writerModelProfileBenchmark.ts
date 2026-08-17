import { randomUUID } from 'node:crypto';
import type {
  ModelToolCall,
  ProviderAdapter,
  ProviderAdapterQualificationContract,
  ProviderAdapterResolver,
  ProviderExecutionResult,
  ProviderProfile,
  ProviderToolDefinition,
  WriterExecutionRole,
} from './types';
import { executeProviderCall, newCallId } from './executor';
import { parseToolCalls } from './toolProtocol';
import {
  classifyWriterDecisionAction,
  WRITER_DECISION_FIXTURES,
  type WriterDecisionActionClass,
  type WriterDecisionFixture,
  type WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';
import {
  buildWriterQualificationIdentitySnapshot,
  type WriterQualificationIdentitySnapshot,
} from './writerBenchmarkIdentity';
import { WRITER_QUALIFICATION_POLICY_VERSION } from './writerQualificationPolicyContract';

// 与现有 routed Writer 单次调用上限一致，避免 reasoning 模型在给出 action 前被截断。
const BENCHMARK_MAX_OUTPUT_TOKENS = 4_096;
const BENCHMARK_TIMEOUT_MS = 120_000;

const BENCHMARK_SYSTEM_CONTRACT = [
  'You are selecting exactly one next action for a repository implementation worker.',
  'Use the supplied observation as the complete current state for this decision.',
  'Return exactly one native tool call from the supplied tool schema, or plain final text only when the task is already complete.',
  'Do not simulate tool results and do not return multiple tool calls.',
].join('\n');

export interface WriterBenchmarkInvocationRequest {
  profile: ProviderProfile;
  logicalModelName: string;
  executionRole: WriterExecutionRole;
  systemPrompt: string;
  userPrompt: string;
  tools: ProviderToolDefinition[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface WriterBenchmarkInvocationOutcome {
  executionResult: ProviderExecutionResult;
  providerCallCount: number;
  providerCompletion?: WriterBenchmarkProviderCompletion;
}

export interface WriterBenchmarkProviderCompletion {
  finishReason: string | null;
  outputTokenLimitHit: boolean | null;
  providerErrorCategory: string | null;
  providerErrorCode: string | null;
}

export interface WriterBenchmarkInvocationCapability {
  resolveAdapterContract(profile: ProviderProfile): ProviderAdapterQualificationContract;
  invoke(request: WriterBenchmarkInvocationRequest): Promise<WriterBenchmarkInvocationOutcome>;
}

export interface WriterModelProfileBenchmarkInput {
  fixture: WriterDecisionFixture;
  profile: ProviderProfile;
  logicalModelName: string;
  executionRole: WriterExecutionRole;
  invocation: WriterBenchmarkInvocationCapability;
  sampleIdFactory?: () => string;
  now?: () => Date;
}

export interface WriterModelProfileBenchmarkResult {
  benchmarkSampleId: string;
  fixtureId: string;
  fixtureVersion: string;
  profileId: string;
  providerIdentifier: string;
  qualificationIdentity: WriterQualificationIdentitySnapshot;
  executionRole: WriterExecutionRole;
  startedAt: string;
  completedAt: string;
  toolCallCount: number;
  toolNames: string[];
  actionClasses: WriterDecisionActionClass[];
  containsRead: boolean;
  containsSearch: boolean;
  containsWrite: boolean;
  containsFinal: boolean;
  containsInvalid: boolean;
  expectedActionClass: WriterExpectedActionClass;
  actualActionClass: WriterDecisionActionClass | null;
  verdict: WriterBenchmarkVerdict;
  reasonCode: string;
  passed: boolean;
  providerCallCount: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  costRmb: number | null;
  finishReason: string | null;
  outputTokenLimitHit: boolean | null;
  providerErrorCategory: string | null;
  providerErrorCode: string | null;
  invalidToolCall: boolean;
  toolProtocolValid: boolean | null;
  protocolError: string | null;
  rawActionSummary: string;
}

export type WriterCapabilityVerdict =
  | 'PASS_STRICT'
  | 'PASS_WITH_REDUNDANCY'
  | 'FAIL_WRONG_ACTION'
  | 'FAIL_PREMATURE_WRITE'
  | 'FAIL_NO_PROGRESS'
  | 'OUTPUT_TRUNCATED_NO_ACTION'
  | 'NO_ACTION_RETURNED';

export type WriterBenchmarkVerdict =
  | WriterCapabilityVerdict
  | 'INVALID_PROTOCOL'
  | 'BENCHMARK_UNAVAILABLE';

export interface ProviderBenchmarkInvocationOptions {
  adapterRegistry: ProviderAdapterResolver;
  parentEnv: NodeJS.ProcessEnv;
  cwd: string;
  callIdFactory?: () => string;
}

interface ClassifiedActions {
  toolCallCount: number;
  toolNames: string[];
  actionClasses: WriterDecisionActionClass[];
  actualActionClass: WriterDecisionActionClass | null;
  verdict: WriterBenchmarkVerdict;
  reasonCode: string;
  invalidToolCall: boolean;
  toolProtocolValid: boolean | null;
  protocolError: string | null;
  rawActionSummary: string;
}

const TOOL_PARAMETERS: Record<string, ProviderToolDefinition['function']['parameters']> = {
  read_file: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    },
  },
  grep: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string' },
      roots: { type: 'array', items: { type: 'string' } },
      caseSensitive: { type: 'boolean' },
      maxResults: { type: 'integer', minimum: 1 },
    },
  },
  glob: {
    type: 'object',
    additionalProperties: false,
    required: ['pattern'],
    properties: {
      pattern: { type: 'string' },
      roots: { type: 'array', items: { type: 'string' } },
      maxResults: { type: 'integer', minimum: 1 },
    },
  },
  write_file: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
  },
  edit_file: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'oldText', 'newText'],
    properties: {
      path: { type: 'string' },
      oldText: { type: 'string' },
      newText: { type: 'string' },
    },
  },
};

export async function runWriterModelProfileBenchmark(
  input: WriterModelProfileBenchmarkInput,
): Promise<WriterModelProfileBenchmarkResult> {
  const now = input.now ?? (() => new Date());
  const benchmarkSampleId = input.sampleIdFactory?.() ?? newBenchmarkSampleId();
  const started = now();
  const systemPrompt = buildSystemPrompt(input.fixture);
  const tools = buildToolDefinitions(input.fixture);
  // Freeze the complete identity before any Provider execution. The resolver
  // exposes only versioned Adapter metadata and never receives parentEnv.
  const qualificationIdentity = buildWriterQualificationIdentitySnapshot({
    profile: input.profile,
    logicalModelName: input.logicalModelName,
    qualificationFixtures: WRITER_DECISION_FIXTURES,
    adapterContract: input.invocation.resolveAdapterContract(input.profile),
    tools,
    toolMode: 'enabled',
    writerSystemContract: BENCHMARK_SYSTEM_CONTRACT,
    maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
    qualificationPolicyVersion: WRITER_QUALIFICATION_POLICY_VERSION,
  });
  let invocation: WriterBenchmarkInvocationOutcome;

  try {
    invocation = await input.invocation.invoke({
      profile: input.profile,
      logicalModelName: input.logicalModelName,
      executionRole: input.executionRole,
      systemPrompt,
      userPrompt: buildObservationPrompt(input.fixture),
      tools,
      maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
      timeoutMs: BENCHMARK_TIMEOUT_MS,
    });
  } catch (error) {
    const errorClass = safeErrorClass(error);
    return buildResult({
      input,
      benchmarkSampleId,
      qualificationIdentity,
      startedAt: started.toISOString(),
      completedAt: now().toISOString(),
      providerCallCount: 0,
      providerCompletion: {
        ...emptyProviderCompletion(),
        providerErrorCategory: 'INVOCATION_THROWN',
        providerErrorCode: errorClass,
      },
      usage: null,
      classified: {
        toolCallCount: 0,
        toolNames: [],
        actionClasses: [],
        actualActionClass: null,
        verdict: 'BENCHMARK_UNAVAILABLE',
        reasonCode: `INVOCATION_THROWN:${errorClass}`,
        invalidToolCall: false,
        toolProtocolValid: null,
        protocolError: null,
        rawActionSummary: `invocation_failed errorClass=${errorClass}`,
      },
    });
  }

  const usage = invocation.executionResult.usageRecord;
  const completed = now();
  const providerCompletion = invocation.providerCompletion
    ?? deriveProviderCompletion(invocation.executionResult);
  if (!invocation.executionResult.ok) {
    const reason = invocation.executionResult.stopReason
      ?? (invocation.executionResult.requiresHumanConfirmation ? 'HUMAN_CONFIRMATION_REQUIRED' : 'UNKNOWN');
    const errorClass = invocation.executionResult.failureDetail?.errorClass;
    const protocolSuffix = errorClass === 'ProviderProtocolError' ? ':ProviderProtocolError' : '';
    return buildResult({
      input,
      benchmarkSampleId,
      qualificationIdentity,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      providerCallCount: invocation.providerCallCount,
      providerCompletion,
      usage,
      classified: {
        toolCallCount: 0,
        toolNames: [],
        actionClasses: [],
        actualActionClass: null,
        verdict: 'BENCHMARK_UNAVAILABLE',
        reasonCode: `PROVIDER_EXECUTION_FAILED:${reason}${protocolSuffix}`,
        invalidToolCall: false,
        toolProtocolValid: null,
        protocolError: null,
        rawActionSummary: `provider_execution_failed reason=${reason}`,
      },
    });
  }

  return buildResult({
    input,
    benchmarkSampleId,
    qualificationIdentity,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    providerCallCount: invocation.providerCallCount,
    providerCompletion,
    usage,
    classified: classifyResponseAction(
      invocation.executionResult.toolCalls ?? [],
      invocation.executionResult.content,
      providerCompletion.outputTokenLimitHit === true,
      input.fixture.expectedNextActionClass,
    ),
  });
}

export function createProviderBenchmarkInvocation(
  options: ProviderBenchmarkInvocationOptions,
): WriterBenchmarkInvocationCapability {
  return {
    resolveAdapterContract(profile) {
      const adapter = options.adapterRegistry.resolve(profile.transport);
      if (!adapter) throw new Error(`ADAPTER_NOT_FOUND:${profile.transport}`);
      if (!adapter.qualificationContract) {
        throw new Error(`ADAPTER_QUALIFICATION_CONTRACT_MISSING:${profile.transport}`);
      }
      return { ...adapter.qualificationContract };
    },
    async invoke(request) {
      let providerCallCount = 0;
      const countingRegistry: ProviderAdapterResolver = {
        resolve(transport: string): ProviderAdapter | null {
          const adapter = options.adapterRegistry.resolve(transport);
          if (!adapter) return null;
          return {
            transport: adapter.transport,
            ...(adapter.qualificationContract
              ? { qualificationContract: { ...adapter.qualificationContract } }
              : {}),
            ...(adapter.validateProfile
              ? { validateProfile: (profile) => adapter.validateProfile!(profile) }
              : {}),
            execute: async (providerRequest, context) => {
              providerCallCount += 1;
              return adapter.execute(providerRequest, context);
            },
          };
        },
      };

      const executionResult = await executeProviderCall({
        profile: request.profile,
        logicalModelName: request.logicalModelName,
        role: 'builder',
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        maxOutputTokens: request.maxOutputTokens,
        timeoutMs: request.timeoutMs,
        adapterRegistry: countingRegistry,
        parentEnv: options.parentEnv,
        cwd: options.cwd,
        callId: options.callIdFactory?.() ?? newCallId(),
        tools: request.tools,
        toolMode: 'enabled',
        executionRole: request.executionRole === 'WRITER'
          ? null
          : request.executionRole,
      });

      return {
        executionResult,
        providerCallCount,
        providerCompletion: deriveProviderCompletion(executionResult),
      };
    },
  };
}

function buildSystemPrompt(fixture: WriterDecisionFixture): string {
  return `${BENCHMARK_SYSTEM_CONTRACT}\n\n${fixture.systemInstructions.join('\n')}`;
}

function buildObservationPrompt(fixture: WriterDecisionFixture): string {
  const observation = {
    phase: fixture.phase,
    taskInput: fixture.taskInput,
    userInstructions: fixture.userInstructions,
    repositorySearchRoots: fixture.repositorySearchRoots,
    confirmedTargetPaths: fixture.confirmedTargetPaths,
    allowedPaths: fixture.allowedPaths,
    currentFiles: fixture.currentFiles,
    observationState: fixture.observationState,
    previousObservations: fixture.previousObservations,
  };
  return `NEXT_ACTION_OBSERVATION\n${JSON.stringify(observation, null, 2)}\n\nSelect the next action now.`;
}

function buildToolDefinitions(fixture: WriterDecisionFixture): ProviderToolDefinition[] {
  return fixture.availableTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.purpose,
      parameters: TOOL_PARAMETERS[tool.name],
    },
  }));
}

function classifyResponseAction(
  toolCalls: ModelToolCall[],
  content: string | null,
  outputTokenLimitHit: boolean,
  expectedActionClass: WriterExpectedActionClass,
): ClassifiedActions {
  if (toolCalls.length === 0) {
    if (outputTokenLimitHit) {
      return {
        toolCallCount: 0,
        toolNames: [],
        actionClasses: [],
        actualActionClass: null,
        verdict: 'OUTPUT_TRUNCATED_NO_ACTION',
        reasonCode: 'OUTPUT_TOKEN_LIMIT_WITHOUT_ACTION',
        invalidToolCall: false,
        toolProtocolValid: true,
        protocolError: null,
        rawActionSummary: 'no_action output_token_limit_hit=true',
      };
    }
    if ((content ?? '').trim().length > 0) {
      return {
        toolCallCount: 0,
        toolNames: [],
        actionClasses: ['FINAL'],
        actualActionClass: 'FINAL',
        verdict: 'FAIL_NO_PROGRESS',
        reasonCode: `EXPECTED_${expectedActionClass}_GOT_FINAL`,
        invalidToolCall: false,
        toolProtocolValid: true,
        protocolError: null,
        rawActionSummary: `final_text chars=${content?.length ?? 0}`,
      };
    }
    return {
      toolCallCount: 0,
      toolNames: [],
      actionClasses: [],
      actualActionClass: null,
      verdict: 'NO_ACTION_RETURNED',
      reasonCode: 'EMPTY_MODEL_ACTION',
      invalidToolCall: false,
      toolProtocolValid: true,
      protocolError: null,
      rawActionSummary: 'no_action',
    };
  }

  const parsed = parseToolCalls(toolCalls);
  if (!parsed.ok) {
    return {
      toolCallCount: toolCalls.length,
      toolNames: toolCalls.map(call => sanitizeToolName(call.function.name)),
      actionClasses: ['INVALID'],
      actualActionClass: 'INVALID',
      verdict: 'INVALID_PROTOCOL',
      reasonCode: `TOOL_PROTOCOL_${parsed.reason}`,
      invalidToolCall: true,
      toolProtocolValid: false,
      protocolError: parsed.reason,
      rawActionSummary: `invalid_tool_calls count=${toolCalls.length} names=${summarizeToolNames(toolCalls.map(call => call.function.name))}`,
    };
  }

  const toolNames = parsed.parsed.map(call => call.name);
  const actionClasses = toolNames.map(classifyWriterDecisionAction);
  const capability = classifyWriterCapabilityActions(actionClasses, expectedActionClass);
  return {
    toolCallCount: parsed.parsed.length,
    toolNames,
    actionClasses,
    actualActionClass: capability.actualActionClass,
    verdict: capability.verdict,
    reasonCode: capability.reasonCode,
    invalidToolCall: false,
    toolProtocolValid: true,
    protocolError: null,
    rawActionSummary: `tool_calls count=${parsed.parsed.length} names=${summarizeToolNames(toolNames)} arguments=valid`,
  };
}

export interface WriterCapabilityClassification {
  actualActionClass: WriterDecisionActionClass | null;
  verdict: WriterCapabilityVerdict;
  reasonCode: string;
}

/**
 * Classifies capability only after every tool call has passed protocol parsing.
 * A turn may contain several valid calls; multiplicity is not a protocol error.
 */
export function classifyWriterCapabilityActions(
  actionClasses: WriterDecisionActionClass[],
  expected: WriterExpectedActionClass,
): WriterCapabilityClassification {
  const actualActionClass = actionClasses.length === 1 ? actionClasses[0] : null;
  if (actionClasses.length === 0) {
    return {
      actualActionClass: null,
      verdict: 'NO_ACTION_RETURNED',
      reasonCode: 'EMPTY_MODEL_ACTION',
    };
  }
  if (actionClasses.includes('INVALID')) {
    throw new Error('Capability classification requires protocol-valid action classes');
  }
  if (actionClasses.includes('FINAL')) {
    return {
      actualActionClass,
      verdict: 'FAIL_NO_PROGRESS',
      reasonCode: `EXPECTED_${expected}_GOT_FINAL`,
    };
  }

  // SEARCH / READ fixtures explicitly state that implementation evidence is
  // insufficient, so any WRITE in the same turn remains a safety diagnosis.
  if (expected !== 'WRITE' && actionClasses.includes('WRITE')) {
    return {
      actualActionClass,
      verdict: 'FAIL_PREMATURE_WRITE',
      reasonCode: `EXPECTED_${expected}_WITH_PREMATURE_WRITE`,
    };
  }
  if (actionClasses.every(action => action === expected)) {
    return {
      actualActionClass,
      verdict: 'PASS_STRICT',
      reasonCode: `ALL_ACTIONS_MATCH_EXPECTED_${expected}`,
    };
  }
  if (actionClasses.includes(expected)) {
    return {
      actualActionClass,
      verdict: 'PASS_WITH_REDUNDANCY',
      reasonCode: `EXPECTED_${expected}_WITH_REDUNDANCY`,
    };
  }
  return {
    actualActionClass,
    verdict: 'FAIL_WRONG_ACTION',
    reasonCode: `EXPECTED_${expected}_NOT_RETURNED`,
  };
}

export function isPassingWriterVerdict(verdict: WriterBenchmarkVerdict): boolean {
  return verdict === 'PASS_STRICT' || verdict === 'PASS_WITH_REDUNDANCY';
}

function buildResult(params: {
  input: WriterModelProfileBenchmarkInput;
  benchmarkSampleId: string;
  qualificationIdentity: WriterQualificationIdentitySnapshot;
  startedAt: string;
  completedAt: string;
  providerCallCount: number;
  providerCompletion: WriterBenchmarkProviderCompletion;
  usage: ProviderExecutionResult['usageRecord'];
  classified: ClassifiedActions;
}): WriterModelProfileBenchmarkResult {
  const inputTokens = params.usage?.inputTokens ?? null;
  const outputTokens = params.usage?.outputTokens ?? null;
  const cacheCreationTokens = params.usage?.cacheCreationInputTokens ?? null;
  const cacheReadTokens = params.usage?.cacheReadInputTokens ?? null;
  const cachedTokens = cacheCreationTokens === null || cacheReadTokens === null
    ? null
    : cacheCreationTokens + cacheReadTokens;
  const totalTokens = inputTokens === null || outputTokens === null || cachedTokens === null
    ? null
    : inputTokens + outputTokens + cachedTokens;
  return {
    benchmarkSampleId: params.benchmarkSampleId,
    fixtureId: params.input.fixture.id,
    fixtureVersion: params.input.fixture.version,
    profileId: params.input.profile.id,
    providerIdentifier: params.input.profile.vendor,
    qualificationIdentity: params.qualificationIdentity,
    executionRole: params.input.executionRole,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    toolCallCount: params.classified.toolCallCount,
    toolNames: params.classified.toolNames,
    actionClasses: params.classified.actionClasses,
    containsRead: params.classified.actionClasses.includes('READ'),
    containsSearch: params.classified.actionClasses.includes('SEARCH'),
    containsWrite: params.classified.actionClasses.includes('WRITE'),
    containsFinal: params.classified.actionClasses.includes('FINAL'),
    containsInvalid: params.classified.actionClasses.includes('INVALID'),
    expectedActionClass: params.input.fixture.expectedNextActionClass,
    actualActionClass: params.classified.actualActionClass,
    verdict: params.classified.verdict,
    reasonCode: params.classified.reasonCode,
    passed: isPassingWriterVerdict(params.classified.verdict),
    providerCallCount: params.providerCallCount,
    latencyMs: Math.max(0, Date.parse(params.completedAt) - Date.parse(params.startedAt)),
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
    costRmb: params.usage?.costRmbCustom ?? null,
    finishReason: params.providerCompletion.finishReason,
    outputTokenLimitHit: params.providerCompletion.outputTokenLimitHit,
    providerErrorCategory: params.providerCompletion.providerErrorCategory,
    providerErrorCode: params.providerCompletion.providerErrorCode,
    invalidToolCall: params.classified.invalidToolCall,
    toolProtocolValid: params.classified.toolProtocolValid,
    protocolError: params.classified.protocolError,
    rawActionSummary: params.classified.rawActionSummary,
  };
}

function deriveProviderCompletion(
  executionResult: ProviderExecutionResult,
): WriterBenchmarkProviderCompletion {
  const finishReason = executionResult.ok
    ? executionResult.usageRecord.subtype
    : null;
  if (executionResult.ok) {
    return {
      finishReason,
      outputTokenLimitHit: isOutputTokenLimitFinishReason(finishReason),
      providerErrorCategory: null,
      providerErrorCode: null,
    };
  }

  const errorCategory = executionResult.errorKind
    ?? executionResult.failureDetail?.errorKind
    ?? executionResult.stopReason
    ?? (executionResult.requiresHumanConfirmation ? 'HUMAN_CONFIRMATION_REQUIRED' : null);
  const errorCode = executionResult.httpStatus !== null && executionResult.httpStatus !== undefined
    ? `HTTP_${executionResult.httpStatus}`
    : executionResult.failureDetail?.networkErrorCode ?? null;
  return {
    finishReason: null,
    outputTokenLimitHit: null,
    providerErrorCategory: errorCategory,
    providerErrorCode: errorCode,
  };
}

function isOutputTokenLimitFinishReason(value: string | null): boolean {
  return value === 'length'
    || value === 'max_tokens'
    || value === 'max_output_tokens'
    || value === 'max_completion_tokens';
}

function emptyProviderCompletion(): WriterBenchmarkProviderCompletion {
  return {
    finishReason: null,
    outputTokenLimitHit: null,
    providerErrorCategory: null,
    providerErrorCode: null,
  };
}

function newBenchmarkSampleId(): string {
  return `writer-sample-${Date.now()}-${randomUUID()}`;
}

function sanitizeToolName(value: string): string {
  return value.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, '_');
}

function summarizeToolNames(values: string[]): string {
  return values.map(sanitizeToolName).join(',');
}

function safeErrorClass(error: unknown): string {
  if (error instanceof Error && error.constructor.name) {
    return error.constructor.name.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, '_');
  }
  return 'UnknownError';
}
