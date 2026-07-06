import fs from 'node:fs';
import path from 'node:path';

export function readAppVersion(): string {
  const packagePath = path.join(process.cwd(), 'package.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
