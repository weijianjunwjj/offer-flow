import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { captureKnownJobFromRightPanel, type KnownJobExpected } from './bossExtractor';

function parse(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

interface PanelOpts {
  href?: string | null;
  role?: string;
  salary?: string;
  salaryFont?: string;
  company?: string | null;
  recruiterName?: string;
  recruiterAffiliation?: string;
  education?: string;
  activityStatus?: string;
  activityClass?: string;
  activityNestedInName?: boolean;
}

function panelDoc(opts: PanelOpts): Document {
  const role = opts.role ?? '中级前端开发工程师';
  const salary = opts.salary ?? '11-13K';
  const company = opts.company === undefined ? '右侧科技' : opts.company;
  const companyBlock = company !== null
    ? `<div class="company-info"><a class="name" href="/gongsi/example.html">${company}</a></div>`
    : '';
  const activityNode = opts.activityStatus !== undefined
    ? `<span class="${opts.activityClass ?? 'boss-active-time'}">${opts.activityStatus}</span>`
    : '';
  const recruiterBlock = opts.recruiterAffiliation !== undefined || opts.activityStatus !== undefined
    ? `<div class="job-boss-info"><span class="name">${opts.recruiterName ?? '某招聘者'}${opts.activityNestedInName === true ? activityNode : ''}</span>`
      + `${opts.recruiterAffiliation !== undefined ? `<span class="boss-info-attr">${opts.recruiterAffiliation}</span>` : ''}`
      + `${opts.activityNestedInName === true ? '' : activityNode}</div>`
    : '';
  const salaryStyle = opts.salaryFont !== undefined ? ` style="font-family: ${opts.salaryFont}"` : '';
  const anchor = opts.href !== undefined && opts.href !== null
    ? `<a class="link" href="/job_detail/${opts.href}.html?securityId=x&ka=detail">查看完整详情</a>`
    : '';
  return parse(
    `<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body>`
    + `<div class="job-detail-box">`
    + `<div class="job-header"><h1 class="name">${role}</h1>`
    + `<span class="salary"${salaryStyle}>${salary}</span><span class="text-city">苏州</span>`
    + `<ul class="tag-list"><li>3-5年</li><li>${opts.education ?? '本科'}</li></ul></div>`
    + companyBlock
    + recruiterBlock
    + anchor
    + `<div class="job-sec-text">职位描述 岗位职责：1. 负责数据可视化开发；2. 组件库建设。任职要求：本科，3-5年前端经验。</div>`
    + `</div></body></html>`,
  );
}

function expected(over: Partial<KnownJobExpected> = {}): KnownJobExpected {
  return {
    externalRecordId: 'AAAA1111',
    providerKey: 'boss_zhipin',
    canonicalSourceUrl: 'https://www.zhipin.com/job_detail/AAAA1111.html',
    roleFromCard: '中级前端开发工程师',
    salaryFromCardNorm: '11-13K',
    salaryFromCard: { minK: 11, maxK: 13, period: 'month' },
    salaryDecodedFromPua: false,
    companyDisplayName: '易诚互动',
    experienceFromCard: '3-5年',
    educationFromCard: '本科',
    ...over,
  };
}

describe('captureKnownJobFromRightPanel — 已知身份采集 (§四/§五)', () => {
  it('href 身份一致 → captured；company 来自所选卡片(selected_card)、字段完整', () => {
    const r = captureKnownJobFromRightPanel(panelDoc({ href: 'AAAA1111', salary: '11-13K' }), expected());
    expect(r.status).toBe('captured');
    expect(r.identityMatch).toBe(true);
    expect(r.identityBasis).toBe('right_panel_href');
    expect(r.rightPanelExternalRecordId).toBe('AAAA1111');
    expect(r.role.value).toBe('中级前端开发工程师');
    expect(r.company.value).toBe('易诚互动');
    expect(r.company.source).toBe('selected_card');
    expect(r.companyLegalName).toBeNull();
    expect(r.city.value).toBe('苏州');
    expect(r.salaryMinK.value).toBe(11);
    expect(r.salaryMaxK.value).toBe(13);
    expect(r.experienceRequirement.value).toBe('3-5年');
    expect(r.educationRequirement.value).toBe('本科');
    expect(r.activityStatus.value).toBeNull();
    expect(r.jdText ?? '').toContain('数据可视化开发');
    expect(r.blockingIssues).toHaveLength(0);
  });

  it('保留具体学历限定，并只从受控活跃节点读取采集时状态', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({
        href: 'AAAA1111', education: '全日制本科及以上',
        activityStatus: '在线', activityClass: 'boss-online-tag', activityNestedInName: true,
      }),
      expected(),
    );
    expect(r.educationRequirement.value).toBe('全日制本科及以上');
    expect(r.educationRequirement.source).toBe('boss_dom');
    expect(r.activityStatus.value).toBe('在线');
    expect(r.activityStatus.source).toBe('boss_dom');
    expect(r.activityStatus.value).not.toContain('某招聘者');
  });

  it('状态节点文案不做枚举，页面显示什么短文本就原样采集', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({ href: 'AAAA1111', activityStatus: '最近常来', activityClass: 'boss-status-label' }),
      expected(),
    );
    expect(r.activityStatus.value).toBe('最近常来');
  });

  it('招聘者姓名或非受控活跃文本不会进入 activityStatus', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({ href: 'AAAA1111', recruiterName: '刚刚活跃', recruiterAffiliation: '右侧科技 · HR' }),
      expected(),
    );
    expect(r.activityStatus.value).toBeNull();
  });

  it('§八.14 右侧薪资 PUA 不可读 → 回退所选卡片薪资 11-13K；§八.15「3-5年」不作薪资', () => {
    const r = captureKnownJobFromRightPanel(panelDoc({ href: 'AAAA1111', salary: '面-K议' }), expected());
    expect(r.identityMatch).toBe(true);
    expect(r.salaryMinK.value).toBe(11);
    expect(r.salaryMaxK.value).toBe(13);
    expect(r.salaryMinK.value).not.toBe(3);
    expect(r.salaryMaxK.value).not.toBe(5);
    expect(r.salaryCrossCheck).toBe('unavailable');
    expect(r.status).toBe('captured');
  });

  it('真实 kanzhun PUA 薪资严格解码为 18-28K，并标记 needs_correction 待人工确认', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({
        href: 'AAAA1111',
        salary: '\uE032\uE039-\uE033\uE039K',
        salaryFont: 'kanzhun-mix',
      }),
      expected({
        salaryFromCardNorm: '18-28K',
        salaryFromCard: { minK: 18, maxK: 28, period: 'month' },
        salaryDecodedFromPua: true,
      }),
    );
    expect(r.identityMatch).toBe(true);
    expect(r.salaryCrossCheck).toBe('matched');
    expect(r.salaryMinK.value).toBe(18);
    expect(r.salaryMaxK.value).toBe(28);
    expect(r.salaryMinK.source).toBe('boss_dom');
    expect(r.salaryMinK.confidence).toBe('medium');
    expect(r.salaryMinK.qualityIssues.join('')).toContain('PUA');
    expect(r.status).toBe('needs_correction');
  });

  it('左卡 company 不可读时，在身份一致的右侧详情中读取受控公司展示名', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({ href: 'AAAA1111', company: '右侧科技' }),
      expected({ companyDisplayName: null }),
    );
    expect(r.identityMatch).toBe(true);
    expect(r.company.value).toBe('右侧科技');
    expect(r.company.source).toBe('boss_dom');
  });

  it('猎头岗位从 boss-info-attr 提取所属机构，剥离角色后以 medium + needs_correction 进入预览', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({
        href: 'AAAA1111',
        company: null,
        recruiterName: '李意娜',
        recruiterAffiliation: '高策华途 · 猎头顾问',
      }),
      expected({ companyDisplayName: null }),
    );
    expect(r.company.value).toBe('高策华途');
    expect(r.company.value).not.toContain('李意娜');
    expect(r.company.source).toBe('boss_dom');
    expect(r.company.confidence).toBe('medium');
    expect(r.company.qualityIssues.join('')).toContain('招聘者所属机构');
    expect(r.status).toBe('needs_correction');
  });

  it('截断的招聘机构展示名保留到预览，但明确要求人工补全', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({
        href: 'AAAA1111',
        company: null,
        recruiterAffiliation: '合肥市蜀山区元卓... · hr',
      }),
      expected({ companyDisplayName: '合肥市蜀山区元卓...' }),
    );
    expect(r.company.value).toBe('合肥市蜀山区元卓...');
    expect(r.company.confidence).toBe('medium');
    expect(r.company.qualityIssues.join('')).toContain('截断');
    expect(r.status).toBe('needs_correction');
  });

  it('无右侧机构结构时仍可保留左卡截断展示名，不伪装成高置信完整公司', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({ href: 'AAAA1111', company: null }),
      expected({ companyDisplayName: 'TTR上海臻猎...' }),
    );
    expect(r.company.value).toBe('TTR上海臻猎...');
    expect(r.company.source).toBe('selected_card');
    expect(r.company.confidence).toBe('medium');
    expect(r.status).toBe('needs_correction');
  });

  it('不把未知角色或招聘者姓名当作公司', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({
        href: 'AAAA1111',
        company: null,
        recruiterName: '周硕',
        recruiterAffiliation: '高策华途 · 技术经理',
      }),
      expected({ companyDisplayName: null }),
    );
    expect(r.company.value).toBeNull();
    expect(r.status).toBe('needs_correction');
  });

  it('§八.13 无 href + role 一致但两侧可读薪资冲突 → identityMatch=false、failed、blocked', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({ href: null, salary: '20-30K' }),
      expected({ salaryFromCardNorm: '11-13K' }),
    );
    expect(r.identityBasis).toBe('role_salary_crosscheck');
    expect(r.identityMatch).toBe(false);
    expect(r.status).toBe('failed');
    expect(r.blockingIssues.length).toBeGreaterThan(0);
    expect(r.salaryCrossCheck).toBe('mismatched');
  });

  it('href 身份成立但两侧可读薪资冲突 → needs_correction（不阻塞，待人工确认）', () => {
    const r = captureKnownJobFromRightPanel(
      panelDoc({ href: 'AAAA1111', salary: '20-30K' }),
      expected({ salaryFromCardNorm: '11-13K' }),
    );
    expect(r.identityMatch).toBe(true);
    expect(r.status).toBe('needs_correction');
    expect(r.salaryCrossCheck).toBe('mismatched');
    expect(r.blockingIssues).toHaveLength(0);
    expect(r.salaryMinK.qualityIssues.join('')).toContain('不一致');
  });

  it('右侧 href 与所选岗位不一致 → identityMatch=false、failed、不取其它岗位', () => {
    const r = captureKnownJobFromRightPanel(panelDoc({ href: 'BBBB2222' }), expected({ externalRecordId: 'AAAA1111' }));
    expect(r.identityMatch).toBe(false);
    expect(r.status).toBe('failed');
    expect(r.blockingIssues.join('')).toContain('不一致');
  });

  it('未定位到右侧详情 → failed + 阻塞，jdText 为空（不回退整页）', () => {
    const doc = parse('<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body><div class="job-list-container"><ul><li class="job-card">Java开发工程师</li></ul></div></body></html>');
    const r = captureKnownJobFromRightPanel(doc, expected());
    expect(r.status).toBe('failed');
    expect(r.identityMatch).toBe(false);
    expect(r.jdText).toBeNull();
    expect(r.blockingIssues.length).toBeGreaterThan(0);
  });
});
