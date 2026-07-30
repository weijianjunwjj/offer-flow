/** 实际拉起全局 claude CLI 的封装：仅本模块知道如何 spawn 子进程。 */
import { spawn } from 'node:child_process';
import type { CallUsage, ModelRole } from './types';
import type { ModelRuleConfig, CcAutoConfig } from './config';
import { usdToRmb, customRmbCost } from './budget';

export interface ClaudeCallOptions {
  prompt: string;
  role: ModelRole;
  rule: ModelRuleConfig;
  tools: string[];
  appendSystemPrompt?: string;
  jsonSchema?: object;
  settingsInlineJson?: string;
  cwd: string;
  timeoutMs?: number;
}

export interface ClaudeCallResult {
  raw: unknown;
  resultText: string;
  structuredOutput: unknown;
  isError: boolean;
  subtype: string;
  usage: CallUsage;
  permissionDenials: Array<{ tool_name: string; tool_input: unknown }>;
  /** 返回的模型 ID 未在第三方渠道价格表中时携带此字段；调用方必须立即停止（PRICING_NOT_FOUND），不得使用 usage 中的费用。 */
  pricingError?: { modelId: string };
}

interface RawClaudeResult {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  /** CLI 返回的实际模型 ID（若有）；与配置模型可能不同，定价须以实际模型为准。 */
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  structured_output?: unknown;
  permission_denials?: Array<{ tool_name: string; tool_input: unknown }>;
}

function buildArgs(options: ClaudeCallOptions): string[] {
  const args = [
    '-p', options.prompt,
    '--model', options.rule.model,
    '--effort', options.rule.effort,
    '--max-turns', String(options.rule.maxTurns),
    '--output-format', 'json',
    '--tools', options.tools.join(','),
  ];
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.jsonSchema) args.push('--json-schema', JSON.stringify(options.jsonSchema));
  if (options.settingsInlineJson) args.push('--settings', options.settingsInlineJson);
  return args;
}

function toUsage(role: ModelRole, configuredModelId: string, raw: RawClaudeResult, config: CcAutoConfig): { usage: CallUsage; pricingError?: { modelId: string } } {
  const costUsd = raw.total_cost_usd ?? 0;
  // 定价以「实际返回的模型 ID」为准；CLI 未回传时退回配置模型。未知模型不猜默认价，记为 UNPRICED。
  const modelId = raw.model ?? configuredModelId;
  const tokens = {
    inputTokens: raw.usage?.input_tokens ?? 0,
    outputTokens: raw.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: raw.usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: raw.usage?.cache_read_input_tokens ?? 0,
  };
  const costRmbOfficial = usdToRmb(costUsd, config);
  const customResult = customRmbCost(modelId, tokens, config);
  const usage: CallUsage = {
    model: role,
    modelId,
    ...tokens,
    costUsd,
    costRmbOfficial,
    // 无法定价时费用为 null（绝不写成 0），只保留 token 与官方参考费用等可观测事实。
    costRmbCustom: customResult.ok ? customResult.cost : null,
    costRmb: customResult.ok ? customResult.cost : null,
    durationMs: raw.duration_ms ?? 0,
    numTurns: raw.num_turns ?? 0,
    pricingStatus: customResult.ok ? 'PRICED' : 'UNPRICED',
  };
  if (!customResult.ok) return { usage, pricingError: { modelId: customResult.unknownModelId! } };
  return { usage };
}

/** 拉起 `claude -p ...` 子进程，收集 stdout，解析末尾的 result JSON。 */
export function runClaude(options: ClaudeCallOptions, config: CcAutoConfig): Promise<ClaudeCallResult> {
  const args = buildArgs(options);
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI 调用超时（${timeoutMs}ms），role=${options.role}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', () => {
      clearTimeout(timer);
      try {
        const raw = JSON.parse(stdout.trim()) as RawClaudeResult;
        const { usage, pricingError } = toUsage(options.role, options.rule.model, raw, config);
        resolvePromise({
          raw,
          resultText: raw.result ?? '',
          structuredOutput: raw.structured_output,
          isError: raw.is_error ?? false,
          subtype: raw.subtype ?? 'unknown',
          usage,
          permissionDenials: raw.permission_denials ?? [],
          ...(pricingError ? { pricingError } : {}),
        });
      } catch (err) {
        reject(new Error(`解析 claude CLI 输出失败：${(err as Error).message}；stderr=${stderr.slice(0, 500)}`));
      }
    });
  });
}
