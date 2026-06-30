import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConformance } from './conformance';
import { runDifferential } from './differential';
import { hashFile } from './hash';

const TRACE_PATH = 'traces/2026-06-30-derive-decision-001.json';

export function writeTrace(): { path: string; finalStatus: 'passed' | 'failed' } {
  const conformance = runConformance({ silent: true });
  const differential = runDifferential({ silent: true });
  const finalStatus = conformance.passed && differential.passed ? 'passed' : 'failed';

  const trace = {
    runId: '2026-06-30-derive-decision-001',
    createdAt: '2026-06-30T00:00:00+08:00',
    target: 'deriveDecision',
    mode: 'manual',
    specRef: {
      path: 'spec/derive-decision.yaml',
      hash: hashFile('spec/derive-decision.yaml'),
    },
    promptRefs: [
      refWithHash('prompts/spec-to-types.md'),
      refWithHash('prompts/spec-to-function.md'),
      refWithHash('prompts/spec-to-tests.md'),
    ],
    generatedRefs: [
      refWithHash('generated/deriveDecision.generated.ts'),
      refWithHash('generated/deriveDecision.generated.spec.ts'),
    ],
    qualityGate: {
      conformance: {
        passed: conformance.passed,
        casesChecked: conformance.casesChecked,
        failed: conformance.failed,
      },
      differential: {
        passed: differential.passed,
        casesChecked: differential.casesChecked,
        declaredChangesConfirmed: differential.declaredChangesConfirmed,
        unexpectedMismatches: differential.unexpectedMismatches,
      },
    },
    humanReview: {
      decision: 'approved',
      reviewer: 'wjj',
      notes: 'v0.5.0 high value read-no-reply scenario change approved',
    },
    promotion: {
      promoted: false,
      reason: 'v0.1 deliberately not wired into OfferFlow App',
    },
    finalStatus,
  };

  const absoluteTracePath = resolve(process.cwd(), TRACE_PATH);
  mkdirSync(dirname(absoluteTracePath), { recursive: true });
  writeFileSync(absoluteTracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');

  return { path: TRACE_PATH, finalStatus };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = writeTrace();
  console.log(`[trace:write] ${result.finalStatus} path=${result.path}`);
  process.exit(result.finalStatus === 'passed' ? 0 : 1);
}

function refWithHash(path: string): { path: string; hash: string } {
  return { path, hash: hashFile(path) };
}
