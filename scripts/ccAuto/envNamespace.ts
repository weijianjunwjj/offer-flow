/** cc-auto v0.2.0 Slice 1C — 环境变量命名空间安全工具。
 *
 * 跨 provider.ts、openaiChatAdapter.ts、buildChildEnv.ts 共享。
 * 规则：环境变量名大小写不敏感，保证 Windows / Unix 一致安全语义。
 */
import type { ProviderProfile } from './types';

/**
 * 环境变量名规范化：统一 lowercase。
 * Windows 上 PATH / Path / path 是同一个变量，
 * Unix 上通常不同，但涉及凭证安全时保守处理。
 */
export function normalizeEnvVarName(name: string): string {
  return name.toLowerCase();
}

/** 环境变量命名空间冲突类型 */
export type EnvConflictKind =
  | 'credential_in_staticEnv'
  | 'credential_in_allowlist'
  | 'suspicious_in_allowlist'
  | 'duplicate';

/** 单个冲突细节 */
export interface EnvNamespaceConflict {
  kind: EnvConflictKind;
  detail: string;
}

/**
 * 检查 ProviderProfile 中环境变量集合冲突。
 * - staticEnv 键与 credentialEnvVars 键冲突（大小写不敏感）
 * - runtimeEnvAllowlist 与 credentialEnvVars 键冲突
 * - runtimeEnvAllowlist 含疑似凭证变量但未在 credentialEnvVars 中声明
 * - 同一数组内重复
 */
export function findEnvNamespaceConflicts(
  credVarNames: string[],
  allowNames: string[],
  staticKeys: string[],
): EnvNamespaceConflict[] {
  const conflicts: EnvNamespaceConflict[] = [];

  const creds = credVarNames.map(normalizeEnvVarName);
  const allowlist = allowNames.map(normalizeEnvVarName);
  const statics = staticKeys.map(normalizeEnvVarName);

  // 1. staticEnv 与 credentialEnvVars 冲突
  for (const sk of statics) {
    if (creds.includes(sk)) {
      conflicts.push({
        kind: 'credential_in_staticEnv',
        detail: `staticEnv 键 "${sk}" 与 credentialEnvVars 冲突（大小写不敏感）`,
      });
    }
  }

  // 2. runtimeEnvAllowlist 与 credentialEnvVars 冲突
  for (const a of allowlist) {
    if (creds.includes(a)) {
      conflicts.push({
        kind: 'credential_in_allowlist',
        detail: `runtimeEnvAllowlist 中的 "${a}" 与 credentialEnvVars 冲突（大小写不敏感）`,
      });
    }
  }

  // 3. runtimeEnvAllowlist 含疑似凭证变量但未声明在 credentialEnvVars
  const suspiciousPatterns = ['key', 'secret', 'token', 'password', 'passwd', 'auth', 'credential', 'apikey', 'api_key'];
  for (const a of allowlist) {
    if (suspiciousPatterns.some((p) => a.includes(p)) && !creds.includes(a)) {
      conflicts.push({
        kind: 'suspicious_in_allowlist',
        detail: `runtimeEnvAllowlist 包含疑似凭证变量 "${a}"，但未在 credentialEnvVars 中声明`,
      });
    }
  }

  // 4. credentialEnvVars 内部重复
  const seenCreds = new Set<string>();
  for (let i = 0; i < creds.length; i++) {
    if (seenCreds.has(creds[i])) {
      conflicts.push({
        kind: 'duplicate',
        detail: `credentialEnvVars 中存在重复变量名 "${credVarNames[i]}"（大小写不敏感）`,
      });
    }
    seenCreds.add(creds[i]);
  }

  // 5. runtimeEnvAllowlist 内部重复
  const seenAllow = new Set<string>();
  for (let i = 0; i < allowlist.length; i++) {
    if (seenAllow.has(allowlist[i])) {
      conflicts.push({
        kind: 'duplicate',
        detail: `runtimeEnvAllowlist 中存在重复变量名 "${allowNames[i]}"（大小写不敏感）`,
      });
    }
    seenAllow.add(allowlist[i]);
  }

  return conflicts;
}

/** findEnvNamespaceConflicts 对 ProviderProfile 的便利封装 */
export function checkProfileEnvConflicts(profile: ProviderProfile): EnvNamespaceConflict[] {
  return findEnvNamespaceConflicts(
    profile.credentialEnvVars ?? [],
    profile.runtimeEnvAllowlist ?? [],
    Object.keys(profile.staticEnv ?? {}),
  );
}

/** 格式化冲突列表为单行摘要（用于错误消息，不包含值） */
export function formatEnvConflicts(conflicts: EnvNamespaceConflict[]): string {
  return conflicts.map((c) => c.detail).join('; ');
}
