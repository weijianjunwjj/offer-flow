import type { JobSeekerProfile } from '../../src/storage';
import {
  createEmptyJobMatchProfileState,
  JobMatchProfileStateSchema,
  type JobMatchProfileState,
} from '../../src/domain/job-match-profile';
import type { SqliteDatabase } from '../db';

const PROFILE_ID = 'default';

export class ProfileStateVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Profile 画像状态版本冲突');
    this.name = 'ProfileStateVersionConflictError';
  }
}

export class ProfileRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(): JobSeekerProfile | null {
    const row = this.db
      .prepare('SELECT data_json FROM profiles WHERE id = ?')
      .get(PROFILE_ID) as { data_json: string } | undefined;
    return row ? (JSON.parse(row.data_json) as JobSeekerProfile) : null;
  }

  save(profile: JobSeekerProfile): JobSeekerProfile {
    const current = this.get();
    const next = current?.jobMatchProfile === undefined
      ? profile
      : { ...profile, jobMatchProfile: current.jobMatchProfile };
    this.db
      .prepare(
        `INSERT INTO profiles (id, data_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data_json = excluded.data_json,
           updated_at = excluded.updated_at`,
      )
      .run(PROFILE_ID, JSON.stringify(next), Date.now());
    return next;
  }

  updateJobMatchProfile(
    expectedStateVersion: number,
    update: (current: JobMatchProfileState) => JobMatchProfileState,
  ): JobSeekerProfile {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT data_json FROM profiles WHERE id = ?').get(PROFILE_ID) as {
        data_json: string;
      } | undefined;
      if (row === undefined) throw new Error('PROFILE_NOT_FOUND');
      const profile = JSON.parse(row.data_json) as JobSeekerProfile;
      const current = profile.jobMatchProfile === undefined
        ? createEmptyJobMatchProfileState()
        : JobMatchProfileStateSchema.parse(profile.jobMatchProfile);
      if (current.stateVersion !== expectedStateVersion) {
        throw new ProfileStateVersionConflictError(current.stateVersion);
      }
      const nextState = JobMatchProfileStateSchema.parse(update(structuredClone(current)));
      const nextProfile: JobSeekerProfile = { ...profile, jobMatchProfile: nextState };
      this.db.prepare('UPDATE profiles SET data_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(nextProfile), Date.now(), PROFILE_ID);
      return nextProfile;
    });
    return transaction.immediate();
  }

  delete(): void {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(PROFILE_ID);
  }
}
