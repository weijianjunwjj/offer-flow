# OfferFlow v0.9 搜索 Provider 契约

> **版本：** 1.0  
> **创建日期：** 2026-08-11  

---

## SearchProviderAdapter

```ts
interface SearchProviderAdapter {
  /** Provider 标识（如 'jooble'） */
  readonly providerKey: string;
  
  /** Provider 版本（如 '1.0.0'） */
  readonly providerVersion: string;
  
  /**
   * 执行搜索。
   * @param plan - 当前活跃的 PlanVersion（冻结配置）
   * @param tasks - 展开后的搜索任务列表
   * @param signal - 取消信号
   * @returns 搜索结果 + 覆盖信息
   * 
   * 关键约束：
   * - 不假定返回完整 JD（Jooble 提供的是 snippet）
   * - 完整 API 原始 payload 必须保存到 rawResponse
   * - 不根据 snippet 编造完整 JD
   * - 不为补全 JD 自动去抓专业招聘平台页面
   */
  search(
    plan: DailySearchPlanVersion,
    tasks: SearchTask[],
    signal: AbortSignal
  ): Promise<SearchProviderResult>;
}
```

## SearchTask

```ts
interface SearchTask {
  /** 城市（如 "苏州"） */
  city: string;
  
  /** 岗位方向（如 "前端开发"） */
  roleDirection: string;
  
  /** 搜索关键词（组合了 baseKeyword + expandedKeyword） */
  keyword: string;
  
  /** 薪资过滤（可选） */
  salary?: {
    min?: number;  // 年薪下限（K）
    max?: number;  // 年薪上限（K）
  } | null;
  
  /** 分页（从 1 开始，由 Pipeline 控制） */
  page?: number;
  
  /** Task 唯一键（如 "苏州×前端开发×React"），用于覆盖追踪 */
  taskKey: string;
}
```

## SearchProviderResult

```ts
interface SearchProviderResult {
  /** 搜索返回的岗位条目列表 */
  items: SearchResultItem[];
  
  /** 覆盖信息 */
  coverage: SearchCoverage;
  
  /** Provider 特定元数据 */
  providerMeta: SearchProviderMeta;
}
```

## SearchResultItem

```ts
interface SearchResultItem {
  // === Provider 身份 ===
  /** Provider 标识 */
  providerKey: string;
  /** Provider 版本 */
  providerVersion: string;
  
  // === 岗位定位 ===
  /** 原始岗位 URL（用户可点击查看） */
  sourceUrl: string;
  /** 外部岗位 ID（Provider 内部 ID，如 Jooble 的 `id` 字段） */
  externalRecordId: string;
  
  // === 岗位内容 ===
  /** 岗位标题 */
  title: string;
  /** 公司名 */
  company: string;
  /** 工作地点 */
  location: string;
  /** 薪资文本 */
  salary?: string;
  /** 岗位摘要/描述片段 */
  snippet: string;
  
  // === 来源溯源 ===
  /** 原始来源站名（如 "BOSS 直聘"——Jooble 的 `source` 字段） */
  source: string;
  /** 原始岗位链接（Jooble 的 `link` 字段） */
  link: string;
  /** 更新时间 */
  updated: string;
  
  // === 采集元数据 ===
  /** 采集时间戳 */
  capturedAt: number;
  /** 完整原始响应（写入 Snapshot） */
  rawResponse: unknown;
}
```

## SearchCoverage

```ts
interface SearchCoverage {
  /** 完成的搜索任务数 */
  tasksCompleted: number;
  
  /** 失败的搜索任务数 */
  tasksFailed: number;
  
  /** 等待用户处理的搜索任务数（如登录失效） */
  tasksWaitingForUser: number;
  
  /** 失败范围列表 */
  failedScopes: FailedScope[];
  
  /** 每个 task 的具体结果 */
  taskResults: TaskCoverageResult[];
}

interface TaskCoverageResult {
  taskKey: string;
  status: 'COMPLETED' | 'FAILED' | 'VALID_EMPTY' | 'WAITING_FOR_USER';
  itemsReturned: number;
  pagesFetched: number;
  errorCode?: SearchProviderErrorCode;
  errorMessage?: string;
}

interface FailedScope {
  /** Task 唯一键 */
  taskKey: string;
  /** 错误码 */
  errorCode: SearchProviderErrorCode;
  /** 人类可读消息 */
  message: string;
}
```

## SearchProviderMeta

```ts
interface SearchProviderMeta {
  /** API 请求总数 */
  requestsMade: number;
  
  /** 剩余频率限制（如果有） */
  rateLimitRemaining?: number;
  
  /** 频率限制重置时间（如果有） */
  rateLimitReset?: number;
  
  /** 成本信息（如果 Provider 提供可靠成本数据） */
  cost?: ProviderCost;
}

interface ProviderCost {
  /** 货币单位 */
  currency: string;
  /** 本次消耗金额 */
  amount: number;
  /** 成本来源（如 'provider_api_response' | 'pricing_page'） */
  source: string;
}
```

## SearchProviderErrorCode

```ts
type SearchProviderErrorCode =
  | 'VALID_EMPTY'          // 搜索正常，结果为空（HTTP 200 + 合法 JSON + jobs=[]）
  | 'AUTH_ERROR'           // API Key 无效、过期
  | 'RATE_LIMITED'         // 频率限制
  | 'TIMEOUT'              // 请求超时
  | 'NETWORK_ERROR'        // 网络不可达
  | 'MALFORMED_RESPONSE'   // 响应结构不符合预期
  | 'PROVIDER_UNAVAILABLE' // Provider 服务不可用（5xx）
  | 'ACTION_REQUIRED';     // 需要用户介入（如 API Key 未配置）
```

---

## Jooble Provider（P0 实现）

```ts
class JoobleSearchProvider implements SearchProviderAdapter {
  readonly providerKey = 'jooble';
  readonly providerVersion = '1.0.0';
  
  constructor(
    private readonly secretResolver: () => string,  // 读取 API Key
    private readonly baseUrl = 'https://jooble.org/api',
    private readonly timeout = 30_000,
    private readonly rateLimiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 1,       // 1 token/sec
      refillInterval: 1000,
    }),
  ) {}
  
  async search(
    plan: DailySearchPlanVersion,
    tasks: SearchTask[],
    signal: AbortSignal,
  ): Promise<SearchProviderResult> {
    const apiKey = this.secretResolver();
    const items: SearchResultItem[] = [];
    const taskResults: TaskCoverageResult[] = [];
    const failedScopes: FailedScope[] = [];
    let requestsMade = 0;
    
    for (const task of tasks) {
      if (signal.aborted) break;
      if (requestsMade >= plan.scanBudget.maxTotalPages) break;
      
      const taskResult = await this.executeTask(task, apiKey, signal);
      taskResults.push(taskResult);
      
      requestsMade += taskResult.pagesFetched;
      items.push(...taskResult.items);
      
      if (taskResult.errorCode && taskResult.errorCode !== 'VALID_EMPTY') {
        failedScopes.push({
          taskKey: task.taskKey,
          errorCode: taskResult.errorCode,
          message: taskResult.errorMessage ?? 'Unknown error',
        });
      }
    }
    
    return {
      items,
      coverage: {
        tasksCompleted: taskResults.filter(t => t.status === 'COMPLETED' || t.status === 'VALID_EMPTY').length,
        tasksFailed: taskResults.filter(t => t.status === 'FAILED').length,
        tasksWaitingForUser: taskResults.filter(t => t.status === 'WAITING_FOR_USER').length,
        failedScopes,
        taskResults,
      },
      providerMeta: {
        requestsMade,
      },
    };
  }
}
```

### Jooble API 请求/响应

**Request** (POST `https://jooble.org/api/<API_KEY>`):
```json
{
  "keywords": "前端 React TypeScript",
  "location": "苏州",
  "radius": 50,
  "salary": 150000,
  "page": 1,
  "ResultOnPage": 20,
  "SearchMode": 0
}
```

**Response** (200):
```json
{
  "jobs": [
    {
      "id": "200820851236175312",
      "title": "高级前端开发工程师",
      "company": "某科技有限公司",
      "location": "苏州",
      "salary": "15K-25K",
      "snippet": "负责Web前端开发，使用React、TypeScript...",
      "source": "BOSS 直聘",
      "type": "full-time",
      "link": "https://www.zhipin.com/job_detail/xxx.html",
      "updated": "2026-08-10T12:00:00.000"
    }
  ],
  "totalCount": 42
}
```

**重要**：官方 API 返回的文本内容主要是 `snippet`（岗位摘要），**不是完整 JD**。见 Plan §2.2 Data Quality Gate。

### Jooble 字段映射到 SearchResultItem

| Jooble 字段 | SearchResultItem 字段 | 说明 |
|-------------|----------------------|------|
| `id` | `externalRecordId` | Provider 内部唯一标识 |
| `title` | `title` | 岗位标题 |
| `company` | `company` | 公司名 |
| `location` | `location` | 工作地点 |
| `salary` | `salary` | 薪资文本（由后续标准化解析为 minK/maxK） |
| `snippet` | `snippet` | **岗位摘要（Snippet，非完整 JD）**——作为 visibleText 主要来源 |
| `source` | `source` | 原始来源站名（provenance） |
| `type` | 写入 Snapshot metadata | 岗位类型（full-time 等） |
| `link` | `link` / `sourceUrl` | 原始岗位链接 |
| `updated` | `updated` | 更新时间 |
| 完整 jobs 条目 | `rawResponse` | 写入 Snapshot 的原始 JSON |

---

## IngestionInput（Provider → RadarIngestionService）

Provider 的 `SearchResultItem` 转换到 `RadarIngestionInput` 后进入共享 Ingestion Core：

```ts
interface RadarIngestionInput {
  providerKey: string;           // 'jooble'
  providerVersion: string;       // '1.0.0'
  externalRecordId: string;      // Jooble `id`
  sourceUrl: string;             // Jooble `link`
  sourceDomain: string | null;   // 从 link 解析
  
  visibleText: string;           // title + company + location + salary + snippet 拼合（主要文本来源：snippet，非完整 JD）
  pageTitle: string | null;      // title
  
  recognizedFields: Partial<RadarCandidateNormalized> | null;  // title/company/location/salary 映射
  extractionMetadata: unknown;   // rawResponse
  
  capturedAt: number;
  
  captureSessionId: null;        // Active Discovery 无 session
  captureMethod: 'api_discovery'; // 新 capture_method
}
```
