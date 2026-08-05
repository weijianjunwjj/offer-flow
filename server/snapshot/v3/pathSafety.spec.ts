import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoPathConflict,
  assertSnapshotMemberRegularFile,
  readSnapshotMemberUtf8,
  validateExistingInputDirectory,
  validateExistingInputFile,
  validateExplicitLocalAbsolutePath,
  validateNewOutputDirectory,
  validateNewOutputFile,
} from './pathSafety';

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-v3-path-'));
  temporaryDirectories.push(directory);
  return directory;
}

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(expect.objectContaining({ code }));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Host Snapshot V3 Windows path safety', () => {
  it('接受本地绝对路径及匹配的既有文件、目录与新输出', () => {
    const root = tempDirectory();
    const file = path.join(root, 'source.sqlite3');
    fs.writeFileSync(file, 'fixture');
    expect(validateExplicitLocalAbsolutePath(file)).toBe(path.normalize(file));
    expect(validateExistingInputFile(file).canonicalPath).toBe(fs.realpathSync.native(file));
    expect(validateExistingInputDirectory(root).canonicalPath).toBe(fs.realpathSync.native(root));
    expect(validateNewOutputFile(path.join(root, 'candidate.sqlite3')).path).toContain('candidate.sqlite3');
    expect(validateNewOutputDirectory(path.join(root, 'snapshot')).path).toContain('snapshot');
  });

  it.each(['relative.sqlite3', '.', '..', '   '])('拒绝相对、点路径或空白：%s', (candidate) => {
    expectCode(() => validateExplicitLocalAbsolutePath(candidate), 'HOST_SNAPSHOT_V3_PATH_ABSOLUTE_REQUIRED');
  });

  it.each([
    '\\\\server\\share\\snapshot',
    '\\\\?\\C:\\snapshot',
    '\\\\.\\C:\\snapshot',
    'C:\\safe\\.\\snapshot',
    'C:\\safe\\..\\snapshot',
    'C:\\safe\\trailing.',
    'C:\\safe\\trailing ',
    'C:\\safe\\CON.txt',
    'C:\\safe\\aux',
    'C:\\safe\\database.sqlite3-wal',
    'C:\\safe\\database.sqlite3-shm',
    'C:\\safe\\database.sqlite3-journal',
    'C:\\',
  ])('拒绝危险 Windows 路径：%s', (candidate) => {
    expectCode(() => validateExplicitLocalAbsolutePath(candidate), 'HOST_SNAPSHOT_V3_WINDOWS_PATH_DANGEROUS');
  });

  it('拒绝目录冒充文件和文件冒充目录', () => {
    const root = tempDirectory();
    const file = path.join(root, 'file.sqlite3');
    fs.writeFileSync(file, 'fixture');
    expectCode(() => validateExistingInputFile(root), 'HOST_SNAPSHOT_V3_PATH_TYPE_MISMATCH');
    expectCode(() => validateExistingInputDirectory(file), 'HOST_SNAPSHOT_V3_PATH_TYPE_MISMATCH');
  });

  it('拒绝不存在父目录和已存在输出', () => {
    const root = tempDirectory();
    const existing = path.join(root, 'existing.sqlite3');
    fs.writeFileSync(existing, 'fixture');
    expectCode(
      () => validateNewOutputFile(path.join(root, 'missing', 'candidate.sqlite3')),
      'HOST_SNAPSHOT_V3_PARENT_DIRECTORY_NOT_FOUND',
    );
    expectCode(() => validateNewOutputFile(existing), 'HOST_SNAPSHOT_V3_OUTPUT_ALREADY_EXISTS');
    expectCode(() => validateNewOutputDirectory(root), 'HOST_SNAPSHOT_V3_OUTPUT_ALREADY_EXISTS');
  });

  it('拒绝规范化相同、大小写别名和危险重叠', () => {
    const root = tempDirectory();
    const file = path.join(root, 'source.sqlite3');
    fs.writeFileSync(file, 'fixture');
    const source = validateExistingInputFile(file);
    expectCode(() => assertNoPathConflict(source, source), 'HOST_SNAPSHOT_V3_PATH_CONFLICT');
    expectCode(
      () => assertNoPathConflict(source, { ...source, canonicalPath: source.canonicalPath.toUpperCase() }),
      'HOST_SNAPSHOT_V3_PATH_CONFLICT',
    );
    const parent = validateExistingInputDirectory(root);
    expectCode(() => assertNoPathConflict(parent, source, { rejectOverlap: true }), 'HOST_SNAPSHOT_V3_PATH_CONFLICT');
    const normalizedAlias = validateNewOutputFile(`${root}\\\\candidate.sqlite3`);
    const direct = validateNewOutputFile(path.join(root, 'candidate.sqlite3'));
    expectCode(() => assertNoPathConflict(normalizedAlias, direct), 'HOST_SNAPSHOT_V3_PATH_CONFLICT');
  });

  it('拒绝目录 junction 与文件 symlink', () => {
    const root = tempDirectory();
    const targetDirectory = path.join(root, 'target');
    const junction = path.join(root, 'junction');
    fs.mkdirSync(targetDirectory);
    fs.symlinkSync(targetDirectory, junction, 'junction');
    expectCode(() => validateExistingInputDirectory(junction), 'HOST_SNAPSHOT_V3_PATH_LINK_OR_REPARSE_POINT');

    const targetFile = path.join(root, 'target.json');
    const fileLink = path.join(root, 'link.json');
    fs.writeFileSync(targetFile, '{}');
    try {
      fs.symlinkSync(targetFile, fileLink, 'file');
      expectCode(() => validateExistingInputFile(fileLink), 'HOST_SNAPSHOT_V3_PATH_LINK_OR_REPARSE_POINT');
    } catch (error) {
      // Windows without Developer Mode rejects file-symlink creation. The real
      // junction assertion above remains active; this fallback exercises the
      // file-symlink lstat branch instead of silently skipping it.
      expect(error).toMatchObject({ code: 'EPERM' });
      const original = fs.lstatSync.bind(fs);
      const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((candidate: fs.PathLike, options?: unknown) => {
        const stats = original(candidate, options as never);
        if (path.normalize(String(candidate)) === path.normalize(targetFile)) {
          Object.defineProperty(stats, 'isSymbolicLink', { value: () => true });
        }
        return stats;
      }) as typeof fs.lstatSync);
      try {
        expectCode(() => validateExistingInputFile(targetFile), 'HOST_SNAPSHOT_V3_PATH_LINK_OR_REPARSE_POINT');
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('snapshot 成员必须是目录内的实际普通文件', () => {
    const root = tempDirectory();
    const member = path.join(root, 'manifest.json');
    fs.writeFileSync(member, '{}');
    const snapshot = validateExistingInputDirectory(root);
    expect(assertSnapshotMemberRegularFile(snapshot, 'manifest.json').canonicalPath).toBe(fs.realpathSync.native(member));

    const link = path.join(root, 'linked.json');
    const targetDirectory = path.join(root, 'linked-target');
    fs.mkdirSync(targetDirectory);
    fs.symlinkSync(targetDirectory, link, 'junction');
    expectCode(
      () => assertSnapshotMemberRegularFile(snapshot, 'linked.json'),
      'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE',
    );
    fs.mkdirSync(path.join(root, 'directory.json'));
    expectCode(
      () => assertSnapshotMemberRegularFile(snapshot, 'directory.json'),
      'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE',
    );
  });

  it('拒绝 snapshot 成员在检查与打开之间被替换的明显竞态', () => {
    const root = tempDirectory();
    const member = path.join(root, 'data.json');
    const original = path.join(root, 'original.json');
    const replacement = path.join(root, 'replacement.json');
    fs.writeFileSync(member, '{"version":"checked"}');
    fs.writeFileSync(replacement, '{"version":"replacement"}');
    const snapshot = validateExistingInputDirectory(root);
    expectCode(
      () => readSnapshotMemberUtf8(snapshot, 'data.json', {
        afterValidation() {
          fs.renameSync(member, original);
          fs.renameSync(replacement, member);
        },
      }),
      'HOST_SNAPSHOT_V3_SNAPSHOT_MEMBER_NOT_REGULAR_FILE',
    );
  });
});
