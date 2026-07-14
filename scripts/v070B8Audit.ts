import { pathToFileURL } from 'node:url';
import { runV070B8Audit } from '../server/job-memory/recovery';

export async function runV070B8AuditCli(): Promise<void> {
  const report = await runV070B8Audit();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write('V070_B8_AUDIT_PASS\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runV070B8AuditCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
