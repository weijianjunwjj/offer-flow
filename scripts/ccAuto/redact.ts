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
