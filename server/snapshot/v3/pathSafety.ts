import fs from 'node:fs';
import path from 'node:path';
import { hostSnapshotError } from './errors';

export interface ValidatedV3Path {
  /** Canonical path used for all subsequent filesystem operations. */
  path: string;
  /** Canonical comparison key before Windows case folding. */
  canonicalPath: string;
  device?: bigint;
  inode?: bigint;
  size?: bigint;
  modifiedAtNanoseconds?: bigint;
  createdAtNanoseconds?: bigint;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WINDOWS_UNSAFE_CHARACTER = /[<>"|?*]/u;
const WINDOWS_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const SQLITE_SIDECAR = /-(?:journal|wal|shm)$/iu;
const DEVICE_NAMESPACE = /^\\\\[?.]\\/u;
const UNC_PATH = /^\\\\/u;

function dangerousPath(message: string): never {
  throw hostSnapshotError('HOST_SNAPSHOT_V3_WINDOWS_PATH_DANGEROUS', message);
}

function comparisonKey(candidate: string): string {
  return path.win32.normalize(candidate).toLocaleLowerCase('en-US');
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function assertExistingNodesAreNotLinks(candidate: string): void {
  const parsed = path.parse(candidate);
  let current = parsed.root;
  const segments = candidate.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    let stats: fs.BigIntStats;
    try {
      stats = fs.lstatSync(current, { bigint: true });
    } catch {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_TYPE_MISMATCH', '路径节点无法安全读取');
    }
    // Node exposes symbolic links and Windows junctions through isSymbolicLink().
    // It does not expose every possible Windows reparse tag; that residual limit is documented.
    if (stats.isSymbolicLink()) {
      throw hostSnapshotError(
        'HOST_SNAPSHOT_V3_PATH_LINK_OR_REPARSE_POINT',
        '路径不得包含 symlink、junction 或可识别的 reparse point',
      );
    }
  }
}

export function validateExplicitLocalAbsolutePath(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '' || !path.win32.isAbsolute(raw)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_ABSOLUTE_REQUIRED', '路径必须是显式本地绝对路径');
  }
  if (CONTROL_CHARACTER.test(raw)) dangerousPath('路径包含危险控制字符');
  const windowsPath = raw.replace(/\//gu, '\\');
  if (DEVICE_NAMESPACE.test(windowsPath) || UNC_PATH.test(windowsPath)) {
    dangerousPath('不接受 UNC、network path 或 Windows device namespace');
  }
  if (!/^[a-z]:\\/iu.test(windowsPath)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_ABSOLUTE_REQUIRED', '路径必须是带盘符的本地绝对路径');
  }
  const segments = windowsPath.slice(3).split('\\').filter((segment) => segment.length > 0);
  if (segments.length === 0) dangerousPath('根目录不能作为业务路径');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') dangerousPath('路径不得包含点路径节点');
    if (/[. ]$/u.test(segment)) dangerousPath('路径节点不得以点或空格结尾');
    if (WINDOWS_RESERVED_DEVICE.test(segment)) dangerousPath('路径包含 Windows 保留设备名');
    if (WINDOWS_UNSAFE_CHARACTER.test(segment) || segment.includes(':')) {
      dangerousPath('路径包含 Windows 危险字符或数据流语法');
    }
  }
  if (SQLITE_SIDECAR.test(segments.at(-1)!)) dangerousPath('SQLite sidecar 不能作为业务路径');
  return path.normalize(raw);
}

function validateExisting(raw: string, expected: 'file' | 'directory'): ValidatedV3Path {
  const normalized = validateExplicitLocalAbsolutePath(raw);
  assertExistingNodesAreNotLinks(normalized);
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(normalized, { bigint: true });
  } catch {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_TYPE_MISMATCH', '输入路径不存在或类型不正确');
  }
  if (stats.isSymbolicLink()) {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_PATH_LINK_OR_REPARSE_POINT',
      '路径不得包含 symlink、junction 或可识别的 reparse point',
    );
  }
  if ((expected === 'file' && !stats.isFile()) || (expected === 'directory' && !stats.isDirectory())) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_TYPE_MISMATCH', '输入路径类型不正确');
  }
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(normalized);
  } catch {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_TYPE_MISMATCH', '输入路径无法 canonicalize');
  }
  return {
    path: canonicalPath,
    canonicalPath,
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedAtNanoseconds: stats.mtimeNs,
    createdAtNanoseconds: stats.birthtimeNs,
  };
}

export function validateExistingInputFile(raw: string): ValidatedV3Path {
  return validateExisting(raw, 'file');
}

export function validateExistingInputDirectory(raw: string): ValidatedV3Path {
  return validateExisting(raw, 'directory');
}

function validateNewOutput(raw: string): ValidatedV3Path {
  const normalized = validateExplicitLocalAbsolutePath(raw);
  assertExistingNodesAreNotLinks(normalized);
  if (fs.existsSync(normalized)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_OUTPUT_ALREADY_EXISTS', '输出目标已经存在');
  }
  const parentRaw = path.dirname(normalized);
  let parent: ValidatedV3Path;
  try {
    parent = validateExistingInputDirectory(parentRaw);
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && [
        'HOST_SNAPSHOT_V3_PATH_LINK_OR_REPARSE_POINT',
        'HOST_SNAPSHOT_V3_WINDOWS_PATH_DANGEROUS',
      ].includes(String((error as { code?: string }).code))
    ) {
      throw error;
    }
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PARENT_DIRECTORY_NOT_FOUND', '输出父目录不存在或不是普通目录');
  }
  const canonicalPath = path.join(parent.canonicalPath, path.basename(normalized));
  return { path: canonicalPath, canonicalPath };
}

export function validateNewOutputFile(raw: string): ValidatedV3Path {
  return validateNewOutput(raw);
}

export function validateNewOutputDirectory(raw: string): ValidatedV3Path {
  return validateNewOutput(raw);
}

function isInside(parent: string, candidate: string): boolean {
  const parentKey = comparisonKey(parent);
  const candidateKey = comparisonKey(candidate);
  const relative = path.win32.relative(parentKey, candidateKey);
  return relative !== '' && !relative.startsWith('..') && !path.win32.isAbsolute(relative);
}

export function isPathStrictlyInside(parent: ValidatedV3Path, candidate: ValidatedV3Path): boolean {
  return isInside(parent.canonicalPath, candidate.canonicalPath);
}

export function assertNoPathConflict(
  left: ValidatedV3Path,
  right: ValidatedV3Path,
  options: { rejectOverlap?: boolean } = {},
): void {
  const same = comparisonKey(left.canonicalPath) === comparisonKey(right.canonicalPath);
  const overlap = options.rejectOverlap
    && (isInside(left.canonicalPath, right.canonicalPath) || isInside(right.canonicalPath, left.canonicalPath));
  if (same || overlap) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_CONFLICT', '路径 canonicalize 后相同或发生危险重叠');
  }
}

export function assertSnapshotMemberRegularFile(
  snapshotDirectory: ValidatedV3Path,
  memberName: string,
): ValidatedV3Path {
  if (path.basename(memberName) !== memberName || memberName === '.' || memberName === '..') {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE',
      'snapshot 成员名称无效',
    );
  }
  const memberPath = path.join(snapshotDirectory.path, memberName);
  try {
    const member = validateExistingInputFile(memberPath);
    if (!isPathStrictlyInside(snapshotDirectory, member)) throw new Error('member escaped snapshot');
    return member;
  } catch {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE',
      'snapshot 成员必须是目录内的实际普通文件',
    );
  }
}

function assertMemberIdentity(member: ValidatedV3Path, descriptor: number): void {
  const descriptorStats = fs.fstatSync(descriptor, { bigint: true });
  const currentStats = fs.lstatSync(member.path, { bigint: true });
  if (
    !descriptorStats.isFile()
    || !currentStats.isFile()
    || currentStats.isSymbolicLink()
    || !sameIdentity(descriptorStats, currentStats)
    || descriptorStats.dev !== member.device
    || descriptorStats.ino !== member.inode
    || descriptorStats.size !== member.size
    || descriptorStats.mtimeNs !== member.modifiedAtNanoseconds
    || descriptorStats.birthtimeNs !== member.createdAtNanoseconds
    || comparisonKey(fs.realpathSync.native(member.path)) !== comparisonKey(member.canonicalPath)
  ) {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE',
      'snapshot 成员在检查与读取之间发生变化',
    );
  }
}

export function readSnapshotMemberUtf8(
  snapshotDirectory: ValidatedV3Path,
  memberName: string,
  hooks?: { /** Deterministic race test only; production callers must omit. */ afterValidation?: () => void },
): string {
  const member = assertSnapshotMemberRegularFile(snapshotDirectory, memberName);
  hooks?.afterValidation?.();
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(member.path, 'r');
    assertMemberIdentity(member, descriptor);
    const content = fs.readFileSync(descriptor, 'utf8');
    assertMemberIdentity(member, descriptor);
    return content;
  } catch (error) {
    if (error instanceof Error && 'code' in error
      && (error as { code?: string }).code === 'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE') {
      throw error;
    }
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE',
      'snapshot 成员无法作为稳定普通文件读取',
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        throw hostSnapshotError(
          'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE',
          'snapshot 成员文件句柄无法安全关闭',
        );
      }
    }
  }
}
