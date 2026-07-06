import { exportSnapshot } from '../server/sync/exportSnapshot';

const result = exportSnapshot();
console.log(JSON.stringify(result, null, 2));
