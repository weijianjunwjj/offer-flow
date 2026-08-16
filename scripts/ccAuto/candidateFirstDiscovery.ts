/**
 * Minimal Candidate-First discovery policy.
 *
 * This module is intentionally deterministic and model-free: it ranks an
 * already available path inventory, selects one high-confidence candidate,
 * and verifies it through the existing workspace read security boundary.
 */
import type { FileScope } from './types';
import {
  safeGlob,
  safeReadFile,
  type WorkspaceReadBudget,
  type WorkspaceReadDenyReason,
} from './workspaceRead';

const MIN_HIGH_CONFIDENCE_SCORE = 80;
const IGNORED_TASK_TOKENS = new Set([
  'add', 'change', 'cover', 'create', 'fix', 'for', 'implement', 'make',
  'test', 'tests', 'the', 'unit', 'update', 'write', 'with',
]);

export interface RankedDiscoveryCandidate {
  path: string;
  score: number;
  highConfidence: boolean;
}

export interface CandidateProbeOptions {
  repositoryRoot: string;
  cwd: string;
  runId: string;
  fileScope: FileScope;
  taskDescription: string;
  candidatePaths: string[];
  budget?: WorkspaceReadBudget;
}

export type CandidateProbeOutcome =
  | {
      status: 'READ';
      candidatePath: string;
      score: number;
      content: string;
      lineCount: number;
      byteCount: number;
      truncated: boolean;
    }
  | {
      status: 'FALLBACK';
      candidatePath: string | null;
      reason: WorkspaceReadDenyReason | 'NO_HIGH_CONFIDENCE_CANDIDATE' | 'CANDIDATE_INVENTORY_FAILED' | 'MAX_OUTPUT_EXCEEDED';
    };

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function meaningfulTaskTokens(taskDescription: string): string[] {
  const tokens = normalizeText(taskDescription).match(/[a-z][a-z0-9_-]*/g) ?? [];
  return Array.from(new Set(
    tokens
      .flatMap(token => token.split(/[_-]+/))
      .filter(token => token.length >= 2 && !IGNORED_TASK_TOKENS.has(token)),
  ));
}

function pathTokens(candidatePath: string): Set<string> {
  return new Set(
    normalizeText(candidatePath)
      .split(/[^a-z0-9]+/)
      .filter(token => token.length >= 2),
  );
}

function hasTestIntent(taskDescription: string): boolean {
  return /(?:\b(?:spec|test|tests|unit)\b|单测|测试)/i.test(taskDescription);
}

function hasFieldIntent(taskDescription: string): boolean {
  return /(?:\b(?:field|fields|property|properties|schema|type|types)\b|字段|属性)/i.test(taskDescription);
}

/** Rank paths using task terms and generic test/field intent signals. */
export function rankDiscoveryCandidates(
  taskDescription: string,
  candidatePaths: string[],
): RankedDiscoveryCandidate[] {
  const taskTokens = meaningfulTaskTokens(taskDescription);
  const testIntent = hasTestIntent(taskDescription);
  const fieldIntent = hasFieldIntent(taskDescription);

  return Array.from(new Set(candidatePaths.map(candidatePath => candidatePath.replace(/\\/g, '/'))))
    .map(candidatePath => {
      const normalizedPath = normalizeText(candidatePath);
      const tokens = pathTokens(candidatePath);
      let score = 0;

      for (const token of taskTokens) {
        if (tokens.has(token)) score += 80;
        else if (normalizedPath.includes(token)) score += 30;
      }

      const isTestFile = /(?:^|[./_-])(?:spec|test)(?:[./_-]|$)/i.test(candidatePath);
      if (testIntent) score += isTestFile ? 70 : -30;

      const isFieldFile = /(?:^|[./_-])(?:field|fields|schema|type|types)(?:[./_-]|$)/i.test(candidatePath);
      if (fieldIntent && isFieldFile) score += 50;

      return {
        path: candidatePath,
        score,
        highConfidence: score >= MIN_HIGH_CONFIDENCE_SCORE,
      };
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

/** Select and read exactly one candidate. Any failure delegates to normal discovery. */
export function probeHighestRankedCandidate(options: CandidateProbeOptions): CandidateProbeOutcome {
  const highest = rankDiscoveryCandidates(options.taskDescription, options.candidatePaths)[0];
  if (!highest?.highConfidence) {
    return { status: 'FALLBACK', candidatePath: null, reason: 'NO_HIGH_CONFIDENCE_CANDIDATE' };
  }

  const read = safeReadFile({
    repositoryRoot: options.repositoryRoot,
    cwd: options.cwd,
    runId: options.runId,
    targetPath: highest.path,
    fileScope: options.fileScope,
    budget: options.budget,
    startLine: 1,
    endLine: 200,
  });
  if (!read.ok) {
    return { status: 'FALLBACK', candidatePath: highest.path, reason: read.reason };
  }

  return {
    status: 'READ',
    candidatePath: highest.path,
    score: highest.score,
    content: read.content,
    lineCount: read.lineCount,
    byteCount: read.byteCount,
    truncated: read.truncated,
  };
}

/** Obtain the minimal path inventory through the existing safe glob boundary. */
export function prepareCandidateFirstProbe(
  options: Omit<CandidateProbeOptions, 'candidatePaths'>,
): CandidateProbeOutcome {
  const inventory = safeGlob({
    repositoryRoot: options.repositoryRoot,
    cwd: options.cwd,
    runId: options.runId,
    fileScope: options.fileScope,
    pattern: '**/*',
    maxResults: 500,
  });
  if (!inventory.ok) {
    return { status: 'FALLBACK', candidatePath: null, reason: 'CANDIDATE_INVENTORY_FAILED' };
  }
  return probeHighestRankedCandidate({ ...options, candidatePaths: inventory.result.paths });
}
