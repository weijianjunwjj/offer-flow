# OfferFlow v0.9 搜索 Provider 契约

> **版本：** 2.0  
> **创建日期：** 2026-08-11  
> **最后修订：** 2026-08-11（Plan Amendment：Jooble → Tavily Search API，重新设计 Provider-neutral Search contract）

---

## Design Principle

核心 contract 是 Provider-neutral 的。Tavily-specific DTO 只能存在于 Adapter mapping section。业务层不直接消费 `TavilySearchResult`。

---

## SearchProviderAdapter

```ts
interface SearchProviderAdapter {
  /** Provider 标识（如 'tavily'） */
  readonly providerKey: string;
  
  /** Provider 版本（如 '1.0.0'） */
  readonly providerVersion: string;
  
  /**
   * 执行搜索。
   * @param plan - 当前活跃的 PlanVersion（冻结配置）
   * @param queries - 展开后的搜索查询列表
   * @param signal - 取消信号
   * @returns Search Evidence + 覆盖信息
   * 
   * 关键约束：
   * - 不假定返回完整 JD（Tavily content 为搜索摘要）
   * - 完整 Provider raw response 保存到 providerMetadata
   * - Content Acquisition 是后续独立步骤，由 Source Policy 触发
   * - 不在 Search Provider 层建立招聘平台域名 exclude
   */
  search(
    plan: DailySearchPlanVersion,
    queries: SearchQuery[],
    signal: AbortSignal
  ): Promise<SearchProviderResult>;
}
```

## SearchQuery

```ts
interface SearchQuery {
  /** 组合后的搜索词（如 "苏州 前端工程师 招聘"） */
  query: string;
  
  /** Query 唯一键（如 "苏州×前端开发×React"），用于覆盖追踪 */
  queryKey: string;
  
  /** 城市 */
  city: string;
  
  /** 岗位方向 */
  roleDirection: string;
  
  /** 基础关键词 */
  keyword: string;
  
  /** 关键词来源 */
  keywordSource: 'base' | 'expanded';
}
```

## SearchProviderResult

```ts
interface SearchProviderResult {
  /** Search Evidence 条目列表 */
  items: SearchEvidenceItem[];
  
  /** 覆盖信息 */
  coverage: SearchCoverage;
  
  /** Provider 特定元数据 */
  providerMeta: SearchProviderMeta;
}
```

## SearchEvidenceItem（Provider-neutral）

```ts
/**
 * Provider-neutral Search Evidence。基于 Tavily/Brave 共同最小语义设计，
 * 不绑定任何单一 Provider DTO。Tavily-specific mapping 在 Adapter 内完成。
 */
interface SearchEvidenceItem {
  // === 搜索溯源 ===
  /** Search Provider 标识 */
  provider: string;               // 'tavily'
  /** 搜索查询词 */
  query: string;
  /** Provider request/trace ID（如有） */
  providerRequestId?: string;
  
  // === 结果内容 ===
  /** 结果标题 */
  title: string;
  /** 结果 URL */
  url: string;
  /** 搜索摘要/内容片段（Provider Output，非完整 JD） */
  content: string;
  /** 来源域名（从 url 解析） */
  domain: string;
  
  // === Provider 评分 ===
  /** Provider 相关性评分（如有） */
  providerScore?: number;
  /** 发布时间（如有） */
  publishedAt?: string;
  
  // === 采集元数据 ===
  /** 搜索时间戳 */
  searchedAt: number;
  
  // === Source Policy 判定 ===
  /** 来源策略分类（由 Source Policy 判定） */
  sourcePolicy: 'SEARCH_ONLY' | 'SEARCH_AND_FETCH' | 'CONDITIONAL_FETCH';
  /** 证据等级（初始 = SEARCH_EVIDENCE） */
  evidenceLevel: 'SEARCH_EVIDENCE' | 'FULL_EVIDENCE' | 'MANUAL_REVIEW_REQUIRED';
  
  /** Provider 特定元数据（必要最小，不包含完整 raw response 的冗余字段） */
  providerMetadata?: Record<string, unknown>;
}
```

**关键约束：**
- `content` 是 Provider Output（搜索摘要），不假定为完整 JD
- `evidenceLevel` 初始 = `SEARCH_EVIDENCE`；只有 Content Acquisition 成功或 Manual Capture 后才升级为 `FULL_EVIDENCE`
- Tavily-specific 字段（如 `images`, `answer`, `raw_content`）不进入此类型

---

## SearchCoverage

```ts
interface SearchCoverage {
  /** 完成的查询数 */
  queriesCompleted: number;
  
  /** 失败的查询数 */
  queriesFailed: number;
  
  /** 失败范围列表 */
  failedScopes: FailedScope[];
  
  /** 每个 query 的具体结果 */
  queryResults: QueryCoverageResult[];
}

interface QueryCoverageResult {
  queryKey: string;
  status: 'COMPLETED' | 'FAILED' | 'VALID_EMPTY';
  resultsReturned: number;
  errorCode?: SearchProviderErrorCode;
  errorMessage?: string;
}

interface FailedScope {
  /** Query 唯一键 */
  queryKey: string;
  /** 错误码 */
  errorCode: SearchProviderErrorCode;
  /** 人类可读消息 */
  message: string;
}
```

---

## SearchProviderMeta

```ts
interface SearchProviderMeta {
  /** API 请求总数 */
  requestsMade: number;
  
  /** 消耗的 credits（如 Provider 返回） */
  creditsUsed?: number;
  
  /** 剩余频率限制（如有） */
  rateLimitRemaining?: number;
  
  /** 频率限制重置时间（如有） */
  rateLimitReset?: number;
  
  /** 成本信息（如有可靠数据） */
  cost?: ProviderCost;
}

interface ProviderCost {
  /** 货币单位 */
  currency: string;
  /** 本次消耗金额 */
  amount: number;
  /** 成本来源（如 'provider_api_response'） */
  source: string;
}
```

---

## SearchProviderErrorCode

```ts
type SearchProviderErrorCode =
  | 'VALID_EMPTY'          // 搜索正常，结果为空（HTTP 200 + 合法 JSON + results=[]）
  | 'AUTH_ERROR'           // API Key 无效、过期（401）
  | 'RATE_LIMITED'         // 频率限制（429）
  | 'USAGE_LIMIT'          // 月度额度耗尽（432 Usage Limit Exceeded）
  | 'TIMEOUT'              // 请求超时
  | 'NETWORK_ERROR'        // 网络不可达
  | 'MALFORMED_RESPONSE'   // 响应结构不符合预期
  | 'PROVIDER_UNAVAILABLE' // Provider 服务不可用（5xx）
```

**核心原则**：`VALID_EMPTY`（API 请求成功 + 响应有效 + results=[]）与所有其他错误严格区分。禁止 `catch(...) { return [] }` 吞异常。

---

## Tavily Provider（P0 实现）

### Tavily-specific Adapter（仅此 section 包含 Tavily-specific 类型）

```ts
class TavilySearchProvider implements SearchProviderAdapter {
  readonly providerKey = 'tavily';
  readonly providerVersion = '1.0.0';
  
  constructor(
    private readonly secretResolver: () => string,  // → 'tvly-<key>'
    private readonly baseUrl = 'https://api.tavily.com',
    private readonly timeout = 30_000,
    private readonly rateLimiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 1,
      refillInterval: 1000,
    }),
  ) {}
  
  async search(
    plan: DailySearchPlanVersion,
    queries: SearchQuery[],
    signal: AbortSignal,
  ): Promise<SearchProviderResult> {
    // 对每个 query 调用 POST /search
    // Tavily response → SearchEvidenceItem[] mapping
    // 见下方字段映射
  }
}
```

### Tavily API 请求/响应

**Request** (POST `https://api.tavily.com/search`):
```json
{
  "query": "苏州 前端工程师 招聘",
  "search_depth": "basic",
  "topic": "general",
  "country": "china",
  "max_results": 10,
  "include_answer": false,
  "include_raw_content": false
}
```

**Response** (200):
```json
{
  "query": "苏州 前端工程师 招聘",
  "results": [
    {
      "title": "高级前端开发工程师",
      "url": "https://www.zhipin.com/job_detail/xxx.html",
      "content": "负责Web前端开发，使用React、TypeScript...（搜索摘要）",
      "score": 0.85,
      "raw_content": null
    }
  ],
  "response_time": 0.45,
  "images": [],
  "usage": {
    "credit_used": 1
  }
}
```

### Tavily → SearchEvidenceItem 字段映射（Adapter boundary）

| Tavily Field | SearchEvidenceItem Field | Notes |
|-------------|------------------------|-------|
| (provider constant) | `provider` | `'tavily'` |
| `query` | `query` | 回显 |
| `results[].title` | `title` | |
| `results[].url` | `url` | |
| `results[].content` | `content` | Provider Output（搜索摘要） |
| domain from `url` | `domain` | 解析 |
| `results[].score` | `providerScore` | |
| `results[].published_date` | `publishedAt`（如有） | Optional |
| Server timestamp | `searchedAt` | |
| (Source Policy 判定) | `sourcePolicy` | Adapter 不判定——由 Source Policy 服务判定后注入 |
| (初始 = SEARCH_EVIDENCE) | `evidenceLevel` | 初始值 |
| `{ response_time, query }` | `providerMetadata` | 必要最小 |

**不映射（P0）的 Tavily fields：** `answer`、`images`、`raw_content`、`follow_up_questions`

---

## IngestionInput（Provider → RadarIngestionService）

Provider 的 `SearchEvidenceItem` 转换到 `RadarIngestionInput`：

```ts
interface RadarIngestionInput {
  // Provider identity
  providerKey: string;              // 'tavily'
  providerVersion: string;          // '1.0.0'
  externalRecordId: string | null;  // url（用于去重）
  sourceUrl: string;                // url
  sourceDomain: string | null;      // domain
  
  // Content
  visibleText: string;              // content（Provider Output）
  pageTitle: string | null;         // title
  
  // Structured
  recognizedFields: Partial<RadarCandidateNormalized> | null;  // 从 title/content 解析
  extractionMetadata: unknown;      // SearchEvidenceItem 完整结构（含 providerScore、query、sourcePolicy）
  
  // Evidence
  evidenceLevel: 'SEARCH_EVIDENCE' | 'FULL_EVIDENCE' | 'MANUAL_REVIEW_REQUIRED';
  sourcePolicy: 'SEARCH_ONLY' | 'SEARCH_AND_FETCH' | 'CONDITIONAL_FETCH';
  
  // Metadata
  capturedAt: number;
  captureSessionId: null;
  captureMethod: 'search_discovery' | 'open_web_fetch';
}
```

**`captureMethod` 判定：**
- `SearchEvidenceItem.evidenceLevel === 'SEARCH_EVIDENCE'` → `'search_discovery'`
- `SearchEvidenceItem.evidenceLevel === 'FULL_EVIDENCE'`（Content Acquisition 成功）→ `'open_web_fetch'`
