import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEnvFile } from './loadEnv';

/**
 * 定向覆盖 env 加载优先级语义（不触碰项目真实 .env / .env.local）：
 * - 真实 process.env（非文件写入）永不被文件覆盖；
 * - 后加载的文件（.env.local）覆盖先加载文件（.env）写入的同名键；
 * - 缺失文件返回 0，不抛错。
 * 使用系统临时目录构造 env 文件，测试内的键均带唯一前缀避免污染。
 */
describe('loadEnv · applyEnvFile 优先级', () => {
  const PREFIX = '__OFFERFLOW_LOADENV_SPEC__';
  const REAL = `${PREFIX}REAL`;
  const A = `${PREFIX}A`;
  const B = `${PREFIX}B`;
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'offerflow-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  function writeEnv(name: string, body: string): string {
    const p = path.join(dir, name);
    writeFileSync(p, body, 'utf-8');
    return p;
  }

  it('真实 process.env 不被文件覆盖', () => {
    process.env[REAL] = 'real-value';
    const keys = new Set<string>();
    const p = writeEnv('.env', `${REAL}=from-file`);

    const count = applyEnvFile(p, keys);

    expect(process.env[REAL]).toBe('real-value');
    expect(count).toBe(0);
    expect(keys.has(REAL)).toBe(false);
  });

  it('.env.local 覆盖 .env 写入的同名键', () => {
    delete process.env[A];
    const keys = new Set<string>();
    const base = writeEnv('.env', `${A}=from-base`);
    const local = writeEnv('.env.local', `${A}=from-local`);

    const baseCount = applyEnvFile(base, keys);
    const localCount = applyEnvFile(local, keys);

    expect(baseCount).toBe(1);
    expect(localCount).toBe(1);
    expect(process.env[A]).toBe('from-local');
  });

  it('不同键各自加载，互不影响', () => {
    delete process.env[A];
    delete process.env[B];
    const keys = new Set<string>();
    applyEnvFile(writeEnv('.env', `${A}=a`), keys);
    applyEnvFile(writeEnv('.env.local', `${B}=b`), keys);

    expect(process.env[A]).toBe('a');
    expect(process.env[B]).toBe('b');
  });

  it('文件缺失返回 0 且不抛错', () => {
    const keys = new Set<string>();
    expect(applyEnvFile(path.join(dir, '.env.missing'), keys)).toBe(0);
  });

  it('忽略注释与空行，去除引号', () => {
    delete process.env[A];
    const keys = new Set<string>();
    applyEnvFile(writeEnv('.env', `# comment\n\n${A}="quoted"\n`), keys);

    expect(process.env[A]).toBe('quoted');
  });
});
