import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRunLease, releaseRunLease } from './runLease';
import {
  probeHighestRankedCandidate,
  rankDiscoveryCandidates,
} from './candidateFirstDiscovery';
import type { FileScope } from './types';

const RUN_ID = 'run-candidate-first-test';
let repositoryRoot: string;

function scope(overrides: Partial<FileScope> = {}): FileScope {
  return {
    allowedRoots: ['src', 'scripts'],
    protectedPaths: [],
    proposedFiles: [],
    approvedFiles: [],
    maxChangedFiles: 10,
    ...overrides,
  };
}

beforeEach(() => {
  repositoryRoot = path.join(os.tmpdir(), `cc-auto-candidate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(repositoryRoot, 'src', 'logistics'), { recursive: true });
  mkdirSync(path.join(repositoryRoot, 'scripts'), { recursive: true });
  acquireRunLease(repositoryRoot, RUN_ID, 'c'.repeat(64));
});

afterEach(() => {
  try { releaseRunLease(repositoryRoot, RUN_ID); } catch { /* best effort */ }
  rmSync(repositoryRoot, { recursive: true, force: true });
});

describe('Candidate-First Discovery Contract', () => {
  it('存在有效候选时，确定性优先读取最高排名候选', () => {
    const top = 'src/logistics/ShipmentTracker.fields.spec.ts';
    writeFileSync(path.join(repositoryRoot, top), 'export const marker = "highest-ranked";\n', 'utf8');
    writeFileSync(path.join(repositoryRoot, 'src/logistics/ShipmentTracker.ts'), 'export class ShipmentTracker {}\n', 'utf8');
    writeFileSync(path.join(repositoryRoot, 'src/logistics/Unrelated.spec.ts'), 'export {};\n', 'utf8');

    const result = probeHighestRankedCandidate({
      repositoryRoot, cwd: repositoryRoot, runId: RUN_ID, fileScope: scope(),
      taskDescription: 'add unit tests for shipment tracker fields',
      candidatePaths: [
        'src/logistics/Unrelated.spec.ts',
        'src/logistics/ShipmentTracker.ts',
        top,
      ],
    });

    expect(result.status).toBe('READ');
    if (result.status === 'READ') {
      expect(result.candidatePath).toBe(top);
      expect(result.content).toContain('highest-ranked');
    }
  });

  it('最高候选不存在时安全 fallback，不尝试猜测下一个路径', () => {
    writeFileSync(path.join(repositoryRoot, 'src/logistics/ShipmentTracker.ts'), 'export class ShipmentTracker {}\n', 'utf8');
    const result = probeHighestRankedCandidate({
      repositoryRoot, cwd: repositoryRoot, runId: RUN_ID, fileScope: scope(),
      taskDescription: 'add shipment tracker unit tests',
      candidatePaths: [
        'src/logistics/ShipmentTracker.spec.ts',
        'src/logistics/ShipmentTracker.ts',
      ],
    });

    expect(result.status).toBe('FALLBACK');
    if (result.status === 'FALLBACK') {
      expect(result.candidatePath).toBe('src/logistics/ShipmentTracker.spec.ts');
      expect(result.reason).toBe('FILE_NOT_FOUND');
    }
  });

  it('候选明显无关时不强行读取，允许正常 discovery', () => {
    writeFileSync(path.join(repositoryRoot, 'src/logistics/GenericButton.ts'), 'export {};\n', 'utf8');
    const result = probeHighestRankedCandidate({
      repositoryRoot, cwd: repositoryRoot, runId: RUN_ID, fileScope: scope(),
      taskDescription: 'add invoice parser unit tests',
      candidatePaths: ['src/logistics/GenericButton.ts'],
    });

    expect(result).toMatchObject({
      status: 'FALLBACK',
      candidatePath: null,
      reason: 'NO_HIGH_CONFIDENCE_CANDIDATE',
    });
  });

  it('排序行为不依赖任何产品或页面固定名字', () => {
    const ranked = rankDiscoveryCandidates(
      'cover shipment tracker fields with unit tests',
      [
        'src/logistics/ShipmentTracker.ts',
        'src/logistics/ShipmentTracker.fields.spec.ts',
        'src/pages/GenericPage.spec.ts',
      ],
    );
    expect(ranked[0]?.path).toBe('src/logistics/ShipmentTracker.fields.spec.ts');
    expect(ranked[0]?.highConfidence).toBe(true);
  });

  it('候选预读复用安全路径检查，不能读取受保护路径', () => {
    mkdirSync(path.join(repositoryRoot, '.git'), { recursive: true });
    writeFileSync(path.join(repositoryRoot, '.git', 'config'), 'secret-like-content', 'utf8');
    const result = probeHighestRankedCandidate({
      repositoryRoot, cwd: repositoryRoot, runId: RUN_ID,
      fileScope: scope({ allowedRoots: ['.git', 'src'] }),
      taskDescription: 'inspect git config',
      candidatePaths: ['.git/config'],
    });

    expect(result.status).toBe('FALLBACK');
    if (result.status === 'FALLBACK') expect(result.reason).toBe('SYSTEM_PROTECTED_PATH');
  });
});
