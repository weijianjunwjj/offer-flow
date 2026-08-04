/** cc-auto v0.2.0 Slice 1B — 子进程环境隔离。
 *
 * 规则：
 * 1. 只复制 runtimeEnvAllowlist 中存在的变量
 * 2. 只读取 credentialEnvVars 声明的凭证
 * 3. 凭证缺失时 fail closed
 * 4. 合并 staticEnv
 * 5. 不使用 { ...process.env }
 * 6. 不修改 parentEnv
 * 7/8. 跨 Provider 凭证隔离由 allowlist + 显式注入保证
 * 9. 日志只允许出现凭证变量名，不允许出现正文
 */
import type { ProviderProfile } from './types';

export class CredentialMissingError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly missingVar: string,
  ) {
    super(`Provider "${providerId}" 凭证环境变量 "${missingVar}" 缺失或为空——fail closed`);
    this.name = 'CredentialMissingError';
  }
}

/**
 * 返回值中的凭证变量名列表——调用方可用于日志（只记变量名，不记值）。
 */
export interface BuildChildEnvResult {
  childEnv: NodeJS.ProcessEnv;
  credentialVarNames: string[];
}

/**
 * 为 Provider 构建隔离的子进程环境。
 *
 * @param profile Provider 配置
 * @param parentEnv 父进程环境（process.env 或等价对象）
 * @returns 只包含 allowlist + credential + staticEnv 的独立环境对象
 * @throws CredentialMissingError 当声明的凭证缺失时
 */
export function buildChildEnv(
  profile: ProviderProfile,
  parentEnv: NodeJS.ProcessEnv,
): BuildChildEnvResult {
  const childEnv: NodeJS.ProcessEnv = {};

  // 1. 只复制 allowlist 中声明的变量
  for (const key of profile.runtimeEnvAllowlist) {
    if (key in parentEnv) {
      childEnv[key] = parentEnv[key];
    }
  }

  // 2. 注入声明的凭证——缺失即 fail closed
  for (const key of profile.credentialEnvVars) {
    const value = parentEnv[key];
    if (value === undefined || value === '') {
      throw new CredentialMissingError(profile.id, key);
    }
    childEnv[key] = value;
  }

  // 3. 合并 staticEnv（已在配置校验阶段确认为非敏感）
  if (profile.staticEnv) {
    for (const [key, value] of Object.entries(profile.staticEnv)) {
      childEnv[key] = value;
    }
  }

  return {
    childEnv,
    credentialVarNames: [...profile.credentialEnvVars],
  };
}

/**
 * 安全日志：只输出凭证变量名，不输出值。
 */
export function credentialNamesForLog(credentialVarNames: string[]): string {
  return credentialVarNames.join(', ');
}
