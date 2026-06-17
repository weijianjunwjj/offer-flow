// Key naming. One namespace, one profile key, one key per job.
// Listing jobs = scan keys by prefix (no separate index that could desync).

export const LEGACY_NAMESPACE = 'offerpilot:';
export const NAMESPACE = 'offerflow:';
export const PROFILE_KEY = `${NAMESPACE}profile`;
export const JOB_PREFIX = `${NAMESPACE}job:`;
export const LEGACY_PROFILE_KEY = `${LEGACY_NAMESPACE}profile`;
export const LEGACY_JOB_PREFIX = `${LEGACY_NAMESPACE}job:`;

export function jobKey(id: string): string {
  return `${JOB_PREFIX}${id}`;
}

export function isJobKey(key: string): boolean {
  return key.startsWith(JOB_PREFIX);
}

export function legacyKeyToCurrentKey(key: string): string | null {
  if (!key.startsWith(LEGACY_NAMESPACE)) {
    return null;
  }
  return `${NAMESPACE}${key.slice(LEGACY_NAMESPACE.length)}`;
}
