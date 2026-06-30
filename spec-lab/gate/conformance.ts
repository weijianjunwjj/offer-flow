import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeriveDecisionOutput } from '../spec/derive-decision.schema';
import { deriveDecision } from '../generated/deriveDecision.generated';
import { loadSpec } from './validateSpec';

export interface ConformanceResult {
  passed: boolean;
  casesChecked: number;
  failed: number;
  failures: Array<{
    id: string;
    expected: DeriveDecisionOutput;
    actual: DeriveDecisionOutput;
  }>;
}

export function runConformance(options: { silent?: boolean } = {}): ConformanceResult {
  const spec = loadSpec();
  const failures: ConformanceResult['failures'] = [];

  for (const testCase of spec.cases) {
    const actual = deriveDecision(testCase.when);
    if (!sameOutput(actual, testCase.then)) {
      failures.push({
        id: testCase.id,
        expected: testCase.then,
        actual,
      });
    }
  }

  const result: ConformanceResult = {
    passed: failures.length === 0,
    casesChecked: spec.cases.length,
    failed: failures.length,
    failures,
  };

  if (!options.silent) {
    if (result.passed) {
      console.log(`[test:conformance] passed cases=${result.casesChecked}`);
    } else {
      console.error(`[test:conformance] failed failed=${result.failed}`);
      for (const failure of result.failures) {
        console.error(JSON.stringify(failure, null, 2));
      }
    }
  }

  return result;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = runConformance();
  process.exit(result.passed ? 0 : 1);
}

function sameOutput(a: DeriveDecisionOutput, b: DeriveDecisionOutput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
