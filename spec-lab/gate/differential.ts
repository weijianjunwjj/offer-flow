import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DeriveDecisionInput,
  DeriveDecisionOutput,
} from '../spec/derive-decision.schema';
import { deriveDecision as oracleDeriveDecision } from '../oracle/deriveDecision.oracle';
import { deriveDecision as generatedDeriveDecision } from '../generated/deriveDecision.generated';
import { buildDifferentialMatrix } from './matrix';

export interface DifferentialMismatch {
  input: DeriveDecisionInput;
  oracle: DeriveDecisionOutput;
  generated: DeriveDecisionOutput;
}

export interface DifferentialResult {
  passed: boolean;
  casesChecked: number;
  declaredChangesConfirmed: boolean;
  expectedMismatches: DifferentialMismatch[];
  unexpectedMismatches: DifferentialMismatch[];
}

export function runDifferential(options: { silent?: boolean } = {}): DifferentialResult {
  const matrix = buildDifferentialMatrix();
  const expectedMismatches: DifferentialMismatch[] = [];
  const unexpectedMismatches: DifferentialMismatch[] = [];

  for (const input of matrix) {
    const oracle = oracleDeriveDecision(input);
    const generated = generatedDeriveDecision(input);
    if (sameOutput(oracle, generated)) {
      continue;
    }

    const mismatch = { input, oracle, generated };
    if (isDeclaredChange(input, oracle, generated)) {
      expectedMismatches.push(mismatch);
    } else {
      unexpectedMismatches.push(mismatch);
    }
  }

  const declaredChangesConfirmed = expectedMismatches.length > 0;
  const result: DifferentialResult = {
    passed: unexpectedMismatches.length === 0 && declaredChangesConfirmed,
    casesChecked: matrix.length,
    declaredChangesConfirmed,
    expectedMismatches,
    unexpectedMismatches,
  };

  if (!options.silent) {
    if (result.passed) {
      console.log(
        `[gate:diff] passed cases=${result.casesChecked} expected=${result.expectedMismatches.length} unexpected=0 declaredChangesConfirmed=true`,
      );
    } else {
      console.error(
        `[gate:diff] failed unexpected=${result.unexpectedMismatches.length} declaredChangesConfirmed=${result.declaredChangesConfirmed}`,
      );
      for (const mismatch of result.unexpectedMismatches) {
        console.error(JSON.stringify(mismatch, null, 2));
      }
    }
  }

  return result;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = runDifferential();
  process.exit(result.passed ? 0 : 1);
}

function sameOutput(a: DeriveDecisionOutput, b: DeriveDecisionOutput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isDeclaredChange(
  input: DeriveDecisionInput,
  oracle: DeriveDecisionOutput,
  generated: DeriveDecisionOutput,
): boolean {
  return (
    input.communicationStatus === 'greeted_read_no_reply' &&
    input.followupCount === 0 &&
    input.highValueSignal === true &&
    oracle.strategy === generated.strategy &&
    oracle.nextAction === generated.nextAction &&
    oracle.stopLoss === generated.stopLoss &&
    oracle.companyWarning === generated.companyWarning &&
    oracle.scenario === 'follow_up_with_new_angle' &&
    generated.scenario === 'follow_up_with_value_angle'
  );
}
