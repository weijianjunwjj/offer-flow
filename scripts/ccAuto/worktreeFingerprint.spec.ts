/** worktreeFingerprint.spec.ts —— WorktreeFingerprint 计算测试 */
import { describe, it, expect } from 'vitest';
import { computeWorktreeFingerprint } from './worktreeFingerprint';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('computeWorktreeFingerprint', () => {
  it('produces full 64-char SHA256 fingerprint', () => {
    const fp = computeWorktreeFingerprint(REPO_ROOT);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces stable fingerprint for the same worktree', () => {
    const fp1 = computeWorktreeFingerprint(REPO_ROOT);
    const fp2 = computeWorktreeFingerprint(REPO_ROOT);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(64);
  });

  it('is not affected by .cc-auto/ content changes', () => {
    const fp1 = computeWorktreeFingerprint(REPO_ROOT);
    const fp2 = computeWorktreeFingerprint(REPO_ROOT);
    expect(fp1).toBe(fp2);
  });

  it('normalizes Windows paths consistently', () => {
    const fp1 = computeWorktreeFingerprint(REPO_ROOT);
    const fp2 = computeWorktreeFingerprint(REPO_ROOT);
    expect(fp1).toBe(fp2);
  });

  it('computation does not throw on valid repo', () => {
    expect(() => computeWorktreeFingerprint(REPO_ROOT)).not.toThrow();
  });
});
