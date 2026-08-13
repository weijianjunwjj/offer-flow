# OfferFlow v0.9 快速启动 / 本地开发验证流程

> **版本：** 2.0  
> **对应 Plan：** `specs/001-daily-job-hunter/plan.md`  
> **创建日期：** 2026-08-11  
> **最后修订：** 2026-08-11（Plan Amendment：Jooble → Tavily Search API，Search Evidence / Source Policy / Content Acquisition 更新）

---

## 环境

- **操作系统**：Windows 11 Home（原生）
- **Shell**：Git Bash（所有命令使用 Bash，禁止 PowerShell/CMD）
- **Node.js**：≥ 18
- **包管理**：pnpm

---

## 1. 前置条件

```bash
# 确认仓库状态
cd /d/VSCode/offer-flow
git status
git branch  # 应在 feat/v0.9

# 确认依赖
pnpm install

# 确认现有测试通过
pnpm vitest run
pnpm vue-tsc --noEmit
pnpm build
```

---

## 2. 本地开发启动

```bash
# 启动开发模式
pnpm run dev

# 这会启动：
# - Fastify 后端（默认 127.0.0.1:3000）
# - Vite 前端（默认 127.0.0.1:5173）
# - 使用本地 SQLite 数据库
```

---

## 3. V9-0：Tavily Integration Smoke + Evidence Model Validation

在投入完整 Discovery 基建前，先验证 Tavily Search API 的真实能力。

### 3.1 获取 Tavily API Key

1. 访问 `https://app.tavily.com/home`
2. 注册（Free tier 无需信用卡）
3. 在 Dashboard 获取 API Key（格式：`tvly-<key>`）

### 3.2 真实 API 验证

```bash
# 设置 API Key（开发环境使用环境变量）
export TAVILY_API_KEY="tvly-your-api-key-here"

# 运行 Provider Validation 脚本
pnpm run provider:validate
```

### 3.3 Tavily Integration Smoke Checklist

1. API Key 能真实取得
2. `POST https://api.tavily.com/search` —— Bearer token 认证生效
3. `country=china` 搜索可正常调用
4. 苏州 / 无锡等至少一个目标城市能获得真实搜索结果
5. 返回字段与官方 contract 一致（`results[].title`、`url`、`content`、`score`）
6. `search_depth=basic` 消耗 1 credit（验证 `usage.credit_used` 如有）
7. 真实结果的内容质量评估（`content` 字段长度、信息密度）
8. Secret 脱敏验证（日志、API 响应不包含 API Key）

### 3.4 如果验证失败

- 记录为 Provider Validation Failed
- 不偷改 Radar 规则
- 不爬专业招聘平台补数据
- 重新进行 Provider 决策

---

## 4. V9-1：Shared Radar Ingestion Core 验证

### 4.1 启动沙箱

```bash
# 启动 Radar 沙箱（隔离数据库，Radar 功能开启）
pnpm run dev:radar-sandbox
```

### 4.2 运行测试

```bash
# Radar Ingestion 测试
pnpm vitest run server/radar/service.spec.ts
pnpm vitest run server/radar/ingestion/  # V9-1 新增

# Commit Decision（evidence-aware）
pnpm vitest run server/radar/commitDecision.spec.ts

# 现有 Browser Capture 回归
pnpm vitest run server/radar/routes.spec.ts
pnpm vitest run server/radar/radar.spec.ts

# 全量回归
pnpm vitest run
```

### 4.3 验证点

1. Browser Capture 旧行为不变
2. `captureMethod='search_discovery'` Snapshot 可正常写入（需 schema v9）
3. `captureSessionId=null` Snapshot 不影响 Ingestion
4. SEARCH_EVIDENCE CandidateVersion 创建（`evidenceLevel='SEARCH_EVIDENCE'`）
5. `analysisEligible=false` 当 evidenceLevel='SEARCH_EVIDENCE'
6. 同 source URL → 同一 Candidate（Tavily discovery + Manual Capture 两路输入共用去重）
7. Evidence Upgrade → 新 CandidateVersion（`originType='evidence_upgrade'`）
8. 表重建 migration（v8→v9）v0.8 Radar 回归通过

---

## 5. V9-2：SearchPlan + Scheduler + Tavily Discovery 验证

### 5.1 配置 Tavily API Key

```bash
# 开发环境使用环境变量注入
export TAVILY_API_KEY="tvly-your-api-key-here"
```

### 5.2 配置 Secret Store

```bash
# 开发环境使用环境变量（Production 使用 Windows DPAPI）
export OFFERFLOW_SECRET_STORE_MODE="env"

# V9-4 阶段配置 QQ SMTP 授权码
export OFFERFLOW_QQ_SMTP_AUTH_CODE="your-smtp-auth-code"
```

### 5.3 运行测试

```bash
# SearchPlan API 测试
pnpm vitest run server/search-plan/

# Tavily Provider 测试（使用 mock）
pnpm vitest run server/search-provider/tavily.spec.ts

# Query Expansion 测试
pnpm vitest run server/pipeline/taskExpansion.spec.ts

# Scheduler 测试
pnpm vitest run server/scheduler/

# SourceRun 测试
pnpm vitest run server/source-run/
```

### 5.4 手动验证

```bash
# 创建 SearchPlan（通过 API）
curl -X POST http://127.0.0.1:3000/api/daily-search-plans \
  -H "Content-Type: application/json" \
  -d '{
    "name": "每日前端岗位",
    "cities": [{"name":"苏州","priority":1}],
    "roleDirections": ["前端开发"],
    "baseKeywords": ["React","TypeScript"],
    "sourceConfigs": [{"providerKey":"tavily","searchDepth":"basic","country":"china"}],
    "schedule": {"dailyAt":"09:00"},
    "scanBudget": {"maxQueriesPerRun":30},
    "analysisBudget": {"maxAnalysesPerRun":5},
    "notificationPolicy": {"highPriorityEnabled":true,"dailyBriefEnabled":true}
  }'

# 手动触发运行
curl -X POST http://127.0.0.1:3000/api/daily-search-plans/<planId>/run-now

# 查看 SourceRun 状态
curl http://127.0.0.1:3000/api/source-runs
```

---

## 6. V9-3：Source Policy + Content Acquisition + DailyJobBrief 验证

### 6.1 运行测试

```bash
# Source Policy 测试
pnpm vitest run server/source-policy/

# Content Acquisition 测试
pnpm vitest run server/content-acquisition/

# Pipeline 测试
pnpm vitest run server/pipeline/

# DailyBrief 测试
pnpm vitest run server/daily-brief/

# Analysis + Recommendation 复用回归
pnpm vitest run server/radar/analysis/
pnpm vitest run server/radar/recommendation/
```

### 6.2 验证点

1. Source Policy：SEARCH_ONLY domain → MANUAL_REVIEW_REQUIRED
2. Source Policy：SEARCH_AND_FETCH domain → Content Acquisition → 完整性验证 → evidence_upgrade → FULL_EVIDENCE
3. Source Policy：CONDITIONAL_FETCH / UNKNOWN → 默认不 Fetch
4. Pipeline：discover → source policy → ingest → analyze → recommend → buildBrief
5. DailyBrief 引用 RecommendationBatch + discoveryItems
6. 0-8 推荐
7. 空 Brief + emptyReason
8. Cost Summary（含 `estimatedSearchCredits` / `actualSearchCredits`）

---

## 7. V9-4：QQ SMTP + Outbox 验证（保持）

同旧 Plan。Jooble-specific 内容替换为 Tavily。

### 7.1 配置邮箱 Channel

```bash
curl -X POST http://127.0.0.1:3000/api/notification-channels/email \
  -H "Content-Type: application/json" \
  -d '{
    "channelType": "QQ_SMTP_EMAIL",
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
      "quietHours": {"start":"22:00","end":"08:00"}
    }
  }'

# 发送测试邮件
curl -X POST http://127.0.0.1:3000/api/notification-channels/<channelId>/test
```

---

## 8. V9-5 / V9-6：Judgment + Preference 验证（保持）

同旧 Plan。新增：evidenceLevel-aware 追问抑制（MANUAL_REVIEW_REQUIRED 候选不触发追问）、evidenceLevel-aware signal 生成。

---

## 9. 全量回归

```bash
# 全量测试
pnpm vitest run

# TypeScript 编译
pnpm vue-tsc --noEmit

# 构建
pnpm build

# Migration selftest
pnpm migration:selftest

# DB 医生
pnpm db:doctor
```

---

## 10. 连续 3 自然日真实运行验收（更新）

1. 配置真实 SearchPlan（苏州/无锡，前端方向，Tavily Provider）
2. 确保服务开机自启动（`POST /api/local-service/autostart/enable`）
3. **第 1 日：** Scheduler → Tavily /search → Search Evidence → Source Policy → SEARCH_EVIDENCE 候选创建 → Policy B 来源经 Content Acquisition + 完整性验证 + evidence_upgrade → FULL_EVIDENCE 候选 → MatchAnalysis → RecommendationBatch → DailyJobBrief（含混合 Evidence Level）→ 邮件
4. **第 2 日：** 重复岗位不重复创建 Candidate → 变化岗位新 CandidateVersion → SEARCH_EVIDENCE 旧岗正確抑制分析
5. **第 3 日：** 四档判断 → PreferenceSignal → Rule → SearchExpand
6. 中途测试：关机/睡眠 → Catch-up；Provider failure → 显式错误；服务崩溃 → INTERRUPTED → RETRY
7. **Evidence Upgrade 测试：** SEARCH_EVIDENCE 候选 → 用户打开 BOSS → Manual Capture → 同一 Candidate → FULL_EVIDENCE version → MatchAnalysis

---

## 11. 开发命令速查

```bash
# 开发模式（前后端）
pnpm run dev

# 仅后端
pnpm run dev:server

# Radar 沙箱（隔离数据库）
pnpm run dev:radar-sandbox

# 运行特定波次测试
pnpm vitest run server/radar/ingestion/        # V9-1
pnpm vitest run server/search-plan/             # V9-2
pnpm vitest run server/search-provider/tavily/  # V9-2
pnpm vitest run server/pipeline/                # V9-2/V9-3
pnpm vitest run server/scheduler/               # V9-2
pnpm vitest run server/source-policy/           # V9-3
pnpm vitest run server/content-acquisition/     # V9-3
pnpm vitest run server/daily-brief/             # V9-3
pnpm vitest run server/notification/            # V9-4
pnpm vitest run server/judgment/                # V9-5
pnpm vitest run server/preference/              # V9-6

# Provider validation (Tavily smoke)
pnpm run provider:validate

# Migration
pnpm migration:selftest

# DB 状态
pnpm db:doctor

# 构建
pnpm build
```
