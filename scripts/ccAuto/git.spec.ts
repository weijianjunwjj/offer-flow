/** git.spec.ts — run-start baseline & runChangedFiles regression tests (P4) */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureRunStartBaseline,
  computeRunChangedFiles,
  inspectGitHead,
  GitBaselineError,
} from './git';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-git-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function commitFile(rel: string, content: string): void {
  const abs = path.join(cwd, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '-q', '-m', `seed ${rel}`], { cwd });
}

/** Write a file and commit ONLY that specific file (doesn't stage other dirty files). */
function commitSingle(rel: string, content: string): void {
  const abs = path.join(cwd, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  execFileSync('git', ['add', rel], { cwd });
  execFileSync('git', ['commit', '-q', '-m', `seed single ${rel}`], { cwd });
}

describe('captureRunStartBaseline', () => {
  it('captures per-file status and content fingerprint for pre-existing dirty files', () => {
    commitFile('a.ts', 'const a = 1;\n');
    // Make a.ts dirty
    writeFileSync(path.join(cwd, 'a.ts'), 'const a = 2;\n', 'utf8');

    const baseline = captureRunStartBaseline(cwd);
    expect(baseline.files.length).toBe(1);
    expect(baseline.files[0].path).toBe('a.ts');
    expect(baseline.files[0].contentFingerprint).not.toBeNull();
    expect(baseline.files[0].contentFingerprint).toHaveLength(64); // SHA256 hex
  });

  it('captures multiple pre-dirty files', () => {
    commitFile('cli.ts', '// cli\n');
    commitFile('orchestrator.ts', '// orch\n');
    commitFile('taskCostSummary.ts', '// tcs\n');

    writeFileSync(path.join(cwd, 'cli.ts'), '// cli modified\n', 'utf8');
    writeFileSync(path.join(cwd, 'orchestrator.ts'), '// orch modified\n', 'utf8');
    writeFileSync(path.join(cwd, 'taskCostSummary.ts'), '// tcs modified\n', 'utf8');

    const baseline = captureRunStartBaseline(cwd);
    expect(baseline.files.length).toBe(3);
  });

  it('returns empty baseline when worktree is clean', () => {
    commitFile('a.ts', 'clean\n');
    const baseline = captureRunStartBaseline(cwd);
    expect(baseline.files.length).toBe(0);
  });
});

describe('computeRunChangedFiles', () => {
  // Case A: pre-existing dirty, model did NOT touch → NOT in runChangedFiles
  it('Case A: pre-existing dirty file untouched by run → excluded from runChangedFiles', () => {
    commitFile('cli.ts', '// original\n');
    writeFileSync(path.join(cwd, 'cli.ts'), '// pre-dirty\n', 'utf8');

    const baseline = captureRunStartBaseline(cwd);
    expect(baseline.files.length).toBe(1);

    // Model runs, only touches demoRun.ts (which was clean).
    // Use commitSingle to avoid accidentally staging the pre-dirty cli.ts.
    commitSingle('demoRun.ts', 'export const TITLE = "hello";\n');
    writeFileSync(path.join(cwd, 'demoRun.ts'), 'export const TITLE = "hello [modified]";\n', 'utf8');

    const runChanged = computeRunChangedFiles(cwd, baseline);

    // demoRun.ts is in runChanged (Case C)
    expect(runChanged).toContain('demoRun.ts');

    // cli.ts is NOT in runChanged (Case A — pre-dirty, untouched)
    expect(runChanged).not.toContain('cli.ts');
  });

  // Case B: pre-existing dirty, model modified again → in runChangedFiles
  it('Case B: pre-existing dirty file modified again during run → included in runChangedFiles', () => {
    commitFile('cli.ts', '// original\n');
    writeFileSync(path.join(cwd, 'cli.ts'), '// pre-dirty\n', 'utf8');

    const baseline = captureRunStartBaseline(cwd);
    expect(baseline.files.length).toBe(1);

    // Model runs and further modifies cli.ts
    writeFileSync(path.join(cwd, 'cli.ts'), '// pre-dirty, then model modified again\n', 'utf8');

    const runChanged = computeRunChangedFiles(cwd, baseline);

    // cli.ts changed content from baseline → in runChangedFiles
    expect(runChanged).toContain('cli.ts');
  });

  // Case C: clean → dirty during run → in runChangedFiles
  it('Case C: clean file modified by model → included in runChangedFiles', () => {
    commitFile('demoRun.ts', 'export const TITLE = "hello";\n');

    const baseline = captureRunStartBaseline(cwd);
    expect(baseline.files.length).toBe(0);

    // Model modifies demoRun.ts
    writeFileSync(path.join(cwd, 'demoRun.ts'), 'export const TITLE = "hello [modified]";\n', 'utf8');

    const runChanged = computeRunChangedFiles(cwd, baseline);
    expect(runChanged).toEqual(['demoRun.ts']);
  });

  // Case D: pre-existing dirty, model restores to HEAD → in runChangedFiles
  it('Case D: pre-existing dirty file restored to HEAD by model → included in runChangedFiles', () => {
    const original = '// original content\n';
    commitFile('cli.ts', original);
    writeFileSync(path.join(cwd, 'cli.ts'), '// pre-dirty modification\n', 'utf8');

    const baseline = captureRunStartBaseline(cwd);

    // Model restores to HEAD content
    writeFileSync(path.join(cwd, 'cli.ts'), original, 'utf8');

    const runChanged = computeRunChangedFiles(cwd, baseline);

    // Content differs from baseline → in runChangedFiles (even though it now matches HEAD)
    expect(runChanged).toContain('cli.ts');
  });

  // Regression: multiple pre-dirty files, model only touches one
  it('Regression: 3 pre-dirty files, model only changes demoRun.ts → only demoRun.ts in runChangedFiles', () => {
    commitFile('cli.ts', '// cli original\n');
    commitFile('orchestrator.ts', '// orch original\n');
    commitFile('taskCostSummary.ts', '// tcs original\n');
    commitFile('demoRun.ts', 'export const TITLE = "hello";\n');

    // Pre-dirty: 3 files
    writeFileSync(path.join(cwd, 'cli.ts'), '// cli pre-dirty\n', 'utf8');
    writeFileSync(path.join(cwd, 'orchestrator.ts'), '// orch pre-dirty\n', 'utf8');
    writeFileSync(path.join(cwd, 'taskCostSummary.ts'), '// tcs pre-dirty\n', 'utf8');

    const baseline = captureRunStartBaseline(cwd);
    expect(baseline.files.length).toBe(3);

    // Model only modifies demoRun.ts
    writeFileSync(path.join(cwd, 'demoRun.ts'), 'export const TITLE = "hello [modified]";\n', 'utf8');

    const runChanged = computeRunChangedFiles(cwd, baseline);

    // Only demoRun.ts should be in runChangedFiles
    expect(runChanged).toEqual(['demoRun.ts']);

    // Explicitly: pre-dirty files NOT in runChangedFiles
    expect(runChanged).not.toContain('cli.ts');
    expect(runChanged).not.toContain('orchestrator.ts');
    expect(runChanged).not.toContain('taskCostSummary.ts');
  });

  // Security counter-example: pre-dirty cli.ts is modified again
  it('Security counter-example: pre-dirty cli.ts modified again → FILE_NOT_APPROVED detectable', () => {
    commitFile('cli.ts', '// original\n');
    commitFile('demoRun.ts', 'export const TITLE = "hello";\n');

    // cli.ts pre-dirty
    writeFileSync(path.join(cwd, 'cli.ts'), '// pre-dirty\n', 'utf8');

    const baseline = captureRunStartBaseline(cwd);

    // Model modifies BOTH demoRun.ts AND cli.ts
    writeFileSync(path.join(cwd, 'demoRun.ts'), 'export const TITLE = "hello [modified]";\n', 'utf8');
    writeFileSync(path.join(cwd, 'cli.ts'), '// pre-dirty + model modified again\n', 'utf8');

    const runChanged = computeRunChangedFiles(cwd, baseline);

    // Both files in runChangedFiles
    expect(runChanged).toContain('demoRun.ts');
    expect(runChanged).toContain('cli.ts');

    // If FileScope only has demoRun.ts approved, cli.ts would be FILE_NOT_APPROVED
    // This test proves the security counter-example is detectable
  });
});

describe('Git HEAD classification', () => {
  it('normal repo + valid HEAD → baseline 正常且不打印 ambiguous HEAD', () => {
    commitFile('a.ts', 'clean\n');
    const stderr: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
      stderr.push(String(chunk));
      return (origErr as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...args);
    }) as typeof process.stderr.write;
    try {
      expect(inspectGitHead(cwd)).toBe('NORMAL_HEAD');
      const baseline = captureRunStartBaseline(cwd);
      expect(baseline.headState).toBe('NORMAL_HEAD');
      expect(baseline.files.length).toBe(0);
    } finally {
      process.stderr.write = origErr;
    }
    expect(stderr.join('')).not.toContain("ambiguous argument 'HEAD'");
  });

  it('git repo + unborn HEAD → 明确 unborn 语义，不打印 ambiguous HEAD', () => {
    writeFileSync(path.join(cwd, 'draft.ts'), 'unborn\n', 'utf8');
    const stderr: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
      stderr.push(String(chunk));
      return (origErr as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...args);
    }) as typeof process.stderr.write;
    try {
      expect(inspectGitHead(cwd)).toBe('UNBORN_HEAD');
      const baseline = captureRunStartBaseline(cwd);
      expect(baseline.headState).toBe('UNBORN_HEAD');
      expect(baseline.files.map((f) => f.path)).toContain('draft.ts');
    } finally {
      process.stderr.write = origErr;
    }
    expect(stderr.join('')).not.toContain("ambiguous argument 'HEAD'");
    expect(stderr.join('')).not.toMatch(/fatal:/);
  });

  it('non-git directory → NOT_A_GIT_REPOSITORY', () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-nongit-'));
    try {
      expect(() => inspectGitHead(plain)).toThrow(GitBaselineError);
      try {
        inspectGitHead(plain);
      } catch (error) {
        expect(error).toBeInstanceOf(GitBaselineError);
        expect((error as GitBaselineError).kind).toBe('NOT_A_GIT_REPOSITORY');
      }
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('real git command failure → GIT_COMMAND_FAILED，不被吞掉', () => {
    commitFile('a.ts', 'seed\n');
    // 仓库仍有 commit，但 HEAD 指向不存在的分支：不是 unborn，也不是 non-git。
    writeFileSync(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/missing-branch\n', 'utf8');
    expect(() => inspectGitHead(cwd)).toThrow(GitBaselineError);
    try {
      inspectGitHead(cwd);
    } catch (error) {
      expect(error).toBeInstanceOf(GitBaselineError);
      expect((error as GitBaselineError).kind).toBe('GIT_COMMAND_FAILED');
    }
  });
});
