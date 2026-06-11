// Key naming. One namespace, one profile key, one key per job.
// Listing jobs = scan keys by prefix (no separate index that could desync).

export const NAMESPACE = 'offerpilot:';
export const PROFILE_KEY = `${NAMESPACE}profile`;
export const JOB_PREFIX = `${NAMESPACE}job:`;

export function jobKey(id: string): string {
  return `${JOB_PREFIX}${id}`;
}

export function isJobKey(key: string): boolean {
  return key.startsWith(JOB_PREFIX);
}
