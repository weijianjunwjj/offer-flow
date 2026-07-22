/**
 * 受控城市/区县/地址解析（§三、§七.5）。纯函数，不猜测：
 * 只从一个「地点字符串」里按受控城市字典 + 行政区后缀正则拆出 city / district，
 * 并保留完整 address。绝不把整段地址塞进 city，也不从整页文本模糊定位城市。
 */

/** 受控城市字典（直辖市 + 常见地级市，含苏州）。用于从地址前缀确定城市。 */
const CITY_DICTIONARY = [
  '北京', '上海', '天津', '重庆',
  '广州', '深圳', '珠海', '佛山', '东莞', '中山', '惠州',
  '杭州', '宁波', '温州', '绍兴', '嘉兴', '金华', '台州',
  '南京', '苏州', '无锡', '常州', '徐州', '南通', '扬州', '盐城', '镇江', '泰州',
  '成都', '绵阳', '重庆',
  '武汉', '长沙', '郑州', '西安', '合肥', '福州', '厦门', '泉州',
  '济南', '青岛', '烟台', '潍坊', '大连', '沈阳', '长春', '哈尔滨',
  '南昌', '南宁', '昆明', '贵阳', '兰州', '太原', '石家庄', '唐山',
  '海口', '三亚', '珠海',
];

const DISTRICT_PATTERN = /([一-龥]{1,8}?(?:新区|经济技术开发区|经济开发区|高新区|开发区|自治县|区|县|市))/;

export interface CityAddressParts {
  city: string | null;
  district: string | null;
  address: string | null;
}

/** 归一化用于匹配的字符串：去掉分隔符 ·、空格、·、-、/ 等，不改变原始 address。 */
function normalizeForMatch(raw: string): string {
  return raw.replace(/[·・\s,，、\-—/|]+/g, '');
}

/**
 * 从地点字符串解析 city / district / address。
 * - city：优先受控字典前缀匹配（如「苏州」），否则「XX市」前缀。
 * - district：城市之后的第一个行政区后缀词（区/县/新区/开发区…）。
 * - address：始终保留传入的完整地址。
 * 无法确定的部分保持 null，不猜测。
 */
export function parseCityAddress(raw: string | null | undefined): CityAddressParts {
  if (raw === null || raw === undefined) return { city: null, district: null, address: null };
  const address = raw.trim();
  if (address.length === 0) return { city: null, district: null, address: null };

  const compact = normalizeForMatch(address);

  let city: string | null = null;
  for (const candidate of CITY_DICTIONARY) {
    if (compact.startsWith(candidate)) {
      // 取字典中最长匹配，避免「南京」被「南」类误配（字典均为完整城市名，startsWith 已足够）。
      if (city === null || candidate.length > city.length) city = candidate;
    }
  }
  if (city === null) {
    const cityMatch = compact.match(/^([一-龥]{2,4}市)/);
    if (cityMatch !== null) city = cityMatch[1] ?? null;
  }

  let district: string | null = null;
  const rest = city === null ? compact : compact.slice(city.length);
  const districtMatch = rest.match(DISTRICT_PATTERN);
  if (districtMatch !== null) {
    const candidate = districtMatch[1] ?? null;
    // 避免把「苏州国际科技园」这类非行政区词当区县：只接受以 区/县/新区/开发区 结尾的短词。
    if (candidate !== null && candidate.length <= 8) district = candidate;
  }

  return { city, district, address };
}

/** 判断一个字符串是否本身就是一个「干净的城市名」（用于城市顶部标签直采）。 */
export function isCleanCityLabel(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const value = normalizeForMatch(raw);
  if (CITY_DICTIONARY.includes(value)) return true;
  return /^[一-龥]{2,4}市$/.test(value);
}
