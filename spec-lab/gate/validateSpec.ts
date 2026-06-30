import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateDeriveDecisionSpec,
  type DeriveDecisionCase,
  type DeriveDecisionSpec,
} from '../spec/derive-decision.schema';

type Scalar = string | number | boolean | null;

export function parseDeriveDecisionSpec(source: string): DeriveDecisionSpec {
  const lines = source.split(/\r?\n/);
  const spec: DeriveDecisionSpec = {
    rule: 'deriveDecision',
    version: 'v0.5.0',
    constants: {
      FOLLOWUP_COOLDOWN_DAYS: 3,
      MAX_FOLLOWUPS: 2,
    },
    cases: [],
  };

  let currentCase: Partial<DeriveDecisionCase> | null = null;
  let section: 'constants' | 'when' | 'then' | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    if (line.startsWith('rule:')) {
      spec.rule = valueAfterColon(line) as DeriveDecisionSpec['rule'];
      continue;
    }
    if (line.startsWith('version:')) {
      spec.version = valueAfterColon(line) as DeriveDecisionSpec['version'];
      continue;
    }
    if (line === 'constants:') {
      section = 'constants';
      continue;
    }
    if (line === 'cases:') {
      section = null;
      continue;
    }
    if (line.startsWith('  - id:')) {
      if (currentCase !== null) {
        spec.cases.push(finalizeCase(currentCase));
      }
      currentCase = {
        id: valueAfterColon(line),
        when: {},
        then: {},
      } as Partial<DeriveDecisionCase>;
      section = null;
      continue;
    }

    if (currentCase === null && section === 'constants' && line.startsWith('  ')) {
      const [key, value] = keyValue(trimmed);
      if (key === 'FOLLOWUP_COOLDOWN_DAYS' || key === 'MAX_FOLLOWUPS') {
        (spec.constants as unknown as Record<string, number>)[key] = Number(value);
      }
      continue;
    }

    if (currentCase !== null && line.startsWith('    description:')) {
      currentCase.description = valueAfterColon(line);
      continue;
    }
    if (currentCase !== null && line === '    when:') {
      section = 'when';
      continue;
    }
    if (currentCase !== null && line === '    then:') {
      section = 'then';
      continue;
    }
    if (currentCase !== null && (section === 'when' || section === 'then') && line.startsWith('      ')) {
      const [key, value] = keyValue(trimmed);
      const target = currentCase[section] as Record<string, Scalar>;
      target[key] = parseScalar(value);
    }
  }

  if (currentCase !== null) {
    spec.cases.push(finalizeCase(currentCase));
  }

  return spec;
}

export function loadSpec(): DeriveDecisionSpec {
  const specPath = resolve(process.cwd(), 'spec/derive-decision.yaml');
  return parseDeriveDecisionSpec(readFileSync(specPath, 'utf8'));
}

export function runValidateSpec(): { passed: boolean; errors: string[]; casesChecked: number } {
  const spec = loadSpec();
  const errors = validateDeriveDecisionSpec(spec);
  return {
    passed: errors.length === 0,
    errors,
    casesChecked: spec.cases.length,
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = runValidateSpec();
  if (result.passed) {
    console.log(`[spec:validate] passed cases=${result.casesChecked}`);
  } else {
    console.error('[spec:validate] failed');
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
  }
  process.exit(result.passed ? 0 : 1);
}

function valueAfterColon(line: string): string {
  return line.slice(line.indexOf(':') + 1).trim();
}

function keyValue(line: string): [string, string] {
  const index = line.indexOf(':');
  if (index === -1) {
    throw new Error(`Invalid YAML line: ${line}`);
  }
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function parseScalar(value: string): Scalar {
  if (value === 'null') {
    return null;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function finalizeCase(testCase: Partial<DeriveDecisionCase>): DeriveDecisionCase {
  if (typeof testCase.id !== 'string') {
    throw new Error('Case is missing id');
  }
  if (testCase.when === undefined || testCase.then === undefined) {
    throw new Error(`Case ${testCase.id} is missing when/then`);
  }
  return testCase as DeriveDecisionCase;
}
