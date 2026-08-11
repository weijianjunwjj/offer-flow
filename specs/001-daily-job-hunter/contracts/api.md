# OfferFlow v0.9 API Contracts

> **Source**: `specs/001-daily-job-hunter/plan.md`  
> **版本：** 1.0  
> **创建日期：** 2026-08-11  

本文档记录 v0.9 新增 API 的契约定义。所有路径遵循现有 `/api/*` 约定，沿用 Fastify + loopback + Origin 保护。

---

## 1. SearchPlan

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
    { "providerKey": "jooble", "enabled": true }
  ],
  "schedule": {
    "dailyAt": "09:00"
  },
  "scanBudget": {
    "maxPagesPerTask": 1,
    "maxTotalPages": 20
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

**Response** (201):
```json
{
  "plan": {
    "id": "dsp_abc123",
    "name": "每日前端岗位",
    "status": "active",
    "activeVersionId": "dspv_v1_abc",
    "createdAt": 1755014400000
  },
  "version": {
    "id": "dspv_v1_abc",
    "searchPlanId": "dsp_abc123",
    "version": 1,
    "cities": [...],
    "roleDirections": [...],
    "baseKeywords": [...],
    "sourceConfigs": [...],
    "schedule": { "dailyAt": "09:00" },
    "scanBudget": {...},
    "analysisBudget": {...},
    "notificationPolicy": {...},
    "latestCatchUpTime": "12:00",
    "createdAt": 1755014400000
  }
}
```

### `GET /api/daily-search-plans`

列出所有 SearchPlan。

**Response** (200):
```json
{
  "plans": [
    {
      "id": "dsp_abc123",
      "name": "每日前端岗位",
      "status": "active",
      "activeVersionId": "dspv_v1_abc",
      "createdAt": 1755014400000,
      "updatedAt": 1755014400000,
      "nextScheduledRun": "2026-08-12T09:00:00+08:00"
    }
  ]
}
```

### `GET /api/daily-search-plans/:id`

获取单个 SearchPlan 详情。

**Response** (200): 包含 plan + active version 完整信息。

### `POST /api/daily-search-plans/:id/versions`

创建新 Version（修改计划）。

**Request Body**: 同创建时的 Version 字段，全部可选（提供则更新）。

**Response** (201): 新 Version 对象。

### `POST /api/daily-search-plans/:id/activate`

激活指定 Version。

**Request Body**:
```json
{
  "versionId": "dspv_v2_def"
}
```

**Response** (200): 更新后的 Plan。

### `POST /api/daily-search-plans/:id/pause`

暂停 Plan。此后不再自动执行调度。

**Response** (200): Plan status 变为 `paused`。

### `POST /api/daily-search-plans/:id/resume`

恢复已暂停的 Plan。

**Response** (200): Plan status 变为 `active`。

### `POST /api/daily-search-plans/:id/run-now`

手动触发一次运行。

**Response** (202):
```json
{
  "sourceRun": {
    "id": "sr_xyz789",
    "triggerType": "MANUAL",
    "status": "PENDING",
    "scheduledFor": 1755014500000
  }
}
```

### `POST /api/daily-search-plans/:id/skip-today`

跳过今天的调度/补偿。已有运行不受影响。

**Response** (200): 确认。

---

## 2. SourceRun

### `GET /api/source-runs`

列出 SourceRun，支持过滤。

**Query Parameters**:
- `planId` (optional)
- `status` (optional)
- `triggerType` (optional)
- `limit` (default 20)
- `offset` (default 0)

**Response** (200):
```json
{
  "runs": [
    {
      "id": "sr_xyz789",
      "searchPlanVersionId": "dspv_v1_abc",
      "sourceKey": "jooble",
      "sourceVersion": "1.0.0",
      "triggerType": "SCHEDULED",
      "status": "SUCCEEDED",
      "phase": "BUILDING_BRIEF",
      "scheduledFor": 1755014400000,
      "startedAt": 1755014401000,
      "finishedAt": 1755014450000,
      "scannedCount": 42,
      "ingestedCount": 15,
      "newCount": 8,
      "changedCount": 2,
      "duplicateCount": 5,
      "analysisRequestedCount": 10,
      "analysisSucceededCount": 10,
      "selectedCount": 5,
      "coverageSummary": {
        "completedTasks": 4,
        "failedTasks": 0
      },
      "costSummary": {
        "totalRequests": 4,
        "analysisRequests": 10,
        "model": "deepseek-chat"
      }
    }
  ],
  "total": 1
}
```

### `GET /api/source-runs/:id`

获取单个 SourceRun 详情。

**Response** (200): 包含完整 coverage、cost 和 error 信息。

### `POST /api/source-runs/:id/retry`

对失败/中断的 Run 创建 RETRY Run。

**Response** (202):
```json
{
  "retryRun": {
    "id": "sr_retry_abc",
    "triggerType": "RETRY",
    "retryOfRunId": "sr_xyz789",
    "status": "PENDING"
  }
}
```

### `POST /api/source-runs/:id/cancel`

取消 PENDING/RUNNING 的 Run。

**Response** (200): Run status 变为 `CANCELLED`。

---

## 3. DailyJobBrief

### `GET /api/daily-job-briefs`

列出 DailyJobBrief，按日期降序。

**Query Parameters**:
- `limit` (default 30)
- `offset` (default 0)

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

### `GET /api/daily-job-briefs/today`

获取今天的 DailyJobBrief（或最近一份未完成的）。

**Response** (200): brief 对象（可能为 null）。

### `GET /api/daily-job-briefs/:id`

获取单份 Brief 详情。包含审批进度。

**Response** (200):
```json
{
  "brief": { ... },
  "recommendationBatch": { ... },
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

### `POST /api/daily-job-briefs/:id/complete`

标记 Brief 为完成。

**Response** (200): Brief status 变为 `COMPLETED`。

---

## 4. JobJudgment

### `POST /api/daily-job-briefs/:briefId/items/:candidateId/judgment`

创建四档判断。

**Request Body**:
```json
{
  "judgment": "VERY_SUITABLE",
  "reason": {
    "source": "USER_SELECTED",
    "reasonCode": "role_direction_match",
    "reasonText": "React前端主导，方向很匹配"
  }
}
```

**Response** (201):
```json
{
  "judgment": {
    "id": "jj_001",
    "dailyBriefId": "djb_20260811",
    "radarCandidateId": "rc_001",
    "candidateVersionId": "rcv_001_v1",
    "judgment": "VERY_SUITABLE",
    "systemRecommendation": "apply_now",
    "systemConfidence": "high",
    "judgedAt": 1755014600000,
    "supersedesJudgmentId": null
  },
  "reason": {
    "id": "jr_001",
    "judgmentId": "jj_001",
    "reasonCode": "role_direction_match",
    "reasonText": "React前端主导，方向很匹配",
    "polarity": "positive",
    "source": "USER_SELECTED"
  }
}
```

### `PATCH /api/job-judgments/:id`

修改已有判断（创建新版本，旧版本保留）。

**Request Body**: 同创建。

**Response** (200): 新 judgment + 旧 judgment 被 supersedes。

### `DELETE /api/job-judgments/:id`

撤销判断。关联 Signal 失效，Rule 重算。

**Response** (200):
```json
{
  "reverted": {
    "id": "jj_001",
    "revertedAt": 1755014700000
  },
  "affectedRules": ["pr_rule_001"]
}
```

### `POST /api/job-judgments/:id/reason`

补充/修改理由。

**Request Body**: 同创建时的 reason 字段。

**Response** (200): 新 reason 对象。

---

## 5. Preference

### `GET /api/preference-signals`

列出 PreferenceSignal。

**Query Parameters**:
- `direction` (optional: `positive` | `negative`)
- `activeOnly` (default true)

**Response** (200):
```json
{
  "signals": [
    {
      "id": "ps_001",
      "judgmentId": "jj_001",
      "featureKey": "company_type",
      "featureValue": { "value": "self_research_team" },
      "direction": "positive",
      "strength": "strong",
      "createdAt": 1755014600000,
      "invalidatedAt": null
    }
  ]
}
```

### `GET /api/preference-rules`

列出 PreferenceRule。

**Query Parameters**:
- `status` (optional: `PROPOSED` | `ACTIVE` | `DISABLED`)
- `ruleType` (optional)

**Response** (200):
```json
{
  "rules": [
    {
      "id": "pr_001",
      "ruleType": "RANK_BOOST",
      "featureKey": "company_type",
      "condition": { "value": "self_research_team" },
      "effect": { "boost": 2 },
      "status": "ACTIVE",
      "explanation": "用户多次认为自研团队岗位非常合适",
      "activationMode": "THRESHOLD_AUTO",
      "signalCount": 2,
      "createdAt": 1755014700000
    }
  ]
}
```

### `PATCH /api/preference-rules/:id`

更新 PreferenceRule（启用/停用）。

**Request Body**:
```json
{
  "status": "DISABLED"
}
```

**Response** (200): 更新后的 rule。

### `DELETE /api/preference-rules/:id`

删除 PreferenceRule。

**Response** (200): Rule status 变为 `DELETED`。

---

## 6. Notification

### `GET /api/notification-channels`

列出通知渠道。

**Response** (200):
```json
{
  "channels": [
    {
      "id": "nc_email_001",
      "channelType": "QQ_SMTP_EMAIL",
      "displayName": "我的QQ邮箱",
      "status": "ACTIVE",
      "senderAddress": "xxx@qq.com",
      "recipientAddress": "xxx@qq.com",
      "secretRef": "***",
      "lastTestedAt": 1755014000000,
      "lastSuccessAt": 1755014500000
    }
  ]
}
```

### `POST /api/notification-channels/email`

创建/配置 QQ 邮箱渠道。

**Request Body**:
```json
{
  "displayName": "我的QQ邮箱",
  "senderAddress": "xxx@qq.com",
  "recipientAddress": "xxx@qq.com",
  "secret": "你的QQ邮箱SMTP授权码",
  "config": {
    "smtpHost": "smtp.qq.com",
    "smtpPort": 465,
    "tls": true,
    "highPriorityEnabled": true,
    "dailyBriefEnabled": true,
    "dailyBriefTime": "10:00",
    "failureNoticeEnabled": true,
    "quietHours": {
      "start": "22:00",
      "end": "08:00"
    }
  }
}
```

**Response** (201): 创建的 channel 对象（`secretRef` 为 `"***"`）。

### `PATCH /api/notification-channels/:id`

更新渠道配置（可更新 Secret）。

**Response** (200): 更新后的 channel。

### `DELETE /api/notification-channels/:id`

删除渠道。同时删除关联 Secret。

**Response** (200): 确认。

### `POST /api/notification-channels/:id/test`

发送测试邮件。

**Response** (200):
```json
{
  "status": "SENT",
  "sentAt": 1755014800000
}
```

### `GET /api/notifications`

列出通知 Outbox 条目。

**Query Parameters**:
- `status` (optional)
- `notificationType` (optional)
- `limit` (default 50)
- `offset` (default 0)

**Response** (200):
```json
{
  "notifications": [
    {
      "id": "no_001",
      "notificationType": "DAILY_BRIEF",
      "status": "SENT",
      "subject": "【OfferFlow 日报】2026-08-11",
      "attemptCount": 1,
      "sentAt": 1755014500000,
      "linkedEntities": [
        { "entityType": "DAILY_JOB_BRIEF", "entityId": "djb_20260811" }
      ]
    }
  ]
}
```

### `POST /api/notifications/:id/retry`

重试失败的 Outbox 条目。

**Response** (202): 新 status 和 next_retry_at。

---

## 7. Local Service / Scheduler

### `GET /api/local-service/status`

获取本地服务状态。

**Response** (200):
```json
{
  "online": true,
  "uptime": 3600000,
  "autostartEnabled": true,
  "scheduler": {
    "status": "RUNNING",
    "activePlans": 1,
    "nextScheduledRun": "2026-08-12T09:00:00+08:00",
    "missedSchedules": []
  },
  "outbox": {
    "pending": 0,
    "sending": 0,
    "failedRetryable": 0,
    "failedFinal": 0
  }
}
```

### `GET /api/scheduler/status`

获取 Scheduler 详细信息。

**Response** (200):
```json
{
  "scheduler": {
    "status": "RUNNING",
    "activePlans": [
      {
        "planId": "dsp_abc123",
        "planName": "每日前端岗位",
        "nextRun": "2026-08-12T09:00:00+08:00",
        "todayStatus": "COMPLETED"
      }
    ]
  }
}
```

### `POST /api/local-service/autostart/enable`

启用开机自启动。

**Response** (200):
```json
{
  "autostartEnabled": true
}
```

### `POST /api/local-service/autostart/disable`

禁用开机自启动。

**Response** (200):
```json
{
  "autostartEnabled": false
}
```

---

## 8. 安全与错误约定

### 通用错误响应格式

```json
{
  "error": {
    "code": "PLAN_NOT_FOUND",
    "message": "找岗计划不存在",
    "requestId": "req_abc123"
  }
}
```

### HTTP Status Codes

| Status | 含义 |
|--------|------|
| 200 | 成功（读取） |
| 201 | 创建成功 |
| 202 | 已接受（异步任务已创建） |
| 400 | 请求校验失败 |
| 404 | 资源不存在 |
| 409 | 冲突（并发运行、幂等冲突） |
| 422 | 业务逻辑拒绝（如已暂停的 Plan 不可运行） |
| 500 | 服务端错误 |

### 安全 Header

- 所有 Radar API 继续受 `assertCaptureRequestAllowed` 保护（loopback + Host + Origin + `x-offerflow-capture-client` header）
- 公开路由（`/health`）无需鉴权
- Notification Channel 创建/更新时，`secret` 字段只接受明文（首次配置），API 响应中 `secretRef` 始终返回 `"***"` 掩码

### 不定义的路由

以下明确不提供：
- `POST /api/local-service/start` — 已停止进程无法 HTTP 自举
- `GET /source-runs/:id/snapshots` — Snapshot 通过 Radar 事实关系追踪
