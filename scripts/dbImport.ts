import { importSnapshot } from '../server/sync/importSnapshot';

try {
  const result = importSnapshot();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('snapshot hash mismatch')) {
    console.error(
      [
        '[OfferFlow] Snapshot hash mismatch; refused import.',
        'The snapshot JSON and manifest do not match.',
        'If this machine has the latest data, run: npm run db:export',
        'If another machine has the latest data, pull the matching sync/offerflow.snapshot.json and sync/offerflow.manifest.json together.',
      ].join('\n'),
    );
  } else {
    console.error(`[OfferFlow] DB import failed: ${message}`);
  }
  process.exitCode = 1;
}
