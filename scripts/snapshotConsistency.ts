import { auditSnapshotConsistency } from '../server/sync/consistency';

const report = auditSnapshotConsistency();
console.log(JSON.stringify({
  ok: report.ok,
  snapshotSchemaVersion: report.snapshotSchemaVersion,
  snapshotAppVersion: report.snapshotAppVersion,
  snapshotExportedAt: report.snapshotExportedAt,
  tables: Object.fromEntries(Object.entries(report.tables).map(([table, value]) => [table, {
    databaseCount: value.databaseCount,
    snapshotCount: value.snapshotCount,
    onlyInDatabaseCount: value.onlyInDatabase.length,
    onlyInSnapshotCount: value.onlyInSnapshot.length,
    changedCount: value.changed.length,
  }])),
}, null, 2));
if (!report.ok) {
  process.exitCode = 1;
}
