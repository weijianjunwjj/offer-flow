import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redactForDisk } from './redact';
import { _atomicRenameWithRetry } from './store';
import type {
  WriterBenchmarkVerdict,
  WriterModelProfileBenchmarkResult,
} from './writerModelProfileBenchmark';
import type { ExecutionModelRole } from './types';
import type {
  WriterDecisionActionClass,
  WriterExpectedActionClass,
} from './__fixtures__/writerDecisionFixture';

export const WRITER_BENCHMARK_SAMPLE_SCHEMA_VERSION =
  'writer-model-profile-benchmark-sample-v2' as const;

export interface PersistedWriterBenchmarkSample {
  schemaVersion: typeof WRITER_BENCHMARK_SAMPLE_SCHEMA_VERSION;
  benchmarkSampleId: string;
  fixtureId: string;
  fixtureVersion: string;
  profileId: string;
  providerIdentifier: string;
  executionRole: ExecutionModelRole;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  providerCallCount: number;
  toolNames: string[];
  actionClasses: WriterDecisionActionClass[];
  toolCallCount: number;
  containsRead: boolean;
  containsSearch: boolean;
  containsWrite: boolean;
  containsFinal: boolean;
  containsInvalid: boolean;
  expectedActionClass: WriterExpectedActionClass;
  actualActionClass: WriterDecisionActionClass | null;
  protocolValid: boolean | null;
  verdict: WriterBenchmarkVerdict;
  reasonCode: string;
  passed: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  costRmb: number | null;
  finishReason: string | null;
  outputTokenLimitHit: boolean | null;
  providerErrorCategory: string | null;
  providerErrorCode: string | null;
}

export interface SavedWriterBenchmarkSample {
  filePath: string;
  sample: PersistedWriterBenchmarkSample;
}

export function saveWriterBenchmarkSample(
  cwd: string,
  result: WriterModelProfileBenchmarkResult,
): SavedWriterBenchmarkSample {
  assertSafePathComponent(result.benchmarkSampleId, 'benchmarkSampleId');
  const fixtureDirectory = safeDirectoryComponent(result.fixtureId);
  const profileDirectory = safeDirectoryComponent(result.profileId);
  const directory = path.join(
    cwd,
    '.cc-auto',
    'benchmarks',
    'writer-model-profile',
    fixtureDirectory,
    profileDirectory,
  );
  mkdirSync(directory, { recursive: true });

  const sample = toPersistedWriterBenchmarkSample(result);
  const targetPath = path.join(directory, `${result.benchmarkSampleId}.json`);
  const temporaryPath = path.join(
    directory,
    `${result.benchmarkSampleId}.${process.pid}.${randomUUID()}.tmp`,
  );
  const serialized = redactForDisk(JSON.stringify(sample, null, 2));
  writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
  _atomicRenameWithRetry(temporaryPath, targetPath);
  return { filePath: targetPath, sample };
}

export function toPersistedWriterBenchmarkSample(
  result: WriterModelProfileBenchmarkResult,
): PersistedWriterBenchmarkSample {
  return {
    schemaVersion: WRITER_BENCHMARK_SAMPLE_SCHEMA_VERSION,
    benchmarkSampleId: result.benchmarkSampleId,
    fixtureId: result.fixtureId,
    fixtureVersion: result.fixtureVersion,
    profileId: result.profileId,
    providerIdentifier: result.providerIdentifier,
    executionRole: result.executionRole,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    latencyMs: result.latencyMs,
    providerCallCount: result.providerCallCount,
    toolNames: [...result.toolNames],
    actionClasses: [...result.actionClasses],
    toolCallCount: result.toolCallCount,
    containsRead: result.containsRead,
    containsSearch: result.containsSearch,
    containsWrite: result.containsWrite,
    containsFinal: result.containsFinal,
    containsInvalid: result.containsInvalid,
    expectedActionClass: result.expectedActionClass,
    actualActionClass: result.actualActionClass,
    protocolValid: result.toolProtocolValid,
    verdict: result.verdict,
    reasonCode: result.reasonCode,
    passed: result.passed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cachedTokens: result.cachedTokens,
    totalTokens: result.totalTokens,
    costRmb: result.costRmb,
    finishReason: result.finishReason,
    outputTokenLimitHit: result.outputTokenLimitHit,
    providerErrorCategory: result.providerErrorCategory,
    providerErrorCode: result.providerErrorCode,
  };
}

function assertSafePathComponent(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(value)) {
    throw new Error(`${label} contains unsupported path characters`);
  }
}

function safeDirectoryComponent(value: string): string {
  const sanitized = value.slice(0, 128).replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'unknown';
}
