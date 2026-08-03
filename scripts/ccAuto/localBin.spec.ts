import { expect, it, describe, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLocalPackageBin } from './localBin';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-localbin-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 在临时仓库内造一个 node_modules 包：写 package.json（bin 字段）与真实入口文件。 */
function fakePackage(name: string, bin: unknown, entries: Record<string, string> = {}): void {
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, bin }), 'utf8');
  for (const [rel, content] of Object.entries(entries)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

describe('resolveLocalPackageBin：解析本地依赖包 JS bin 绝对路径（不依赖 PATH）', () => {
  it('bin 为对象形式（如 vitest {"vitest":"./vitest.mjs"}）能解析到真实入口', () => {
    fakePackage('vitest', { vitest: './vitest.mjs' }, { 'vitest.mjs': '// entry\n' });
    const r = resolveLocalPackageBin(root, 'vitest', 'vitest');
    expect(r.ok).toBe(true);
    expect(r.binPath).toBe(path.join(root, 'node_modules', 'vitest', 'vitest.mjs'));
  });

  it('bin 为对象形式（如 vue-tsc {"vue-tsc":"./bin/vue-tsc.js"}）能解析到真实入口', () => {
    fakePackage('vue-tsc', { 'vue-tsc': './bin/vue-tsc.js' }, { 'bin/vue-tsc.js': '// entry\n' });
    const r = resolveLocalPackageBin(root, 'vue-tsc', 'vue-tsc');
    expect(r.ok).toBe(true);
    expect(r.binPath).toBe(path.join(root, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'));
  });

  it('bin 为字符串形式时直接作为入口', () => {
    fakePackage('foo', './cli.js', { 'cli.js': '// entry\n' });
    const r = resolveLocalPackageBin(root, 'foo', 'foo');
    expect(r.ok).toBe(true);
    expect(r.binPath).toBe(path.join(root, 'node_modules', 'foo', 'cli.js'));
  });

  it('bin 为对象但 preferredBinName 缺失时退回同名项/首项', () => {
    fakePackage('bar', { other: './other.js' }, { 'other.js': '// entry\n' });
    const r = resolveLocalPackageBin(root, 'bar', 'not-present');
    expect(r.ok).toBe(true);
    expect(r.binPath).toBe(path.join(root, 'node_modules', 'bar', 'other.js'));
  });

  it('包不存在时给出明确错误 PACKAGE_NOT_FOUND（不伪装成测试失败）', () => {
    const r = resolveLocalPackageBin(root, 'no-such-pkg', 'no-such-pkg');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('PACKAGE_NOT_FOUND');
  });

  it('bin 入口声明了但文件不存在时报 BIN_ENTRY_MISSING', () => {
    fakePackage('baz', { baz: './missing.js' }); // 不创建 missing.js
    const r = resolveLocalPackageBin(root, 'baz', 'baz');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('BIN_ENTRY_MISSING');
  });

  it('bin 字段缺失时报 BIN_FIELD_MISSING', () => {
    fakePackage('nobin', undefined);
    const r = resolveLocalPackageBin(root, 'nobin', 'nobin');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('BIN_FIELD_MISSING');
  });

  it('bin 入口存在 `..` 穿越时报 PATH_ESCAPE，绝不解析到包目录之外', () => {
    fakePackage('evil', { evil: '../../../../etc/passwd' });
    const r = resolveLocalPackageBin(root, 'evil', 'evil');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('PATH_ESCAPE');
  });
});

describe('resolveLocalPackageBin：真实仓库 node_modules（证明 Windows 下不依赖 PATH 中的 pnpm）', () => {
  const repoRoot = process.cwd();

  it('能解析真实 vitest 本地 bin 为存在的绝对路径', () => {
    const r = resolveLocalPackageBin(repoRoot, 'vitest', 'vitest');
    expect(r.ok).toBe(true);
    expect(path.isAbsolute(r.binPath!)).toBe(true);
    expect(r.binPath!.includes(path.join('node_modules', 'vitest'))).toBe(true);
  });

  it('能解析真实 vue-tsc 本地 bin 为存在的绝对路径', () => {
    const r = resolveLocalPackageBin(repoRoot, 'vue-tsc', 'vue-tsc');
    expect(r.ok).toBe(true);
    expect(path.isAbsolute(r.binPath!)).toBe(true);
    expect(r.binPath!.includes(path.join('node_modules', 'vue-tsc'))).toBe(true);
  });
});
