#!/usr/bin/env node
/**
 * cc-auto PreToolUse 安全钩子。以 CommonJS + 零依赖实现，便于用固定相对路径通过
 * `claude --settings '<inline JSON>'` 直接引用，不依赖 tsx/ts-node 运行时。
 * 读 stdin 的 hook 事件 JSON，命中高风险规则则输出 deny 决策并 exit 0；否则不输出、exit 0。
 */
const path = require('node:path');

function readStdin() {
  const fs = require('node:fs');
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const DENY_COMMAND_RULES = [
  { pattern: /git\s+push\s+[^\n]*(--force|-f\b)/i, reason: '禁止 git push --force / -f（强推）' },
  { pattern: /git\s+push\s+[^\n]*\borigin\s+main\b/i, reason: '禁止直接 push main，需用户单独授权' },
  { pattern: /git\s+reset\s+--hard/i, reason: '禁止 git reset --hard' },
  { pattern: /git\s+clean\s+-[a-z]*f/i, reason: '禁止 git clean -f 系列（不可逆删除）' },
  { pattern: /git\s+branch\s+-D\b/i, reason: '禁止强制删除分支 (-D)' },
  { pattern: /git\s+tag\b/i, reason: '禁止创建/删除 Git Tag，需用户单独授权' },
  { pattern: /\brm\s+-rf?\s+[^\n]*\/(?!\.cc-auto|tmp\/)/i, reason: '禁止对仓库外/非临时目录执行 rm -rf' },
  { pattern: /drop\s+table|drop\s+database/i, reason: '禁止 DROP TABLE / DROP DATABASE' },
  { pattern: /data[\\/]offerflow\.sqlite3\b/i, reason: '禁止直接操作生产 SQLite 文件' },
  { pattern: /gh\s+pr\s+create/i, reason: '禁止自动创建 PR（个人项目默认不建 PR）' },
  { pattern: /\.env\b/i, reason: '禁止读写 .env 系列文件' },
];

const DENY_PATH_RULES = [
  { pattern: /data[\\/]offerflow\.sqlite3/i, reason: '禁止直接写生产 SQLite 文件' },
  { pattern: /(^|[\\/])\.env(\.|$)/i, reason: '禁止写 .env 系列文件' },
  { pattern: /server[\\/]schema\.ts$/i, reason: '禁止未经授权修改数据库 schema' },
];

function denyDecision(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `cc-auto 安全钩子拦截：${reason}`,
    },
  }));
}

function main() {
  const stdin = readStdin();
  let event;
  try {
    event = JSON.parse(stdin || '{}');
  } catch {
    process.exit(0); // 无法解析事件时不拦截，交由上层正常权限流程处理
  }

  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : (typeof toolInput.path === 'string' ? toolInput.path : '');

  if (command) {
    for (const rule of DENY_COMMAND_RULES) {
      if (rule.pattern.test(command)) {
        denyDecision(rule.reason);
        process.exit(0);
      }
    }
  }

  if (filePath && (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit')) {
    for (const rule of DENY_PATH_RULES) {
      if (rule.pattern.test(filePath)) {
        denyDecision(rule.reason);
        process.exit(0);
      }
    }
  }

  process.exit(0); // 未命中任何规则：不输出，交由正常权限流程处理
}

main();
