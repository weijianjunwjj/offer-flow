import { describe, expect, it } from 'vitest';
import type { ResumeVersionRecord } from '../domain/job-memory';
import type { JobSeekerProfile } from '../storage';
import {
  buildProfileResumeSnapshot,
  hashResumeContentSnapshot,
  hasResumeContent,
  shortContentHash,
  sortResumeVersions,
} from './resumeVersionsModel';

function version(id: string, createdAt: number, archivedAt: number | null = null): ResumeVersionRecord {
  return {
    id,
    name: id,
    source: 'profile_snapshot',
    contentHash: `${id}-0123456789`,
    summary: '',
    contentSnapshot: { resumeText: id, projectExperience: '' },
    createdAt,
    archivedAt,
    rowVersion: 1,
  };
}

const profile: JobSeekerProfile = {
  resumeText: 'Vue\r\nTypeScript',
  projectExperience: 'OfferFlow\rProject',
  targetCity: '',
  targetRole: '',
  expectedSalary: '',
  acceptOutsourcing: false,
  acceptOvertime: false,
  jobSearchFocus: 'growth',
  weaknessNote: '',
};

describe('ResumeVersion 页面模型', () => {
  it('按 active、未归档、创建时间和 id 稳定排序', () => {
    const sorted = sortResumeVersions([
      version('archived', 50, 60),
      version('b', 20),
      version('active', 1),
      version('a', 20),
    ], 'active');
    expect(sorted.map((item) => item.id)).toEqual(['active', 'a', 'b', 'archived']);
  });

  it('只从真实 Profile 的两个设计字段构建并规范化快照', () => {
    expect(buildProfileResumeSnapshot(profile)).toEqual({
      resumeText: 'Vue\nTypeScript',
      projectExperience: 'OfferFlow\nProject',
    });
    expect(hasResumeContent({ resumeText: '  ', projectExperience: '' })).toBe(false);
    expect(hasResumeContent({ resumeText: '', projectExperience: '项目' })).toBe(true);
  });

  it('内容 hash 与 B2 canonical JSON 顺序一致，并只短显示 hash', async () => {
    await expect(hashResumeContentSnapshot({
      resumeText: 'Vue',
      projectExperience: 'OfferFlow',
    })).resolves.toBe('8c88732ca1d8f99b9712dd81cde1de81ab362f1fb768423363619f166948b09c');
    expect(shortContentHash('0123456789abcdef')).toBe('0123456789');
  });
});
