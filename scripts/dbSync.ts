import { runSync } from '../server/sync/syncRunner';

const result = runSync();
console.log(JSON.stringify(result, null, 2));
