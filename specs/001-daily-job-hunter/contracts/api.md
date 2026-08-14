# OfferFlow v0.9 API Contracts

> **Source**: `specs/001-daily-job-hunter/plan.md`  
> **版本：** 2.0  
> **创建日期：** 2026-08-11  
> **最后修订：** 2026-08-11（Plan Amendment：SearchPlan providerKey 更新，DailyJobBrief 新增 discoveryItems，SourceRun 更新）

本文档记录 v0.9 新增 API 的契约定义。所有路径沿用现有**无 `/api` 前缀**约定（与 `/daily-search-plans`、`/daily-job-briefs` 一致），Fastify + Origin 保护。

---

## 1. SearchPlan（providerKey 更新）

### `POST /daily-search-plans`

创建新的每日找岗计划。

**Request Body**:
```json
{
  "name": "每日前端岗位",
  "cities": [
    { "name": "苏州", "priority": 1 },
    { "name": "无锡", "priority": 2 }
  ],
  "roleDirections": ["前端开发", "全栈开发"],
  "baseKeywords": ["React", "TypeScript"],
  "sourceConfigs": [
    { "providerKey": "tavily", "searchDepth": "basic", "country": "china", "enabled": true }
  ],
  "schedule": {
    "dailyAt": "09:00"
  },
  "scanBudget": {
    "maxQueriesPerRun": 30
  },
  "analysisBudget": {
    "maxAnalysesPerRun": 5
  },
  "notificationPolicy": {
    "highPriorityEnabled": true,
    "dailyBriefEnabled": true,
    "failureNoticeEnabled": true
  }
}
```

**Response** (201): 同旧 Plan。

**其他 SearchPlan 端点**（GET、versions、activate、pause、resume、run-now、skip-today）：同旧 Plan。主要变化：`sourceConfigs` 的 `providerKey` 现在是 `'tavily'`。

---

## 2. SourceRun（T030 只读观测 API）

### `GET /source-runs`

列出 SourceRun，支持过滤，始终有界（默认 `limit=50`，上限 100）。

**Query（均可选）：**

| 参数 | 说明 |
|------|------|
| `planId` | 按 `search_plan_id` 精确过滤 |
| `status` | 按运行状态过滤（PENDING/RUNNING/WAITING_FOR_USER/PARTIALLY_SUCCEEDED/SUCCEEDED/FAILED/CANCELLED/INTERRUPTED） |
| `triggerType` | SCHEDULED / CATCH_UP / MANUAL / RETRY |
| `day` | 按 `scheduledDay`（YYYY-MM-DD）精确过滤 |
| `limit` | 1..100，默认 50 |

**Response** (200):
```json
{
  "runs": [
    {
      "id": "sr_xyz789",
      "searchPlanId": "dsp_abc",
      "searchPlanVersionId": "dspv_v1_abc",
      "searchPlan": { "id": "dsp_abc", "name": "每日前端岗位", "versionId": "dspv_v1_abc" },
      "sourceKey": "tavily",
      "sourceVersion": "1.0.0",
      "triggerType": "SCHEDULED",
      "retryOfRunId": null,
      "status": "SUCCEEDED",
      "phase": "BUILDING_BRIEF",
      "scheduledDay": "2026-08-14",
      "scheduledFor": 1755014400000,
      "startedAt": 1755014401000,
      "finishedAt": 1755014450000,
      "queriesAttempted": 24,
      "queriesSucceeded": 22,
      "queriesFailed": 2,
      "resultsDiscovered": 85,
      "relevantResults": 60,
      "newCount": 0,
      "changedCount": 0,
      "duplicateCount": 0,
      "conflictCount": 0,
      "blockedCount": 0,
      "searchEvidencePersisted": 45,
      "manualReviewRequired": 20,
      "fullEvidenceCount": 15,
      "analysisEligibleCount": 15,
      "analysisRequestedCount": 10,
      "analysisSucceededCount": 10,
      "selectedCount": 5,
      "alertedCount": 0,
      "failedCount": 2,
      "estimatedSearchCredits": 24,
      "actualSearchCredits": 22,
      "coverage": {
        "queriesCompleted": 22,
        "queriesFailed": 2,
        "failedScopes": [
          { "queryKey": "苏州×AI前端", "errorCode": "VALID_EMPTY" }
        ]
      },
      "errorCode": null,
      "errorMessage": null,
      "createdAt": 1755014400000,
      "updatedAt": 1755014450000
    }
  ],
  "total": 1
}
```

### `GET /source-runs/:id`

单次运行详情，含最小关联（`searchPlan` + `dailyBrief`）。

**Response** (200):
```json
{
  "run": { "...同列表 SourceRun 视图..." },
  "dailyBrief": {
    "id": "djb_20260811",
    "briefDate": "2026-08-14",
    "status": "READY"
  }
}
```

`dailyBrief` 为 `null` 表示该 run 尚未关联任何简报。

**关键约束（read-only）：**
- `phase`/`status` 只透出真实持久化值，不在 route 中重新计算
- `searchPlan` 按 `searchPlanVersionId → Version.searchPlanId → Plan.name` 精确解析（历史版本仍可解析，不猜 activeVersionId）
- `errorCode`/`errorMessage` 是持久化字段，失败时可透出安全诊断信息
- `coverage.failedScopes` 只透出 `queryKey` + `errorCode`，不透出 provider error detail / queryResults
- 不暴露 `progressJson` / `costSummaryJson` 等内部 raw JSON、完整 provider payload 或内部 hash
- 本 API 无写端点：不启动 Pipeline / retry / Run Now / 创建 Brief / 触发 Scheduler（属 T032）

---

## 3. DailyJobBrief（新增 discoveryItems）

### `GET /daily-job-briefs`

列出 DailyJobBrief，按日期降序。

**Response** (200):
```json
{
  "briefs": [
    {
      "id": "djb_20260811",
      "briefDate": "2026-08-11",
      "searchPlanVersionId": "dspv_v1_abc",
      "searchPlan": { "id": "dsp_abc", "name": "每日前端岗位", "versionId": "dspv_v1_abc" },
      "sourceRunIds": ["sr_xyz789"],
      "recommendationBatchId": "rb_batch_001",
      "discoveryItemIds": ["rcv_006_v1"],
      "status": "READY",
      "coverage": { ... },
      "costSummaryJson": null,
      "emptyReason": null,
      "generatedAt": 1755014500000,
      "completedAt": null,
      "createdAt": 1755014400000,
      "updatedAt": 1755014500000
    }
  ],
  "total": 1
}
```

> `searchPlan` 由 `searchPlanVersionId` 精确解析（`{ id, name, versionId }`），版本/计划缺失时为 `null`；`costSummaryJson` 为 `null` 表示 cost summary 尚未计算（T043 再补充）。

### `GET /daily-job-briefs/:id`

获取单份 Brief 详情。包含正式推荐展开（`recommendationItems`）和 supplementary 发现条目（`discoveryItems`）。

**Response** (200):
```json
{
  "brief": {
    "id": "djb_20260811",
    "briefDate": "2026-08-11",
    "searchPlanVersionId": "dspv_v1_abc",
    "searchPlan": { "id": "dsp_abc", "name": "每日前端岗位", "versionId": "dspv_v1_abc" },
    "sourceRunIds": ["sr_xyz789"],
    "recommendationBatchId": "rb_batch_001",
    "discoveryItemIds": ["rcv_006_v1"],
    "status": "READY",
    "coverage": { ... },
    "costSummaryJson": null,
    "emptyReason": null,
    "generatedAt": 1755014500000,
    "completedAt": null,
    "createdAt": 1755014400000,
    "updatedAt": 1755014500000
  },
  "recommendationBatch": { ... },
  "recommendationItems": [
    {
      "candidateId": "rc_001",
      "candidateVersionId": "rcv_001_v1",
      "evidenceLevel": "FULL_EVIDENCE",
      "title": "高级前端开发工程师",
      "company": "某科技有限公司",
      "city": "苏州",
      "sourceUrl": "https://www.zhipin.com/job_detail/xxx.html",
      "sourceDomain": "zhipin.com",
      "provider": "tavily",
      "kind": "recommend",
      "priority": 1,
      "confidence": "medium",
      "rationale": "...",
      "conditions": [...],
      "evidenceRefs": [...]
    }
  ],
  "discoveryItems": [
    {
      "candidateId": "rc_006",
      "candidateVersionId": "rcv_006_v1",
      "evidenceLevel": "MANUAL_REVIEW_REQUIRED",
      "title": "高级前端开发工程师",
      "company": "某科技有限公司",
      "city": "苏州",
      "sourceUrl": "https://www.zhipin.com/job_detail/xxx.html",
      "sourceDomain": "zhipin.com",
      "provider": "tavily"
    }
  ]
}
```

**关键约束：**
- `recommendationItems` 是唯一正式推荐集合的展开视图（FULL_EVIDENCE 候选，0-8），按 `Recommendation.candidateVersionId` 精确读取岗位身份，不猜 latest/activeVersionId
- `discoveryItems` 是 supplementary 发现条目（SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED）——不是第二套推荐
- `discoveryItems` 不经过 MatchAnalysis（无 `analysisRecordId`、无 `recommendation`、`evidenceRefs` 等）
- `recommendationBatch` 仍是唯一正式推荐集合的原始契约

### `GET /daily-job-briefs/today` 和 `POST .../complete`

同旧 Plan。

> **`/today` product-day timezone（v0.9 口径）：** 「today」按 **Asia/Shanghai** 计算（`todayInTimeZone(now, DEFAULT_TIMEZONE)`），响应回显 `briefDate`。v0.9 Scheduler 的 officially supported timezone 收敛为 Asia/Shanghai；`DailySearchPlanVersion.schedule.timezone` 仍保存显式 IANA 值作为未来扩展 contract，但 `/today` 当前**不**按各 PlanVersion timezone 动态解析、也不承诺完整多 IANA timezone 支持。此口径已与 T041 实现一致，无需架构裁决。

---

## 4. JobJudgment（保持，新增 evidenceLevel context）

### `POST /daily-job-briefs/:briefId/items/:candidateId/judgment`

创建四档判断。**请求**同旧 Plan。**响应**新增 evidenceLevel context：

```json
{
  "judgment": {
    "id": "jj_001",
    "...": "...",
    "candidateEvidenceLevel": "FULL_EVIDENCE"
  }
}
```

`candidateEvidenceLevel` 用于前端区分：FULL_EVIDENCE → 正常审批；SEARCH_EVIDENCE → 提示"信息不足"但仍可判断。

### `PATCH /job-judgments/:id`、`DELETE /job-judgments/:id`、`POST .../reason`

同旧 Plan。

---

## 5. Preference（保持）

同旧 Plan。API 响应中新增 `evidenceLevel` context 在必要时展示。

---

## 6. Notification（保持）

同旧 Plan。Secret 引用 `TAVILY_API_KEY`（替换 `OFFERFLOW_JOOLE_API_KEY`）。

---

## 7. Local Service / Scheduler（保持）

同旧 Plan。

---

## 8. 安全与错误约定

同旧 Plan。新增：
- 禁止在 API 响应中暴露 `TAVILY_API_KEY`
- 禁止在 API 响应中暴露 Tavily raw response metadata（`providerMetadata` 只在内部使用，API 不对外）
- SourceRun coverage 中 `failedScopes` 不暴露 Provider error detail（仅 errorCode）
- `discoveryItems[].sourceUrl` 通过 HTTP/HTTPS 白名单校验后返回

### 不定义的路由

保持旧 Plan + 新增：
- `GET /discovery-items` — discovery items 通过 DailyBrief API 获取，不独立暴露
- `POST /content-acquisition/...` — Content Acquisition 是 Pipeline 内部步骤，不暴露独立 API

---

## 9. API 字段新增汇总

| Endpoint | 新增字段 | 说明 |
|----------|---------|------|
| `GET /daily-job-briefs/:id` | `recommendationItems[]` | 正式推荐展开视图（FULL_EVIDENCE，0-8） |
| `GET /daily-job-briefs` / `:id` | `searchPlan` | `{ id, name, versionId }` plan 身份解析 |
| `GET /daily-job-briefs/:id` | `discoveryItems[]` | SEARCH_EVIDENCE/MANUAL_REVIEW_REQUIRED 发现条目 |
| `GET /daily-job-briefs/:id` | `discoveryItems[].evidenceLevel` | SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED |
| `GET /source-runs` | `queriesAttempted` 等 | 替换 Jooble-specific 字段 |
| `GET /source-runs` | `estimatedSearchCredits` / `actualSearchCredits` | Cost visibility |
| `GET /source-runs` | `searchEvidencePersisted` / `manualReviewRequired` / `fullEvidenceCount` | Evidence breakdown |
| `GET /source-runs/:id` | `dailyBrief` | 最小 DailyBrief 关联（id/briefDate/status） |
| POST judgment response | `candidateEvidenceLevel` | 前端区分信息完整度 |
