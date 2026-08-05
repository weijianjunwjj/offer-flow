export const HOST_SNAPSHOT_V3_ERROR_CODES = [
  'HOST_SNAPSHOT_V3_CONFIRMATION_REQUIRED',
  'HOST_SNAPSHOT_V3_PATH_INVALID',
  'HOST_SNAPSHOT_V3_OFFLINE_LOCK_REQUIRED',
  'HOST_SNAPSHOT_V3_SCHEMA_MISMATCH',
  'HOST_SNAPSHOT_V3_INVALID',
  'HOST_SNAPSHOT_V3_SENSITIVE_DATA',
  'HOST_SNAPSHOT_V3_EXPORT_FAILED',
  'HOST_SNAPSHOT_V3_BOOTSTRAP_FAILED',
  'HOST_SNAPSHOT_V3_RESTORE_FAILED',
] as const;

export type HostSnapshotV3ErrorCode = (typeof HOST_SNAPSHOT_V3_ERROR_CODES)[number];

/** Stable offline lifecycle error that never retains SQLite text, absolute paths, or row content. */
export class HostSnapshotV3Error extends Error {
  constructor(readonly code: HostSnapshotV3ErrorCode, message: string) {
    super(message);
    this.name = 'HostSnapshotV3Error';
  }
}

export function hostSnapshotError(
  code: HostSnapshotV3ErrorCode,
  message: string,
): HostSnapshotV3Error {
  return new HostSnapshotV3Error(code, message);
}
