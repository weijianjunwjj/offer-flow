import { doctorDatabase } from '../server/sync/doctor';

const result = doctorDatabase();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exitCode = 1;
}
