export const RESTORE_CANDIDATE_PHASES = [
  'PATHS_VALIDATED',
  'SNAPSHOT_VERIFIED',
  'CANDIDATE_RESERVED',
  'OFFERFLOW_SCHEMA_BOOTSTRAPPED',
  'NOVAWING_SCHEMA_BOOTSTRAPPED',
  'OFFERFLOW_DATA_RESTORED',
  'NOVAWING_DATA_RESTORED',
  'INTEGRITY_FK_VALIDATED',
  'HOST_VERIFICATION_PENDING',
  'COMPONENTS_VALIDATED',
  'HOST_VALIDATED',
  'RUNTIME_VALIDATED',
  'RENAME_PROBE_RESERVED',
  'RENAME_PROBE_CANDIDATE_MOVED',
  'RENAME_PROBE_COMPLETED',
  'REPORT_TEMP_CREATED',
  'REPORT_TEMP_WRITTEN',
  'REPORT_TEMP_FSYNCED',
  'REPORT_FINAL_PUBLISHED',
  'REPORT_TEMP_REMOVED',
  'RESULT_REVALIDATED',
  'OWNERSHIP_RELEASED',
  'OPERATION_COMPLETED',
] as const;

export type RestoreCandidatePhase = (typeof RESTORE_CANDIDATE_PHASES)[number];

/** Test-only observer. Production and the formal CLI never provide it. */
export type RestoreCandidatePhaseObserver = (phase: RestoreCandidatePhase) => void;

export interface RestoreCandidatePhaseModelEntry {
  phase: RestoreCandidatePhase;
  durableArtifacts: readonly string[];
  openHandles: readonly string[];
  sourceMutationPossible: false;
  safeAfterAbruptTermination: true;
  expectedResidue: string;
  nextRunBehavior: string;
}

function entry(
  phase: RestoreCandidatePhase,
  durableArtifacts: readonly string[],
  openHandles: readonly string[],
  expectedResidue: string,
  nextRunBehavior: string,
): RestoreCandidatePhaseModelEntry {
  return Object.freeze({
    phase,
    durableArtifacts,
    openHandles,
    sourceMutationPossible: false as const,
    safeAfterAbruptTermination: true as const,
    expectedResidue,
    nextRunBehavior,
  });
}

const NO_RESIDUE = '无本次 restore 持久化产物';
const RETRY_ALLOWED = '目标无残留时可重新运行';
const CANDIDATE_RESIDUE = 'candidate 可能存在，但不得视为成功';
const COLLISION = '精确目标碰撞时 fail-closed，不覆盖现有文件';

/**
 * Disk-boundary model for restore-candidate. It deliberately describes only
 * observable facts and never attributes post-crash ownership.
 */
export const RESTORE_CANDIDATE_PHASE_MODEL: readonly RestoreCandidatePhaseModelEntry[] = Object.freeze([
  entry('PATHS_VALIDATED', [], [], NO_RESIDUE, RETRY_ALLOWED),
  entry('SNAPSHOT_VERIFIED', [], [], NO_RESIDUE, RETRY_ALLOWED),
  entry('CANDIDATE_RESERVED', ['candidate (zero-length reservation)'], [], CANDIDATE_RESIDUE, COLLISION),
  entry('OFFERFLOW_SCHEMA_BOOTSTRAPPED', ['candidate'], [], CANDIDATE_RESIDUE, COLLISION),
  entry('NOVAWING_SCHEMA_BOOTSTRAPPED', ['candidate'], [], CANDIDATE_RESIDUE, COLLISION),
  entry('OFFERFLOW_DATA_RESTORED', ['candidate'], [], CANDIDATE_RESIDUE, COLLISION),
  entry('NOVAWING_DATA_RESTORED', ['candidate'], [], CANDIDATE_RESIDUE, COLLISION),
  entry(
    'INTEGRITY_FK_VALIDATED',
    ['candidate'],
    ['OfferFlow readonly SQLite handle', 'NovaWing readonly SQLite handle'],
    CANDIDATE_RESIDUE,
    COLLISION,
  ),
  entry(
    'HOST_VERIFICATION_PENDING',
    ['candidate'],
    ['OfferFlow readonly SQLite handle', 'NovaWing readonly SQLite handle'],
    CANDIDATE_RESIDUE,
    COLLISION,
  ),
  entry(
    'COMPONENTS_VALIDATED',
    ['candidate'],
    ['OfferFlow readonly SQLite handle', 'NovaWing readonly SQLite handle'],
    CANDIDATE_RESIDUE,
    COLLISION,
  ),
  entry(
    'HOST_VALIDATED',
    ['candidate'],
    ['OfferFlow readonly SQLite handle', 'NovaWing readonly SQLite handle'],
    CANDIDATE_RESIDUE,
    COLLISION,
  ),
  entry(
    'RUNTIME_VALIDATED',
    ['candidate'],
    ['OfferFlow runtime handle', 'NovaWing runtime handle'],
    CANDIDATE_RESIDUE,
    COLLISION,
  ),
  entry('RENAME_PROBE_RESERVED', ['candidate', 'rename probe reservation'], [], 'candidate 与 probe 可能并存', COLLISION),
  entry(
    'RENAME_PROBE_CANDIDATE_MOVED',
    ['rename probe containing candidate bytes'],
    [],
    'candidate 最终路径可能不存在，随机 probe 残留且 ownership 不可证明',
    '检测到 V3 probe 残留时 fail-closed，不自动删除或接管',
  ),
  entry('RENAME_PROBE_COMPLETED', ['candidate'], [], CANDIDATE_RESIDUE, COLLISION),
  entry(
    'REPORT_TEMP_CREATED',
    ['candidate', 'empty report temp'],
    ['report temp descriptor'],
    'candidate 与未完成 report temp',
    '检测到 V3 report temp 时 fail-closed，不自动删除或发布',
  ),
  entry(
    'REPORT_TEMP_WRITTEN',
    ['candidate', 'written but unflushed report temp'],
    ['report temp descriptor'],
    'candidate 与未 fsync 的 report temp',
    '检测到 V3 report temp 时 fail-closed，不自动删除或发布',
  ),
  entry(
    'REPORT_TEMP_FSYNCED',
    ['candidate', 'fsynced report temp'],
    ['report temp descriptor'],
    'candidate 与未发布 report temp',
    '检测到 V3 report temp 时 fail-closed，不自动删除或发布',
  ),
  entry(
    'REPORT_FINAL_PUBLISHED',
    ['candidate', 'final report', 'report temp hard-link'],
    [],
    '正式 report 已原子发布，但临时 link 仍存在',
    '只读分类并阻止覆盖；不得删除正式 report',
  ),
  entry(
    'REPORT_TEMP_REMOVED',
    ['candidate', 'final report'],
    [],
    'candidate 与 final report；尚需完整成功重验证',
    COLLISION,
  ),
  entry(
    'RESULT_REVALIDATED',
    ['candidate', 'final report'],
    [],
    'candidate 与 final report 已通过完整只读重验证',
    '仍拒绝覆盖；后续正式启用或替换需要独立人工授权',
  ),
  entry(
    'OWNERSHIP_RELEASED',
    ['candidate', 'final report'],
    [],
    '完整 candidate/report 成功结果',
    '拒绝覆盖；可通过只读 inspection 重新验证',
  ),
  entry(
    'OPERATION_COMPLETED',
    ['candidate', 'final report'],
    [],
    '完整 candidate/report 成功结果',
    '拒绝覆盖；可通过只读 inspection 重新验证',
  ),
]);
