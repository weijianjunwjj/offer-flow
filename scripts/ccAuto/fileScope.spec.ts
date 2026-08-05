/** fileScope.spec.ts —— FileScope 路径规范化、系统保护、提案与批准测试 */
import { describe, it, expect } from 'vitest';
import {
  normalizeRepositoryRelativePath,
  isPathWithinRoot,
  isSystemProtectedPath,
  evaluateFileProposals,
  approveProposedFiles,
  normalizeSecurityPathKey,
  pathComparisonKey,
  pathsEqualForFilesystem,
  isPathWithinRootForFilesystem,
} from './fileScope';
import type { FileScope } from './types';

// ============================================================================
// 路径规范化
// ============================================================================
describe('normalizeRepositoryRelativePath', () => {
  it('normalizes a standard relative path', () => {
    const r = normalizeRepositoryRelativePath('src/components/Foo.vue');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('src/components/Foo.vue');
  });

  it('converts Windows backslashes to forward slashes', () => {
    const r = normalizeRepositoryRelativePath('scripts\\ccAuto\\foo.ts');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('scripts/ccAuto/foo.ts');
  });

  it('rejects empty path', () => {
    const r = normalizeRepositoryRelativePath('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EMPTY_PATH');
  });

  it('rejects whitespace-only path', () => {
    const r = normalizeRepositoryRelativePath('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('WHITESPACE_ONLY');
  });

  it('rejects path with NUL character', () => {
    const r = normalizeRepositoryRelativePath('src/\0/file.ts');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NUL_CHARACTER');
  });

  it('rejects POSIX absolute path /etc/passwd', () => {
    const r = normalizeRepositoryRelativePath('/etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ABSOLUTE_PATH');
  });

  it('rejects Windows drive-letter path', () => {
    const r = normalizeRepositoryRelativePath('C:\\foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ABSOLUTE_PATH');
  });

  it('rejects UNC path', () => {
    const r = normalizeRepositoryRelativePath('//server/share/file');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ABSOLUTE_PATH');
  });

  it('rejects path with leading ../', () => {
    const r = normalizeRepositoryRelativePath('../foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PATH_TRAVERSAL');
  });

  it('rejects path with mid-path traversal foo/../../bar', () => {
    const r = normalizeRepositoryRelativePath('foo/../../bar');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PATH_TRAVERSAL');
  });

  it('rejects . as root path', () => {
    const r = normalizeRepositoryRelativePath('.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ROOT_ONLY');
  });

  it('normalizes correctly for segment boundary testing scenario', () => {
    const r1 = normalizeRepositoryRelativePath('src/app');
    const r2 = normalizeRepositoryRelativePath('src/application/file.ts');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(r1.normalized).toBe('src/app');
    if (r2.ok) expect(r2.normalized).toBe('src/application/file.ts');
  });

  it('rejects double slashes (empty segment)', () => {
    const r = normalizeRepositoryRelativePath('src//components///Foo.vue');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EMPTY_PATH');
  });

  it('strips trailing slash', () => {
    const r = normalizeRepositoryRelativePath('src/components/');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('src/components');
  });

  it('allows dot in filename like .gitignore', () => {
    const r = normalizeRepositoryRelativePath('.gitignore');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('.gitignore');
  });

  it('allows dot in filename like .env.example', () => {
    const r = normalizeRepositoryRelativePath('.env.example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('.env.example');
  });

  it('strips leading ./', () => {
    const r = normalizeRepositoryRelativePath('./src/foo.ts');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('src/foo.ts');
  });

  it('treats %2e%2e as literal filename, not traversal', () => {
    const r = normalizeRepositoryRelativePath('%2e%2e');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('%2e%2e');
  });

  it('treats %2e%2e/file as literal filename', () => {
    const r = normalizeRepositoryRelativePath('%2e%2e/file');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('%2e%2e/file');
  });

  it('preserves spaces in paths', () => {
    const r = normalizeRepositoryRelativePath('src/my components/Header.tsx');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('src/my components/Header.tsx');
  });
});

// ============================================================================
// normalizeSecurityPathKey — 大小写折叠
// ============================================================================
describe('normalizeSecurityPathKey', () => {
  it('lowercases ASCII paths', () => {
    expect(normalizeSecurityPathKey('.GIT/config')).toBe('.git/config');
    expect(normalizeSecurityPathKey('.CC-AUTO/config.json')).toBe('.cc-auto/config.json');
    expect(normalizeSecurityPathKey('NODE_MODULES/foo.js')).toBe('node_modules/foo.js');
  });

  it('preserves already-lowercase paths', () => {
    expect(normalizeSecurityPathKey('.git/config')).toBe('.git/config');
    expect(normalizeSecurityPathKey('src/app.ts')).toBe('src/app.ts');
  });

  it('handles mixed case with Unicode stability', () => {
    expect(normalizeSecurityPathKey('.Git/Config')).toBe('.git/config');
    expect(normalizeSecurityPathKey('.Cc-AuTo/RuNs/x.json')).toBe('.cc-auto/runs/x.json');
  });
});

// ============================================================================
// pathComparisonKey — 平台感知路径比较键
// ============================================================================
describe('pathComparisonKey', () => {
  it('returns lowercase on win32 for non-security', () => {
    const key = pathComparisonKey('Src/App.Ts', { platform: 'win32' });
    expect(key).toBe('src/app.ts');
  });

  it('returns original case on linux for non-security', () => {
    const key = pathComparisonKey('Src/App.Ts', { platform: 'linux' });
    expect(key).toBe('Src/App.Ts');
  });

  it('returns lowercase when securitySensitive regardless of platform', () => {
    expect(pathComparisonKey('Src/App.Ts', { platform: 'linux', securitySensitive: true })).toBe('src/app.ts');
    expect(pathComparisonKey('Src/App.Ts', { platform: 'win32', securitySensitive: true })).toBe('src/app.ts');
  });
});

// ============================================================================
// pathsEqualForFilesystem — 平台感知相等判断
// ============================================================================
describe('pathsEqualForFilesystem', () => {
  it('treats as equal on win32 case-insensitively', () => {
    expect(pathsEqualForFilesystem('SRC/App.ts', 'src/app.ts', { platform: 'win32' })).toBe(true);
  });

  it('treats as not equal on linux for case mismatch', () => {
    expect(pathsEqualForFilesystem('SRC/App.ts', 'src/app.ts', { platform: 'linux' })).toBe(false);
  });

  it('treats as equal on linux for exact match', () => {
    expect(pathsEqualForFilesystem('src/app.ts', 'src/app.ts', { platform: 'linux' })).toBe(true);
  });
});

// ============================================================================
// isPathWithinRootForFilesystem — 平台感知段边界
// ============================================================================
describe('isPathWithinRootForFilesystem', () => {
  it('returns true on win32 with case mismatch', () => {
    expect(isPathWithinRootForFilesystem('SRC/App/foo.ts', 'src/app', { platform: 'win32' })).toBe(true);
  });

  it('returns false on linux with case mismatch', () => {
    expect(isPathWithinRootForFilesystem('SRC/App/foo.ts', 'src/app', { platform: 'linux' })).toBe(false);
  });

  it('respects segment boundary on win32', () => {
    expect(isPathWithinRootForFilesystem('SRC/Application/file.ts', 'src/app', { platform: 'win32' })).toBe(false);
  });
});

// ============================================================================
// 路径段边界比较（原始字符串比较）
// ============================================================================
describe('isPathWithinRoot', () => {
  it('returns true when target equals root', () => {
    expect(isPathWithinRoot('src/app', 'src/app')).toBe(true);
  });

  it('returns true when target is under root', () => {
    expect(isPathWithinRoot('src/app/foo.ts', 'src/app')).toBe(true);
  });

  it('returns false when target shares prefix but is not under root', () => {
    expect(isPathWithinRoot('src/application/file.ts', 'src/app')).toBe(false);
  });

  it('returns false when root is empty', () => {
    expect(isPathWithinRoot('src/app', '')).toBe(false);
  });

  it('returns false when target is empty', () => {
    expect(isPathWithinRoot('', 'src/app')).toBe(false);
  });

  it('returns true for nested multi-level root', () => {
    expect(isPathWithinRoot('src/components/ui/Button.tsx', 'src/components')).toBe(true);
  });

  it('returns false for root path that is a file', () => {
    expect(isPathWithinRoot('src/app.ts', 'src/app')).toBe(false);
  });

  it('returns false for shorter path', () => {
    expect(isPathWithinRoot('src', 'src/app/deep')).toBe(false);
  });
});

// ============================================================================
// 系统保护路径 — 核心测试
// ============================================================================
describe('isSystemProtectedPath', () => {
  // === .git 保护 ===
  it('rejects .git directory', () => {
    expect(isSystemProtectedPath('.git')).toBe(true);
    expect(isSystemProtectedPath('.git/config')).toBe(true);
    expect(isSystemProtectedPath('.git/objects/ab/cdef')).toBe(true);
    expect(isSystemProtectedPath('.git/HEAD')).toBe(true);
  });

  // === 大小写绕过防护 ===
  it('rejects .GIT/config (case-insensitive protection)', () => {
    expect(isSystemProtectedPath('.GIT/config')).toBe(true);
    expect(isSystemProtectedPath('.Git/HEAD')).toBe(true);
    expect(isSystemProtectedPath('.GIT')).toBe(true);
  });

  it('rejects .CC-AUTO/config.json (case-insensitive protection)', () => {
    expect(isSystemProtectedPath('.CC-AUTO/config.json')).toBe(true);
    expect(isSystemProtectedPath('.Cc-Auto/config.json')).toBe(true);
  });

  it('rejects .CC-AUTO/RUNS/x/state.json (case-insensitive protection)', () => {
    expect(isSystemProtectedPath('.CC-AUTO/RUNS/x/state.json')).toBe(true);
    expect(isSystemProtectedPath('.cc-auto/RUNS/run-1/state.json')).toBe(true);
  });

  it('rejects NODE_MODULES/x.js (case-insensitive protection)', () => {
    expect(isSystemProtectedPath('NODE_MODULES/x.js')).toBe(true);
    expect(isSystemProtectedPath('Node_Modules/vite/index.js')).toBe(true);
  });

  it('rejects .CC-AUTO/run-lock.json (case-insensitive protection)', () => {
    expect(isSystemProtectedPath('.CC-AUTO/run-lock.json')).toBe(true);
    expect(isSystemProtectedPath('.CC-AUTO/RUN-lock.json')).toBe(true);
  });

  // === 不误伤合法路径 ===
  it('does not reject .gitignore', () => {
    expect(isSystemProtectedPath('.gitignore')).toBe(false);
    expect(isSystemProtectedPath('.gitattributes')).toBe(false);
    // Case variants should not be rejected either — it's not .git/
    expect(isSystemProtectedPath('.GITIGNORE')).toBe(false);
  });

  it('does not reject .cc-auto/runs-old', () => {
    expect(isSystemProtectedPath('.cc-auto/runs-old')).toBe(false);
    expect(isSystemProtectedPath('.cc-auto/runs-old/state.json')).toBe(false);
  });

  it('does not reject node_modules-old', () => {
    expect(isSystemProtectedPath('node_modules-old')).toBe(false);
    expect(isSystemProtectedPath('node_modules-old/foo.js')).toBe(false);
  });

  it('does not reject server/schema.ts.bak', () => {
    expect(isSystemProtectedPath('server/schema.ts.bak')).toBe(false);
  });

  // === 保护路径正例 ===
  it('rejects .cc-auto/config.json', () => {
    expect(isSystemProtectedPath('.cc-auto/config.json')).toBe(true);
  });

  it('rejects .cc-auto/run-lock.json', () => {
    expect(isSystemProtectedPath('.cc-auto/run-lock.json')).toBe(true);
  });

  it('rejects .cc-auto/runs paths', () => {
    expect(isSystemProtectedPath('.cc-auto/runs')).toBe(true);
    expect(isSystemProtectedPath('.cc-auto/runs/run-123/state.json')).toBe(true);
  });

  it('rejects .env', () => {
    expect(isSystemProtectedPath('.env')).toBe(true);
  });

  it('rejects .env.local per safety.ts rules', () => {
    expect(isSystemProtectedPath('.env.local')).toBe(true);
    expect(isSystemProtectedPath('.env.production')).toBe(true);
    expect(isSystemProtectedPath('.env.development')).toBe(true);
  });

  it('rejects data/offerflow.sqlite3', () => {
    expect(isSystemProtectedPath('data/offerflow.sqlite3')).toBe(true);
  });

  it('rejects node_modules paths', () => {
    expect(isSystemProtectedPath('node_modules')).toBe(true);
    expect(isSystemProtectedPath('node_modules/vite/index.js')).toBe(true);
    expect(isSystemProtectedPath('node_modules/@types/node/index.d.ts')).toBe(true);
  });

  it('handles .env.example per safety.ts rules', () => {
    expect(isSystemProtectedPath('.env.example')).toBe(true);
  });

  it('rejects server/schema.ts via safety.ts inheritance', () => {
    expect(isSystemProtectedPath('server/schema.ts')).toBe(true);
  });

  it('handles foo/server/schema.ts per safety.ts current semantics', () => {
    expect(isSystemProtectedPath('foo/server/schema.ts')).toBe(true);
  });

  it('allows normal business paths', () => {
    expect(isSystemProtectedPath('src/app/prompt.ts')).toBe(false);
    expect(isSystemProtectedPath('scripts/ccAuto/fileScope.ts')).toBe(false);
    expect(isSystemProtectedPath('docs/README.md')).toBe(false);
  });
});

// ============================================================================
// FileScope 提案
// ============================================================================
function makeScope(overrides: Partial<FileScope> = {}): FileScope {
  return {
    allowedRoots: ['scripts/ccAuto', 'src/components'],
    protectedPaths: ['scripts/ccAuto/safety.ts', 'src/components/Legacy'],
    proposedFiles: [],
    approvedFiles: [],
    maxChangedFiles: 10,
    ...overrides,
  };
}

describe('evaluateFileProposals', () => {
  it('auto-approves files within allowedRoots', () => {
    const scope = makeScope();
    const result = evaluateFileProposals(scope, ['scripts/ccAuto/newFile.ts']);
    expect(result.approvedFiles).toContain('scripts/ccAuto/newFile.ts');
    expect(result.denied).toBe(false);
    expect(result.requiresHumanApproval).toBe(false);
  });

  it('requires human approval for files outside allowedRoots', () => {
    const scope = makeScope();
    const result = evaluateFileProposals(scope, ['docs/README.md']);
    expect(result.requiresHumanApproval).toBe(true);
    const d = result.decisions.find((x) => x.path === 'docs/README.md');
    expect(d).toBeDefined();
    expect(d!.decision).toBe('REQUIRES_HUMAN_APPROVAL');
    expect(d!.reason).toBe('OUTSIDE_ALLOWED_ROOTS');
  });

  it('requires human approval for protected paths', () => {
    const scope = makeScope();
    const result = evaluateFileProposals(scope, ['scripts/ccAuto/safety.ts']);
    const d = result.decisions.find((x) => x.normalizedPath === 'scripts/ccAuto/safety.ts');
    expect(d).toBeDefined();
    expect(d!.decision).toBe('REQUIRES_HUMAN_APPROVAL');
    expect(d!.reason).toBe('PROTECTED_PATH');
  });

  it('permanently denies system protected paths', () => {
    const scope = makeScope();
    const result = evaluateFileProposals(scope, ['.git/config', 'data/offerflow.sqlite3']);
    expect(result.denied).toBe(true);
    for (const d of result.decisions) {
      expect(d.decision).toBe('DENIED');
      expect(d.reason).toBe('SYSTEM_PROTECTED_PATH');
    }
  });

  // === 大小写绕过系统保护路径永久拒绝 ===
  it('permanently denies case-variant system protected paths', () => {
    const scope = makeScope();
    const result = evaluateFileProposals(scope, ['.GIT/config', '.CC-AUTO/config.json', 'NODE_MODULES/x.js']);
    expect(result.denied).toBe(true);
    for (const d of result.decisions) {
      expect(d.decision).toBe('DENIED');
      expect(d.reason).toBe('SYSTEM_PROTECTED_PATH');
    }
  });

  it('does not grant write permission based on proposal alone for out-of-scope files', () => {
    const scope = makeScope();
    const result = evaluateFileProposals(scope, ['docs/README.md']);
    expect(result.approvedFiles).not.toContain('docs/README.md');
  });

  it('deduplicates after normalization', () => {
    const scope = makeScope();
    const result = evaluateFileProposals(scope, [
      'scripts/ccAuto/foo.ts',
      'scripts\\ccAuto\\foo.ts',
    ]);
    const approved = result.decisions.filter((d) => d.decision === 'APPROVED');
    expect(approved.length).toBe(1);
    const duplicate = result.decisions.find((d) => d.reason === 'DUPLICATE_PATH');
    expect(duplicate).toBeDefined();
  });

  // === 整批原子 maxChangedFiles ===
  it('allows files when batch fits exactly at maxChangedFiles', () => {
    const scope = makeScope({ maxChangedFiles: 3 });
    const result = evaluateFileProposals(scope, [
      'scripts/ccAuto/a.ts',
      'scripts/ccAuto/b.ts',
      'scripts/ccAuto/c.ts',
    ]);
    expect(result.approvedFiles.length).toBe(3);
    expect(result.denied).toBe(false);
  });

  it('rejects entire batch when exceeding maxChangedFiles (zero new approvals)', () => {
    const scope = makeScope({
      maxChangedFiles: 2,
      approvedFiles: ['scripts/ccAuto/existing.ts'],
    });
    const result = evaluateFileProposals(scope, [
      'scripts/ccAuto/a.ts',
      'scripts/ccAuto/b.ts',
    ]);
    const approved = result.decisions.filter((d) => d.decision === 'APPROVED');
    expect(approved.length).toBe(0);
    const denied = result.decisions.filter((d) => d.reason === 'MAX_CHANGED_FILES_EXCEEDED');
    expect(denied.length).toBe(2);
    expect(result.approvedFiles).toEqual(['scripts/ccAuto/existing.ts']);
  });

  it('produces consistent result regardless of proposedFiles order', () => {
    const scope = makeScope({ maxChangedFiles: 2, approvedFiles: [] });
    const r1 = evaluateFileProposals(scope, ['scripts/ccAuto/a.ts', 'scripts/ccAuto/b.ts', 'scripts/ccAuto/c.ts']);
    const r2 = evaluateFileProposals(scope, ['scripts/ccAuto/c.ts', 'scripts/ccAuto/b.ts', 'scripts/ccAuto/a.ts']);
    expect(r1.approvedFiles.length).toBe(0);
    expect(r2.approvedFiles.length).toBe(0);
    expect(r1.decisions.filter(d => d.reason === 'MAX_CHANGED_FILES_EXCEEDED').length).toBe(3);
    expect(r2.decisions.filter(d => d.reason === 'MAX_CHANGED_FILES_EXCEEDED').length).toBe(3);
  });

  it('deduplicated norm path does not double-count toward maxChangedFiles', () => {
    const scope = makeScope({ maxChangedFiles: 2, approvedFiles: [] });
    const result = evaluateFileProposals(scope, [
      'scripts/ccAuto/a.ts',
      'scripts\\ccAuto\\a.ts',
      'scripts/ccAuto/b.ts',
    ]);
    expect(result.approvedFiles.length).toBe(2);
  });

  it('already-approved files re-proposed do not consume slots', () => {
    const scope = makeScope({
      maxChangedFiles: 2,
      approvedFiles: ['scripts/ccAuto/a.ts'],
    });
    const result = evaluateFileProposals(scope, [
      'scripts/ccAuto/a.ts',
      'scripts/ccAuto/b.ts',
    ]);
    expect(result.approvedFiles.length).toBe(2);
    expect(result.decisions.find(d => d.reason === 'DUPLICATE_PATH')).toBeDefined();
  });

  it('denies invalid paths', () => {
    const scope = makeScope();
    const result = evaluateFileProposals(scope, ['/etc/passwd']);
    const d = result.decisions[0];
    expect(d.decision).toBe('DENIED');
    expect(d.reason).toBe('INVALID_PATH');
  });

  it('handles empty proposed files', () => {
    const scope = makeScope();
    const result = evaluateFileProposals(scope, []);
    expect(result.approvedFiles).toEqual([]);
    expect(result.denied).toBe(false);
    expect(result.requiresHumanApproval).toBe(false);
  });

  // === protectedPaths 段边界真实断言 ===
  it('protectedPaths segment boundary does not false-match similar prefix', () => {
    const scope = makeScope({ protectedPaths: ['src/app'] });
    // 'src/application/file.ts' should NOT be under 'src/app' (segment boundary)
    const result = evaluateFileProposals(scope, ['src/application/file.ts', 'src/app/file.ts']);
    // src/application/file.ts — NOT under src/app root
    const dOutside = result.decisions.find(d => d.normalizedPath === 'src/application/file.ts');
    expect(dOutside).toBeDefined();
    expect(dOutside!.reason).not.toBe('PROTECTED_PATH');
    // src/app/file.ts — IS under src/app root
    const dInside = result.decisions.find(d => d.normalizedPath === 'src/app/file.ts');
    expect(dInside).toBeDefined();
    expect(dInside!.reason).toBe('PROTECTED_PATH');
  });

  // === scope 配置含非法路径 → fail closed ===
  it('fails closed when allowedRoots contains invalid path', () => {
    const scope = makeScope({ allowedRoots: ['/etc'] });
    const result = evaluateFileProposals(scope, ['src/test.txt']);
    expect(result.denied).toBe(true);
  });
});

// ============================================================================
// 人工批准
// ============================================================================
describe('approveProposedFiles', () => {
  it('approves out-of-scope files when user approves (non-protected)', () => {
    const scope = makeScope();
    const result = approveProposedFiles(scope, ['docs/README.md'], true);
    expect(result.approvedFiles).toContain('docs/README.md');
    expect(result.denied).toBe(false);
  });

  it('cannot override system protected paths even with user approval', () => {
    const scope = makeScope();
    const result = approveProposedFiles(scope, ['.git/config'], true);
    expect(result.denied).toBe(true);
    expect(result.approvedFiles).not.toContain('.git/config');
    expect(result.decisions[0].reason).toBe('SYSTEM_PROTECTED_PATH');
  });

  // === 大小写绕过系统保护路径即使人工批准也拒绝 ===
  it('cannot override case-variant system protected paths even with user approval', () => {
    const scope = makeScope();
    const result = approveProposedFiles(scope, ['.GIT/config', '.CC-AUTO/config.json'], true);
    expect(result.denied).toBe(true);
    for (const d of result.decisions) {
      expect(d.reason).toBe('SYSTEM_PROTECTED_PATH');
    }
  });

  it('stores approved files as exact file paths, not directory grants', () => {
    const scope = makeScope();
    const result = approveProposedFiles(scope, ['scripts/ccAuto/foo.ts'], true);
    expect(result.approvedFiles).toContain('scripts/ccAuto/foo.ts');
    expect(result.approvedFiles).not.toContain('scripts/ccAuto');
  });

  it('requires human approval for protected paths when user did not approve', () => {
    const scope = makeScope();
    const result = approveProposedFiles(scope, ['scripts/ccAuto/safety.ts'], false);
    const d = result.decisions[0];
    expect(d.decision).toBe('REQUIRES_HUMAN_APPROVAL');
    expect(result.approvedFiles).not.toContain('scripts/ccAuto/safety.ts');
  });

  it('does not approve protected paths even when userApproved=true', () => {
    const scope = makeScope();
    const result = approveProposedFiles(scope, ['scripts/ccAuto/safety.ts'], true);
    const d = result.decisions[0];
    expect(d.decision).toBe('REQUIRES_HUMAN_APPROVAL');
    expect(d.reason).toBe('PROTECTED_PATH');
    expect(result.approvedFiles).not.toContain('scripts/ccAuto/safety.ts');
  });

  it('does not auto-delete protectedPaths during approval', () => {
    const scope = makeScope({ protectedPaths: ['scripts/ccAuto/safety.ts'] });
    const beforeProtected = [...scope.protectedPaths];
    approveProposedFiles(scope, ['scripts/ccAuto/safety.ts'], true);
    expect(scope.protectedPaths).toEqual(beforeProtected);
  });

  it('rejects entire batch when exceeding maxChangedFiles even with user approval', () => {
    const scope = makeScope({
      maxChangedFiles: 1,
      approvedFiles: ['existing.ts'],
    });
    const result = approveProposedFiles(scope, ['docs/a.md', 'docs/b.md'], true);
    expect(result.denied).toBe(true);
    expect(result.approvedFiles.length).toBe(1);
  });

  it('rejects invalid paths even with user approval', () => {
    const scope = makeScope();
    const result = approveProposedFiles(scope, ['/etc/passwd'], true);
    expect(result.denied).toBe(true);
    expect(result.decisions[0].reason).toBe('INVALID_PATH');
  });
});
