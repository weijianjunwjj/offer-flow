import type { JobSeekerProfile } from './types';
import type { StorageDriver } from './driver';
import { PROFILE_KEY } from './keys';

/** Global profile: a single record, saved by overwrite. */
export class ConfigStore {
  constructor(private readonly driver: StorageDriver) {}

  getProfile(): JobSeekerProfile | null {
    const raw = this.driver.getItem(PROFILE_KEY);
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as JobSeekerProfile;
    } catch (error) {
      // Don't swallow silently — surface a clear, actionable error.
      throw new Error(
        `[OfferPilot] Stored profile is corrupted and cannot be parsed: ${(error as Error).message}`,
      );
    }
  }

  saveProfile(profile: JobSeekerProfile): JobSeekerProfile {
    this.driver.setItem(PROFILE_KEY, JSON.stringify(profile));
    return profile;
  }

  clearProfile(): void {
    this.driver.removeItem(PROFILE_KEY);
  }
}
