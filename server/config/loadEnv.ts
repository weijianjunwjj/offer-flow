import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) {
    return null;
  }
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex < 0) {
    return null;
  }
  const key = trimmed.slice(0, eqIndex).trim();
  let value = trimmed.slice(eqIndex + 1).trim();

  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  } else if (value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

export function loadProjectEnv(): void {
  const __filename = fileURLToPath(import.meta.url);
  const rootDir = path.dirname(path.dirname(__filename));
  const envPath = path.join(rootDir, '.env');

  if (!existsSync(envPath)) {
    console.warn('[env] .env file not found at', envPath);
    console.warn('[env] using only existing process.env variables');
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  const lines = content.split(/\r?\n/);

  let loaded = 0;
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
      loaded++;
    }
  }

  console.log('[env] loaded:', envPath, `(${loaded} variables added)`);
}