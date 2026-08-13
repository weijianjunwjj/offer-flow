/**
 * OfferFlow v0.9 — Phase 0 / V9-0 Tavily Integration Smoke Gate
 *
 * T001–T008: 独立验证 Tavily Search API 的真实能力、合约和合规边界。
 *
 * 约束：
 * - 只依赖 Node.js fetch，不依赖任何 OfferFlow 业务服务、数据库或 Fastify
 * - 从环境变量 TAVILY_API_KEY 读取 API Key
 * - 输出写入 scripts/provider-validation/output/ 目录
 * - 不写数据库
 * - 不修改业务主流程
 *
 * 运行: pnpm run provider:validate
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Config ──────────────────────────────────────────────────────────────────

const TAVILY_BASE_URL = 'https://api.tavily.com';
const SEARCH_ENDPOINT = `${TAVILY_BASE_URL}/search`;
const SCRIPT_DIR = join(fileURLToPath(import.meta.url), '..');
const OUTPUT_DIR = join(SCRIPT_DIR, 'output');
const TIMEOUT_MS = 30_000;
const API_KEY = process.env['TAVILY_API_KEY'];

// ── Core test queries (苏州/无锡/上海 + 高级前端/AI应用工程师/产品型前端) ──

const CORE_QUERIES = [
  { query: '苏州 高级前端工程师 招聘', city: '苏州', direction: '高级前端' },
  { query: '无锡 高级前端工程师 招聘', city: '无锡', direction: '高级前端' },
  { query: '上海 高级前端工程师 招聘', city: '上海', direction: '高级前端' },
  { query: '苏州 AI应用工程师 前端 招聘', city: '苏州', direction: 'AI应用工程师' },
  { query: '无锡 AI前端 全栈 招聘', city: '无锡', direction: 'AI应用工程师' },
  { query: '上海 AI前端 全栈 招聘', city: '上海', direction: 'AI应用工程师' },
  { query: '苏州 产品型前端 TypeScript React 招聘', city: '苏州', direction: '产品型前端' },
  { query: '无锡 产品型前端 TypeScript React 招聘', city: '无锡', direction: '产品型前端' },
  { query: '上海 产品型前端 TypeScript React 招聘', city: '上海', direction: '产品型前端' },
];

// ── Types ───────────────────────────────────────────────────────────────────

interface TavilySearchBody {
  query: string;
  search_depth: 'basic' | 'advanced';
  topic: 'general' | 'news';
  country?: string;
  max_results?: number;
  include_answer?: boolean;
  include_raw_content?: boolean;
  include_usage?: boolean;
  time_range?: 'day' | 'week' | 'month' | 'year';
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content: string | null;
  published_date?: string;
}

/**
 * Tavily usage object — real response shape depends on API version.
 * Official docs (2026): `{ credits: number, search_depth: string }`.
 * Field priorities for credit extraction:
 *   1. `usage.credits` (official field name per Tavily API docs)
 *   2. `usage.credit_used` (legacy — observed in some responses)
 *   3. `usage.credits_used` (alternate spelling)
 */
interface TavilyUsage {
  credits?: number;
  credit_used?: number;
  credits_used?: number;
  search_depth?: string;
}

interface TavilySearchResponse {
  query: string;
  results: TavilyResult[];
  response_time: number;
  images?: unknown[];
  usage?: TavilyUsage;
}

/**
 * Extract credits used from a Tavily usage object.
 * Priority per Tavily official API docs (2026):
 *   1. `usage.credits` — canonical field name
 *   2. `usage.credit_used` — legacy alias
 *   3. `usage.credits_used` — alternate spelling
 *
 * Also captures the actual response shape for reporting.
 */
function extractCredits(usage: TavilyUsage | undefined): {
  credits: number | null;
  sourceField: string | null;
  allUsageFields: Record<string, unknown>;
} {
  if (!usage) return { credits: null, sourceField: null, allUsageFields: {} };
  const allFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(usage)) {
    allFields[k] = v;
  }
  if (typeof usage.credits === 'number') {
    return { credits: usage.credits, sourceField: 'usage.credits', allUsageFields: allFields };
  }
  if (typeof usage.credit_used === 'number') {
    return { credits: usage.credit_used, sourceField: 'usage.credit_used (legacy)', allUsageFields: allFields };
  }
  if (typeof usage.credits_used === 'number') {
    return { credits: usage.credits_used, sourceField: 'usage.credits_used', allUsageFields: allFields };
  }
  return { credits: null, sourceField: null, allUsageFields: allFields };
}

interface SmokeCheck {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'PRELIMINARY_PASS_WITH_BOUNDARIES';
  details: Record<string, unknown>;
  errors: string[];
}

interface QuerySample {
  city: string;
  direction: string;
  query: string;
  resultCount: number;
  sampleTitles: string[];
  responseTime: number;
  creditUsed: number | null;
}

interface FieldCoverage {
  field: string;
  exists: boolean;
  type: string;
  nonEmptyRate: number;
  sampleValue: unknown;
  note: string;
}

interface DomainDistribution {
  domain: string;
  count: number;
  classification: 'RECRUITMENT_PLATFORM' | 'COMPANY_CAREER' | 'TECH_COMMUNITY' | 'HIGHER_ED' | 'OTHER' | 'UNKNOWN';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureOutputDir(): void {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function domainClassify(hostname: string): DomainDistribution['classification'] {
  const patterns: [string, DomainDistribution['classification']][] = [
    ['zhipin.com', 'RECRUITMENT_PLATFORM'],
    ['liepin.com', 'RECRUITMENT_PLATFORM'],
    ['zhaopin.com', 'RECRUITMENT_PLATFORM'],
    ['lagou.com', 'RECRUITMENT_PLATFORM'],
    ['51job.com', 'RECRUITMENT_PLATFORM'],
    ['yingjiesheng.com', 'RECRUITMENT_PLATFORM'],
    ['yupao.com', 'RECRUITMENT_PLATFORM'],
    ['nowcoder.com', 'TECH_COMMUNITY'],
    ['zhiye.com', 'COMPANY_CAREER'],
    ['alibaba.com', 'COMPANY_CAREER'],
    ['bytedance.com', 'COMPANY_CAREER'],
    ['fanruan.com', 'COMPANY_CAREER'],
    ['github.com', 'TECH_COMMUNITY'],
    ['juejin.cn', 'TECH_COMMUNITY'],
    ['linux.do', 'TECH_COMMUNITY'],
    ['edu.cn', 'HIGHER_ED'],
  ];
  for (const [p, c] of patterns) {
    if (hostname.endsWith(p)) return c;
  }
  if (/career|job|hr\.|zhaopin|hire|recruit/i.test(hostname)) return 'COMPANY_CAREER';
  return 'UNKNOWN';
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid_url';
  }
}

function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

async function tavilySearch(
  body: TavilySearchBody,
  apiKey: string,
): Promise<{ response: TavilySearchResponse; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json()) as TavilySearchResponse;
    return { response: data, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// ── T002: API Key 可达性 ────────────────────────────────────────────────────

async function t002AuthCheck(): Promise<SmokeCheck> {
  const check: SmokeCheck = {
    id: 'T002',
    name: 'Tavily API Key 可达性',
    status: 'FAIL',
    details: {},
    errors: [],
  };

  if (!API_KEY || API_KEY.length === 0) {
    check.errors.push('TAVILY_API_KEY 环境变量未设置或为空');
    check.details = { authStatus: 'fail', reason: 'missing_api_key' };
    return check;
  }

  // Test 1: valid key
  const body: TavilySearchBody = {
    query: '苏州 前端工程师 招聘',
    search_depth: 'basic',
    topic: 'general',
    country: 'china',
    max_results: 3,
    include_answer: false,
    include_raw_content: false,
    include_usage: true,
  };

  try {
    const { response, status } = await tavilySearch(body, API_KEY);
    check.details = {
      ...check.details,
      validKeyStatus: status,
      validKeyResponseTime: response.response_time,
      validKeyResultCount: response.results?.length ?? 0,
    };
    if (status === 200 && response.results) {
      check.status = 'PASS';
    } else {
      check.errors.push(`有效 Key 返回非 200: ${status}`);
    }
  } catch (err) {
    check.errors.push(`有效 Key 请求失败: ${String(err)}`);
    check.details = { ...check.details, validKeyError: String(err) };
  }

  // Test 2: invalid key
  try {
    const res = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tvly-invalid-test-key-12345',
      },
      body: JSON.stringify(body),
    });
    check.details = { ...check.details, invalidKeyStatus: res.status };
    if (res.status === 401 || res.status === 403) {
      // expected
    } else {
      check.errors.push(`无效 Key 应返回 401/403，实际 ${res.status}`);
    }
  } catch (err) {
    check.details = { ...check.details, invalidKeyError: String(err) };
  }

  if (check.errors.length === 0) check.status = 'PASS';
  else check.status = 'FAIL';
  return check;
}

// ── T003: 中国地区搜索真实可用 ─────────────────────────────────────────────

async function t003ChinaSearch(checkAuthStatus: string): Promise<SmokeCheck> {
  const check: SmokeCheck = {
    id: 'T003',
    name: '中国地区搜索真实可用 (country=china)',
    status: 'FAIL',
    details: {},
    errors: [],
  };

  if (checkAuthStatus === 'FAIL') {
    check.status = 'SKIP';
    check.errors.push('T002 FAIL — 跳过 T003');
    return check;
  }

  if (!API_KEY) {
    check.status = 'SKIP';
    check.errors.push('TAVILY_API_KEY 不可用');
    return check;
  }

  const samples: QuerySample[] = [];
  let atLeastOneResult = false;

  for (const q of CORE_QUERIES) {
    try {
      const body: TavilySearchBody = {
        query: q.query,
        search_depth: 'basic',
        topic: 'general',
        country: 'china',
        max_results: 10,
        include_answer: false,
        include_raw_content: false,
        include_usage: true,
      };

      const { response, status } = await tavilySearch(body, API_KEY);
      const titles = (response.results ?? []).slice(0, 5).map((r) => r.title);
      const cr = extractCredits(response.usage);

      samples.push({
        city: q.city,
        direction: q.direction,
        query: q.query,
        resultCount: response.results?.length ?? 0,
        sampleTitles: titles,
        responseTime: response.response_time,
        creditUsed: cr.credits,
      });

      if ((response.results?.length ?? 0) > 0) atLeastOneResult = true;

      if (status !== 200) {
        check.errors.push(`${q.query}: HTTP ${status}`);
      }
    } catch (err) {
      check.errors.push(`${q.query}: ${String(err)}`);
      samples.push({
        city: q.city,
        direction: q.direction,
        query: q.query,
        resultCount: 0,
        sampleTitles: [],
        responseTime: 0,
        creditUsed: null,
      });
    }

    // Brief pause between queries to avoid rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  check.details = { samples, atLeastOneResult, totalQueries: CORE_QUERIES.length };

  if (atLeastOneResult && check.errors.length === 0) {
    check.status = 'PASS';
  } else if (atLeastOneResult && check.errors.length > 0) {
    check.status = 'FAIL';
    check.errors.push('部分查询有结果但存在错误');
  } else {
    check.errors.push('所有目标城市查询均返回 0 结果');
  }

  return check;
}

// ── T004: Response Contract 字段一致性 ─────────────────────────────────────

async function t004ContractVerify(checkT003Status: string): Promise<SmokeCheck> {
  const check: SmokeCheck = {
    id: 'T004',
    name: 'Tavily Response Contract 字段一致性',
    status: 'FAIL',
    details: {},
    errors: [],
  };

  if (checkT003Status === 'FAIL' || checkT003Status === 'SKIP') {
    check.status = 'SKIP';
    check.errors.push(`T003 ${checkT003Status} — 跳过 T004`);
    return check;
  }

  if (!API_KEY) {
    check.status = 'SKIP';
    return check;
  }

  // Use a known-good query to verify contract
  const body: TavilySearchBody = {
    query: '上海 高级前端工程师 React TypeScript 招聘',
    search_depth: 'basic',
    topic: 'general',
    country: 'china',
    max_results: 10,
    include_answer: false,
    include_raw_content: false,
    include_usage: true,
  };

  try {
    const { response } = await tavilySearch(body, API_KEY);
    const results = response.results ?? [];

    // Build field coverage matrix
    const fields: FieldCoverage[] = [
      {
        field: 'results[].title',
        exists: results.length > 0,
        type: typeof results[0]?.title,
        nonEmptyRate: results.filter((r) => r.title && r.title.length > 0).length / Math.max(results.length, 1),
        sampleValue: results[0]?.title ?? 'N/A',
        note: results.every((r) => typeof r.title === 'string' && r.title.length > 0) ? '✅ all non-empty' : '⚠️ some empty',
      },
      {
        field: 'results[].url',
        exists: results.length > 0,
        type: typeof results[0]?.url,
        nonEmptyRate: results.filter((r) => r.url && isValidUrl(r.url)).length / Math.max(results.length, 1),
        sampleValue: results[0]?.url ?? 'N/A',
        note: results.every((r) => isValidUrl(r.url)) ? '✅ all valid URLs' : '⚠️ some invalid',
      },
      {
        field: 'results[].content',
        exists: results.length > 0,
        type: typeof results[0]?.content,
        nonEmptyRate: results.filter((r) => r.content && r.content.length > 0).length / Math.max(results.length, 1),
        sampleValue: (results[0]?.content ?? '').slice(0, 120),
        note: `avg length: ${Math.round(results.reduce((s, r) => s + (r.content?.length ?? 0), 0) / Math.max(results.length, 1))} chars`,
      },
      {
        field: 'results[].score',
        exists: results.length > 0 && results[0]?.score !== undefined,
        type: typeof results[0]?.score,
        nonEmptyRate: results.filter((r) => r.score !== undefined && r.score !== null).length / Math.max(results.length, 1),
        sampleValue: results[0]?.score ?? 'N/A',
        note: results.length > 0 && typeof results[0]?.score === 'number'
          ? `range: [${Math.min(...results.map((r) => r.score ?? Infinity))}, ${Math.max(...results.map((r) => r.score ?? -Infinity))}]`
          : 'N/A',
      },
      {
        field: 'results[].raw_content',
        exists: true,
        type: results.length > 0 ? typeof results[0]?.raw_content : 'N/A',
        nonEmptyRate: 1,
        sampleValue: results[0]?.raw_content,
        note: (results.every((r) => r.raw_content === null || r.raw_content === undefined))
          ? '✅ P0 配置下全部为 null（include_raw_content=false）'
          : '🔴 P0 配置下仍有 raw_content！',
      },
      {
        field: 'query (echo)',
        exists: response.query !== undefined,
        type: typeof response.query,
        nonEmptyRate: response.query ? 1 : 0,
        sampleValue: response.query,
        note: response.query === body.query ? '✅ echo correct' : '⚠️ echo mismatch',
      },
      {
        field: 'response_time',
        exists: response.response_time !== undefined,
        type: typeof response.response_time,
        nonEmptyRate: response.response_time !== undefined ? 1 : 0,
        sampleValue: response.response_time,
        note: typeof response.response_time === 'number' ? '✅' : '⚠️',
      },
      {
        field: 'images',
        exists: response.images !== undefined,
        type: typeof response.images,
        nonEmptyRate: 1,
        sampleValue: Array.isArray(response.images) ? `[${(response.images as unknown[]).length} items]` : 'N/A',
        note: 'optional field',
      },
      {
        field: 'usage.credits (canonical)',
        exists: response.usage?.credits !== undefined,
        type: typeof response.usage?.credits,
        nonEmptyRate: response.usage?.credits !== undefined ? 1 : 0,
        sampleValue: response.usage?.credits ?? 'N/A',
        note: response.usage?.credits === 1 ? '✅ basic=1 credit' : '⚠️ usage.credits not present or ≠ 1 — see actual usage shape below',
      },
      {
        field: 'usage (actual response shape)',
        exists: response.usage !== undefined,
        type: response.usage ? 'object' : 'N/A',
        nonEmptyRate: response.usage !== undefined ? 1 : 0,
        sampleValue: response.usage ? JSON.stringify(extractCredits(response.usage).allUsageFields) : 'N/A',
        note: '实际 API 返回的 usage 对象完整字段集合（用于 Provider Adapter 字段选择）',
      },
      {
        field: 'results[].published_date',
        exists: results.some((r) => r.published_date !== undefined),
        type: results.find((r) => r.published_date !== undefined) ? 'string' : 'N/A',
        nonEmptyRate: results.filter((r) => r.published_date).length / Math.max(results.length, 1),
        sampleValue: results.find((r) => r.published_date)?.published_date ?? 'N/A',
        note: 'optional — Tavily may not always return this',
      },
    ];

    // Flag raw_content violation
    const rawContentViolation = !results.every((r) => r.raw_content === null || r.raw_content === undefined);
    if (rawContentViolation) {
      check.errors.push('P0 配置 (include_raw_content=false) 下 raw_content 非 null——违反禁止保存 raw_content 约束');
    }

    check.details = {
      fields,
      totalResults: results.length,
      rawContentViolation,
    };

    check.status = check.errors.length === 0 ? 'PASS' : 'FAIL';
  } catch (err) {
    check.errors.push(`Contract 验证请求失败: ${String(err)}`);
    check.status = 'FAIL';
  }

  return check;
}

// ── T006: 中国招聘平台结果发现能力 ─────────────────────────────────────────

async function t006SourceDiscovery(checkT003Status: string): Promise<SmokeCheck> {
  const check: SmokeCheck = {
    id: 'T006',
    name: 'Tavily 中国招聘平台结果发现能力',
    status: 'FAIL',
    details: {},
    errors: [],
  };

  if (checkT003Status === 'FAIL' || checkT003Status === 'SKIP') {
    check.status = 'SKIP';
    return check;
  }

  if (!API_KEY) {
    check.status = 'SKIP';
    return check;
  }

  // Aggregate domains across all queries
  const domainCounts = new Map<string, number>();
  let totalResults = 0;
  const platformHits: { platform: string; found: boolean; sampleUrl: string }[] = [];

  for (const q of CORE_QUERIES) {
    try {
      const body: TavilySearchBody = {
        query: q.query,
        search_depth: 'basic',
        topic: 'general',
        country: 'china',
        max_results: 10,
        include_answer: false,
        include_raw_content: false,
        include_usage: true,
      };
      const { response } = await tavilySearch(body, API_KEY);
      for (const r of response.results ?? []) {
        const hostname = extractHostname(r.url);
        domainCounts.set(hostname, (domainCounts.get(hostname) ?? 0) + 1);
        totalResults++;
      }
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      // individual query failures recorded in T003
    }
  }

  const distributions: DomainDistribution[] = Array.from(domainCounts.entries())
    .map(([domain, count]) => ({
      domain,
      count,
      classification: domainClassify(domain),
    }))
    .sort((a, b) => b.count - a.count);

  // Check specific platforms
  const platforms = ['zhipin.com', 'liepin.com', 'zhaopin.com', 'lagou.com', '51job.com'];
  for (const p of platforms) {
    const found = distributions.some((d) => d.domain.endsWith(p));
    const sample = distributions.find((d) => d.domain.endsWith(p));
    platformHits.push({
      platform: p,
      found,
      sampleUrl: sample ? sample.domain : '',
    });
  }

  const anyPlatformFound = platformHits.some((p) => p.found);
  const recruitmentPlatforms = distributions.filter((d) => d.classification === 'RECRUITMENT_PLATFORM');
  const companyCareers = distributions.filter((d) => d.classification === 'COMPANY_CAREER');
  const techCommunities = distributions.filter((d) => d.classification === 'TECH_COMMUNITY');

  check.details = {
    totalResults,
    uniqueDomains: distributions.length,
    distributions: distributions.slice(0, 30),
    platformHits,
    summary: {
      recruitmentPlatforms: recruitmentPlatforms.length,
      companyCareers: companyCareers.length,
      techCommunities: techCommunities.length,
      other: distributions.filter((d) => d.classification === 'OTHER').length,
      unknown: distributions.filter((d) => d.classification === 'UNKNOWN').length,
    },
  };

  if (anyPlatformFound) {
    check.status = 'PASS';
  } else {
    check.errors.push('未发现任何已知专业招聘平台域名');
    check.status = 'FAIL';
  }

  return check;
}

// ── T007: Rate Limit / Credit Usage ────────────────────────────────────────

async function t007RateLimit(checkT002Status: string): Promise<SmokeCheck> {
  const check: SmokeCheck = {
    id: 'T007',
    name: 'Tavily Rate Limit / Credit Usage 真实行为',
    status: 'FAIL',
    details: {},
    errors: [],
  };

  if (checkT002Status === 'FAIL') {
    check.status = 'SKIP';
    return check;
  }

  if (!API_KEY) {
    check.status = 'SKIP';
    return check;
  }

  const creditObservations: { query: string; credits: number | null; status: number }[] = [];
  let rateLimitedObserved = false;
  let rateLimitRecovery: number | null = null;

  // Observation 1: single basic search = 1 credit
  try {
    const body: TavilySearchBody = {
      query: '上海 前端招聘',
      search_depth: 'basic',
      topic: 'general',
      country: 'china',
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_usage: true,
    };
    const { response, status } = await tavilySearch(body, API_KEY);
    const cr = extractCredits(response.usage);
    creditObservations.push({
      query: '上海 前端招聘',
      credits: cr.credits,
      status,
    });
    check.details = {
      ...check.details,
      singleCredit: cr.credits,
      creditSourceField: cr.sourceField,
      usageActualShape: cr.allUsageFields,
      singleCreditMatch: cr.credits === 1,
    };
  } catch (err) {
    check.errors.push(`Credit 观测失败: ${String(err)}`);
  }

  // Observation 2: consecutive requests — watch for 429
  const burstResults: { index: number; status: number; rateLimited: boolean }[] = [];
  for (let i = 0; i < 5; i++) {
    try {
      const body: TavilySearchBody = {
        query: `前端招聘 苏州 ${i + 1}`,
        search_depth: 'basic',
        topic: 'general',
        country: 'china',
        max_results: 3,
        include_answer: false,
        include_raw_content: false,
        include_usage: true,
      };
      const { status } = await tavilySearch(body, API_KEY);
      burstResults.push({ index: i, status, rateLimited: status === 429 });
      if (status === 429) rateLimitedObserved = true;
    } catch (err) {
      burstResults.push({ index: i, status: 0, rateLimited: false });
    }
    // small delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  check.details = {
    ...check.details,
    creditObservations,
    burstResults,
    rateLimitedObserved,
    rateLimitRecovery,
    recommendation: rateLimitedObserved
      ? '观察到 rate limit — Provider Adapter 需实现 Token Bucket (maxTokens=5, refillRate=1/s)'
      : '未观察到 rate limit（5 次 / 2.5s）— 以 Tavily 官方文档 rate limit 为准，Provider Adapter 仍应实现 Token Bucket',
    usageLimitNote: '未测试 432/433（需耗尽额度），以 Tavily 官方文档为准：432=Usage Limit Exceeded, 433=Pay-as-you-go Limit Exceeded',
  };

  check.status = check.errors.length === 0 ? 'PASS' : 'FAIL';
  return check;
}

// ── T005: Terms / AUP Persistence Check (generates tavily-compliance.md) ──

function t005Compliance(): SmokeCheck {
  const check: SmokeCheck = {
    id: 'T005',
    name: 'Tavily Terms / AUP Persistence 约束合规性',
    status: 'PRELIMINARY_PASS_WITH_BOUNDARIES',
    details: {},
    errors: [],
  };

  // Based on web research and prevalidation findings:
  // 1. Tavily Platform Terms do NOT prohibit storing/caching search Output locally
  // 2. Official Tavily Python SDK includes Hybrid RAG client with save_foreign for MongoDB persistence
  // 3. Zero-data-retention policy applies to Tavily's servers, not user's local storage
  // 4. Human oversight requirement for employment decisions is satisfied by OfferFlow's design
  // HOWEVER — boundaries remain:
  //   a. Tavily ToS bans automated decisions with "significant impact on employment"
  //   b. OfferFlow is a human-assistance tool; it NEVER does auto-apply, auto-delivery, or auto-employment-decision
  //   c. If OfferFlow ever changes this, ToS must be re-evaluated
  //   d. Terms can change — this check is PRELIMINARY, not permanent

  check.details = {
    termsUrl: 'https://tavily.com/terms-of-use',
    aupUrl: 'https://tavily.com/aup',
    overallStatus: 'PRELIMINARY_PASS_WITH_BOUNDARIES',
    explanation: [
      'Tavily ToS does not prohibit local persistence of search Output',
      'However, Tavily ToS requires human oversight for employment-related automated decisions',
      'OfferFlow is strictly a human-assistance tool: AI discovers + analyzes, human makes final judgment',
      'OfferFlow NEVER auto-applies, auto-delivers, or auto-decides employment',
      'If OfferFlow ever adds automated employment decisions, this compliance MUST be re-evaluated',
      'This is a PRELIMINARY finding — ToS can change; re-check before each Phase',
    ],
    hardBoundaries: [
      'OfferFlow MUST NOT auto-apply to jobs',
      'OfferFlow MUST NOT auto-deliver resumes',
      'OfferFlow MUST NOT auto-make employment decisions',
      'OfferFlow MUST NOT bypass human review for significant employment actions',
      'If human oversight is removed from any path, Tavily ToS compliance is LOST',
    ],
    checks: {
      localPersistenceAllowed: {
        result: 'PASS',
        evidence: [
          'Tavily Platform Terms do not prohibit storing/caching search Output locally',
          'Official Tavily Python SDK includes Hybrid RAG client with save_foreign parameter for MongoDB persistence',
          'Community projects (tavily-cli) use Redis caching with TTL-based persistence',
          'Zero-data-retention policy applies to Tavily infrastructure, not user-owned storage',
        ],
      },
      humanOversightRequirement: {
        result: 'PRELIMINARY_PASS_WITH_BOUNDARIES',
        evidence: [
          'Tavily AUP: automated decisions with "significant impact on employment" require human oversight',
          'OfferFlow design satisfies this TODAY: AI does discovery + analysis, user makes final judgment',
          'No automated employment decisions are made by OfferFlow',
          'MANUAL_REVIEW_REQUIRED candidates require explicit user review before analysis',
          '⚠️ BOUNDARY: this compliance is conditional on OfferFlow never adding automated employment decisions',
        ],
      },
      rawContentConstraint: {
        result: 'PASS',
        evidence: [
          'P0 uses include_raw_content=false',
          'raw_content is prohibited from storage per OfferFlow Source Policy',
          'If include_raw_content=true is enabled in future, a separate ToS compliance re-evaluation is required',
        ],
      },
      searchEvidenceFieldsAllowed: {
        result: 'PASS',
        evidence: [
          'title, url, content, score — are the minimum necessary Search Evidence fields',
          'query, domain, searchedAt — are metadata for OfferFlow dedup/history',
          'These fields represent the minimum viable set for product operation',
        ],
      },
    },
    savedFields: [
      'title',
      'url',
      'content',
      'score (as providerScore)',
      'query',
      'domain',
      'searchedAt',
      'provider (constant: "tavily")',
      'providerRequestId',
    ],
    prohibitedFields: [
      'raw_content',
      'images',
      'answer',
      'follow_up_questions',
    ],
    futureConsiderations: [
      'If include_raw_content=true is enabled in future: re-evaluate Tavily ToS/AUP compliance',
      'If Tavily ToS is updated: re-run this compliance check',
      'If OfferFlow adds automated employment decisions: human oversight requirement LOST — must re-evaluate',
      'Re-check T005 status at the start of each Phase',
    ],
  };

  return check;
}

// ── Aggregate & Report ──────────────────────────────────────────────────────

interface SmokeReport {
  meta: {
    generatedAt: string;
    tavilyApiKeyAvailable: boolean;
    version: '1.0.0';
  };
  results: {
    T002: SmokeCheck;
    T003: SmokeCheck;
    T004: SmokeCheck;
    T005: SmokeCheck;
    T006: SmokeCheck;
    T007: SmokeCheck;
  };
  verdict: {
    overall: 'PASS' | 'FAIL';
    allowPhase1: boolean;
    summary: string;
    knownRisks: string[];
    remainingRisks: string[];
  };
}

function generateSmokeReport(checks: Record<string, SmokeCheck>): SmokeReport {
  const passed = Object.values(checks).filter((c) => c.status === 'PASS' || c.status === 'PRELIMINARY_PASS_WITH_BOUNDARIES').length;
  const failed = Object.values(checks).filter((c) => c.status === 'FAIL').length;
  const skipped = Object.values(checks).filter((c) => c.status === 'SKIP').length;

  const overall: 'PASS' | 'FAIL' = failed > 0 ? 'FAIL' : 'PASS';

  const t005OK = checks['T005']?.status === 'PRELIMINARY_PASS_WITH_BOUNDARIES' || checks['T005']?.status === 'PASS';
  const allowPhase1 = checks['T002']?.status === 'PASS'
    && checks['T003']?.status === 'PASS'
    && checks['T004']?.status === 'PASS'
    && t005OK
    && checks['T006']?.status === 'PASS'
    && checks['T007']?.status === 'PASS';

  const knownRisks: string[] = [
    'Tavily Free tier: 1,000 credits/month — 如有 query expansion 膨胀可能不足',
    'Tavily content 字段为搜索摘要，非完整 JD — SEARCH_EVIDENCE 岗位需 MANUAL_REVIEW_REQUIRED 机制',
    '招聘平台 BOSS 直聘在公开搜索结果中出现频次低于猎聘/智联',
    'Tavily ToS/AUP 未来更新可能改变持久化权限 — 需定期复查',
  ];

  const remainingRisks: string[] = [];
  if (checks['T003']?.status === 'PASS') {
    const details = checks['T003'].details as Record<string, unknown>;
    const samples = details['samples'] as QuerySample[] | undefined;
    if (samples) {
      const emptyQueries = samples.filter((s) => s.resultCount === 0);
      if (emptyQueries.length > 0) {
        remainingRisks.push(`${emptyQueries.length}/${samples.length} 查询返回 0 结果: ${emptyQueries.map((s) => s.city).join(', ')}`);
      }
    }
  }

  if (checks['T007']?.status === 'PASS') {
    const details = checks['T007'].details as Record<string, unknown>;
    if (details['rateLimitedObserved'] === true) {
      remainingRisks.push('观察到 Tavily rate limit — Provider Adapter 必须实现 Token Bucket');
    }
    if (details['singleCreditMatch'] !== true) {
      remainingRisks.push(`basic search credit 不是 1 — 实测: ${JSON.stringify(details['singleCredit'])}`);
    }
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      tavilyApiKeyAvailable: !!API_KEY && API_KEY.length > 0,
      version: '1.0.0',
    },
    results: {
      T002: checks['T002'],
      T003: checks['T003'],
      T004: checks['T004'],
      T005: checks['T005'],
      T006: checks['T006'],
      T007: checks['T007'],
    },
    verdict: {
      overall,
      allowPhase1,
      summary: overall === 'PASS'
        ? `所有 ${passed} 项 GATE 检查 PASS（${skipped} 项 SKIP）。Tavily Search API 满足 P0 Open Web Search Provider 的 Smoke Gate 要求，允许进入 Phase 1。`
        : `${failed} 项 GATE 检查 FAIL（${passed} PASS, ${skipped} SKIP）。Tavily Search API 不满足 Smoke Gate，请检查失败项。`,
      knownRisks,
      remainingRisks,
    },
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureOutputDir();

  // T005 is a pure documentation check — run first
  const t005 = t005Compliance();

  // Generate tavily-compliance.md immediately
  const complianceMd = `# Tavily API Terms / AUP Persistence Compliance Check

> **生成时间：** ${new Date().toISOString()}
> **检查人：** OfferFlow v0.9 Phase 0 Smoke Gate (T005)
> **状态：** PRELIMINARY_PASS_WITH_BOUNDARIES
> **依据：** Tavily Platform Terms (https://tavily.com/terms-of-use), Acceptable Use Policy (https://tavily.com/aup)

---

## 0. 总体判定

**PRELIMINARY_PASS_WITH_BOUNDARIES** — OfferFlow 当前 P0 配置下的 Search Evidence 持久化行为与 Tavily Platform Terms / AUP 基本一致，**但附带硬边界**。

这些边界不是可选的：

- **禁止自动投递** — OfferFlow MUST NOT auto-apply to jobs
- **禁止自动投递简历** — OfferFlow MUST NOT auto-deliver resumes
- **禁止自动就业决策** — OfferFlow MUST NOT auto-make employment decisions
- **禁止绕过人工审查** — OfferFlow MUST NOT bypass human review for significant employment actions

**如果上述任何边界被突破，Tavily ToS 合规性立即失效，需要重新评估。**

OfferFlow 的定位严格限定为人工辅助工具：AI 做发现 + 分析 → 用户做最终判断。这是 Tavily ToS 对 employment 领域 human oversight 要求的具体体现。

---

## 1. 检查结论

OfferFlow 在 P0 配置（\`search_depth=basic\`, \`include_raw_content=false\`, \`include_usage=true\`, \`country=china\`）下，Search Evidence 持久化行为与 Tavily Platform Terms / AUP 一致，**但仅限当前人工辅助设计**。

---

## 2. 合规检查矩阵

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 本地持久化搜索结果是否被禁止？ | **否** | Tavily Platform Terms 不禁止本地存储/缓存 Search Output。零数据保留政策适用于 Tavily 服务器端，不适用于用户自有存储。 |
| 官方 SDK 是否支持本地持久化？ | **是** | Tavily Python SDK 的 Hybrid RAG Client 内置 \`save_foreign\` 参数，将搜索结果保存到本地 MongoDB。 |
| 就业决策的人工监督要求？ | **PRELIMINARY_PASS** ⚠️ | Tavily AUP 禁止"对就业产生重大影响"的自动化决策。OfferFlow 当前设计满足此要求（AI 辅助 + 人工决策），但这是**条件性合规**——如果未来 OfferFlow 增加自动投递等能力，合规立即失效。 |
| raw_content 保存是否合规？ | **不适用** | P0 使用 \`include_raw_content=false\`，raw_content 被明确禁止保存。未来若启用需重新评估 ToS。 |
| Search Evidence 字段是否属于合理最小范围？ | **是** | title/url/content/score/query/domain/searchedAt 是实现产品去重、历史和 DailyBrief 所需的最小字段集。 |

---

## 3. 硬边界（不可在产品中突破）

| 边界 | 说明 |
|------|------|
| **禁止自动投递** | OfferFlow MUST NOT auto-apply to jobs |
| **禁止自动投递简历** | OfferFlow MUST NOT auto-deliver resumes |
| **禁止自动就业决策** | OfferFlow MUST NOT auto-make employment decisions |
| **禁止绕过人工审查** | OfferFlow MUST NOT bypass human review for significant employment actions |
| **Human-in-the-loop 不可移除** | 如果任何路径移除人工监督，Tavily ToS 合规立即失效 |

---

## 4. 允许保存的 Search Evidence 字段

| 字段 | 来源 | 用途 |
|------|------|------|
| \`title\` | Tavily \`results[].title\` | 岗位标题 |
| \`url\` | Tavily \`results[].url\` | 岗位链接，用于去重和用户跳转 |
| \`content\` | Tavily \`results[].content\` | 搜索摘要（Provider Output，非完整 JD） |
| \`score\` (as \`providerScore\`) | Tavily \`results[].score\` | Provider 相关性评分 |
| \`query\` | Tavily \`query\` (echo) | 搜索查询词，用于追踪 |
| \`domain\` | 从 \`url\` 解析 | 来源域名，用于 Source Policy 判定 |
| \`searchedAt\` | 服务端时间戳 | 搜索时间 |
| \`provider\` | 常量 \`"tavily"\` | Provider 标识 |
| \`providerRequestId\` | Tavily response metadata | 请求追踪（如有） |

---

## 5. 禁止保存的字段

| 字段 | 原因 |
|------|------|
| \`raw_content\` | P0 \`include_raw_content=false\`；若未来启用需重新评估 ToS |
| \`images\` | 不映射到 SearchEvidenceItem，超出最小必要范围 |
| \`answer\` | P0 \`include_answer=false\`，不映射 |
| \`follow_up_questions\` | 不在 Search Evidence 模型范围内 |

---

## 6. Credit 字段说明

Tavily 官方 API 文档规定 credit 字段为 \`usage.credits\`（\`number\` 类型），但不同 API 版本可能返回不同的字段名。

Provider Adapter 实现时必须按以下优先级读取：
1. \`usage.credits\` — 官方规范字段名
2. \`usage.credit_used\` — legacy alias
3. \`usage.credits_used\` — alternate spelling

Smoke 脚本会输出实际 response 中 usage 对象的完整 shape，用于确认当前 API 版本的字段名。

---

## 7. 未来启用 raw_content 的前置条件

1. **重新读取** Tavily 当前 Platform Terms / AUP
2. **确认** raw_content（清洗后的 HTML/Markdown）持久化未被禁止
3. **记录** 原始 URL 作为 raw_content 的来源归属
4. **审计** raw_content 是否包含 PII 或敏感内容
5. **限制** raw_content 仅用于 Content Acquisition → FULL_EVIDENCE 路径
6. **更新** 本合规文档

---

## 8. 一致性声明

OfferFlow 在 P0 配置（\`search_depth=basic\`, \`country=china\`, \`include_usage=true\`, \`include_raw_content=false\`）下：
- 不保存 raw_content
- 不保存 images/answer
- 只保存实现产品功能所需的最小 Search Evidence 字段集
- 用户的最终判断满足 Tavily 的人工监督要求
- **严格禁止自动投递、自动就业决策**

此行为与 Tavily 当前 Platform Terms / AUP 一致，但合规是有条件的。

---

> **下一次复查：** 每个 Phase 开始前
> **⚠️ 本检查是 PRELIMINARY — Tavily ToS 可能变更。不替代法律建议。**
`;

  writeFileSync(join(OUTPUT_DIR, 'tavily-compliance.md'), complianceMd, 'utf-8');
  console.log('[T005] tavily-compliance.md generated');

  // Run interactive checks
  console.log('[T002] Checking API Key reachability...');
  const t002 = await t002AuthCheck();
  console.log(`[T002] ${t002.status}: ${t002.errors.length > 0 ? t002.errors.join('; ') : 'OK'}`);

  const t002Status = t002.status as string;

  console.log('[T003] Checking China search availability...');
  const t003 = await t003ChinaSearch(t002Status);
  console.log(`[T003] ${t003.status}: ${t003.errors.length > 0 ? t003.errors.join('; ') : `${(t003.details as Record<string, unknown>)['totalQueries'] ?? '?'} queries, ${((t003.details as Record<string, unknown>)['atLeastOneResult'] ? 'results found' : 'no results')}`}`);

  const t003Status = t003.status as string;

  console.log('[T004] Verifying response contract...');
  const t004 = await t004ContractVerify(t003Status);
  console.log(`[T004] ${t004.status}: ${t004.errors.length > 0 ? t004.errors.join('; ') : `${(t004.details as Record<string, unknown>)['totalResults'] ?? '?'} results analyzed`}`);

  console.log('[T006] Analyzing source domain distribution...');
  const t006 = await t006SourceDiscovery(t003Status);
  console.log(`[T006] ${t006.status}: ${t006.errors.length > 0 ? t006.errors.join('; ') : `${(t006.details as Record<string, unknown>)['totalResults'] ?? '?'} results, ${(t006.details as Record<string, unknown>)['uniqueDomains'] ?? '?'} unique domains`}`);

  console.log('[T007] Observing rate limit / credit usage...');
  const t007 = await t007RateLimit(t002Status);
  console.log(`[T007] ${t007.status}: ${t007.errors.length > 0 ? t007.errors.join('; ') : `${(t007.details as Record<string, unknown>)['singleCreditMatch'] === true ? 'basic=1 credit ✅' : 'credit mismatch'}`}`);

  // Build final report
  const report = generateSmokeReport({
    T002: t002,
    T003: t003,
    T004: t004,
    T005: t005,
    T006: t006,
    T007: t007,
  });

  // Write smoke-report.md
  const querySamples = ((t003.details as Record<string, unknown>)['samples'] as QuerySample[] | undefined) ?? [];
  const fieldCoverage = ((t004.details as Record<string, unknown>)['fields'] as FieldCoverage[] | undefined) ?? [];
  const domainDist = ((t006.details as Record<string, unknown>)['distributions'] as DomainDistribution[] | undefined) ?? [];
  const platformHits = ((t006.details as Record<string, unknown>)['platformHits'] as { platform: string; found: boolean }[] | undefined) ?? [];

  const smokeMd = `# OfferFlow v0.9 — Tavily Integration Smoke Gate Report

> **生成时间：** ${report.meta.generatedAt}
> **API Key 状态：** ${report.meta.tavilyApiKeyAvailable ? '已配置' : '未配置'}
> **报告版本：** ${report.meta.version}

---

## 1. 总体裁决

| 项目 | 结果 |
|------|------|
| **Overall** | **${report.verdict.overall}** |
| **允许进入 Phase 1** | **${report.verdict.allowPhase1 ? '✅ YES' : '❌ NO'}** |
| P0 Provider | Tavily Search API (search endpoint only) |

### 各检查项状态

| Check | Status |
|-------|--------|
| T002 — API Key 可达性 | ${t002.status} |
| T003 — 中国地区搜索 | ${t003.status} |
| T004 — Response Contract | ${t004.status} |
| T005 — Terms/AUP 合规 | ${t005.status} |
| T006 — 招聘平台发现 | ${t006.status} |
| T007 — Rate Limit/Credit | ${t007.status} |

${report.verdict.allowPhase1 ? '' : '### ❌ 阻断原因\n\n' + Object.entries(report.results).filter(([, c]) => c.status === 'FAIL').map(([id, c]) => `- **${id}**: ${c.errors.join('; ')}`).join('\n') + '\n'}

${t005.status === 'PRELIMINARY_PASS_WITH_BOUNDARIES' ? '### ⚠️ T005: PRELIMINARY_PASS_WITH_BOUNDARIES\n\nTavily ToS 合规通过但附带硬边界——OfferFlow MUST NOT：\n- 自动投递\n- 自动投递简历\n- 自动就业决策\n- 绕过人工审查\n\n详见 `tavily-compliance.md` §3 硬边界。\n' : ''}

---

## 2. 查询样本

| City | Direction | Query | Results | Titles |
|------|-----------|-------|---------|--------|
${querySamples.map((s) => `| ${s.city} | ${s.direction} | ${s.query} | ${s.resultCount} | ${s.sampleTitles.slice(0, 3).join('; ') || '(none)'} |`).join('\n')}

---

## 3. 字段覆盖矩阵

| Field | Exists | Type | Non-Empty Rate | Sample |
|-------|--------|------|---------------|--------|
${fieldCoverage.map((f) => `| \`${f.field}\` | ${f.exists} | ${f.type} | ${(f.nonEmptyRate * 100).toFixed(0)}% | ${String(f.sampleValue).slice(0, 80)} |`).join('\n')}

### 字段说明

${fieldCoverage.map((f) => `- **\`${f.field}\`**: ${f.note}`).join('\n')}

---

## 4. 可保存字段 vs 禁止保存字段

### ✅ 可保存 (P0 Search Evidence)

${t005.details && (t005.details as Record<string, unknown>)['savedFields'] ? ((t005.details as Record<string, unknown>)['savedFields'] as string[]).map((f: string) => `- \`${f}\``).join('\n') : '- (see tavily-compliance.md)'}

### ❌ 禁止保存

${t005.details && (t005.details as Record<string, unknown>)['prohibitedFields'] ? ((t005.details as Record<string, unknown>)['prohibitedFields'] as string[]).map((f: string) => `- \`${f}\``).join('\n') : '- raw_content, images, answer, follow_up_questions'}

---

## 5. Source Domain 分布

### 分类汇总

${(() => {
  const summary = (t006.details as Record<string, unknown>)['summary'] as Record<string, number> | undefined;
  if (!summary) return '_数据不可用_';
  return `| Classification | Count |
|----------------|-------|
| Recruitment Platform | ${summary['recruitmentPlatforms'] ?? 0} |
| Company Career | ${summary['companyCareers'] ?? 0} |
| Tech Community | ${summary['techCommunities'] ?? 0} |
| Other | ${summary['other'] ?? 0} |
| Unknown | ${summary['unknown'] ?? 0} |`;
})()}

### 招聘平台发现

| Platform | Discoverable |
|----------|:-----------:|
${platformHits.map((p) => `| ${p.platform} | ${p.found ? '✅ YES' : '❌ NO'} |`).join('\n')}

### Top Domains

| Domain | Count | Classification |
|--------|-------|---------------|
${domainDist.slice(0, 20).map((d) => `| ${d.domain} | ${d.count} | ${d.classification} |`).join('\n')}

---

## 6. Credit Usage

| Metric | Value |
|--------|-------|
| Credits consumed (single basic search) | ${(t007.details as Record<string, unknown>)['singleCredit'] ?? 'N/A'} |
| Credit source field | ${(t007.details as Record<string, unknown>)['creditSourceField'] ?? 'N/A'} |
| Matches expected (basic=1)? | ${(t007.details as Record<string, unknown>)['singleCreditMatch'] === true ? '✅ Yes' : (t007.details as Record<string, unknown>)['singleCreditMatch'] === false ? '⚠️ No — check actual response shape below' : 'N/A'} |
| Actual usage response shape | \`${JSON.stringify((t007.details as Record<string, unknown>)['usageActualShape'] ?? {})}\` |
| Rate limit triggered (5 req / 2.5s)? | ${(t007.details as Record<string, unknown>)['rateLimitedObserved'] === true ? '⚠️ Yes — 需 Token Bucket' : '✅ No'} |

### Credit 字段读取优先级

Provider Adapter 实现时按以下优先级读取 credit 值：
1. \`usage.credits\` — 官方规范字段名 (Tavily API docs 2026)
2. \`usage.credit_used\` — legacy alias
3. \`usage.credits_used\` — alternate spelling

---

## 7. Provider 风险

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| Tavily 中国技术岗位覆盖不足（某些城市/方向） | 中 | Pre-validation 已验证基本覆盖；VALID_EMPTY 显式区分；不为凑数降低标准 |
| Tavily content 字段不足以进入 FULL_EVIDENCE | 中 | Data Quality Gate；MANUAL_REVIEW_REQUIRED 机制；不编造 JD |
| Query 笛卡尔积导致 credit 浪费 | 中 | Query dedupe + budget + high-value selection |
| Tavily Free tier 1,000 credits 长期不够 | 低 | 扩展路径明确（Project \$25/mo）；实际 usage 追踪 |
| BOSS 直聘在搜索结果中出现频次较低 | 中 | 猎聘/智联为主要招聘平台来源；BOSS 通过 Manual Capture 补充 |
| Tavily ToS 未来更新可能影响持久化权限 | 低 | 当前合规；定期复查 |

---

## 8. 剩余风险

${report.verdict.remainingRisks.length > 0
    ? report.verdict.remainingRisks.map((r) => `- ${r}`).join('\n')
    : '_无_'}

---

## 9. 裁决详情

${report.verdict.summary}

### 已知产品风险

${report.verdict.knownRisks.map((r) => `- ${r}`).join('\n')}

---

## 10. Phase 1 前置条件确认

| 条件 | 状态 |
|------|------|
| T002 API Key 可达 | ${t002.status === 'PASS' ? '✅' : '❌'} |
| T003 中国地区搜索 | ${t003.status === 'PASS' ? '✅' : '❌'} |
| T004 Contract 一致性 | ${t004.status === 'PASS' ? '✅' : '❌'} |
| T005 Terms/AUP 合规 | ${(t005.status === 'PRELIMINARY_PASS_WITH_BOUNDARIES' || t005.status === 'PASS') ? '✅ (PRELIMINARY)' : '❌'} |
| T006 招聘平台发现 | ${t006.status === 'PASS' ? '✅' : '❌'} |
| T007 Rate Limit 观测 | ${t007.status === 'PASS' ? '✅' : '❌'} |

**${report.verdict.allowPhase1
    ? '✅ 所有 GATE 通过 — 允许进入 Phase 1 (Schema Migration + Evidence Foundation)'
    : '❌ 存在 FAIL 项 — 停止进入 Phase 1，回到 Provider Decision' + (report.verdict.allowPhase1 ? '' : '\n\n**禁止在 FAIL 后**：降低 Radar 数据质量要求、爬专业招聘平台、根据 snippet 编造完整 JD')}**

${t005.status === 'PRELIMINARY_PASS_WITH_BOUNDARIES' ? '\n> ⚠️ **T005 提醒**：Tavily ToS 合规是 PRELIMINARY + 条件性的。进入 Phase 1 后仍需在每个 Phase 开始前复查人工监督边界是否保持。详见 `tavily-compliance.md`。' : ''}

---

> **输出目录：** \`scripts/provider-validation/output/\`（**本地生成物，已被 .gitignore 忽略**）
> **长期参考：** 关键结论已在本报告中；完整 JSON 在 \`smoke-report.json\`
> **Compliance 文档：** \`scripts/provider-validation/output/tavily-compliance.md\`
> **验证脚本：** \`scripts/provider-validation/tavily-smoke.ts\`
`;

  writeFileSync(join(OUTPUT_DIR, 'smoke-report.md'), smokeMd, 'utf-8');
  console.log('[T008] smoke-report.md generated');

  // Write raw JSON for reference
  writeFileSync(
    join(OUTPUT_DIR, 'smoke-report.json'),
    JSON.stringify(report, null, 2),
    'utf-8',
  );
  console.log('[T008] smoke-report.json generated');

  // Print summary
  console.log('\n══════════════════════════════════════════════');
  console.log(`  Tavily Smoke Gate: ${report.verdict.overall}`);
  console.log(`  Allow Phase 1:     ${report.verdict.allowPhase1 ? 'YES ✅' : 'NO ❌'}`);
  console.log(`  T002: ${t002.status}  T003: ${t003.status}  T004: ${t004.status}`);
  console.log(`  T005: ${t005.status}  T006: ${t006.status}  T007: ${t007.status}`);
  console.log('══════════════════════════════════════════════');
  console.log(`  Output: ${OUTPUT_DIR}/`);
  console.log('══════════════════════════════════════════════\n');

  if (!report.verdict.allowPhase1) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Smoke Gate 执行异常:', err);
  process.exitCode = 1;
});
