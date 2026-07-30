/** 高风险命令检测：供 PreToolUse 钩子和编排器共用的纯函数规则。 */

export interface SafetyMatch {
  denied: boolean;
  reason?: string;
}

/** 针对 Bash/PowerShell 等命令类工具的 command 字段做检测。 */
const DENY_RULES: Array<{ pattern: RegExp; reason: string }> = [
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

/** 针对 Write/Edit 等文件写入类工具的目标路径做检测。 */
const DENY_PATH_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /data[\\/]offerflow\.sqlite3/i, reason: '禁止直接写生产 SQLite 文件' },
  { pattern: /(^|[\\/])\.env(\.|$)/i, reason: '禁止写 .env 系列文件' },
  { pattern: /server[\\/]schema\.ts$/i, reason: '禁止未经授权修改数据库 schema' },
];

export function checkCommandSafety(command: string): SafetyMatch {
  for (const rule of DENY_RULES) {
    if (rule.pattern.test(command)) return { denied: true, reason: rule.reason };
  }
  return { denied: false };
}

export function checkPathSafety(path: string): SafetyMatch {
  for (const rule of DENY_PATH_RULES) {
    if (rule.pattern.test(path)) return { denied: true, reason: rule.reason };
  }
  return { denied: false };
}
