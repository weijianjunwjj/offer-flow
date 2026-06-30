import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function hashFile(relativePath: string): string {
  const content = readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(content).digest('hex');
}
