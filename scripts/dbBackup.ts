import { backupDatabase } from '../server/sync/backup';

const result = backupDatabase();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exitCode = 1;
}
