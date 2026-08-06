export const HOST_SNAPSHOT_V3_ERROR_CODES = [
  'HOST_SNAPSHOT_V3_CONFIRMATION_REQUIRED',
  'HOST_SNAPSHOT_V3_PATH_INVALID',
  'HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID',
  'HOST_SNAPSHOT_V3_CLI_ARGUMENT_LIMIT_EXCEEDED',
  'HOST_SNAPSHOT_V3_PATH_ABSOLUTE_REQUIRED',
  'HOST_SNAPSHOT_V3_PATH_TYPE_MISMATCH',
  'HOST_SNAPSHOT_V3_WINDOWS_PATH_DANGEROUS',
  'HOST_SNAPSHOT_V3_PATH_LINK_OR_REPARSE_POINT',
  'HOST_SNAPSHOT_V3_PATH_CONFLICT',
  'HOST_SNAPSHOT_V3_OUTPUT_ALREADY_EXISTS',
  'HOST_SNAPSHOT_V3_PARENT_DIRECTORY_NOT_FOUND',
  'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE',
  'HOST_SNAPSHOT_V3_OFFLINE_LOCK_REQUIRED',
  'HOST_SNAPSHOT_V3_SCHEMA_MISMATCH',
  'HOST_SNAPSHOT_V3_INVALID',
  'HOST_SNAPSHOT_V3_SENSITIVE_DATA',
  'HOST_SNAPSHOT_V3_EXPORT_FAILED',
  'HOST_SNAPSHOT_V3_BOOTSTRAP_FAILED',
  'HOST_SNAPSHOT_V3_RESTORE_FAILED',
  'HOST_SNAPSHOT_V3_ARTIFACT_COLLISION',
  'HOST_SNAPSHOT_V3_REPORT_PUBLISH_FAILED',
  'HOST_SNAPSHOT_V3_CLEANUP_FAILED',
  'HOST_SNAPSHOT_V3_INTERRUPTED_RESIDUE_COLLISION',
  'HOST_SNAPSHOT_V3_CANDIDATE_INCOMPLETE',
  'HOST_SNAPSHOT_V3_REPORT_INCOMPLETE',
  'HOST_SNAPSHOT_V3_CANDIDATE_REPORT_BINDING_MISMATCH',
  'HOST_SNAPSHOT_V3_SQLITE_SIDECAR_AMBIGUOUS',
  'HOST_SNAPSHOT_V3_RESIDUE_OWNERSHIP_UNPROVEN',
  'HOST_SNAPSHOT_V3_INTERRUPTION_HARNESS_SYNC_FAILED',
] as const;

export type HostSnapshotV3ErrorCode = (typeof HOST_SNAPSHOT_V3_ERROR_CODES)[number];

export interface HostSnapshotV3ErrorContext {
  primaryCode?: HostSnapshotV3ErrorCode;
  cleanupStatus?: 'failed';
  resultState?: 'none' | 'candidate-and-report-retained';
  cleanupFailureCount?: number;
}

/** Stable offline lifecycle error that never retains SQLite text, absolute paths, or row content. */
export class HostSnapshotV3Error extends Error {
  readonly primaryCode?: HostSnapshotV3ErrorCode;
  readonly cleanupStatus?: 'failed';
  readonly resultState?: 'none' | 'candidate-and-report-retained';
  readonly cleanupFailureCount?: number;

  constructor(
    readonly code: HostSnapshotV3ErrorCode,
    message: string,
    context: HostSnapshotV3ErrorContext = {},
  ) {
    super(message);
    this.name = 'HostSnapshotV3Error';
    this.primaryCode = context.primaryCode;
    this.cleanupStatus = context.cleanupStatus;
    this.resultState = context.resultState;
    this.cleanupFailureCount = context.cleanupFailureCount;
  }
}

export function hostSnapshotError(
  code: HostSnapshotV3ErrorCode,
  message: string,
  context: HostSnapshotV3ErrorContext = {},
): HostSnapshotV3Error {
  return new HostSnapshotV3Error(code, message, context);
}
