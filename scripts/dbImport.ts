import { importSnapshot } from '../server/sync/importSnapshot';

const result = importSnapshot();
console.log(JSON.stringify(result, null, 2));
