import fs from 'node:fs/promises';
import path from 'node:path';
import {
  extractOfferFlowJson,
  parseOfferFlowJson,
  type OfferFlowJsonParseStatus,
} from '../src/app/offerFlowJson';

interface ExpectedResult {
  caseId: string;
  expectedStatus: OfferFlowJsonParseStatus;
  shouldParse: boolean;
  expectedWarningsIncludes: string[];
  notes: string;
}

interface CaseResult {
  caseId: string;
  expectedStatus: OfferFlowJsonParseStatus;
  actualStatus: OfferFlowJsonParseStatus;
  passed: boolean;
  notes: string;
  failures: string[];
}

const evalRoot = path.resolve(process.cwd(), 'eval', 'offer-flow-json');
const casesDir = path.join(evalRoot, 'cases');
const expectedDir = path.join(evalRoot, 'expected');

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function hasStructuredResult(result: ReturnType<typeof parseOfferFlowJson>): boolean {
  return result.matchScore !== '' || result.companyAssessment !== null || result.opportunityAnalysis !== null;
}

function includesWarning(warnings: string[], expected: string): boolean {
  return warnings.some((warning) => warning.includes(expected));
}

async function runCase(caseFile: string): Promise<CaseResult> {
  const caseId = path.basename(caseFile, '.md');
  const casePath = path.join(casesDir, caseFile);
  const expectedPath = path.join(expectedDir, `${caseId}.json`);
  const raw = await fs.readFile(casePath, 'utf8');
  const expected = await readJson<ExpectedResult>(expectedPath);
  const extracted = extractOfferFlowJson(raw);
  const parsed = parseOfferFlowJson(extracted ?? '');
  const actualShouldParse = hasStructuredResult(parsed);
  const failures: string[] = [];

  if (expected.caseId !== caseId) {
    failures.push(`expected.caseId=${expected.caseId} does not match file caseId=${caseId}`);
  }
  if (parsed.status !== expected.expectedStatus) {
    failures.push(`status expected ${expected.expectedStatus}, got ${parsed.status}`);
  }
  if (actualShouldParse !== expected.shouldParse) {
    failures.push(`shouldParse expected ${expected.shouldParse}, got ${actualShouldParse}`);
  }
  for (const warningNeedle of expected.expectedWarningsIncludes) {
    if (!includesWarning(parsed.warnings, warningNeedle)) {
      failures.push(`warning does not include: ${warningNeedle}`);
    }
  }

  return {
    caseId,
    expectedStatus: expected.expectedStatus,
    actualStatus: parsed.status,
    passed: failures.length === 0,
    notes: expected.notes,
    failures,
  };
}

async function main(): Promise<void> {
  const files = (await fs.readdir(casesDir))
    .filter((file) => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const results: CaseResult[] = [];
  for (const file of files) {
    results.push(await runCase(file));
  }

  let passed = 0;
  for (const result of results) {
    if (result.passed) {
      passed += 1;
    }
    console.log(
      [
        result.passed ? 'PASS' : 'FAIL',
        result.caseId,
        `expected=${result.expectedStatus}`,
        `actual=${result.actualStatus}`,
        `notes=${result.notes}`,
      ].join(' | '),
    );
    for (const failure of result.failures) {
      console.log(`  - ${failure}`);
    }
  }

  const total = results.length;
  const failed = total - passed;
  const passRate = total === 0 ? '0.00%' : `${((passed / total) * 100).toFixed(2)}%`;

  console.log('\n=== OFFER_FLOW_JSON Eval Summary ===');
  console.log(`total: ${total}`);
  console.log(`passed: ${passed}`);
  console.log(`failed: ${failed}`);
  console.log(`passRate: ${passRate}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});