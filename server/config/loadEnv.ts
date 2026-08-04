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

/**
 * 加载单个 env 文件到 process.env。
 *
 * 优先级：真实 process.env（进程启动前既有）> 后加载的文件 > 先加载的文件。
 * 通过 fileLoadedKeys 追踪「由文件写入」的键：真实环境变量永不被文件覆盖，
 * 但后一个文件（.env.local）可覆盖前一个文件（.env）写入的同名键。
 *
 * 仅服务端调用（server/index.ts、scripts/*）。不处理 VITE_ 前缀 / 前端 bundle，
 * 也绝不打印任何变量值。
 */
export function applyEnvFile(envPath: string, fileLoadedKeys: Set<string>): number {
  if (!existsSync(envPath)) {
    return 0;
  }

  const content = readFileSync(envPath, 'utf-8');
  const lines = content.split(/\r?\n/);

  let loaded = 0;
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }
    const alreadySet = process.env[parsed.key] !== undefined;
    // 真实环境变量（非本函数写入）最高优先，绝不覆盖；仅覆盖此前由文件写入的键。
    if (alreadySet && !fileLoadedKeys.has(parsed.key)) {
      continue;
    }
    process.env[parsed.key] = parsed.value;
    fileLoadedKeys.add(parsed.key);
    loaded++;
  }

  return loaded;
}

/**
 * 按 .env → .env.local 顺序加载项目根环境文件（.env.local 覆盖 .env，真实 process.env 最高优先）。
 * 两个文件均可缺失。仅服务端使用，只报告加载文件与新增/覆盖计数，绝不输出变量值。
 */
export function loadProjectEnv(): void {
  const __filename = fileURLToPath(import.meta.url);
  const rootDir = path.dirname(path.dirname(__filename));

  // 顺序即优先级：后者覆盖前者写入的同名键。
  const envFiles = [
    path.join(rootDir, '.env'),
    path.join(rootDir, '.env.local'),
  ];

  const fileLoadedKeys = new Set<string>();
  const loadedFrom: string[] = [];
  for (const envPath of envFiles) {
    if (!existsSync(envPath)) {
      continue;
    }
    const count = applyEnvFile(envPath, fileLoadedKeys);
    loadedFrom.push(`${envPath} (${count})`);
  }

  if (loadedFrom.length === 0) {
    console.warn('[env] no .env / .env.local found under', rootDir);
    console.warn('[env] using only existing process.env variables');
    return;
  }

  console.log('[env] loaded:', loadedFrom.join(', '));
}