/**
 * OfferFlow v0.9 — Tavily 最小生产 Smoke（走真实生产 Adapter 路径）。
 *
 * 目标：只回答 Tavily credential / endpoint / quota 是否真实可用。
 *
 * 复用生产组件，不新造第二套 Tavily client：
 *   - loadProjectEnv() 读取 repository-root .env.local（.env 先、.env.local 覆盖）
 *   - EnvSecretStore.resolve('env:TAVILY_API_KEY') 解析凭据
 *   - TavilySearchProvider.search() 走真实生产 adapter
 *
 * 只做最少真实调用：1 个 control query +（control 成功后）1 个岗位 query。
 * 绝不重跑 DailySearchPlan、绝不跑 30 queries。
 *
 * 安全输出：只打印 provider / classification / success / resultCount /
 * coverage（query 级计数 + normalized errorCode）。绝不打印 API key、Authorization、
 * 完整 raw response、raw_content 或完整 snippet。
 *
 * 运行：npx tsx scripts/provider-validation/tavily-production-smoke.ts
 */

import { loadProjectEnv } from '../../server/config/loadEnv';
import { EnvSecretStore } from '../../server/secret/EnvSecretStore';
import { TavilySearchProvider } from '../../server/search-provider/tavily/TavilySearchProvider';
import type {
  SearchProviderErrorCode,
  SearchQuery,
} from '../../server/search-provider/types';

loadProjectEnv();

const CONTROL_QUERY = 'OpenAI';
const TARGET_QUERY = '无锡 高级前端 Vue3 Node.js 招聘';
const CONTROL_MAX_RESULTS = 1;
const TARGET_MAX_RESULTS = 3;

function makeQuery(query: string, queryKey: string): SearchQuery {
  return { query, queryKey, city: '', roleDirection: '', keyword: '', keywordSource: 'base' };
}

/** 归一化 errorCode → 大类（绝不打印 provider error body / secret）。 */
function classifyError(errorCode: SearchProviderErrorCode | undefined): {
  classification: 'AUTH_FAILURE' | 'QUOTA_OR_RATE_LIMIT' | 'NETWORK_OR_PROVIDER' | 'MALFORMED_RESPONSE';
  code: string;
} {
  switch (errorCode) {
    case 'AUTH_ERROR':
      return { classification: 'AUTH_FAILURE', code: 'AUTH_ERROR' };
    case 'USAGE_LIMIT':
    case 'RATE_LIMITED':
      return { classification: 'QUOTA_OR_RATE_LIMIT', code: errorCode };
    case 'MALFORMED_RESPONSE':
      return { classification: 'MALFORMED_RESPONSE', code: errorCode };
    case 'TIMEOUT':
    case 'NETWORK_ERROR':
    case 'PROVIDER_UNAVAILABLE':
    default:
      return { classification: 'NETWORK_OR_PROVIDER', code: errorCode ?? 'UNKNOWN' };
  }
}

interface SmokeOutcome {
  label: string;
  success: boolean;
  resultCount: number;
  queriesCompleted: number;
  queriesFailed: number;
  errorCode: string | null;
  errorClassification: string | null;
}

async function runSingleQuery(
  label: string,
  queryText: string,
  queryKey: string,
  maxResults: number,
): Promise<SmokeOutcome> {
  const provider = new TavilySearchProvider({
    apiKeyResolver: () => new EnvSecretStore().resolve('env:TAVILY_API_KEY'),
    defaultMaxResults: maxResults,
  });
  const controller = new AbortController();

  try {
    const result = await provider.search({
      queries: [makeQuery(queryText, queryKey)],
      config: { maxResults },
      signal: controller.signal,
    });

    const qr = result.coverage.queryResults[0];
    const failed = result.coverage.queriesFailed > 0;
    const errorCode = failed ? (qr?.errorCode ?? null) : null;
    return {
      label,
      success: !failed,
      resultCount: result.items.length,
      queriesCompleted: result.coverage.queriesCompleted,
      queriesFailed: result.coverage.queriesFailed,
      errorCode,
      errorClassification: errorCode === null ? null : classifyError(errorCode).classification,
    };
  } catch (err) {
    // 凭据缺失/解析异常在 searchSingle 的 apiKeyResolver() 处抛出（非 provider error code）。
    const message = err instanceof Error ? err.message : String(err);
    const missingKey = /not set or empty/i.test(message);
    return {
      label,
      success: false,
      resultCount: 0,
      queriesCompleted: 0,
      queriesFailed: 1,
      errorCode: missingKey ? 'AUTH_ERROR' : 'RESOLVER_ERROR',
      errorClassification: missingKey ? 'AUTH_FAILURE' : 'NETWORK_OR_PROVIDER',
    };
  }
}

/** control query 结果 → PART A4 的 CASE 1~5。 */
function classifyControl(outcome: SmokeOutcome): string {
  if (!outcome.success) {
    switch (outcome.errorClassification) {
      case 'AUTH_FAILURE':
        return 'CASE 3: AUTH_FAILURE';
      case 'QUOTA_OR_RATE_LIMIT':
        return 'CASE 4: QUOTA/RATE_LIMIT FAILURE';
      default:
        return 'CASE 5: NETWORK/TIMEOUT/PROVIDER ERROR';
    }
  }
  return outcome.resultCount > 0
    ? 'CASE 1: CONTROL_QUERY_SUCCESS (resultCount > 0)'
    : 'CASE 2: CONTROL_QUERY_SUCCESS (resultCount = 0)';
}

async function main(): Promise<void> {
  console.log('[smoke] provider=tavily');
  console.log('[smoke] control query running...');

  const control = await runSingleQuery('control', CONTROL_QUERY, 'control×OpenAI', CONTROL_MAX_RESULTS);
  const controlClass = classifyControl(control);
  console.log(`[smoke] CONTROL_QUERY_STATUS = ${control.success ? 'SUCCESS' : 'FAILURE'}`);
  console.log(`[smoke] CONTROL_QUERY_RESULT_COUNT = ${control.resultCount}`);
  console.log(`[smoke] CONTROL_QUERY_ERROR_CODE = ${control.errorCode ?? 'n/a'}`);
  console.log(`[smoke] CONTROL_QUERY_CLASSIFICATION = ${control.errorClassification ?? 'n/a'}`);
  console.log(`[smoke] CONTROL_QUERY_VERDICT = ${controlClass}`);

  if (!control.success) {
    console.log(`[smoke] TARGET_QUERY_STATUS = SKIPPED (control 未成功，不做第二个 query)`);
    console.log('[smoke] PROVIDER_ACCOUNT_GATE = BLOCKED');
    return;
  }

  console.log('[smoke] target query running...');
  const target = await runSingleQuery('target', TARGET_QUERY, '无锡×高级前端×Vue3Node', TARGET_MAX_RESULTS);
  console.log(`[smoke] TARGET_QUERY_STATUS = ${target.success ? 'SUCCESS' : 'FAILURE'}`);
  console.log(`[smoke] TARGET_QUERY_RESULT_COUNT = ${target.resultCount}`);
  console.log(`[smoke] TARGET_QUERY_ERROR_CODE = ${target.errorCode ?? 'n/a'}`);
  console.log(`[smoke] TARGET_QUERY_CLASSIFICATION = ${target.errorClassification ?? 'n/a'}`);

  const gate = control.success ? 'PASS' : 'BLOCKED';
  console.log(`[smoke] PROVIDER_ACCOUNT_GATE = ${gate}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // 绝不打印 err.stack / 请求体；只输出归一化原因分类。
  console.error('[smoke] 未预期错误:', /not set or empty/i.test(message) ? 'AUTH_ERROR(凭据缺失)' : 'UNEXPECTED');
  process.exitCode = 1;
});
