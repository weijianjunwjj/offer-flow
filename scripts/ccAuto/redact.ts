/** 落盘前的脱敏：绝不把密钥/完整环境变量写入 run 状态或日志。 */

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|passwd|authorization)/i;

/** 屏蔽形如 KEY=value 的行中疑似密钥的 value。 */
export function redactEnvLikeText(text: string): string {
  return text.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("?)([^\s"']{6,})\2/g, (full, key: string, quote: string) => {
    if (SECRET_KEY_PATTERN.test(key)) return `${key}=${quote}<redacted>${quote}`;
    return full;
  });
}

/** 屏蔽常见密钥字面模式（sk-、Bearer xxx 等），不依赖 key 名。 */
export function redactSecretLiterals(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '<redacted-key>')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, 'Bearer <redacted-token>');
}

export function redactForDisk(text: string): string {
  return redactSecretLiterals(redactEnvLikeText(text));
}

/**
 * 按实际凭证值精确脱敏——将文本中每一个 secret 的全部出现替换为 `<redacted-secret>`。
 *
 * 规则：
 * - 忽略 undefined 和空字符串
 * - 正确处理正则特殊字符（通过转义）
 * - 不改变原 secret
 * - 不把 secret 写入日志
 * - 可叠加现有 redactSecretLiterals / redactEnvLikeText
 */
export function redactSecretValues(
  text: string,
  secrets: Array<string | undefined>,
): string {
  let result = text;
  for (const secret of secrets) {
    if (secret === undefined || secret === '') continue;
    // 转义正则特殊字符
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), '<redacted-secret>');
  }
  return result;
}
