/**
 * V8-4 分析输入组装测试 fixture：在 v8 沙箱库内 seed 正式简历与正式求职画像，
 * 供 inputSnapshot / llmInput 集成测试使用。绝不写入真实生产库。
 */
import type { SqliteDatabase } from '../../db';
import { ResumeVersionRepository } from '../../job-memory/resumeVersionRepository';
import { ProfileRepository } from '../../repositories/profileRepository';
import { sha256RequestHash } from '../../job-memory/requestHash';
import { createEmptyJobMatchProfileDraft } from '../../../src/domain/job-match-profile/defaults';
import type { JobMatchProfileState, JobMatchProfileVersion } from '../../../src/domain/job-match-profile/types';

export interface SeedProfilesResult {
  resumeVersionId: string;
  profileVersionId: string;
}

/** Seed 一条正式简历版本 + 一条正式求职画像版本；返回其版本 ID。 */
export function seedActiveResumeAndProfile(db: SqliteDatabase, now: number): SeedProfilesResult {
  const resumeRepo = new ResumeVersionRepository(db);
  const contentSnapshot = { resumeText: '资深后端工程师，Go 与分布式实战。', projectExperience: '主导支付系统重构，QPS x3。' };
  const resumeVersionId = 'resume-ver-1';
  resumeRepo.insert({
    record: {
      id: resumeVersionId, name: '后端简历', source: 'pasted_text', contentHash: sha256RequestHash(contentSnapshot),
      summary: '6 年后端，主导支付重构', contentSnapshot, createdAt: now, archivedAt: null, rowVersion: 1,
    },
    idempotencyKey: 'seed-resume-1', requestHash: sha256RequestHash({ resumeVersionId }),
  });
  resumeRepo.setActiveResumeVersionId(resumeVersionId, now);

  const draft = createEmptyJobMatchProfileDraft();
  draft.primaryRoleFamilies = ['后端工程师'];
  draft.coreCapabilities = [{ key: 'backend', label: '后端', level: 'strong', summary: 'Go 微服务与高并发' } as never];
  draft.constraints = [{ key: 'city', label: '城市', summary: '仅苏州' } as never];
  draft.idealEnvironment.description = '技术驱动、工程文化强的团队';
  const profileVersionId = 'jmp-ver-1';
  const version = {
    ...draft, id: profileVersionId, version: 1, status: 'active', sourceSnapshot: {} as never,
    createdAt: now, activatedAt: now, supersedesVersionId: null, proposalId: 'prop-1',
  } as unknown as JobMatchProfileVersion;
  const state: JobMatchProfileState = {
    stateVersion: 1, activeVersionId: profileVersionId, versions: [version], proposals: [], commandReceipts: [],
  };

  const profileRepo = new ProfileRepository(db);
  profileRepo.save({
    resumeText: '', projectExperience: '', targetCity: '苏州', targetRole: '后端工程师', expectedSalary: '25-35K',
    acceptOutsourcing: false, acceptOvertime: true, jobSearchFocus: 'growth', weaknessNote: '', jobMatchProfile: state,
  });
  return { resumeVersionId, profileVersionId };
}
