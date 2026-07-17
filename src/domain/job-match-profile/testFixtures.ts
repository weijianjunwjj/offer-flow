import { JOB_MATCH_CITY_CODES, type JobMatchCityCode, type JobMatchProfileDraft } from './types';

const roleBand = (titles: string[], salaryNote: string) => ({
  roleTitles: titles,
  roleFamilies: ['前端工程', 'AI 应用工程'],
  salaryRange: { minK: 20, maxK: 35, note: salaryNote },
  companySizes: ['20–500 人'],
  companyTypes: ['自研产品团队'],
  industries: ['企业服务', 'AI 应用'],
  technicalFocus: ['Vue', 'TypeScript', 'Node.js', 'AI 应用工程化'],
  suitableReasons: ['具备复杂产品与前后端闭环交付经验'],
  risks: ['需要用更多真实面试反馈验证岗位上限'],
});

const cityName: Record<JobMatchCityCode, string> = {
  suzhou: '苏州', wuxi: '无锡', shanghai: '上海', hangzhou: '杭州',
};

export function makeJobMatchProfileDraftFixture(): JobMatchProfileDraft {
  const supportingEvidence = [{
    sourceType: 'resume_version' as const,
    sourceId: 'resume-fixture',
    label: '当前主简历',
    polarity: 'support' as const,
    strength: 'strong' as const,
    city: null,
    summary: '简历体现 Vue、TypeScript、复杂 B 端与 AI 应用工程化经验。',
  }];
  return {
    northStarPositioning: '中小型自研团队的 AI 应用全栈工程师 / AI 产品工程师',
    highestReachableRole: '复杂产品技术负责人',
    primaryRoleFamilies: ['高级前端工程师', 'AI 应用前端工程师', '产品型前端工程师'],
    stretchRoles: roleBand(['AI 应用工程师', 'AI 产品工程师', '复杂产品技术负责人'], '仅作探索性测试区间'),
    primaryRoles: roleBand(['高级前端工程师', '产品型前端工程师', 'AI 应用前端工程师'], '以真实同城岗位为准'),
    safeRoles: roleBand(['复杂中后台前端', '数据平台前端', '工业软件前端'], '稳妥范围不代表长期价值下降'),
    coreCapabilities: [
      { key: 'vue_ts', label: 'Vue / TypeScript', level: 'core', summary: '能够交付复杂前端产品。', evidenceRefs: ['resume-fixture'] },
      { key: 'ai_delivery', label: 'AI 应用工程化', level: 'supporting', summary: '具备结构化输出与人工审核闭环经验。', evidenceRefs: ['resume-fixture'] },
      { key: 'large_ai', label: '大型 AI 生产经验', level: 'to_validate', summary: '仍需更多生产项目证据。', evidenceRefs: ['resume-fixture'] },
    ],
    constraints: [
      { key: 'education', label: '学历硬门槛', summary: '部分岗位可能存在全日制学历筛选。', evidenceRefs: ['resume-fixture'] },
      { key: 'stack', label: '技术栈边界', summary: 'React/Python 不是当前最强项。', evidenceRefs: ['resume-fixture'] },
    ],
    idealEnvironment: {
      companySizes: ['20–500 人'],
      companyTypes: ['自研产品团队'],
      industries: ['企业服务', 'AI 应用', '工业软件'],
      teamTraits: ['业务负责人或技术总监直接带队', '重视完整交付闭环'],
      description: '需要前端、产品、Node.js 与 AI 应用闭环的务实团队。',
    },
    acceptableRange: {
      roleTitles: ['高级前端工程师', 'AI 应用前端工程师', '复杂中后台前端'],
      cities: [...JOB_MATCH_CITY_CODES],
      salaryNote: '薪资必须按城市独立验证，不使用跨城结论。',
      companyTypes: ['自研产品', '边界清晰的交付团队'],
      workModes: ['现场办公', '混合办公'],
      notes: ['不接受画像自动降级', '稳妥岗位是战术范围'],
    },
    cityProfiles: JOB_MATCH_CITY_CODES.map((city) => ({
      city,
      confidence: city === 'suzhou' ? 'exploratory' : 'insufficient',
      summary: `${cityName[city]}画像使用独立样本；当前结论仍需更多本地反馈。`,
      highestReachableRole: city === 'shanghai' ? 'AI 应用工程师（待验证）' : '高级前端工程师（待验证）',
      stretchRoles: roleBand(['AI 应用工程师', '复杂产品技术负责人'], `${cityName[city]}冲刺薪资待本地验证`),
      primaryRoles: roleBand(['高级前端工程师', '产品型前端工程师'], `${cityName[city]}主攻薪资待本地验证`),
      safeRoles: roleBand(['复杂中后台前端', '工业软件前端'], `${cityName[city]}稳妥薪资待本地验证`),
      educationBarrier: '样本不足，学历门槛强度尚待本地验证',
      salaryNote: '不借用其他城市薪资；当前仅展示探索性范围。',
      preferredCompanyProfile: ['20–500 人自研团队', '产品与技术协作紧密'],
      supportingEvidence: city === 'suzhou' ? [{
        sourceType: 'application' as const,
        sourceId: 'application-suzhou-fixture',
        label: '苏州真实流程样本',
        polarity: 'support' as const,
        strength: 'medium' as const,
        city,
        summary: '存在一条苏州真实流程，仅用于探索性判断。',
      }] : [],
      counterEvidence: [],
      missingEvidence: ['独立招聘主体反馈', '本地可比较薪资', '明确岗位门槛反馈'],
      borrowedEvidence: city === 'wuxi' ? [{
        sourceCity: 'suzhou' as const,
        reason: '仅借用可迁移的复杂 B 端交付能力',
        discountNote: '作为弱参考，不提高无锡市场置信度',
        notApplicableTo: ['薪资', '回复率', '学历门槛', '岗位供给'],
      }] : [],
    })),
    supportingEvidence,
    counterEvidence: [{
      sourceType: 'user_input',
      sourceId: null,
      label: '待验证限制',
      polarity: 'counter',
      strength: 'weak',
      city: null,
      summary: '大型成熟 AI 项目生产证明仍不足。',
    }],
    confidence: 'exploratory',
    largestUncertainties: ['四城市独立样本量不足', '最高可达岗位仍需面试与 Offer 证据验证'],
  };
}
