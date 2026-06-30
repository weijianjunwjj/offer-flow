import fs from 'node:fs';
import { openDb } from '../server/db';
import { initSchema } from '../server/schema';
import { applyLocalStorageBackup } from '../server/importLocalStorage';

const file = process.argv[2];

if (!file) {
  console.error('Usage: npm run import:backup -- path/to/offerflow-web-backup.json');
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
const backup = JSON.parse(raw) as unknown;
const db = openDb();
initSchema(db);
try {
  const result = applyLocalStorageBackup(db, backup, file);
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
