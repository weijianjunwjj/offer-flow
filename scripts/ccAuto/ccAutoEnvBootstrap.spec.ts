import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCcAutoCliProcess } from './cli';
import { runWriterBenchmarkProcess } from './writerModelProfileBenchmark.run';

const originalEnv = { ...process.env };
const cleanup: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('cc-auto process env bootstrap', () => {
  it('CLI startup completes env bootstrap before entering config/provider initialization', async () => {
    const order: string[] = [];
    const result = await runCcAutoCliProcess(
      ['node', 'cc-auto', '--help'],
      'D:/workspace',
      {
        loadEnv: (rootDir) => {
          expect(rootDir).toBe('D:/workspace');
          order.push('env');
        },
        handleCli: async () => {
          order.push('provider-initialization');
          return { exitCode: 0 };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(order).toEqual(['env', 'provider-initialization']);
  });

  it('normal CLI startup loads a project credential from .env.local without manual export', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'cc-auto-env-bootstrap-'));
    cleanup.push(cwd);
    const credentialName = '__CC_AUTO_BOOTSTRAP_SPEC_CREDENTIAL__';
    delete process.env[credentialName];
    writeFileSync(path.join(cwd, '.env.local'), `${credentialName}=fixture-value\n`, 'utf8');
    let credentialAvailable = false;
    await runCcAutoCliProcess(
      ['node', 'cc-auto', '--help'],
      cwd,
      {
        handleCli: async () => {
          credentialAvailable = process.env[credentialName] !== undefined
            && process.env[credentialName] !== '';
          return { exitCode: 0 };
        },
      },
    );

    expect(credentialAvailable).toBe(true);
  });

  it('standalone benchmark startup uses the same generic env bootstrap before its runner', async () => {
    const order: string[] = [];
    const emptyResult = {
      samples: [],
      sampleFiles: [],
      summaries: [],
      benchmarkInvocationCount: 0,
      providerCallCount: 0,
    };

    const result = await runWriterBenchmarkProcess('D:/workspace', {
      loadEnv: () => { order.push('env'); },
      runBenchmarks: async () => {
        order.push('benchmark-provider-initialization');
        return emptyResult;
      },
    });

    expect(result).toBe(emptyResult);
    expect(order).toEqual(['env', 'benchmark-provider-initialization']);
  });

  it('bootstrap entrypoints contain no provider-specific credential selection', () => {
    const startupSource = [
      runCcAutoCliProcess.toString(),
      runWriterBenchmarkProcess.toString(),
    ].join('\n').toLowerCase();

    for (const providerName of ['deepseek', 'gpt', 'grok', 'claude']) {
      expect(startupSource).not.toContain(providerName);
    }
    expect(startupSource).not.toContain('api_key');
  });
});
