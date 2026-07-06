import Database from 'better-sqlite3';
import { ensureDbDir, getDbPath } from '../server/db';

const dbPath = process.argv[2] ?? getDbPath();

ensureDbDir(dbPath);

const db = new Database(dbPath);

try {
  db.pragma('busy_timeout = 5000');
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
  const journalMode = db.pragma('journal_mode = DELETE', { simple: true });
  const hasJobsTable = db
    .prepare("SELECT 1 AS existsFlag FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
    .get() as { existsFlag: 1 } | undefined;
  const jobCount = hasJobsTable
    ? (db.prepare('SELECT count(*) AS count FROM jobs').get() as { count: number }).count
    : null;

  console.log(
    JSON.stringify(
      {
        path: dbPath,
        checkpoint,
        journalMode,
        jobCount,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('database is locked') || message.includes('SQLITE_BUSY')) {
    console.error(
      [
        '[OfferFlow] SQLite database is locked.',
        'Stop npm run dev / npm run server, then rerun npm run db:checkpoint.',
        `DB: ${dbPath}`,
      ].join('\n'),
    );
  } else {
    console.error(`[OfferFlow] DB checkpoint failed: ${message}`);
  }
  process.exitCode = 1;
} finally {
  db.close();
}
