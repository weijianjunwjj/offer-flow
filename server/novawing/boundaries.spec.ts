import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  });
}

describe('NovaWing package and SQL boundaries', () => {
  it('locks the official package exactly with GitHub Packages integrity', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string; resolved?: string; integrity?: string }>;
    };
    const locked = lock.packages?.['node_modules/@weijianjunwjj/nova-wing'];
    expect(manifest.dependencies?.['@weijianjunwjj/nova-wing']).toBe('0.1.0');
    expect(locked?.version).toBe('0.1.0');
    expect(locked?.resolved).toBe(
      'https://npm.pkg.github.com/download/@weijianjunwjj/nova-wing/0.1.0/188533d0b90a16a540c6f4f63e8f06ac720a3b4e',
    );
    expect(locked?.integrity).toBe(
      'sha512-XvYY6xOekbzPQGi5dk9jkL6FWgjeISXSPp+o0TwmjL8tWlSnjgARcH1OZUDg6YdVounQMOuuRLGf8aNep7FhQw==',
    );
    expect(fs.readFileSync(path.join(root, '.npmrc'), 'utf8').trim()).toBe(
      '@weijianjunwjj:registry=https://npm.pkg.github.com',
    );
  });

  it('imports every required public production export', async () => {
    const [core, sqlite, hostSnapshot] = await Promise.all([
      import('@weijianjunwjj/nova-wing/core'),
      import('@weijianjunwjj/nova-wing/sqlite'),
      import('@weijianjunwjj/nova-wing/host-snapshot'),
    ]);
    expect(core.createNovaWingFacade).toBeTypeOf('function');
    expect(sqlite.createInjectedSqliteNovaWingStore).toBeTypeOf('function');
    expect(hostSnapshot.createHostSnapshotV3Manifest).toBeTypeOf('function');
  });

  it('keeps normal runtime free of nw_* SQL and confines lifecycle SQL to Snapshot V3 infrastructure', () => {
    const productionFiles = walk(path.join(root, 'server'))
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => !file.endsWith('.spec.ts') && !file.endsWith('.specHelper.ts'));
    const source = productionFiles.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
    expect(source.filter(({ text }) => /@weijianjunwjj\/nova-wing\/(?:dist|testing)/.test(text))).toEqual([]);
    const snapshotV3Root = path.join(root, 'server', 'snapshot', 'v3') + path.sep;
    const normalRuntime = source.filter(({ file }) => !file.startsWith(snapshotV3Root));
    expect(normalRuntime.filter(({ text }) => /\bnw_[a-z0-9_]*\b/i.test(text))).toEqual([]);
    expect(
      normalRuntime.filter(({ text }) => text.includes("from 'node:sqlite'"))
        .map(({ file }) => path.relative(root, file).split('\\').join('/')),
    ).toEqual(['server/novawing/infrastructure.ts']);
    expect(
      source.filter(({ file, text }) => file.startsWith(snapshotV3Root) && /\bnw_[a-z0-9_]*\b/i.test(text))
        .map(({ file }) => path.relative(root, file).split('\\').join('/')),
    ).toEqual(['server/snapshot/v3/bootstrap.ts']);
  });

  it('rejects a deep package import at Node resolution time', () => {
    const deepImport = `@weijianjunwjj/nova-wing/${'dist/core/index.js'}`;
    const require = createRequire(import.meta.url);
    expect(() => require.resolve(deepImport)).toThrowError(expect.objectContaining({
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    }));
  });
});
