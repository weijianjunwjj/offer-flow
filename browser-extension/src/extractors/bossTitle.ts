import { isCleanCityLabel } from './cityAddress';

/**
 * 受控的 BOSS 页面 <title> 解析（§三 的 role/company 二级 fallback）。
 * 只做确定性的分隔与「招聘」定位，不从整页文本模糊猜测。
 *
 * 常见格式示例：
 *   「web前端（苏州、银行项目）_赞同科技招聘-BOSS直聘」
 *   「web前端_苏州赞同科技招聘-BOSS直聘」
 * 解析目标：role = 第一段（下划线前）；company = 「…招聘」前的公司名（剥掉前缀城市）。
 */

const CITY_PREFIXES = [
  '北京', '上海', '天津', '重庆', '广州', '深圳', '杭州', '南京', '苏州', '无锡', '常州',
  '武汉', '成都', '西安', '郑州', '合肥', '长沙', '青岛', '济南', '宁波', '厦门', '福州',
  '东莞', '佛山', '南通', '嘉兴', '绍兴',
];

export interface BossTitleParts {
  role: string | null;
  company: string | null;
}

function stripBossSuffix(title: string): string {
  return title
    .replace(/[-_—|]\s*BOSS\s*直聘.*$/i, '')
    .replace(/【\s*BOSS\s*直聘\s*】.*$/i, '')
    .replace(/\s*BOSS\s*直聘\s*$/i, '')
    .trim();
}

function stripLeadingCity(name: string): string {
  for (const city of CITY_PREFIXES) {
    if (name.startsWith(city) && name.length > city.length) {
      return name.slice(city.length);
    }
  }
  return name;
}

export function parseBossTitle(rawTitle: string | null | undefined): BossTitleParts {
  if (rawTitle === null || rawTitle === undefined) return { role: null, company: null };
  // 受控解析前置条件：标题必须含 BOSS 结构标记（BOSS直聘 / 招聘），否则视为无结构，不猜测。
  if (!/BOSS\s*直聘/i.test(rawTitle) && !/招聘/.test(rawTitle)) return { role: null, company: null };
  const cleaned = stripBossSuffix(rawTitle.trim());
  if (cleaned.length === 0) return { role: null, company: null };

  // role：只在有明确岗位结构时提取——存在下划线（role_company招聘）取下划线前一段；
  // 否则仅当标题形如「<岗位>招聘…」时取「招聘」前一段。都不满足则 role=null，不把
  // 「BOSS直聘-职位列表」这类无结构标题当作岗位名。
  const underscoreIndex = cleaned.indexOf('_');
  let role: string | null = null;
  if (underscoreIndex >= 0) {
    const rp = cleaned.slice(0, underscoreIndex).trim();
    role = rp.length > 0 ? rp : null;
  } else {
    const roleMatch = cleaned.match(/^(.+?)招聘/);
    const rp = roleMatch?.[1]?.trim() ?? '';
    role = rp.length > 0 ? rp : null;
  }

  // company：在「role 之后」的部分里找「…招聘」，取招聘前的公司名并剥掉前缀城市。
  const afterRole = underscoreIndex >= 0 ? cleaned.slice(underscoreIndex + 1) : cleaned;
  const companyMatch = afterRole.match(/([^_\-—【】|]+?)招聘/);
  let company: string | null = null;
  if (companyMatch !== null) {
    const token = companyMatch[1]?.trim() ?? '';
    const stripped = stripLeadingCity(token).trim();
    // 若剥城市后剩下的仍疑似城市标签（如整段就是城市），视为无法确定公司。
    company = stripped.length > 0 && !isCleanCityLabel(stripped) ? stripped : null;
  }

  return { role: role && role.length > 0 ? role : null, company };
}
