// GENERATED FILE - DO NOT EDIT DIRECTLY

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveDecision } from './deriveDecision.generated';
import { parseDeriveDecisionSpec } from '../gate/validateSpec';

const spec = parseDeriveDecisionSpec(
  readFileSync(resolve(process.cwd(), 'spec/derive-decision.yaml'), 'utf8'),
);

let failed = 0;
for (const testCase of spec.cases) {
  const actual = deriveDecision(testCase.when);
  const expected = testCase.then;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed += 1;
    console.error(`[generated spec] ${testCase.id} failed`);
    console.error({ expected, actual });
  }
}

const generatedSource = readFileSync(
  resolve(process.cwd(), 'generated/deriveDecision.generated.ts'),
  'utf8',
);
const currentTimeToken = `Date.${'now'}()`;
const constructedTimeToken = `${'new'} ${'Date'}(`;
if (generatedSource.includes(currentTimeToken) || generatedSource.includes(constructedTimeToken)) {
  failed += 1;
  console.error('[generated spec] generated source must not create current time');
}

console.log(`[generated spec] cases=${spec.cases.length}, failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
