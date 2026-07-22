import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { extractBoss } from './bossExtractor';
import { extractGenericPage } from './genericExtractor';
import { parseBossTitle } from './bossTitle';
import { parseCityAddress } from './cityAddress';
import { selectAndExtract } from './selectExtractor';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseHtml(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

function loadFixture(name: string): Document {
  return parseHtml(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
}

const JOB_DETAIL_URL = 'https://www.zhipin.com/job_detail/abc123.html';
const LIST_URL = 'https://www.zhipin.com/web/geek/job?query=web前端&city=101190400';

describe('parseCityAddress (§七.5 城市/区县/地址拆分)', () => {
  it('normalizes 苏州吴中区苏州国际科技园 into city/district/address', () => {
    const parts = parseCityAddress('苏州吴中区苏州国际科技园');
    expect(parts.city).toBe('苏州');
    expect(parts.district).toBe('吴中区');
    expect(parts.address).toBe('苏州吴中区苏州国际科技园');
  });

  it('handles separators and keeps the full address', () => {
    const parts = parseCityAddress('苏州·吴中区·苏州国际科技园');
    expect(parts.city).toBe('苏州');
    expect(parts.district).toBe('吴中区');
    expect(parts.address).toBe('苏州·吴中区·苏州国际科技园');
  });

  it('returns nulls for empty input, never guessing', () => {
    expect(parseCityAddress('')).toEqual({ city: null, district: null, address: null });
    expect(parseCityAddress(null)).toEqual({ city: null, district: null, address: null });
  });
});

describe('parseBossTitle (§七.4 页面 title fallback 分组)', () => {
  it('splits role and company from a real-shaped title without swapping', () => {
    const parts = parseBossTitle('web前端（苏州、银行项目）_赞同科技招聘-BOSS直聘');
    expect(parts.role).toBe('web前端（苏州、银行项目）');
    expect(parts.company).toBe('赞同科技');
  });

  it('strips a leading city from the company token', () => {
    const parts = parseBossTitle('web前端_苏州赞同科技招聘-BOSS直聘');
    expect(parts.role).toBe('web前端');
    expect(parts.company).toBe('赞同科技');
  });

  it('returns nulls when nothing parseable', () => {
    expect(parseBossTitle('BOSS直聘')).toEqual({ role: null, company: null });
  });
});

describe('extractBoss — job_detail layout (§七.2 独立详情页 fixture)', () => {
  const boss = extractBoss(JOB_DETAIL_URL, loadFixture('boss-job-detail.html'));

  it('detects the job_detail layout', () => {
    expect(boss.layout).toBe('job_detail');
  });

  it('maps role from the title area and company from the company card, WITHOUT swapping (§七.3)', () => {
    expect(boss.role.value).toBe('web前端（苏州、银行项目）');
    expect(boss.company.value).toBe('赞同科技');
    expect(boss.role.value).not.toBe(boss.company.value);
    // 公司绝不等于岗位名。
    expect(boss.company.value).not.toBe('web前端（苏州、银行项目）');
  });

  it('splits city / district / address; city holds ONLY the city (§七.5)', () => {
    expect(boss.city.value).toBe('苏州');
    expect(boss.district.value).toBe('吴中区');
    expect(boss.address.value).toBe('苏州吴中区苏州国际科技园');
    // 城市不得写进整段地址。
    expect(boss.city.value).not.toContain('吴中区');
    expect(boss.city.value).not.toContain('科技园');
  });

  it('parses salary 11-16K (§七.6)', () => {
    expect(boss.salaryMinK.value).toBe(11);
    expect(boss.salaryMaxK.value).toBe(16);
  });

  it('extracts experience/education from tags', () => {
    expect(boss.experienceRequirement.value).toBe('3-5年');
    expect(boss.educationRequirement.value).toBe('本科');
  });

  it('extracts JD from the description card only, excluding nav/recommend/chat/footer (§七.7)', () => {
    expect(boss.jdText).toContain('岗位职责');
    expect(boss.jdText).toContain('任职要求');
    for (const noise of ['首页', '校园招聘', '海归', 'APP下载', '推荐岗位', '立即沟通', '隐私政策']) {
      expect(boss.jdText ?? '').not.toContain(noise);
    }
  });

  it('attaches provenance/confidence/qualityIssues to every core field (§六)', () => {
    for (const field of [boss.role, boss.company, boss.city, boss.salaryMinK]) {
      expect(field.source).toBeDefined();
      expect(['high', 'medium', 'low']).toContain(field.confidence);
      expect(Array.isArray(field.qualityIssues)).toBe(true);
    }
    expect(boss.company.source).toBe('boss_dom');
    // 由地址解析得到的城市应带质量提示，不能被当作高置信确定事实。
    expect(boss.city.qualityIssues.length).toBeGreaterThan(0);
  });
});

describe('extractBoss — list+panel layout (§七.1 组合页 fixture)', () => {
  const boss = extractBoss(LIST_URL, loadFixture('boss-list-panel.html'));

  it('detects the list_panel layout and reads the RIGHT panel, not the left list', () => {
    expect(boss.layout).toBe('list_panel');
    expect(boss.role.value).toBe('web前端（苏州、银行项目）');
    expect(boss.company.value).toBe('赞同科技');
    // 不能抓成左侧列表里的其它岗位/公司。
    expect(boss.role.value).not.toBe('Java开发工程师');
    expect(boss.company.value).not.toBe('甲公司');
  });

  it('splits city and salary correctly on the panel layout (§七.11 两种布局回归)', () => {
    expect(boss.city.value).toBe('苏州');
    expect(boss.district.value).toBe('吴中区');
    expect(boss.salaryMinK.value).toBe(11);
    expect(boss.salaryMaxK.value).toBe(16);
  });
});

describe('extractBoss — company full-name from 工商信息 / 公司介绍 (§六 定点修复)', () => {
  const FULL_NAME = '苏州工业园区航星信息技术服务有限公司';
  const boss = extractBoss(JOB_DETAIL_URL, loadFixture('boss-job-detail-full-company.html'));

  it('1. 工商信息「公司名称」标签对应值 → 完整公司名', () => {
    expect(boss.company.value).toBe(FULL_NAME);
    expect(boss.company.source).toBe('boss_business_info');
    expect(boss.company.confidence).toBe('high');
  });

  it('2. 公司介绍正文开头可提取完整公司名（工商信息缺失时）(§六.8)', () => {
    const doc = parseHtml(
      `<html><head><title>资深前端开发工程师_苏州工业园区航星...招聘-BOSS直聘</title></head><body>`
      + `<div class="job-banner"><div class="name"><h1>资深前端开发工程师</h1></div>`
      + `<div class="company-info"><a class="name">苏州工业园区航星...</a></div></div>`
      + `<div class="job-detail-company"><div class="job-sec company-info"><div class="job-sec-text">`
      + `${FULL_NAME}是一家专注于金融科技的服务商。</div></div></div>`
      + `</body></html>`,
    );
    const b = extractBoss(JOB_DETAIL_URL, doc);
    expect(b.company.value).toBe(FULL_NAME);
    expect(b.company.source).toBe('boss_company_intro');
  });

  it('3. 工商信息优先于顶部截断卡片值', () => {
    expect(boss.company.value).toBe(FULL_NAME);
    expect(boss.company.value).not.toContain('...');
    expect(boss.company.source).not.toBe('boss_dom');
    expect(boss.company.source).not.toBe('page_title');
  });

  it('4. 公司介绍优先于 page_title（title 公司被截断时不采信）', () => {
    const doc = parseHtml(
      `<html><head><title>资深前端开发工程师_苏州工业园区航星...招聘-BOSS直聘</title></head><body>`
      + `<div class="job-banner"><div class="name"><h1>资深前端开发工程师</h1></div></div>`
      + `<div class="job-detail-company"><div class="job-sec company-info"><div class="job-sec-text">`
      + `${FULL_NAME}成立于2015年。</div></div></div>`
      + `</body></html>`,
    );
    const b = extractBoss(JOB_DETAIL_URL, doc);
    expect(b.company.value).toBe(FULL_NAME);
    expect(b.company.source).toBe('boss_company_intro');
  });

  it('5. 「工业园区航星...」截断值被判定为截断并拒绝，不作为公司字段', () => {
    // 仅有被截断的顶部卡片与 title、没有完整来源时，company 必须为 null。
    const doc = parseHtml(
      `<html><head><title>资深前端开发工程师_苏州工业园区航星...招聘-BOSS直聘</title></head><body>`
      + `<div class="job-banner"><div class="name"><h1>资深前端开发工程师</h1></div>`
      + `<div class="company-info"><a class="name">苏州工业园区航星...</a></div></div>`
      + `</body></html>`,
    );
    const b = extractBoss(JOB_DETAIL_URL, doc);
    expect(b.company.value).toBeNull();
    expect(b.company.value).not.toBe('工业园区航星...');
  });

  it('6. 公司名中的「苏州工业园区」被完整保留，不被当作 district 从公司名剥离', () => {
    expect(boss.company.value).toContain('苏州工业园区');
    // district 独立字段仍从地址派生，不影响公司全称。
    expect(boss.district.value).not.toBe(FULL_NAME);
    expect(boss.company.value).toBe(FULL_NAME);
  });

  it('7. 公司名不与工作地址混淆（address 独立、不等于公司名）', () => {
    expect(boss.address.value).toContain('新建元数智湾');
    expect(boss.company.value).not.toBe(boss.address.value);
    expect(boss.company.value).not.toContain('数智湾');
  });

  it('9. 所有完整来源都不存在时返回 unknown，而不是截断标题', () => {
    const doc = parseHtml(
      `<html><head><title>资深前端开发工程师_苏州工业园区航星...招聘-BOSS直聘</title></head><body>`
      + `<div class="job-banner"><div class="name"><h1>资深前端开发工程师</h1></div></div>`
      + `</body></html>`,
    );
    const b = extractBoss(JOB_DETAIL_URL, doc);
    expect(b.role.value).toBe('资深前端开发工程师');
    expect(b.company.value).toBeNull();
    expect(b.company.source).toBe('none');
  });

  it('还原真实缺陷岗位其余字段（role/city/salary）仍正确', () => {
    expect(boss.role.value).toBe('资深前端开发工程师');
    expect(boss.city.value).toBe('苏州');
    expect(boss.salaryMinK.value).toBe(12);
    expect(boss.salaryMaxK.value).toBe(24);
    expect(boss.salaryPeriod.value).toBe('14薪');
  });
});

describe('extractBoss — selector failures never cross-fill (§七.8 / §七.9)', () => {
  it('company = null (not the job title) when the company node is missing and title has no company', () => {
    const doc = parseHtml('<html><head><title>就是一个岗位名</title></head><body><div class="job-banner"><div class="name"><h1>后端工程师</h1></div></div></body></html>');
    const boss = extractBoss(JOB_DETAIL_URL, doc);
    expect(boss.role.value).toBe('后端工程师');
    expect(boss.company.value).toBeNull();
    expect(boss.company.value).not.toBe('后端工程师');
  });

  it('role = null (not the company) when the role node is missing and title has no role split', () => {
    const doc = parseHtml('<html><head><title></title></head><body><div class="job-banner"><div class="company-info"><a class="name">赞同科技</a></div></div></body></html>');
    const boss = extractBoss(JOB_DETAIL_URL, doc);
    expect(boss.role.value).toBeNull();
    expect(boss.company.value).toBe('赞同科技');
    expect(boss.role.value).not.toBe('赞同科技');
  });
});

describe('extractBoss — list_panel real defect fixture (§九 定点修复)', () => {
  const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs?query=前端&city=101190400';
  const STABLE_ID = '2acf60d4c01b82490nF93N68FFtV';
  const boss = extractBoss(JOBS_URL, loadFixture('boss-list-panel-real.html'));

  it('1. /web/geek/jobs 识别为 list_panel', () => {
    expect(boss.layout).toBe('list_panel');
  });

  it('3./4. 从唯一右侧详情容器取字段，不把左侧列表卡片当详情正文', () => {
    expect(boss.role.value).toBe('资深前端开发工程师');
    // 左侧列表的其它岗位/公司不得串入。
    expect(boss.role.value).not.toBe('Java开发工程师');
    expect(boss.company.value).not.toBe('甲公司');
  });

  it('5./14. role = 资深前端开发工程师（隐藏 kanzhun 反爬节点被清除）', () => {
    expect(boss.role.value).toBe('资深前端开发工程师');
    expect(boss.role.value ?? '').not.toContain('kanzhun');
  });

  it('6. salary = 12-24K·14薪', () => {
    expect(boss.salaryMinK.value).toBe(12);
    expect(boss.salaryMaxK.value).toBe(24);
    expect(boss.salaryPeriod.value).toBe('14薪');
  });

  it('7. city = 苏州（只取城市，不用完整地址）', () => {
    expect(boss.city.value).toBe('苏州');
  });

  it('8./9. 从 selected 卡片提取稳定 job ID，canonicalSourceUrl 去除 securityId/query', () => {
    expect(boss.externalRecordId).toBe(STABLE_ID);
    expect(boss.providerKey).toBe('boss_zhipin');
    expect(boss.canonicalSourceUrl).toBe(`https://www.zhipin.com/job_detail/${STABLE_ID}.html`);
    expect(boss.canonicalSourceUrl ?? '').not.toContain('securityId');
    expect(boss.canonicalSourceUrl ?? '').not.toContain('?');
  });

  it('11. company 为完整可靠值，且不使用截断值', () => {
    expect(boss.company.value).toBe('苏州工业园区航星信息技术服务有限公司');
    expect(boss.company.value ?? '').not.toContain('...');
    expect(boss.company.value ?? '').not.toContain('…');
  });

  it('12./15. JD 不含 CSS 规则、导航、推荐岗位、聊天、页脚，且插入正文的 BOSS直聘 被清除', () => {
    const jd = boss.jdText ?? '';
    expect(jd).toContain('岗位职责');
    expect(jd).toContain('任职要求');
    expect(jd).toContain('数据可视化开发');
    expect(jd).not.toContain('BOSS直聘');
    expect(jd).not.toContain('font-size');
    expect(jd).not.toContain('FrYhQzfSwwjF');
    for (const noise of ['首页', '校园招聘', '推荐岗位', '立即沟通', '用户协议']) {
      expect(jd).not.toContain(noise);
    }
  });

  it('岗位/公司不串位，district/address 不污染 city 或 company', () => {
    expect(boss.role.value).not.toBe(boss.company.value);
    expect(boss.city.value).not.toContain('公司');
    // company 保留完整企业全称（含「苏州工业园区」合法组成部分，不被当地址剥离）。
    expect(boss.company.value).toContain('苏州工业园区');
  });
});

describe('extractBoss — list_panel V8 岗位绑定缺陷定点修复 (§八)', () => {
  const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs?query=前端&city=101190400';
  const SELECTED_ID = '2acf60d4c01b82490nF93N68FFtV';
  const SENIOR_ID = '9999seniorFFFF888';
  const boss = extractBoss(JOBS_URL, loadFixture('boss-list-panel-v8-defect.html'));
  const diag = boss.listPanelDiagnostics!;

  it('1. role 精确为「中级前端开发工程师」（右侧详情头部锚点，非左侧其它卡片）', () => {
    expect(boss.layout).toBe('list_panel');
    expect(boss.role.value).toBe('中级前端开发工程师');
    expect(boss.role.value).not.toBe('资深前端开发工程师');
    expect(boss.role.value).not.toBe('Java开发工程师');
  });

  it('2. role 不含私有区/占位/异常字符与尾部薪资残片（§六 规范化）', () => {
    const role = boss.role.value ?? '';
    expect(role).not.toContain('□');
    expect(role).not.toMatch(/[-]/); // BMP 私用区
    expect(role).not.toContain('�');
    expect(role).not.toMatch(/[·・]?\s*K?\s*薪\s*$/);
    expect(role.endsWith('-')).toBe(false);
  });

  it('3. salary = 11-13K', () => {
    expect(boss.salaryMinK.value).toBe(11);
    expect(boss.salaryMaxK.value).toBe(13);
  });

  it('4. 「3-5年」不得被解析成薪资 (§二 薪资必须带单位)', () => {
    expect(boss.salaryMinK.value).not.toBe(3);
    expect(boss.salaryMaxK.value).not.toBe(5);
  });

  it('5. experienceRequirement = 3-5年', () => {
    expect(boss.experienceRequirement.value).toBe('3-5年');
    expect(boss.educationRequirement.value).toBe('本科');
  });

  it('6. company = 易诚互动（来自已绑定 selected 卡片）', () => {
    expect(boss.company.value).toBe('易诚互动');
  });

  it('7. externalRecordId 来自同一 selected 卡片', () => {
    expect(boss.externalRecordId).toBe(SELECTED_ID);
    expect(boss.providerKey).toBe('boss_zhipin');
    expect(boss.canonicalSourceUrl).toBe(`https://www.zhipin.com/job_detail/${SELECTED_ID}.html`);
    expect(boss.canonicalSourceUrl ?? '').not.toContain('securityId');
    expect(boss.canonicalSourceUrl ?? '').not.toContain('?');
  });

  it('8. 不得取其它「资深前端开发工程师」卡片的 href', () => {
    expect(boss.externalRecordId).not.toBe(SENIOR_ID);
    expect(boss.canonicalSourceUrl ?? '').not.toContain(SENIOR_ID);
  });

  it('§七 身份诊断：identityMatch=true，逐项对照写入 metadata', () => {
    expect(diag.identityMatch).toBe(true);
    expect(diag.identitySource).toBe('selected_card');
    expect(diag.rightPanelRole).toBe('中级前端开发工程师');
    expect(diag.rightPanelSalary).toBe('11-13K');
    expect(diag.selectedCardRole).toBe('中级前端开发工程师');
    expect(diag.selectedCardSalary).toBe('11-13K');
    expect(diag.externalRecordId).toBe(SELECTED_ID);
    expect(boss.blockingIssues).toHaveLength(0);
  });

  it('12. JD 清洗：含岗位职责/任职要求，不含插入式 BOSS直聘 与噪声', () => {
    const jd = boss.jdText ?? '';
    expect(jd).toContain('岗位职责');
    expect(jd).toContain('任职要求');
    expect(jd).toContain('数据可视化开发');
    expect(jd).not.toContain('BOSS直聘');
    for (const noise of ['推荐岗位', '立即沟通', '用户协议', '首页']) {
      expect(jd).not.toContain(noise);
    }
  });
});

describe('extractBoss — list_panel JD-first 定位（PUA 薪资 / 无 .job-name 头部）(§十)', () => {
  const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs?query=前端&city=101190400';
  const SELECTED_ID = '2acf60d4c01b82490nF93N68FFtV';
  const SENIOR_ID = '9999seniorFFFF888';
  const boss = extractBoss(JOBS_URL, loadFixture('boss-list-panel-jdfirst-defect.html'));
  const diag = boss.listPanelDiagnostics!;

  it('1. 右侧薪资不可读时仍能通过 JD-first 定位右侧面板（不依赖 .job-name/固定标题选择器）', () => {
    expect(boss.layout).toBe('list_panel');
    expect(boss.blockingIssues).toHaveLength(0);
    expect(diag.identityMatch).toBe(true);
  });

  it('2. role = 中级前端开发工程师，无 PUA/占位/乱码残片', () => {
    expect(boss.role.value).toBe('中级前端开发工程师');
    expect(boss.role.value).not.toBe('资深前端开发工程师');
    expect(boss.role.value).not.toBe('Java开发工程师');
    const role = boss.role.value ?? '';
    expect(role).not.toContain('□');
    expect(role).not.toContain('�');
    expect(role).not.toMatch(/[-]/);
    expect(role.endsWith('-')).toBe(false);
  });

  it('3. salary = 11-13K（右侧不可读，回退到已绑定 selected 卡片可读薪资）', () => {
    expect(boss.salaryMinK.value).toBe(11);
    expect(boss.salaryMaxK.value).toBe(13);
    // 绝不再显示 3-5（经验区间或干扰卡片薪资）。
    expect(boss.salaryMinK.value).not.toBe(3);
    expect(boss.salaryMaxK.value).not.toBe(5);
  });

  it('4./9. 「3-5年」不被解析为薪资；experience=3-5年、education=本科', () => {
    expect(boss.experienceRequirement.value).toBe('3-5年');
    expect(boss.educationRequirement.value).toBe('本科');
  });

  it('5. company = 易诚互动（来自已绑定 selected 卡片）', () => {
    expect(boss.company.value).toBe('易诚互动');
    expect(boss.company.value).not.toBe('甲公司');
    expect(boss.company.value).not.toBe('丙公司');
  });

  it('6./7. externalRecordId 来自 selected 卡片，canonical url 无 query；不取其它卡片 href', () => {
    expect(boss.externalRecordId).toBe(SELECTED_ID);
    expect(boss.providerKey).toBe('boss_zhipin');
    expect(boss.canonicalSourceUrl).toBe(`https://www.zhipin.com/job_detail/${SELECTED_ID}.html`);
    expect(boss.canonicalSourceUrl ?? '').not.toContain('securityId');
    expect(boss.canonicalSourceUrl ?? '').not.toContain('?');
    expect(boss.externalRecordId).not.toBe(SENIOR_ID);
    expect(boss.externalRecordId).not.toBe('aaaa1111bbbb2222');
  });

  it('§六 身份诊断：salaryCrossCheck=unavailable 时仍可建立身份，逐项对照写入 metadata', () => {
    expect(diag.selectedStateDetected).toBe(true);
    expect(diag.roleMatch).toBe(true);
    expect(diag.salaryCrossCheck).toBe('unavailable');
    expect(diag.identitySource).toBe('selected_card');
    expect(diag.rightPanelRole).toBe('中级前端开发工程师');
    expect(diag.rightPanelSalary).toBeNull();
    expect(diag.selectedCardRole).toBe('中级前端开发工程师');
    expect(diag.selectedCardSalary).toBe('11-13K');
    expect(diag.externalRecordId).toBe(SELECTED_ID);
    expect(diag.locate).toBeNull();
  });

  it('10./12. JD 只含右侧正文，清洗插入式 BOSS直聘 与噪声', () => {
    const jd = boss.jdText ?? '';
    expect(jd).toContain('岗位职责');
    expect(jd).toContain('任职要求');
    expect(jd).toContain('数据可视化开发');
    expect(jd).not.toContain('BOSS直聘');
    for (const noise of ['Java开发工程师', '甲公司', '推荐岗位', '立即沟通', '首页', '用户协议', '招聘专员']) {
      expect(jd).not.toContain(noise);
    }
  });
});

describe('selectAndExtract — list_panel JD-first visibleText 只含右侧 JD (§十.10/11)', () => {
  const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs?query=前端';

  it('10. 定位成功时 visibleText 只含右侧 JD，不含左侧列表/导航/推荐/页脚', () => {
    const result = selectAndExtract(JOBS_URL, loadFixture('boss-list-panel-jdfirst-defect.html'));
    expect(result.captureMethod).toBe('boss_current_page');
    expect(result.commitBlocked).toBe(false);
    expect(result.page.visibleText).toContain('岗位职责');
    expect(result.page.visibleText).toContain('数据可视化开发');
    for (const noise of ['Java开发工程师', '甲公司', '资深前端开发工程师', '推荐岗位', '首页', '在线沟通']) {
      expect(result.page.visibleText).not.toContain(noise);
    }
  });

  it('11. 定位失败时不回退整页岗位列表文本（visibleText 为明确诊断摘要，commitBlocked=true）', () => {
    const doc = parseHtml(
      '<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body>'
      + '<div class="job-list-container"><ul>'
      + '<li class="job-card"><a href="/job_detail/x1.html"><span class="job-name">Java开发工程师</span><span class="salary">10-20K</span></a></li>'
      + '<li class="job-card"><a href="/job_detail/x2.html"><span class="job-name">测试工程师</span><span class="salary">9-15K</span></a></li>'
      + '</ul></div>'
      + '</body></html>',
    );
    const result = selectAndExtract(JOBS_URL, doc);
    expect(result.commitBlocked).toBe(true);
    expect(result.page.visibleText.length).toBeGreaterThan(0);
    expect(result.page.visibleText).toContain('未采集到岗位 JD 正文');
    // 绝不把整页岗位列表文本当作 JD 正文。
    expect(result.page.visibleText).not.toContain('Java开发工程师');
    expect(result.page.visibleText).not.toContain('测试工程师');
    const meta = result.metadata as Record<string, unknown>;
    const locate = (meta.listPanelDiagnostics as { locate?: { salaryRequiredForAnchor?: boolean; layoutType?: string } }).locate;
    expect(locate?.salaryRequiredForAnchor).toBe(false);
    expect(locate?.layoutType).toBe('list_panel');
  });
});

describe('extractBoss — list_panel recommend-result-job 共享外层根因修复 (§五/§六)', () => {
  const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs?query=前端&city=101190400';
  const SELECTED_ID = '2acf60d4c01b82490nF93N68FFtV';
  const boss = extractBoss(JOBS_URL, loadFixture('boss-list-panel-recommend-wrapper.html'));
  const diag = boss.listPanelDiagnostics!;

  it('1. 右侧 JD 与左侧列表共享 recommend-result-job 外层时，右侧 JD 不再被 [class*="recommend"] 误排除', () => {
    expect(boss.layout).toBe('list_panel');
    expect(boss.blockingIssues).toHaveLength(0);
    // 定位成功 → locate 诊断为 null（不再是 jdContainerCandidateCount=0 的失败）。
    expect(diag.locate).toBeNull();
    expect(diag.identityMatch).toBe(true);
  });

  it('3./4./5. right panel 成功定位，role 提取，selected 卡片绑定，company/身份正确', () => {
    expect(boss.role.value).toBe('中级前端开发工程师');
    expect(boss.company.value).toBe('易诚互动');
    expect(boss.city.value).toBe('苏州');
    expect(boss.experienceRequirement.value).toBe('3-5年');
    expect(boss.educationRequirement.value).toBe('本科');
    expect(boss.externalRecordId).toBe(SELECTED_ID);
    expect(boss.canonicalSourceUrl).toBe(`https://www.zhipin.com/job_detail/${SELECTED_ID}.html`);
    expect(diag.identitySource).toBe('selected_card');
  });

  it('6. PUA 薪资：右侧不可读回退 selected 卡片 11-13K，「3-5年」不当薪资', () => {
    expect(boss.salaryMinK.value).toBe(11);
    expect(boss.salaryMaxK.value).toBe(13);
  });

  it('7. 左侧岗位卡片正文仍被排除：JD 只来自右侧详情，清洗 style/BOSS直聘/噪声', () => {
    const jd = boss.jdText ?? '';
    expect(jd).toContain('岗位职责');
    expect(jd).toContain('任职要求');
    expect(jd).toContain('数据可视化开发');
    expect(jd).not.toContain('BOSS直聘');
    expect(jd).not.toContain('font-size');
    expect(jd).not.toContain('REYGmaxGpJA');
    for (const noise of ['Java开发工程师', '甲公司', '资深前端开发工程师']) {
      expect(jd).not.toContain(noise);
    }
  });
});

describe('extractBoss — list_panel 定位失败结构探针 (§四 真实证据收集)', () => {
  const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs?query=前端';

  it('JD 关键词只出现在左侧岗位卡片内、无右侧详情面板时，仍应定位失败，探针如实标记该节点在左侧列表内', () => {
    // 该 JD 节点确实位于左侧 job card / 列表容器内（无 .job-detail-box 祖先）→ 必须保持被排除。
    const doc = parseHtml(
      '<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body>'
      + '<div class="job-list-container"><ul>'
      + '<li class="job-card-wrapper"><a href="/job_detail/x1.html"><span class="job-name">Java开发工程师</span>'
      + '<div class="fake-jd">岗位职责：写代码。任职要求：本科。</div></a></li>'
      + '<li class="job-card-wrapper"><a href="/job_detail/x2.html"><span class="job-name">测试工程师</span></a></li>'
      + '</ul></div>'
      + '</body></html>',
    );
    const b = extractBoss(JOBS_URL, doc);
    expect(b.layout).toBe('list_panel');
    expect(b.blockingIssues.length).toBeGreaterThan(0);
    const locate = b.listPanelDiagnostics!.locate!;
    expect(locate.salaryRequiredForAnchor).toBe(false);
    expect(locate.keywordElementCount).toBeGreaterThan(0);
    expect(locate.probe.length).toBeGreaterThan(0);
    const jdProbe = locate.probe.find((p) => p.textPrefix.includes('岗位职责'));
    expect(jdProbe).toBeDefined();
    expect(jdProbe!.inIframe).toBe(false);
    expect(jdProbe!.inShadowRoot).toBe(false);
    // 该节点确实在左侧列表内（无详情面板祖先）→ excluded=true，祖先链含左侧卡片。
    expect(jdProbe!.excluded).toBe(true);
    expect(jdProbe!.ancestors.some((a) => a.containsLeftCards)).toBe(true);
  });
});

describe('extractBoss — list_panel 绑定阻塞与串位防护 (§四/§七)', () => {
  const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs?query=前端';

  function panel(rolePanel: string, salaryPanel: string): string {
    return (
      '<div class="job-detail-box">'
      + `<div class="job-name">${rolePanel}</div>`
      + `<span class="salary">${salaryPanel}</span>`
      + '<span class="text-city">苏州</span>'
      + '<div class="job-sec-text">岗位职责：负责开发。任职要求：本科。</div>'
      + '</div>'
    );
  }

  it('9. selected 卡片 role 与右侧不一致 → commitBlocked、externalRecordId=null', () => {
    const doc = parseHtml(
      '<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body>'
      + '<div class="job-list-container"><ul>'
      + '<li class="job-card selected"><a href="/job_detail/selectedAAAA1111.html?securityId=x"><span class="job-name">资深前端开发工程师</span><span class="salary">11-13K</span></a></li>'
      + '</ul></div>'
      + panel('中级前端开发工程师', '11-13K')
      + '</body></html>',
    );
    const b = extractBoss(JOBS_URL, doc);
    expect(b.externalRecordId).toBeNull();
    expect(b.blockingIssues.length).toBeGreaterThan(0);
    expect(b.listPanelDiagnostics?.identityMatch).toBe(false);
  });

  it('10. selected 卡片 salary 与右侧不一致（两侧均可读）→ commitBlocked', () => {
    const doc = parseHtml(
      '<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body>'
      + '<div class="job-list-container"><ul>'
      + '<li class="job-card selected"><a href="/job_detail/selectedBBBB2222.html"><span class="job-name">中级前端开发工程师</span><span class="salary">20-30K</span></a></li>'
      + '</ul></div>'
      + panel('中级前端开发工程师', '11-13K')
      + '</body></html>',
    );
    const b = extractBoss(JOBS_URL, doc);
    expect(b.externalRecordId).toBeNull();
    expect(b.blockingIssues.length).toBeGreaterThan(0);
    // §十.7 两侧薪资都可读且不相等 → salaryCrossCheck=mismatched。
    expect(b.listPanelDiagnostics?.salaryCrossCheck).toBe('mismatched');
    expect(b.listPanelDiagnostics?.roleMatch).toBe(true);
  });

  it('11. 多张卡片与右侧精确匹配（无 selected 状态）→ commitBlocked', () => {
    const doc = parseHtml(
      '<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body>'
      + '<div class="job-list-container"><ul>'
      + '<li class="job-card"><a href="/job_detail/dupA1111.html"><span class="job-name">中级前端开发工程师</span><span class="salary">11-13K</span></a></li>'
      + '<li class="job-card"><a href="/job_detail/dupB2222.html"><span class="job-name">中级前端开发工程师</span><span class="salary">11-13K</span></a></li>'
      + '</ul></div>'
      + panel('中级前端开发工程师', '11-13K')
      + '</body></html>',
    );
    const b = extractBoss(JOBS_URL, doc);
    expect(b.externalRecordId).toBeNull();
    expect(b.blockingIssues.length).toBeGreaterThan(0);
  });

  it('右侧薪资被反爬字体隐藏(不可读)时，按 role 唯一绑定并回退取卡片薪资', () => {
    // 右侧标题可读、薪资节点为 PUA 占位（不可读）；selected 卡片薪资 11-13K 可读。
    const doc = parseHtml(
      '<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body>'
      + '<div class="job-list-container"><ul>'
      + '<li class="job-card selected"><a href="/job_detail/obfCCCC3333.html"><span class="job-name">中级前端开发工程师</span><span class="salary">11-13K</span></a></li>'
      + '</ul></div>'
      + '<div class="job-detail-box"><div class="job-name">中级前端开发工程师</div>'
      + '<span class="salary">-K</span>'
      + '<span class="text-city">苏州</span>'
      + '<div class="job-sec-text">岗位职责：负责开发。任职要求：本科。</div></div>'
      + '</body></html>',
    );
    const b = extractBoss(JOBS_URL, doc);
    expect(b.role.value).toBe('中级前端开发工程师');
    expect(b.externalRecordId).toBe('obfCCCC3333');
    expect(b.salaryMinK.value).toBe(11);
    expect(b.salaryMaxK.value).toBe(13);
    expect(b.blockingIssues).toHaveLength(0);
  });
});

describe('extractBoss — list_panel 无稳定 ID 时阻塞写入 (§九.10)', () => {
  it('10. 未取到 job_detail 稳定 ID → blockingIssues 非空（禁止以 /web/geek/jobs 建立来源）', () => {
    const doc = parseHtml(
      '<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body>'
      + '<div class="job-detail-box"><div class="job-name">资深前端开发工程师</div>'
      + '<span class="salary">12-24K</span>'
      + '<div class="job-sec-text">岗位职责：负责开发。任职要求：本科。</div></div>'
      + '</body></html>',
    );
    const boss = extractBoss('https://www.zhipin.com/web/geek/jobs?query=前端', doc);
    expect(boss.layout).toBe('list_panel');
    expect(boss.externalRecordId).toBeNull();
    expect(boss.blockingIssues.length).toBeGreaterThan(0);
  });
});

describe('selectAndExtract — list_panel wire mapping (§九)', () => {
  const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs?query=前端';

  it('list_panel 不因 URL 非 /job_detail 退回 generic；发送稳定身份与 canonical sourceUrl', () => {
    const result = selectAndExtract(JOBS_URL, loadFixture('boss-list-panel-real.html'));
    expect(result.captureMethod).toBe('boss_current_page');
    expect(result.externalRecordId).toBe('2acf60d4c01b82490nF93N68FFtV');
    expect(result.providerKey).toBe('boss_zhipin');
    expect(result.canonicalSourceUrl).toBe('https://www.zhipin.com/job_detail/2acf60d4c01b82490nF93N68FFtV.html');
    expect(result.commitBlocked).toBe(false);
    // visibleText 取清洗后的 JD，不含 CSS 规则与列表噪声。
    expect(result.page.visibleText).toContain('岗位职责');
    expect(result.page.visibleText).not.toContain('font-size');
    expect(result.page.visibleText).not.toContain('推荐岗位');
  });

  it('metadata 携带 identity/commitBlocked/blockingIssues 供前端 gating 使用', () => {
    const result = selectAndExtract(JOBS_URL, loadFixture('boss-list-panel-real.html'));
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.layout).toBe('list_panel');
    expect(meta.commitBlocked).toBe(false);
    const identity = meta.identity as Record<string, unknown>;
    expect(identity.externalRecordId).toBe('2acf60d4c01b82490nF93N68FFtV');
  });
});

describe('selectAndExtract — wire mapping', () => {
  it('保留具体学历表述，并把招聘者活跃度仅放入 extraction metadata', () => {
    const doc = parseHtml(`
      <html><head><title>前端工程师_测试科技招聘-BOSS直聘</title></head><body>
        <div class="job-banner">
          <div class="name"><h1>前端工程师</h1></div>
          <div class="company-info"><span class="name">测试科技</span></div>
          <span class="salary">10-14K</span>
          <div class="info-primary"><p><span>3-5年</span><span>本科</span><span>统招本科及以上</span></p></div>
        </div>
        <div class="job-boss-info"><span class="name">某招聘者</span><span class="boss-active-time">本周活跃</span></div>
        <div class="job-detail-section"><div class="job-sec-text">岗位职责：负责前端开发。</div></div>
      </body></html>
    `);
    const result = selectAndExtract(JOB_DETAIL_URL, doc);
    expect(result.page.recognizedFields?.educationRequirement).toBe('统招本科及以上');
    expect(Object.keys(result.page.recognizedFields ?? {})).not.toContain('activityStatus');
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.activityStatus).toBe('本周活跃');
    const fields = meta.fields as Record<string, { value?: unknown }>;
    expect(fields.activityStatus?.value).toBe('本周活跃');
  });

  it('emits boss_current_page with a clean JD visibleText (no nav) for the job_detail fixture (§五/§七.7)', () => {
    const result = selectAndExtract(JOB_DETAIL_URL, loadFixture('boss-job-detail.html'));
    expect(result.captureMethod).toBe('boss_current_page');
    expect(result.page.recognizedFields?.company).toBe('赞同科技');
    expect(result.page.recognizedFields?.role).toBe('web前端（苏州、银行项目）');
    expect(result.page.recognizedFields?.city).toBe('苏州');
    expect(result.page.visibleText).toContain('岗位职责');
    expect(result.page.visibleText).not.toContain('校园招聘');
    expect(result.page.visibleText).not.toContain('推荐岗位');
  });

  it('carries district/address + per-field provenance in metadata (for raw snapshot, not the 8 fields) (§四)', () => {
    const result = selectAndExtract(JOB_DETAIL_URL, loadFixture('boss-job-detail.html'));
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.kind).toBe('boss_extraction');
    expect(meta.district).toBe('吴中区');
    expect(meta.address).toBe('苏州吴中区苏州国际科技园');
    const fields = meta.fields as Record<string, { value: unknown; source: string; confidence: string; qualityIssues: string[] }>;
    expect(fields.company.source).toBe('boss_dom');
    expect(fields.city.value).toBe('苏州');
    expect(['high', 'medium', 'low']).toContain(fields.city.confidence);
    expect(Array.isArray(fields.city.qualityIssues)).toBe(true);
    // 8 字段里绝不含 district/address。
    expect(Object.keys(result.page.recognizedFields ?? {})).not.toContain('district');
    expect(Object.keys(result.page.recognizedFields ?? {})).not.toContain('address');
  });

  it('generic fallback never guesses core fields for non-BOSS pages (§七.10)', () => {
    const doc = parseHtml('<html><head><title>某招聘网站</title></head><body><p>某公司在招聘一名前端</p></body></html>');
    const result = selectAndExtract('https://example.com/jobs/1', doc);
    expect(result.captureMethod).toBe('generic_visible_text');
    expect(result.page.recognizedFields).toBeNull();
  });

  it('BOSS page with no recognizable fields falls back to generic without guessing', () => {
    const doc = parseHtml('<html><head><title>页面结构完全变了</title></head><body><p>没有任何可识别的定向节点</p></body></html>');
    const result = selectAndExtract(JOB_DETAIL_URL, doc);
    expect(result.captureMethod).toBe('generic_visible_text');
    expect(result.page.recognizedFields).toBeNull();
  });
});

describe('extractGenericPage', () => {
  it('strips script/style content and never sets recognizedFields', () => {
    const doc = parseHtml(`
      <html><head><title>通用页面</title></head>
      <body>
        <script>alert('xss')</script>
        <style>.a{color:red}</style>
        <p>可见文本 A</p>
      </body></html>
    `);
    const page = extractGenericPage(doc);
    expect(page.recognizedFields).toBeNull();
    expect(page.visibleText).not.toContain('alert');
    expect(page.visibleText).toContain('可见文本 A');
  });

  it('truncates extremely long visible text', () => {
    const longText = '字'.repeat(60_000);
    const doc = parseHtml(`<html><body><p>${longText}</p></body></html>`);
    expect(extractGenericPage(doc).visibleText.length).toBeLessThanOrEqual(50_000);
  });
});
