import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function toStableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function atomicWriteJson(filePath: string, value: unknown): string {
  const content = toStableJson(value);
  atomicWriteText(filePath, content);
  return content;
}
