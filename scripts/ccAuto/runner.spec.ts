import { expect, it, describe, afterEach } from 'vitest';
import { buildArgs, verifyClaudeBinary, type ClaudeCallOptions } from './runner';
import type { ModelRuleConfig } from './config';

const RULE: ModelRuleConfig = { model: 'claude-haiku-4-5', effort: 'low', maxTurns: 6 };

/** 取 --flag 后紧跟的值（buildArgs 输出为扁平的 [flag, value, ...] 数组）。 */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function optionsFor(role: ClaudeCallOptions['role'], extra: Partial<ClaudeCallOptions> = {}): ClaudeCallOptions {
  return { prompt: 'p', role, rule: RULE, tools: [], cwd: '/tmp', ...extra };
}

// 三角色的真实参数形态：Scout/Builder 用 isolateContext（不 --bare），Arbiter 用 --bare。
const SCOUT = optionsFor('scout', { tools: ['Read', 'Grep', 'Glob'], appendSystemPrompt: '【scout】所有报告使用简体中文。', isolateContext: true });
const BUILDER = optionsFor('builder', { tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], appendSystemPrompt: '【builder】所有报告使用简体中文。', settingsInlineJson: '{"hooks":{"PreToolUse":[]}}', isolateContext: true });
const ARBITER = optionsFor('arbiter', { tools: [], appendSystemPrompt: '【arbiter】所有报告使用简体中文。', bare: true });

const ISOLATION_FLAGS = ['--strict-mcp-config', '--disable-slash-commands', '--no-chrome', '--no-session-persistence'];

describe('buildArgs：按角色的隔离与显式上下文注入', () => {
  it('Scout / Builder 不含 --bare（--bare 下工具不可执行）', () => {
    expect(buildArgs(SCOUT)).not.toContain('--bare');
    expect(buildArgs(BUILDER)).not.toContain('--bare');
  });

  it('Arbiter 仍含 --bare（tools 为空 + 临时目录隔离）', () => {
    expect(buildArgs(ARBITER)).toContain('--bare');
  });

  it('Scout / Builder 含空 MCP 严格配置、禁用命令、no-chrome、no-session-persistence', () => {
    for (const opts of [SCOUT, BUILDER]) {
      const args = buildArgs(opts);
      for (const flag of ISOLATION_FLAGS) expect(args).toContain(flag);
      expect(flagValue(args, '--mcp-config')).toBe('{"mcpServers":{}}');
    }
  });

  it('Arbiter 不带有工具角色的隔离标志（其隔离靠 --bare + 临时目录）', () => {
    const args = buildArgs(ARBITER);
    for (const flag of ISOLATION_FLAGS) expect(args).not.toContain(flag);
  });

  it('三角色都显式传入对应 --append-system-prompt（含简体中文规则）', () => {
    for (const opts of [SCOUT, BUILDER, ARBITER]) {
      const args = buildArgs(opts);
      expect(args).toContain('--append-system-prompt');
      expect(flagValue(args, '--append-system-prompt')).toContain('简体中文');
    }
  });

  it('Builder 仍显式传入 --settings（安全 Hook 内联 JSON）', () => {
    const args = buildArgs(BUILDER);
    expect(args).toContain('--settings');
    expect(flagValue(args, '--settings')).toBe('{"hooks":{"PreToolUse":[]}}');
  });

  it('Scout / Arbiter 不含 --settings', () => {
    expect(buildArgs(SCOUT)).not.toContain('--settings');
    expect(buildArgs(ARBITER)).not.toContain('--settings');
  });

  it('各角色工具列表保持原约束', () => {
    expect(flagValue(buildArgs(SCOUT), '--tools')).toBe('Read,Grep,Glob');
    expect(flagValue(buildArgs(BUILDER), '--tools')).toBe('Read,Edit,Write,Bash,Grep,Glob');
    expect(flagValue(buildArgs(ARBITER), '--tools')).toBe('');
  });
});

describe('verifyClaudeBinary：Windows 可执行文件校验（不发起任何真实模型调用，仅 --version 探活）', () => {
  const ORIGINAL_BIN = process.env.CC_AUTO_CLAUDE_BIN;

  afterEach(() => {
    if (ORIGINAL_BIN === undefined) delete process.env.CC_AUTO_CLAUDE_BIN;
    else process.env.CC_AUTO_CLAUDE_BIN = ORIGINAL_BIN;
  });

  it('CC_AUTO_CLAUDE_BIN 指向不存在的可执行文件时返回 ok=false 且带 error', () => {
    process.env.CC_AUTO_CLAUDE_BIN = 'D:/definitely-not-a-real-claude-binary-xyz.exe';
    const result = verifyClaudeBinary();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('未设置 CC_AUTO_CLAUDE_BIN 时默认使用裸命令名 "claude"（不拼接 shell、不使用 shell:true）', () => {
    delete process.env.CC_AUTO_CLAUDE_BIN;
    // 仅验证「未设置时退回默认值」这一契约本身可执行且不抛异常；
    // 是否真的存在全局 claude 由运行环境决定，不在此处断言具体 ok 值。
    expect(() => verifyClaudeBinary()).not.toThrow();
  });
});
