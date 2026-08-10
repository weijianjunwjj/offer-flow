/** 实际拉起全局 claude CLI 的封装：仅本模块知道如何 spawn 子进程。 */
import { spawn, spawnSync } from 'node:child_process';
import type { CallUsage, ModelRole } from './types';
import type { ModelRuleConfig, CcAutoConfig } from './config';
import { usdToRmb, customRmbCost } from './budget';

/** 在启动任何模型调用前验证 claude 可执行文件能否启动。 */
export function verifyClaudeBinary(): { ok: boolean; error?: string } {
  const claudeBin = process.env.CC_AUTO_CLAUDE_BIN || 'claude';
  try {
    const result = spawnSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (result.error) return { ok: false, error: `spawn ${claudeBin}: ${result.error.message}` };
    if (result.status !== 0) return { ok: false, error: `${claudeBin} --version 退出码 ${result.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface ClaudeCallOptions {
  prompt: string;
  role: ModelRole;
  rule: ModelRuleConfig;
  tools: string[];
  appendSystemPrompt?: string;
  jsonSchema?: object;
  settingsInlineJson?: string;
  /** 仅供无工具、临时目录隔离的 Arbiter 使用：--bare 最小模式。有工具角色不可用（会导致工具无法执行）。 */
  bare?: boolean;
  /** 有工具角色（Builder/Scout）的上下文隔离：禁用 MCP/Skills/Chrome/会话持久化，同时保留工具可执行。 */
  isolateContext?: boolean;
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
  /** 若 CLI 返回完整 conversation（实验性），用于提取可观测性元数据；不持久化完整 transcript */
  conversation?: Array<{ role: string; content?: string | ConversationContentBlock[] }>;
}

interface ConversationContentBlock {
  type: string;
  name?: string;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

export function buildArgs(options: ClaudeCallOptions): string[] {
  const args: string[] = [];
  // --bare：最小模式，跳过 hooks/自动记忆/CLAUDE.md 自动发现等。经验证：--bare 下内置工具无法执行，
  // 故仅供 tools 为空的 Arbiter 使用；有工具角色改用下方 isolateContext 做等效的上下文隔离。
  if (options.bare) args.push('--bare');
  // 有工具角色（Builder/Scout）的上下文隔离：不继承 GUI 的 MCP/Skills/Chrome/会话，但保留工具可执行。
  if (options.isolateContext) {
    args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-chrome', '--no-session-persistence');
  }
  args.push(
    '-p', options.prompt,
    '--model', options.rule.model,
    '--effort', options.rule.effort,
    '--max-turns', String(options.rule.maxTurns),
    '--output-format', 'json',
    '--tools', options.tools.join(','),
  );
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.jsonSchema) args.push('--json-schema', JSON.stringify(options.jsonSchema));
  if (options.settingsInlineJson) args.push('--settings', options.settingsInlineJson);
  return args;
}

function extractObservability(raw: RawClaudeResult): Pick<CallUsage, 'toolUseCounts' | 'toolErrorCounts' | 'mcpServers' | 'lastAssistantTextSummary'> {
  const toolUseCounts: Record<string, number> = {};
  const toolErrorCounts: Record<string, number> = {};
  let lastAssistantText = '';

  if (raw.conversation && Array.isArray(raw.conversation)) {
    for (const turn of raw.conversation) {
      if (turn.role === 'assistant' && typeof turn.content === 'string') {
        lastAssistantText = turn.content;
      } else if (turn.role === 'assistant' && Array.isArray(turn.content)) {
        for (const block of turn.content) {
          if (block.type === 'tool_use' && block.name) {
            toolUseCounts[block.name] = (toolUseCounts[block.name] ?? 0) + 1;
          } else if (block.type === 'text' && typeof block.text === 'string') {
            lastAssistantText = block.text;
          }
        }
      } else if (turn.role === 'user' && Array.isArray(turn.content)) {
        for (const block of turn.content) {
          if (block.type === 'tool_result' && block.is_error) {
            const name = block.tool_use_id || 'unknown';
            toolErrorCounts[name] = (toolErrorCounts[name] ?? 0) + 1;
          }
        }
      }
    }
  }

  return {
    toolUseCounts: Object.keys(toolUseCounts).length > 0 ? toolUseCounts : undefined,
    toolErrorCounts: Object.keys(toolErrorCounts).length > 0 ? toolErrorCounts : undefined,
    mcpServers: undefined, // CLI 不暴露 MCP server 列表，isolateContext 已确保无 MCP
    lastAssistantTextSummary: lastAssistantText.slice(0, 300) || undefined,
  };
}

function toUsage(role: ModelRole, configuredModelId: string, raw: RawClaudeResult, config: CcAutoConfig): { usage: CallUsage; pricingError?: { modelId: string } } {
  const costUsd = raw.total_cost_usd ?? 0;
  // 定价以「实际返回的模型 ID」为准；CLI 未回传时退回配置模型。未知模型不猜默认价，记为 UNPRICED。
  const modelId = raw.model ?? configuredModelId;
  const tokens = {
    inputTokens: raw.usage?.input_tokens ?? null,
    outputTokens: raw.usage?.output_tokens ?? null,
    cacheCreationInputTokens: raw.usage?.cache_creation_input_tokens ?? null,
    cacheReadInputTokens: raw.usage?.cache_read_input_tokens ?? null,
  };
  // customRmbCost 要求 number，unknown → 0 对费用计算是安全的（无使用量=无费用）
  const costTokens = {
    inputTokens: tokens.inputTokens ?? 0,
    outputTokens: tokens.outputTokens ?? 0,
    cacheCreationInputTokens: tokens.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: tokens.cacheReadInputTokens ?? 0,
  };
  const costRmbOfficial = usdToRmb(costUsd, config);
  const customResult = customRmbCost(modelId, costTokens, config);
  const observability = extractObservability(raw);
  const usage: CallUsage = {
    callId: 'legacy',
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
    subtype: raw.subtype ?? 'unknown',
    isError: raw.is_error ?? false,
    permissionDenialsCount: raw.permission_denials?.length ?? 0,
    ...observability,
  };
  if (!customResult.ok) return { usage, pricingError: { modelId: customResult.unknownModelId! } };
  return { usage };
}

/** 拉起 `claude -p ...` 子进程，收集 stdout，解析末尾的 result JSON。 */
export function runClaude(options: ClaudeCallOptions, config: CcAutoConfig): Promise<ClaudeCallResult> {
  const claudeBin = process.env.CC_AUTO_CLAUDE_BIN || 'claude';
  const args = buildArgs(options);
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(claudeBin, args, {
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
