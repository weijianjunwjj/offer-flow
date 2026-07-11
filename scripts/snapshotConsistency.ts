import { auditSnapshotConsistency } from '../server/sync/consistency';

const report = auditSnapshotConsistency();
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  process.exitCode = 1;
}
