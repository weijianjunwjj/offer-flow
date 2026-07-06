import { execFileSync } from 'node:child_process';
import { doctorDatabase } from '../server/sync/doctor';
import { importSnapshot } from '../server/sync/importSnapshot';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

git(['pull', '--ff-only']);
const importResult = importSnapshot();
const doctor = doctorDatabase();

console.log(
  JSON.stringify(
    {
      ok: doctor.ok,
      importResult,
      doctor,
    },
    null,
    2,
  ),
);

if (!doctor.ok) {
  process.exitCode = 1;
}
