import type { JobSeekerProfile } from '../../src/storage';
import type { SqliteDatabase } from '../db';

const PROFILE_ID = 'default';

export class ProfileRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(): JobSeekerProfile | null {
    const row = this.db
      .prepare('SELECT data_json FROM profiles WHERE id = ?')
      .get(PROFILE_ID) as { data_json: string } | undefined;
    return row ? (JSON.parse(row.data_json) as JobSeekerProfile) : null;
  }

  save(profile: JobSeekerProfile): JobSeekerProfile {
    this.db
      .prepare(
        `INSERT INTO profiles (id, data_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data_json = excluded.data_json,
           updated_at = excluded.updated_at`,
      )
      .run(PROFILE_ID, JSON.stringify(profile), Date.now());
    return profile;
  }

  delete(): void {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(PROFILE_ID);
  }
}
