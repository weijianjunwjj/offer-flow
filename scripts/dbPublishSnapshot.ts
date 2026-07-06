import { execFileSync } from 'node:child_process';
import { exportSnapshot } from '../server/sync/exportSnapshot';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function hasChanges(): boolean {
  return git(['status', '--short', '--', 'sync/offerflow.snapshot.json', 'sync/offerflow.manifest.json']) !== '';
}

const exportResult = exportSnapshot();
git(['add', 'sync/offerflow.snapshot.json', 'sync/offerflow.manifest.json']);

if (hasChanges()) {
  git(['commit', '-m', 'sync: update offerflow snapshot']);
} else {
  console.log('snapshot is already committed');
}

git(['push']);
console.log(
  JSON.stringify(
    {
      ok: true,
      pushed: true,
      snapshotHash: exportResult.snapshotHash,
      tableCounts: exportResult.tableCounts,
    },
    null,
    2,
  ),
);
