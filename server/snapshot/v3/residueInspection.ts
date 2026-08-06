import fs from 'node:fs';
import path from 'node:path';
import { HostSnapshotV3Error } from './errors';
import {
  validateExistingInputDirectory,
  validateExplicitLocalAbsolutePath,
} from './pathSafety';
import { revalidateRestoreCandidateSuccess } from './restoreCandidate';

export const RESTORE_RESIDUE_CLASSIFICATIONS = [
  'NO_RESIDUE',
  'CANDIDATE_WITHOUT_REPORT',
  'REPORT_TEMP_WITHOUT_FINAL',
  'FINAL_REPORT_WITH_TEMP_REMAINDER',
  'CANDIDATE_AND_FINAL_REPORT_PRESENT',
  'SQLITE_SIDECAR_PRESENT',
  'AMBIGUOUS_OR_UNOWNED_RESIDUE',
] as const;

export type RestoreResidueClassification = (typeof RESTORE_RESIDUE_CLASSIFICATIONS)[number];

export interface RestoreResidueInspectionPlan {
  classification: RestoreResidueClassification;
  verifiedFacts: string[];
  unverifiedFacts: string[];
  blockedOperation: string;
  recommendedManualAction: string;
  successRevalidation: 'not-applicable' | 'verified' | 'rejected';
  errorCode?: string;
}

export interface InspectRestoreResidueOptions {
  snapshotDirectory: string;
  candidateDatabasePath: string;
}

const RUN_TEMP = /^\.offerflow-host-v3-[a-f0-9]{32,128}\.report\.tmp$/u;
const RUN_PROBE = /^\.offerflow-host-v3-[a-f0-9]{32,128}\.rename-probe$/u;

function basePlan(
  classification: RestoreResidueClassification,
  verifiedFacts: string[],
  unverifiedFacts: string[],
  blockedOperation: string,
  recommendedManualAction: string,
): RestoreResidueInspectionPlan {
  return {
    classification,
    verifiedFacts,
    unverifiedFacts,
    blockedOperation,
    recommendedManualAction,
    successRevalidation: 'not-applicable',
  };
}

/**
 * Read-only residue inspection. It never deletes, renames, publishes, opens a
 * default database, starts HTTP, or attributes crash residue to a run.
 */
export function inspectRestoreResidue(options: InspectRestoreResidueOptions): RestoreResidueInspectionPlan {
  validateExistingInputDirectory(options.snapshotDirectory);
  const candidatePath = validateExplicitLocalAbsolutePath(options.candidateDatabasePath);
  const parent = validateExistingInputDirectory(path.dirname(candidatePath));
  const candidateName = path.basename(candidatePath);
  const finalReportName = `${candidateName}.host-snapshot-v3-report.json`;
  const sidecarNames = new Set(['-journal', '-wal', '-shm'].map((suffix) => `${candidateName}${suffix}`));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent.path, { withFileTypes: true });
  } catch {
    return {
      ...basePlan(
        'AMBIGUOUS_OR_UNOWNED_RESIDUE',
        [],
        ['目标目录内容无法安全读取，残留 ownership 无法证明'],
        '恢复、覆盖、自动清理与正式启用均被阻止',
        '保持现状并由人工确认目录与文件身份后处理',
      ),
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_RESIDUE_OWNERSHIP_UNPROVEN',
    };
  }

  const names = new Set(entries.map((entry) => entry.name));
  const candidatePresent = names.has(candidateName);
  const finalPresent = names.has(finalReportName);
  const sidecars = [...sidecarNames].filter((name) => names.has(name));
  const reportTemps = entries.filter((entry) => RUN_TEMP.test(entry.name));
  const probes = entries.filter((entry) => RUN_PROBE.test(entry.name));
  const recognized = new Set([
    candidateName,
    finalReportName,
    ...sidecarNames,
    ...reportTemps.map((entry) => entry.name),
    ...probes.map((entry) => entry.name),
  ]);
  const unknown = entries.filter((entry) => !recognized.has(entry.name));

  if (sidecars.length > 0) {
    return {
      ...basePlan(
        'SQLITE_SIDECAR_PRESENT',
        ['检测到候选库精确 sidecar 路径存在'],
        ['sidecar 的创建进程、事务状态与 ownership 无法证明'],
        '恢复、覆盖、自动清理、成功判定与正式启用均被阻止',
        '保持所有文件不变；在隔离副本中由人工确认 SQLite 状态后处理',
      ),
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_SQLITE_SIDECAR_AMBIGUOUS',
    };
  }

  if (probes.length > 0 || unknown.length > 0) {
    return {
      ...basePlan(
        'AMBIGUOUS_OR_UNOWNED_RESIDUE',
        [
          ...(probes.length > 0 ? ['检测到 V3 rename probe 名称的路径项'] : []),
          ...(unknown.length > 0 ? ['检测到不属于候选库固定产物集合的路径项'] : []),
        ],
        ['路径项是否由某次 restore 创建、是否完整以及是否可删除均无法证明'],
        '恢复、覆盖、自动清理与正式启用均被阻止',
        '保持现状并由人工确认文件身份；身份不明的文件仅在人工确认后处理',
      ),
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_RESIDUE_OWNERSHIP_UNPROVEN',
    };
  }

  if (finalPresent && reportTemps.length > 0) {
    return {
      ...basePlan(
        'FINAL_REPORT_WITH_TEMP_REMAINDER',
        ['正式 report 路径存在', '至少一个 V3 report temp 路径存在'],
        ['临时 link 的 ownership 与正式结果完整性尚未证明'],
        '自动清理、覆盖恢复与正式启用均被阻止',
        '保留正式 report；对临时文件仅在人工确认身份后处理，并重新执行完整只读验证',
      ),
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_REPORT_INCOMPLETE',
    };
  }

  if (!finalPresent && reportTemps.length > 0) {
    return {
      ...basePlan(
        'REPORT_TEMP_WITHOUT_FINAL',
        ['至少一个 V3 report temp 路径存在', ...(candidatePresent ? ['candidate 路径存在'] : [])],
        ['report temp 是否完整、是否 fsync、是否属于 candidate 均无法证明'],
        '报告发布、自动清理、覆盖恢复与正式启用均被阻止',
        '保持文件不变；人工确认身份后决定处置，不得将 temp 当作正式报告',
      ),
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_REPORT_INCOMPLETE',
    };
  }

  if (candidatePresent && !finalPresent) {
    return {
      ...basePlan(
        'CANDIDATE_WITHOUT_REPORT',
        ['candidate 路径存在', '正式 report 路径不存在'],
        ['candidate 的创建运行、恢复阶段、组件完整性与 ownership 均无法证明'],
        '覆盖恢复、自动清理、成功判定、正式启用与正式替换均被阻止',
        '保持 candidate 不变；仅在隔离环境中人工核验，未有完整报告前不得正式启用或替换',
      ),
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_CANDIDATE_INCOMPLETE',
    };
  }

  if (!candidatePresent && finalPresent) {
    return {
      ...basePlan(
        'AMBIGUOUS_OR_UNOWNED_RESIDUE',
        ['正式 report 路径存在', 'candidate 路径不存在'],
        ['report 对应的 candidate 与 ownership 无法证明'],
        '覆盖恢复、自动清理、成功判定与正式启用均被阻止',
        '保持 report 不变并人工确认来源；不得把孤立 report 当作成功结果',
      ),
      successRevalidation: 'rejected',
      errorCode: 'HOST_SNAPSHOT_V3_CANDIDATE_REPORT_BINDING_MISMATCH',
    };
  }

  if (candidatePresent && finalPresent) {
    const result = basePlan(
      'CANDIDATE_AND_FINAL_REPORT_PRESENT',
      ['candidate 路径存在', '正式 report 路径存在', '未检测到精确 SQLite sidecar 或 V3 report temp'],
      ['进程中断前的内存 ownership 无法恢复；正式启用授权不由 inspection 推断'],
      '正式替换与生产启用仍被阻止，除非另行人工授权',
      '执行完整只读重验证；验证通过后仍按独立授权流程决定是否进入非生产演练',
    );
    try {
      revalidateRestoreCandidateSuccess(options);
      result.successRevalidation = 'verified';
      result.verifiedFacts.push('report 格式、Host digest、integrity/FK、双组件、Host 与 Runtime 均已重新验证');
      return result;
    } catch (error) {
      result.successRevalidation = 'rejected';
      result.errorCode = error instanceof HostSnapshotV3Error
        ? error.code
        : 'HOST_SNAPSHOT_V3_CANDIDATE_INCOMPLETE';
      result.unverifiedFacts.push('candidate/report 未通过完整成功重验证');
      result.blockedOperation = '覆盖恢复、自动清理、成功判定、正式启用与正式替换均被阻止';
      result.recommendedManualAction = '保持文件不变；在隔离副本中人工核验失败类别后处理';
      return result;
    }
  }

  return basePlan(
    'NO_RESIDUE',
    ['candidate、正式 report、精确 SQLite sidecar、V3 report temp 与 rename probe 均未检测到'],
    [],
    '无残留导致的阻断；正式恢复仍须满足原有确认与路径门禁',
    '可按原有离线 restore-candidate 流程重新执行',
  );
}
