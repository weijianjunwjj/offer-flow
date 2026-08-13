# OfferFlow v0.9 API Contracts

> **Source**: `specs/001-daily-job-hunter/plan.md`  
> **版本：** 2.0  
> **创建日期：** 2026-08-11  
> **最后修订：** 2026-08-11（Plan Amendment：SearchPlan providerKey 更新，DailyJobBrief 新增 discoveryItems，SourceRun 更新）

本文档记录 v0.9 新增 API 的契约定义。所有路径遵循现有 `/api/*` 约定，沿用 Fastify + loopback + Origin 保护。

---

## 1. SearchPlan（providerKey 更新）

### `POST /api/daily-search-plans`

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

## 2. SourceRun（Provider-neutral 更新）

### `GET /api/source-runs`

列出 SourceRun，支持过滤。

**Response** (200):
```json
{
  "runs": [
    {
      "id": "sr_xyz789",
      "searchPlanVersionId": "dspv_v1_abc",
      "sourceKey": "tavily",
      "sourceVersion": "1.0.0",
      "triggerType": "SCHEDULED",
      "status": "SUCCEEDED",
      "phase": "BUILDING_BRIEF",
      "scheduledFor": 1755014400000,
      "startedAt": 1755014401000,
      "finishedAt": 1755014450000,
      "queriesAttempted": 24,
      "queriesSucceeded": 22,
      "queriesFailed": 2,
      "resultsDiscovered": 85,
      "relevantResults": 60,
      "searchEvidencePersisted": 45,
      "manualReviewRequired": 20,
      "fullEvidenceCount": 15,
      "analysisRequestedCount": 10,
      "analysisSucceededCount": 10,
      "selectedCount": 5,
      "estimatedSearchCredits": 24,
      "actualSearchCredits": 22,
      "coverageSummary": {
        "completedQueries": 22,
        "failedQueries": 2,
        "failedScopes": [
          { "queryKey": "苏州×AI前端", "errorCode": "VALID_EMPTY" }
        ]
      },
      "costSummary": {
        "estimatedSearchCredits": 24,
        "actualSearchCredits": 22,
        "analysisRequests": 10,
        "model": "deepseek-chat"
      }
    }
  ],
  "total": 1
}
```

### `GET /api/source-runs/:id` 和操作端点

同旧 Plan。响应格式为 Provider-neutral 结构。

---

## 3. DailyJobBrief（新增 discoveryItems）

### `GET /api/daily-job-briefs`

列出 DailyJobBrief，按日期降序。

**Response** (200):
```json
{
  "briefs": [
    {
      "id": "djb_20260811",
      "briefDate": "2026-08-11",
      "searchPlanVersionId": "dspv_v1_abc",
      "sourceRunIds": ["sr_xyz789"],
      "recommendationBatchId": "rb_batch_001",
      "status": "READY",
      "coverageJson": { ... },
      "costSummaryJson": { ... },
      "emptyReason": null,
      "generatedAt": 1755014500000
    }
  ],
  "total": 1
}
```

### `GET /api/daily-job-briefs/:id`

获取单份 Brief 详情。包含审批进度和发现条目。

**Response** (200):
```json
{
  "brief": { ... },
  "recommendationBatch": { ... },
  "discoveryItems": [
    {
      "candidateId": "rc_006",
      "candidateVersionId": "rcv_006_v1",
      "evidenceLevel": "MANUAL_REVIEW_REQUIRED",
      "sourcePolicy": "SEARCH_ONLY",
      "title": "高级前端开发工程师",
      "company": "某科技有限公司",
      "sourceUrl": "https://www.zhipin.com/job_detail/xxx.html",
      "sourceDomain": "zhipin.com",
      "provider": "tavily",
      "query": "苏州 前端工程师 招聘",
      "snippet": "负责Web前端开发...",
      "searchedAt": 1755014400000,
      "recommendation": "需人工核实的发现——点击原链接确认后可通过 Manual Capture 升级为完整分析"
    }
  ],
  "reviewProgress": {
    "total": 5,
    "judged": 3,
    "pending": 2,
    "breakdown": {
      "VERY_SUITABLE": 1,
      "SOMEWHAT_SUITABLE": 1,
      "NOT_VERY_SUITABLE": 1,
      "VERY_UNSUITABLE": 0
    }
  },
  "nextCandidateToJudge": {
    "candidateId": "rc_004",
    "candidateVersionId": "rcv_004_v1"
  }
}
```

**关键约束：**
- `discoveryItems` 是 supplementary 发现条目（SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED）——不是第二套推荐
- `recommendationBatch` 仍是唯一正式推荐集合（FULL_EVIDENCE 候选，0-8）
- `discoveryItems` 不经过 MatchAnalysis（无 `analysisRecordId`、无 `recommendation`、`evidenceRefs` 等）
- `reviewProgress` 只对 recommendationBatch 中的候选进行统计

### `GET /api/daily-job-briefs/today` 和 `POST .../complete`

同旧 Plan。

---

## 4. JobJudgment（保持，新增 evidenceLevel context）

### `POST /api/daily-job-briefs/:briefId/items/:candidateId/judgment`

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

### `PATCH /api/job-judgments/:id`、`DELETE /api/job-judgments/:id`、`POST .../reason`

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
- `GET /api/discovery-items` — discovery items 通过 DailyBrief API 获取，不独立暴露
- `POST /api/content-acquisition/...` — Content Acquisition 是 Pipeline 内部步骤，不暴露独立 API

---

## 9. API 字段新增汇总

| Endpoint | 新增字段 | 说明 |
|----------|---------|------|
| `GET /api/daily-job-briefs/:id` | `discoveryItems[]` | SEARCH_EVIDENCE/MANUAL_REVIEW_REQUIRED 发现条目 |
| `GET /api/daily-job-briefs/:id` | `discoveryItems[].evidenceLevel` | SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED |
| `GET /api/daily-job-briefs/:id` | `discoveryItems[].sourcePolicy` | SEARCH_ONLY / SEARCH_AND_FETCH / CONDITIONAL_FETCH |
| `GET /api/source-runs` | `queriesAttempted` 等 | 替换 Jooble-specific 字段 |
| `GET /api/source-runs` | `estimatedSearchCredits` / `actualSearchCredits` | Cost visibility |
| `GET /api/source-runs` | `searchEvidencePersisted` / `manualReviewRequired` / `fullEvidenceCount` | Evidence breakdown |
| POST judgment response | `candidateEvidenceLevel` | 前端区分信息完整度 |
