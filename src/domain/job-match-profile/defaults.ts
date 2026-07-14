import {
  JOB_MATCH_CITY_CODES,
  type JobMatchCityCode,
  type JobMatchProfileDraft,
  type JobMatchProfileState,
  type JobMatchRoleBand,
} from './types';

export function emptyJobMatchRoleBand(): JobMatchRoleBand {
  return {
    roleTitles: [],
    roleFamilies: [],
    salaryRange: { minK: null, maxK: null, note: '' },
    companySizes: [],
    companyTypes: [],
    industries: [],
    technicalFocus: [],
    suitableReasons: [],
    risks: [],
  };
}

export function createEmptyJobMatchProfileDraft(): JobMatchProfileDraft {
  return {
    northStarPositioning: '尚待填写核心定位',
    highestReachableRole: '尚待验证',
    primaryRoleFamilies: [],
    stretchRoles: emptyJobMatchRoleBand(),
    primaryRoles: emptyJobMatchRoleBand(),
    safeRoles: emptyJobMatchRoleBand(),
    coreCapabilities: [],
    constraints: [],
    idealEnvironment: {
      companySizes: [], companyTypes: [], industries: [], teamTraits: [], description: '尚待填写理想公司与团队环境',
    },
    acceptableRange: {
      roleTitles: [], cities: [...JOB_MATCH_CITY_CODES], salaryNote: '样本不足，暂不形成正式薪资结论',
      companyTypes: [], workModes: [], notes: [],
    },
    cityProfiles: JOB_MATCH_CITY_CODES.map((city: JobMatchCityCode) => ({
      city,
      confidence: 'insufficient',
      summary: '当前样本不足，请补充该城市的真实投递与反馈。',
      highestReachableRole: '尚待验证',
      stretchRoles: emptyJobMatchRoleBand(),
      primaryRoles: emptyJobMatchRoleBand(),
      safeRoles: emptyJobMatchRoleBand(),
      educationBarrier: '尚无足够本地证据',
      salaryNote: '样本不足，暂不形成正式薪资结论',
      preferredCompanyProfile: [],
      supportingEvidence: [],
      counterEvidence: [],
      missingEvidence: ['真实投递样本', '招聘方明确反馈', '可比较的本地薪资信息'],
      borrowedEvidence: [],
    })),
    supportingEvidence: [],
    counterEvidence: [],
    confidence: 'insufficient',
    largestUncertainties: ['当前尚无足够证据形成正式岗位匹配结论'],
  };
}

export function createEmptyJobMatchProfileState(): JobMatchProfileState {
  return {
    stateVersion: 0,
    activeVersionId: null,
    versions: [],
    proposals: [],
    commandReceipts: [],
  };
}
